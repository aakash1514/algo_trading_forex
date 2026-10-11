import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InstrumentEntity } from '@forexedge/database';
import { isSpreadWide, spreadRatio } from '@forexedge/common';
import {
  KafkaProducerService, KafkaConsumerService, TickMessage, parseTickMessage,
  SPREAD_ALERTS_TOPIC, SpreadAlertMessage, SpreadStatus,
} from '@forexedge/kafka';

export interface SpreadStatusResult {
  pair: string;
  instrument: string;
  currentSpread: number;
  avgSpread: number;
  status: SpreadStatus;
  ratio: number;
}

@Injectable()
export class SpreadMonitorService implements OnModuleInit {
  private readonly logger = new Logger(SpreadMonitorService.name);
  private spreadCache = new Map<string, SpreadStatusResult>();

  constructor(
    @InjectRepository(InstrumentEntity)
    private readonly instrumentRepo: Repository<InstrumentEntity>,
    private readonly kafkaProducer: KafkaProducerService,
    private readonly kafkaConsumer: KafkaConsumerService,
  ) {}

  async onModuleInit() {
    await this.kafkaConsumer.subscribe(
      'domain-service-spread-monitor',
      ['forex.ticks'],
      async (_topic: string, _partition: number, message: string) => {
        await this.handleTick(message);
      },
    );
    this.logger.log('SpreadMonitorService subscribed to forex.ticks');
  }

  getSpreadStatus(instrument: string): SpreadStatusResult | null {
    return this.spreadCache.get(instrument) ?? null;
  }

  private async handleTick(rawMessage: string) {
    let tick: TickMessage;
    try {
      tick = parseTickMessage(rawMessage);
    } catch (err) {
      this.logger.warn(`Ignoring forex.ticks message: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const { instrument, pair, bid, ask, timestamp } = tick;
    if (!bid || !ask) return;

    const currentSpread = ask - bid;

    const dbInstrument = await this.instrumentRepo.findOne({
      where: { pair },
    });
    if (!dbInstrument) return;

    const avgSpread = Number(dbInstrument.avgSpread);
    if (!(avgSpread > 0)) {
      this.logger.warn(`No average spread configured for ${pair}; spread status unknown`);
      return;
    }
    const ratio = spreadRatio(bid, ask, avgSpread);
    const status: SpreadStatus = isSpreadWide(ratio) ? 'WIDE' : 'NORMAL';

    const result: SpreadStatusResult = {
      pair,
      instrument,
      currentSpread,
      avgSpread,
      status,
      ratio,
    };

    const previous = this.spreadCache.get(instrument);
    this.spreadCache.set(instrument, result);

    if (!previous || previous.status !== status) {
      await this.publishAlert(result, new Date(timestamp).toISOString());
    }
  }

  private async publishAlert(result: SpreadStatusResult, timestamp: string) {
    const alert: SpreadAlertMessage = {
      type: result.status,
      instrument: result.instrument,
      pair: result.pair,
      currentSpread: result.currentSpread,
      avgSpread: result.avgSpread,
      ratio: result.ratio,
      timestamp,
    };

    await this.kafkaProducer.publish(
      SPREAD_ALERTS_TOPIC,
      result.instrument,
      alert,
    ).catch((err: Error) => this.logger.error(`Failed to publish spread alert: ${err.message}`));

    this.logger.warn(
      `SPREAD ${result.status}: ${result.pair} ratio=${result.ratio}x avg`,
    );
  }
}