import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { KafkaProducerService } from '@forexedge/kafka';
import {
  ForexSession,
  SessionEventType,
  SessionWindow,
  CurrentSessionsResult,
  SessionKafkaEvent,
} from './interfaces/session.interfaces';
import { toZonedTime } from 'date-fns-tz';

// Base UTC session hours (non-DST / standard time)
const SESSION_WINDOWS: SessionWindow[] = [
  { session: ForexSession.SYDNEY,   openUtcHour: 21, closeUtcHour: 6  },
  { session: ForexSession.TOKYO,    openUtcHour: 0,  closeUtcHour: 9  },
  { session: ForexSession.LONDON,   openUtcHour: 8,  closeUtcHour: 16 },
  { session: ForexSession.NEW_YORK, openUtcHour: 13, closeUtcHour: 22 },
];

@Injectable()
export class SessionClockService implements OnModuleInit {
  private readonly logger = new Logger(SessionClockService.name);
  private previousActiveSessions: Set<ForexSession> = new Set();

  constructor(private readonly kafkaProducer: KafkaProducerService) {}

  onModuleInit() {
    // Run immediately on startup so state is populated before first interval
    this.checkSessions();
  }

  // Runs every 60 seconds
  @Interval(60_000)
  handleInterval() {
    this.checkSessions();
  }

  getCurrentSessions(now: Date = new Date()): CurrentSessionsResult {
    const active: ForexSession[] = [];
    const inactive: ForexSession[] = [];

    const utcHour = now.getUTCHours();
    const utcMinute = now.getUTCMinutes();
    const fractionalHour = utcHour + utcMinute / 60;

    const windows = this.getDstAdjustedWindows(now);

    for (const window of windows) {
      const isActive = this.isInWindow(fractionalHour, window.openUtcHour, window.closeUtcHour);
      if (isActive) {
        active.push(window.session);
      } else {
        inactive.push(window.session);
      }
    }

    return { active, inactive, timestamp: now.toISOString() };
  }

  private checkSessions() {
    const now = new Date();
    const { active } = this.getCurrentSessions(now);
    const currentActive = new Set(active);

    // Detect opens — sessions in current but not in previous
    for (const session of currentActive) {
      if (!this.previousActiveSessions.has(session)) {
        this.publishSessionEvent(SessionEventType.SESSION_OPEN, session, active, now);
        this.logger.log(`Session OPEN: ${session}`);
      }
    }

    // Detect closes — sessions in previous but not in current
    for (const session of this.previousActiveSessions) {
      if (!currentActive.has(session)) {
        this.publishSessionEvent(SessionEventType.SESSION_CLOSE, session, active, now);
        this.logger.log(`Session CLOSE: ${session}`);
      }
    }

    this.previousActiveSessions = currentActive;
  }

  private publishSessionEvent(
    type: SessionEventType,
    session: ForexSession,
    activeSessions: ForexSession[],
    now: Date,
  ) {
    const event: SessionKafkaEvent = {
      type,
      session,
      timestamp: now.toISOString(),
      activeSessions,
    };

    this.kafkaProducer.publish('forex.sessions', session, event)
      .catch(err => this.logger.error(`Failed to publish session event: ${err.message}`));
  }

  // DST adjustments:
  // London (Europe/London): UTC+1 in summer → open 07:00, close 15:00 UTC
  // New York (America/New_York): UTC-4 in summer → open 12:00, close 21:00 UTC
  private getDstAdjustedWindows(now: Date): SessionWindow[] {
    const windows = SESSION_WINDOWS.map(w => ({ ...w }));

    const londonTime = toZonedTime(now, 'Europe/London');
    const londonOffset = londonTime.getHours() - now.getUTCHours();
    if (londonOffset === 1) {
      // BST — London is UTC+1
      const london = windows.find(w => w.session === ForexSession.LONDON)!;
      london.openUtcHour = 7;
      london.closeUtcHour = 15;
    }

    const nyTime = toZonedTime(now, 'America/New_York');
    const nyOffset = nyTime.getHours() - now.getUTCHours();
    if (nyOffset === -4) {
      // EDT — New York is UTC-4
      const ny = windows.find(w => w.session === ForexSession.NEW_YORK)!;
      ny.openUtcHour = 12;
      ny.closeUtcHour = 21;
    }

    return windows;
  }

  // Handles windows that cross midnight (e.g. Sydney 21:00–06:00)
  private isInWindow(fractionalHour: number, open: number, close: number): boolean {
    if (open < close) {
      return fractionalHour >= open && fractionalHour < close;
    }
    // Crosses midnight
    return fractionalHour >= open || fractionalHour < close;
  }
}