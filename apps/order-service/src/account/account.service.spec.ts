import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AccountSummaryEntity, PositionEntity } from '@forexedge/database';
import { AccountService } from './account.service';

const mockAccountRepo = () => ({
  findOne: jest.fn(),
  create: jest.fn(),
  save: jest.fn(),
  update: jest.fn(),
});

const mockPositionRepo = () => ({
  update: jest.fn(),
});

const makeAccountRow = (overrides = {}): AccountSummaryEntity => ({
  id: 'acc-1',
  userId: 'user-1',
  balance: 10000,
  marginUsed: 1000,
  unrealizedPnl: 200,
  leverage: 100,
  updatedAt: new Date(),
  user: {} as any,
  ...overrides,
} as AccountSummaryEntity);

describe('AccountService', () => {
  let service: AccountService;
  let accountRepo: ReturnType<typeof mockAccountRepo>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountService,
        { provide: getRepositoryToken(AccountSummaryEntity), useFactory: mockAccountRepo },
        { provide: getRepositoryToken(PositionEntity), useFactory: mockPositionRepo },
      ],
    }).compile();

    service = module.get(AccountService);
    accountRepo = module.get(getRepositoryToken(AccountSummaryEntity));
  });

  afterEach(() => jest.clearAllMocks());

  // ── getAccountSummary — computed fields ────────────────────────────────────
  describe('getAccountSummary', () => {
    it('computes equity = balance + unrealizedPnl', async () => {
      accountRepo.findOne.mockResolvedValue(makeAccountRow());
      const result = await service.getAccountSummary('user-1');
      // equity = 10000 + 200 = 10200
      expect(result.equity).toBe(10200);
    });

    it('computes freeMargin = equity - marginUsed', async () => {
      accountRepo.findOne.mockResolvedValue(makeAccountRow());
      const result = await service.getAccountSummary('user-1');
      // freeMargin = 10200 - 1000 = 9200
      expect(result.freeMargin).toBe(9200);
    });

    it('computes marginLevel = (equity / marginUsed) * 100', async () => {
      accountRepo.findOne.mockResolvedValue(makeAccountRow());
      const result = await service.getAccountSummary('user-1');
      // marginLevel = (10200 / 1000) * 100 = 1020%
      expect(result.marginLevel).toBe(1020);
    });

    it('returns null marginLevel when no margin used', async () => {
      accountRepo.findOne.mockResolvedValue(makeAccountRow({ marginUsed: 0 }));
      const result = await service.getAccountSummary('user-1');
      expect(result.marginLevel).toBeNull();
    });

    it('returns cached value without hitting DB on second call', async () => {
      accountRepo.findOne.mockResolvedValue(makeAccountRow());
      await service.getAccountSummary('user-1');
      await service.getAccountSummary('user-1');
      // DB should only be hit once — second call uses cache
      expect(accountRepo.findOne).toHaveBeenCalledTimes(1);
    });

    it('equity is correct with negative unrealizedPnl', async () => {
      accountRepo.findOne.mockResolvedValue(makeAccountRow({ unrealizedPnl: -500 }));
      const result = await service.getAccountSummary('user-1');
      // equity = 10000 - 500 = 9500
      expect(result.equity).toBe(9500);
      // freeMargin = 9500 - 1000 = 8500
      expect(result.freeMargin).toBe(8500);
    });
  });

  // ── initializeAccount ──────────────────────────────────────────────────────
  describe('initializeAccount', () => {
    it('creates account with $10,000 balance', async () => {
      accountRepo.findOne.mockResolvedValue(null);
      const newAccount = makeAccountRow({ balance: 10000, marginUsed: 0, unrealizedPnl: 0 });
      accountRepo.create.mockReturnValue(newAccount);
      accountRepo.save.mockResolvedValue(newAccount);

      const result = await service.initializeAccount('user-1');
      expect(result.balance).toBe(10000);
      expect(result.equity).toBe(10000);
      expect(result.marginLevel).toBeNull();
    });

    it('returns existing account without creating duplicate', async () => {
      accountRepo.findOne.mockResolvedValue(makeAccountRow());
      const result = await service.initializeAccount('user-1');
      expect(accountRepo.create).not.toHaveBeenCalled();
      expect(result.balance).toBe(10000);
    });
  });
});