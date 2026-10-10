import { AccountSummaryEntity } from '@forexedge/database';
import { AccountService, PAPER_STARTING_BALANCE } from './account.service';

// account_summary rows as stored: balance and margin_used only (no open P&L)
const makeAccountRow = (overrides: Partial<AccountSummaryEntity> = {}): AccountSummaryEntity => ({
  id: 'acc-1',
  userId: 'user-1',
  balance: 10000,
  marginUsed: 1000,
  leverage: 100,
  updatedAt: new Date('2026-10-07T12:00:00Z'),
  user: {} as AccountSummaryEntity['user'],
  ...overrides,
} as AccountSummaryEntity);

// SUM(unrealized_pnl) over the user's open positions, as node-pg returns it (a string)
const positionsSumming = (openPnl: string) => {
  const qb = {
    select: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), andWhere: jest.fn().mockReturnThis(),
    getRawOne: jest.fn().mockResolvedValue({ openPnl }),
  };
  return { repo: { createQueryBuilder: jest.fn(() => qb) }, qb };
};

const serviceWith = (row: AccountSummaryEntity | null, openPnl = '0') => {
  const accountRepo = { findOne: jest.fn().mockResolvedValue(row), create: jest.fn((x) => x), save: jest.fn(async (x) => ({ ...x, id: 'acc-new' })) };
  const positions = positionsSumming(openPnl);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new AccountService(accountRepo as any, positions.repo as any);
  return { service, accountRepo, positions };
};

describe('AccountService', () => {
  describe('getAccountSummary — open P&L is derived from the open positions', () => {
    it('sums unrealized_pnl of the user\'s open positions', async () => {
      const { service, positions } = serviceWith(makeAccountRow(), '200');
      const result = await service.getAccountSummary('user-1');
      expect(result.unrealizedPnl).toBe(200);
      expect(positions.qb.select).toHaveBeenCalledWith('COALESCE(SUM(p.unrealized_pnl), 0)', 'openPnl');
      expect(positions.qb.where).toHaveBeenCalledWith('p.user_id = :userId', { userId: 'user-1' });
      expect(positions.qb.andWhere).toHaveBeenCalledWith('p.is_open = true');
    });

    it('equity = balance + open P&L, free margin = equity - margin used, margin level = equity / margin', async () => {
      const { service } = serviceWith(makeAccountRow(), '200');
      // equity 10,200; free margin 9,200; margin level 1,020%
      await expect(service.getAccountSummary('user-1')).resolves.toMatchObject({ equity: 10200, freeMargin: 9200, marginLevel: 1020 });
    });

    it('negative open P&L lowers equity and free margin', async () => {
      const { service } = serviceWith(makeAccountRow(), '-500');
      await expect(service.getAccountSummary('user-1')).resolves.toMatchObject({ equity: 9500, freeMargin: 8500, marginLevel: 950 });
    });

    it('margin level is null without margin in use', async () => {
      const { service } = serviceWith(makeAccountRow({ marginUsed: 0 }));
      await expect(service.getAccountSummary('user-1')).resolves.toMatchObject({ marginLevel: null, unrealizedPnl: 0 });
    });

    it('reads fresh values on every call', async () => {
      const { service, accountRepo } = serviceWith(makeAccountRow());
      await service.getAccountSummary('user-1');
      await service.getAccountSummary('user-1');
      expect(accountRepo.findOne).toHaveBeenCalledTimes(2);
    });
  });

  describe('initializeAccount', () => {
    it(`creates an account with the $${PAPER_STARTING_BALANCE} paper balance and no open P&L column`, async () => {
      const { service, accountRepo } = serviceWith(null);
      const result = await service.initializeAccount('user-1');
      expect(accountRepo.create).toHaveBeenCalledWith({ userId: 'user-1', balance: 10000, marginUsed: 0, leverage: 100 });
      expect(result).toMatchObject({ balance: 10000, equity: 10000, unrealizedPnl: 0, marginLevel: null });
    });

    it('returns the existing account without creating a duplicate', async () => {
      const { service, accountRepo } = serviceWith(makeAccountRow(), '12.5');
      const result = await service.initializeAccount('user-1');
      expect(accountRepo.create).not.toHaveBeenCalled();
      expect(result).toMatchObject({ balance: 10000, unrealizedPnl: 12.5 });
    });
  });
});

describe('AccountService cross-user access', () => {
  const USER_A = 'aaaaaaaa-0000-4000-8000-000000000001';
  const USER_B = 'bbbbbbbb-0000-4000-8000-000000000002';
  const rowOfA = makeAccountRow({ id: 'acct-a', userId: USER_A, marginUsed: 0 });
  // Behaves like Postgres: only the row whose user_id matches is returned.
  const accountRepo = { findOne: jest.fn(async ({ where }: { where: { userId?: string } }) => (where.userId === USER_A ? rowOfA : null)) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new AccountService(accountRepo as any, positionsSumming('0').repo as unknown as never);

  afterEach(() => jest.clearAllMocks());

  it("user B without an account gets 404, never user A's account", async () => {
    await expect(service.getAccountSummary(USER_B)).rejects.toThrow('Account not found');
    await expect(service.getAccountSummary(USER_B)).rejects.toHaveProperty('status', 404);
    expect(accountRepo.findOne).toHaveBeenCalledWith({ where: { userId: USER_B } });
  });

  it('owner reads their own account', async () => {
    await expect(service.getAccountSummary(USER_A)).resolves.toMatchObject({ userId: USER_A, balance: 10000 });
  });

  it('a missing user id fails closed (401) instead of matching the first account', async () => {
    await expect(service.getAccountSummary(undefined as unknown as string)).rejects.toHaveProperty('status', 401);
    expect(accountRepo.findOne).not.toHaveBeenCalled();
  });
});

