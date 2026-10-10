import { DataSource } from 'typeorm';
import {
  InstrumentEntity,
  InstrumentType,
  ForexSession,
} from '@forexedge/database';

// Idempotent per row: each instrument is inserted only if its pair isn't there
// yet (ON CONFLICT DO NOTHING on the unique pair). Existing rows are never
// modified, so values changed in the DB survive a re-run, and instruments
// added here later (e.g. XAU/USD) reach databases seeded before them.
//
// avg_spread is a price difference (ask - bid), not pips. max_leverage caps the
// account's leverage for that instrument (null = no cap).
export const seedInstruments = async (dataSource: DataSource): Promise<void> => {
  const instruments: Partial<InstrumentEntity>[] = [
    // ── MAJORS ───────────────────────────────────────────
    {
      pair: 'EUR/USD', baseCurrency: 'EUR', quoteCurrency: 'USD',
      type: InstrumentType.MAJOR, pipSize: 0.0001,
      avgSpread: 0.00010,
      activeSessions: [ForexSession.LONDON, ForexSession.NEW_YORK],
    },
    {
      pair: 'GBP/USD', baseCurrency: 'GBP', quoteCurrency: 'USD',
      type: InstrumentType.MAJOR, pipSize: 0.0001,
      avgSpread: 0.00013,
      activeSessions: [ForexSession.LONDON, ForexSession.NEW_YORK],
    },
    {
      pair: 'USD/JPY', baseCurrency: 'USD', quoteCurrency: 'JPY',
      type: InstrumentType.MAJOR, pipSize: 0.01,
      avgSpread: 0.01,
      activeSessions: [ForexSession.TOKYO, ForexSession.NEW_YORK],
    },
    {
      pair: 'USD/CHF', baseCurrency: 'USD', quoteCurrency: 'CHF',
      type: InstrumentType.MAJOR, pipSize: 0.0001,
      avgSpread: 0.00012,
      activeSessions: [ForexSession.LONDON, ForexSession.NEW_YORK],
    },
    {
      pair: 'USD/CAD', baseCurrency: 'USD', quoteCurrency: 'CAD',
      type: InstrumentType.MAJOR, pipSize: 0.0001,
      avgSpread: 0.00015,
      activeSessions: [ForexSession.NEW_YORK],
    },
    {
      pair: 'AUD/USD', baseCurrency: 'AUD', quoteCurrency: 'USD',
      type: InstrumentType.MAJOR, pipSize: 0.0001,
      avgSpread: 0.00012,
      activeSessions: [ForexSession.SYDNEY, ForexSession.TOKYO],
    },
    {
      pair: 'NZD/USD', baseCurrency: 'NZD', quoteCurrency: 'USD',
      type: InstrumentType.MAJOR, pipSize: 0.0001,
      avgSpread: 0.00015,
      activeSessions: [ForexSession.SYDNEY, ForexSession.TOKYO],
    },

    // ── MINORS (crosses) ─────────────────────────────────
    {
      pair: 'EUR/GBP', baseCurrency: 'EUR', quoteCurrency: 'GBP',
      type: InstrumentType.MINOR, pipSize: 0.0001,
      avgSpread: 0.00013,
      activeSessions: [ForexSession.LONDON],
    },
    {
      pair: 'EUR/JPY', baseCurrency: 'EUR', quoteCurrency: 'JPY',
      type: InstrumentType.MINOR, pipSize: 0.01,
      avgSpread: 0.014,
      activeSessions: [ForexSession.TOKYO, ForexSession.LONDON],
    },
    {
      pair: 'EUR/CHF', baseCurrency: 'EUR', quoteCurrency: 'CHF',
      type: InstrumentType.MINOR, pipSize: 0.0001,
      avgSpread: 0.00015,
      activeSessions: [ForexSession.LONDON],
    },
    {
      pair: 'EUR/CAD', baseCurrency: 'EUR', quoteCurrency: 'CAD',
      type: InstrumentType.MINOR, pipSize: 0.0001,
      avgSpread: 0.00020,
      activeSessions: [ForexSession.LONDON, ForexSession.NEW_YORK],
    },
    {
      pair: 'EUR/AUD', baseCurrency: 'EUR', quoteCurrency: 'AUD',
      type: InstrumentType.MINOR, pipSize: 0.0001,
      avgSpread: 0.00020,
      activeSessions: [ForexSession.LONDON, ForexSession.SYDNEY],
    },
    {
      pair: 'EUR/NZD', baseCurrency: 'EUR', quoteCurrency: 'NZD',
      type: InstrumentType.MINOR, pipSize: 0.0001,
      avgSpread: 0.00025,
      activeSessions: [ForexSession.LONDON, ForexSession.SYDNEY],
    },
    {
      pair: 'GBP/JPY', baseCurrency: 'GBP', quoteCurrency: 'JPY',
      type: InstrumentType.MINOR, pipSize: 0.01,
      avgSpread: 0.018,
      activeSessions: [ForexSession.TOKYO, ForexSession.LONDON],
    },
    {
      pair: 'GBP/CHF', baseCurrency: 'GBP', quoteCurrency: 'CHF',
      type: InstrumentType.MINOR, pipSize: 0.0001,
      avgSpread: 0.00018,
      activeSessions: [ForexSession.LONDON],
    },
    {
      pair: 'GBP/CAD', baseCurrency: 'GBP', quoteCurrency: 'CAD',
      type: InstrumentType.MINOR, pipSize: 0.0001,
      avgSpread: 0.00022,
      activeSessions: [ForexSession.LONDON, ForexSession.NEW_YORK],
    },
    {
      pair: 'GBP/AUD', baseCurrency: 'GBP', quoteCurrency: 'AUD',
      type: InstrumentType.MINOR, pipSize: 0.0001,
      avgSpread: 0.00022,
      activeSessions: [ForexSession.LONDON, ForexSession.SYDNEY],
    },
    {
      pair: 'GBP/NZD', baseCurrency: 'GBP', quoteCurrency: 'NZD',
      type: InstrumentType.MINOR, pipSize: 0.0001,
      avgSpread: 0.00028,
      activeSessions: [ForexSession.LONDON, ForexSession.SYDNEY],
    },
    {
      pair: 'AUD/JPY', baseCurrency: 'AUD', quoteCurrency: 'JPY',
      type: InstrumentType.MINOR, pipSize: 0.01,
      avgSpread: 0.014,
      activeSessions: [ForexSession.TOKYO, ForexSession.SYDNEY],
    },
    {
      pair: 'AUD/CHF', baseCurrency: 'AUD', quoteCurrency: 'CHF',
      type: InstrumentType.MINOR, pipSize: 0.0001,
      avgSpread: 0.00018,
      activeSessions: [ForexSession.TOKYO, ForexSession.SYDNEY],
    },
    {
      pair: 'AUD/CAD', baseCurrency: 'AUD', quoteCurrency: 'CAD',
      type: InstrumentType.MINOR, pipSize: 0.0001,
      avgSpread: 0.00020,
      activeSessions: [ForexSession.SYDNEY, ForexSession.NEW_YORK],
    },
    {
      pair: 'AUD/NZD', baseCurrency: 'AUD', quoteCurrency: 'NZD',
      type: InstrumentType.MINOR, pipSize: 0.0001,
      avgSpread: 0.00018,
      activeSessions: [ForexSession.SYDNEY],
    },
    {
      pair: 'CAD/JPY', baseCurrency: 'CAD', quoteCurrency: 'JPY',
      type: InstrumentType.MINOR, pipSize: 0.01,
      avgSpread: 0.015,
      activeSessions: [ForexSession.TOKYO, ForexSession.NEW_YORK],
    },
    {
      pair: 'CHF/JPY', baseCurrency: 'CHF', quoteCurrency: 'JPY',
      type: InstrumentType.MINOR, pipSize: 0.01,
      avgSpread: 0.015,
      activeSessions: [ForexSession.TOKYO, ForexSession.LONDON],
    },
    {
      pair: 'NZD/JPY', baseCurrency: 'NZD', quoteCurrency: 'JPY',
      type: InstrumentType.MINOR, pipSize: 0.01,
      avgSpread: 0.016,
      activeSessions: [ForexSession.TOKYO, ForexSession.SYDNEY],
    },
    {
      pair: 'NZD/CHF', baseCurrency: 'NZD', quoteCurrency: 'CHF',
      type: InstrumentType.MINOR, pipSize: 0.0001,
      avgSpread: 0.00020,
      activeSessions: [ForexSession.SYDNEY, ForexSession.LONDON],
    },
    {
      pair: 'NZD/CAD', baseCurrency: 'NZD', quoteCurrency: 'CAD',
      type: InstrumentType.MINOR, pipSize: 0.0001,
      avgSpread: 0.00022,
      activeSessions: [ForexSession.SYDNEY, ForexSession.NEW_YORK],
    },

    // ── EXOTIC ───────────────────────────────────────────
    {
      pair: 'USD/SGD', baseCurrency: 'USD', quoteCurrency: 'SGD',
      type: InstrumentType.EXOTIC, pipSize: 0.0001,
      avgSpread: 0.00035,
      activeSessions: [ForexSession.TOKYO],
    },

    // ── METALS ───────────────────────────────────────────
    // XAU/USD: 1 lot = 100 oz, pip 0.01 (quoted to 3 decimals). avg_spread is the
    // median spread of Dukascopy's 2022 traded minutes (0.368; p25 0.328, p75
    // 0.414). Leverage capped at 1:20, the ESMA retail limit for gold.
    {
      pair: 'XAU/USD', baseCurrency: 'XAU', quoteCurrency: 'USD',
      type: InstrumentType.METAL, pipSize: 0.01, pipDecimalPlaces: 2,
      lotSize: 100, minLot: 0.01, maxLot: 100,
      avgSpread: 0.368, maxLeverage: 20,
      activeSessions: [ForexSession.LONDON, ForexSession.NEW_YORK],
    },
  ];

  const result = await dataSource
    .createQueryBuilder()
    .insert()
    .into(InstrumentEntity)
    .values(instruments)
    .orIgnore()
    .returning(['pair'])
    .execute();

  const inserted = (result.raw as { pair: string }[]).map(r => r.pair);
  console.log(
    inserted.length
      ? `✅ Inserted ${inserted.length} instrument(s): ${inserted.join(', ')}`
      : `⏭  All ${instruments.length} instruments already present.`,
  );
};