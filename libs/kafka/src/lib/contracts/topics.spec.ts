import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ContractViolationError } from './contract';
import {
  parseAccountUpdatedMessage, parseCalendarEventMessage, parseOrderLifecycleMessage, parsePositionsUpdatedMessage,
  parseSessionEventMessage, parseSpreadAlertMessage, parseTickMessage,
} from './topics';

// Real messages captured from the local Kafka topics (fixtures/*.json, one per
// line as kafka-console-consumer printed them).
const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf8').trim();

// Re-serializes a fixture without one field, to prove the parser catches it.
const without = (raw: string, field: string) => {
  const o = JSON.parse(raw);
  delete o[field];
  return JSON.stringify(o);
};

describe('Kafka contracts parse real captured messages', () => {
  it('forex.ticks', () => {
    const raw = fixture('forex.ticks.json');
    expect(parseTickMessage(raw)).toMatchObject({ pair: 'XAU/USD', instrument: 'XAU_USD', source: 'MOCK' });
    expect(() => parseTickMessage(without(raw, 'mid'))).toThrow('missing "mid"');
  });

  it('forex.sessions', () => {
    const raw = fixture('forex.sessions.open.json');
    expect(parseSessionEventMessage(raw)).toMatchObject({ type: 'SESSION_OPEN', session: 'LONDON' });
    // The field order-service used to read never existed on this topic
    expect(JSON.parse(raw)).not.toHaveProperty('status');
    expect(() => parseSessionEventMessage(without(raw, 'type'))).toThrow('missing "type"');
  });

  // NORMAL was captured from the current producer. WIDE comes from the producer
  // before e889af3 (ratio exactly 2 counted as WIDE then): the mock feed never
  // exceeds 2x now, and the message shape is unchanged.
  it('forex.spread-alerts (WIDE and NORMAL)', () => {
    for (const name of ['forex.spread-alerts.wide.json', 'forex.spread-alerts.normal.json']) {
      const raw = fixture(name);
      expect(parseSpreadAlertMessage(raw).avgSpread).toBeGreaterThan(0);
      // The field order-service used to read never existed on this topic
      expect(JSON.parse(raw)).not.toHaveProperty('spreadPips');
    }
  });

  it('orders.lifecycle', () => {
    const raw = fixture('orders.lifecycle.json');
    expect(parseOrderLifecycleMessage(raw)).toMatchObject({ status: 'OPEN' });
    expect(() => parseOrderLifecycleMessage(without(raw, 'userId'))).toThrow(ContractViolationError);
  });

  it('positions.updated (PNL and SNAPSHOT)', () => {
    expect(parsePositionsUpdatedMessage(fixture('positions.updated.pnl.json'))).toMatchObject({ type: 'PNL' });
    const snapshot = parsePositionsUpdatedMessage(fixture('positions.updated.snapshot.json'));
    expect(snapshot.type).toBe('SNAPSHOT');
    const broken = JSON.parse(fixture('positions.updated.snapshot.json'));
    delete broken.positions[0].openPrice;
    expect(() => parsePositionsUpdatedMessage(JSON.stringify(broken))).toThrow('missing "positions[0].openPrice"');
  });

  it('accounts.updated', () => {
    const raw = fixture('accounts.updated.json');
    expect(parseAccountUpdatedMessage(raw).summary.balance).toEqual(expect.any(Number));
    const broken = JSON.parse(raw);
    broken.summary.equity = 'n/a';
    expect(() => parseAccountUpdatedMessage(JSON.stringify(broken))).toThrow('"summary.equity" expected a finite number');
  });

  it('forex.calendar-events: no message has ever been published, so the shape comes from the producer code', () => {
    // Built exactly like EconomicCalendarService.publishCalendarEvent builds it
    // (scheduledAt is a Date there, so JSON carries an ISO string).
    const raw = JSON.stringify({
      type: 'CALENDAR_EVENT_APPROACHING', title: 'Non-Farm Employment Change', currency: 'USD', impact: 'HIGH',
      scheduledAt: new Date('2026-10-02T12:30:00Z'), timestamp: '2026-10-02T12:15:00.000Z',
    });
    expect(parseCalendarEventMessage(raw)).toMatchObject({ currency: 'USD', impact: 'HIGH' });
  });

  it('rejects non-JSON and non-object payloads', () => {
    expect(() => parseTickMessage('{oops')).toThrow('not valid JSON');
    expect(() => parseTickMessage('[]')).toThrow('expected a JSON object');
  });
});
