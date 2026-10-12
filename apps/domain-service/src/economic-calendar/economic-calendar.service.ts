import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { CALENDAR_EVENTS_TOPIC, KafkaProducerService, type CalendarEventMessage } from '@forexedge/kafka';
import { EconomicEventEntity } from '@forexedge/database';

export enum CalendarEventType {
  APPROACHING = 'CALENDAR_EVENT_APPROACHING',
  ACTIVE      = 'CALENDAR_EVENT_ACTIVE',
  PASSED      = 'CALENDAR_EVENT_PASSED',
}

export enum ImpactLevel {
  HIGH   = 'HIGH',
  MEDIUM = 'MEDIUM',
  LOW    = 'LOW',
}

// Reads the economic calendar (filled from the official calendars by OfficialCalendarService) and
// publishes forex.calendar-events when a timed event approaches.
@Injectable()
export class EconomicCalendarService {
  private readonly logger = new Logger(EconomicCalendarService.name);
  private readonly APPROACHING_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

  constructor(
    @InjectRepository(EconomicEventEntity)
    private readonly eventRepo: Repository<EconomicEventEntity>,
    private readonly kafkaProducer: KafkaProducerService,
  ) {}

  // Check every minute if any event is approaching
  @Cron('* * * * *', { timeZone: 'UTC' })
  async checkApproachingEvents() {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + this.APPROACHING_WINDOW_MS);

  const upcoming = await this.eventRepo
    .createQueryBuilder('event')
    .where('event.scheduled_at > :now', { now })
    .andWhere('event.scheduled_at <= :windowEnd', { windowEnd })
    .andWhere('event.actual IS NULL')
    .andWhere('NOT event.all_day') // date-only events have no time to approach
    .getMany();

  for (const event of upcoming) {
    await this.publishCalendarEvent(CalendarEventType.APPROACHING, event, now);
  }
}

  async getUpcomingEvents(
    currency?: string,
    from?: Date,
    impact?: ImpactLevel,
  ): Promise<EconomicEventEntity[]> {
    // An all-day event (stored at 00:00 UTC of its date) stays listed for the whole of its day
    const start = from ?? new Date();
    const startOfDay = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
    const qb = this.eventRepo
      .createQueryBuilder('event')
      .where('(event.scheduled_at >= :from OR (event.all_day AND event.scheduled_at >= :startOfDay))', { from: start, startOfDay })
      .orderBy('event.scheduled_at', 'ASC');

    if (currency) qb.andWhere('event.currency = :currency', { currency });
    if (impact)   qb.andWhere('event.impact = :impact', { impact });

    return qb.getMany();
  }

  async hasActiveEvent(currency: string): Promise<boolean> {
    const now = new Date();
    const windowStart = new Date(now.getTime() - this.APPROACHING_WINDOW_MS);

    const active = await this.eventRepo
      .createQueryBuilder('event')
      .where('event.currency = :currency', { currency })
      .andWhere('event.scheduled_at >= :windowStart', { windowStart })
      .andWhere('event.scheduled_at <= :now', { now })
      .andWhere('event.impact = :impact', { impact: ImpactLevel.HIGH })
      .andWhere('NOT event.all_day')
      .getOne();

    return !!active;
  }

  private async publishCalendarEvent(
    type: CalendarEventType,
    event: EconomicEventEntity,
    now: Date,
  ) {
    // economic_events.impact is free text in the DB; the contract allows three levels
    const impact = event.impact as CalendarEventMessage['impact'];
    if (!['HIGH', 'MEDIUM', 'LOW'].includes(impact)) {
      this.logger.warn(`Not publishing "${event.title}": unknown impact "${event.impact}"`);
      return;
    }
    const payload: CalendarEventMessage = {
      type,
      title:       event.title,
      currency:    event.currency,
      impact,
      scheduledAt: new Date(event.scheduledAt).toISOString(),
      timestamp:   now.toISOString(),
    };

    await this.kafkaProducer.publish(
      CALENDAR_EVENTS_TOPIC,
      event.currency,
      payload,
    ).catch((err: Error) =>
      this.logger.error(`Failed to publish calendar event: ${err.message}`)
    );

    this.logger.log(`${type}: ${event.title} (${event.currency}) at ${event.scheduledAt}`);
  }
}
