import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import {
  ForexSession,
  SessionEventType,
  CurrentSessionsResult,
} from './interfaces/session.interfaces';
import { activeSessions } from '@forexedge/common';
import { FOREX_SESSIONS_TOPIC, KafkaProducerService, type SessionEventMessage } from '@forexedge/kafka';

const ALL_SESSIONS = [ForexSession.SYDNEY, ForexSession.TOKYO, ForexSession.LONDON, ForexSession.NEW_YORK];

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

  // Sessions come from the shared clock (@forexedge/common market-hours), the
  // same function order-service stamps orders with; none while FX is closed.
  getCurrentSessions(now: Date = new Date()): CurrentSessionsResult {
    const active = activeSessions(now) as ForexSession[];
    const inactive = ALL_SESSIONS.filter((s) => !active.includes(s));
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
    active: ForexSession[],
    now: Date,
  ) {
    const event: SessionEventMessage = {
      type,
      session,
      timestamp: now.toISOString(),
      activeSessions: active,
    };

    this.kafkaProducer.publish(FOREX_SESSIONS_TOPIC, session, event)
      .catch(err => this.logger.error(`Failed to publish session event: ${err.message}`));
  }
}