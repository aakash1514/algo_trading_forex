import { OpenPairsIndex } from './open-pairs.index';

describe('OpenPairsIndex', () => {
  const rows = (r: { pair: string; open: string }[]) => {
    const qb = {
      select: jest.fn().mockReturnThis(), addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(), groupBy: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue(r),
    };
    return { repo: { createQueryBuilder: jest.fn(() => qb) }, qb };
  };

  afterEach(() => jest.useRealTimers());

  it('builds from the open positions per pair on startup (counts come back as strings)', async () => {
    const { repo, qb } = rows([{ pair: 'XAU/USD', open: '2' }, { pair: 'EUR/USD', open: '1' }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const index = new OpenPairsIndex(repo as any);
    await index.onModuleInit();
    index.onModuleDestroy();

    expect(qb.where).toHaveBeenCalledWith('p.is_open = true');
    expect(qb.groupBy).toHaveBeenCalledWith('p.pair');
    expect(index.has('XAU/USD')).toBe(true);
    expect(index.has('EUR/USD')).toBe(true);
    expect(index.has('USD/JPY')).toBe(false);
  });

  it('tracks opens and closes per pair and drops a pair at zero', async () => {
    const { repo } = rows([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const index = new OpenPairsIndex(repo as any);
    index.opened('XAU/USD');
    index.opened('XAU/USD');
    index.closed('XAU/USD');
    expect(index.has('XAU/USD')).toBe(true);
    index.closed('XAU/USD');
    expect(index.has('XAU/USD')).toBe(false);
    expect(index.pairs()).toEqual([]);
    index.closed('XAU/USD'); // never goes negative
    index.opened('XAU/USD');
    expect(index.has('XAU/USD')).toBe(true);
  });

  it('re-syncs from the DB every 30 s, correcting drift', async () => {
    jest.useFakeTimers();
    const { repo, qb } = rows([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const index = new OpenPairsIndex(repo as any);
    await index.onModuleInit();
    index.opened('GBP/USD'); // e.g. an update this process never saw undone
    qb.getRawMany.mockResolvedValue([{ pair: 'USD/JPY', open: '1' }]);

    await jest.advanceTimersByTimeAsync(OpenPairsIndex.RESYNC_INTERVAL_MS);
    index.onModuleDestroy();

    expect(index.has('GBP/USD')).toBe(false);
    expect(index.has('USD/JPY')).toBe(true);
  });
});
