import { DataSource } from 'typeorm';
import {
  InstrumentEntity,
  InstrumentType,
  ForexSession,
} from '@forexedge/database';

export const seedInstruments = async (dataSource: DataSource): Promise<void> => {
  const repo = dataSource.getRepository(InstrumentEntity);

  // Check if already seeded
  const count = await repo.count();
  if (count > 0) {
    console.log(`⏭  Instruments already seeded (${count} records). Skipping.`);
    return;
  }

  const instruments = [
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
  ];

  const entities = instruments.map(i => repo.create(i));
  await repo.save(entities);
  console.log(`✅ Seeded ${entities.length} forex instruments successfully.`);
};