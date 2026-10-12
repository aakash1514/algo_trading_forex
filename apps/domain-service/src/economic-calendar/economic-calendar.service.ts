import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThanOrEqual } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
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

interface ParsedEvent {
  title: string;
  currency: string;
  impact: ImpactLevel;
  scheduledAt: Date;
  forecast: string | null;
  previous: string | null;
}

@Injectable()
export class EconomicCalendarService {
  private readonly logger = new Logger(EconomicCalendarService.name);
  private readonly FOREXFACTORY_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
  private readonly APPROACHING_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

  constructor(
    @InjectRepository(EconomicEventEntity)
    private readonly eventRepo: Repository<EconomicEventEntity>,
    private readonly httpService: HttpService,
    private readonly kafkaProducer: KafkaProducerService,
  ) {}

  // Fetch and store calendar every 6 hours
  @Cron('0 */6 * * *', { timeZone: 'UTC' })
  async fetchCalendar() {
    this.logger.log('Fetching economic calendar...');
    try {
      const events = await this.scrapeForexFactory();
      let saved = 0;

      for (const event of events) {
        if (event.impact !== ImpactLevel.HIGH) continue; // only store HIGH impact

        const exists = await this.eventRepo.findOne({
          where: {
            title: event.title,
            currency: event.currency,
            scheduledAt: event.scheduledAt,
          },
        });

        if (!exists) {
          await this.eventRepo.save(this.eventRepo.create(event));
          saved++;
        }
      }

      this.logger.log(`Calendar sync complete. ${saved} new HIGH impact events saved.`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to fetch calendar: ${message}`);
    }
  }

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

  private async scrapeForexFactory(): Promise<ParsedEvent[]> {
    // ForexFactory provides a public JSON endpoint (no scraping needed)
    const response = await firstValueFrom(
        this.httpService.get<ForexFactoryEvent[]>(this.FOREXFACTORY_URL, {
         responseType: 'json',
         }),
    );

    const data = response.data as ForexFactoryEvent[];

    return data
      .filter(e => e.impact === 'High')
      .map(e => ({
        title:       e.title,
        currency:    e.country,
        impact:      ImpactLevel.HIGH,
        scheduledAt: new Date(e.date),
        forecast:    e.forecast   || null,
        previous:    e.previous   || null,
      }));
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

// ForexFactory JSON shape
interface ForexFactoryEvent {
  title:    string;
  country:  string;
  date:     string;
  impact:   'High' | 'Medium' | 'Low' | 'Holiday';
  forecast: string;
  previous: string;
}