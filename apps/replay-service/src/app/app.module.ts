import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { HealthModule, sqlCheck } from '@forexedge/common';
import { ReplayPositionEntity, ReplaySessionEntity } from '@forexedge/database';
import { AuthModule } from '../auth/auth.module';
import { SessionLock } from '../engine/session-lock';
import { PairContextService } from '../history/pair-context.service';
import { ReplayOrderController } from '../orders/order.controller';
import { ReplayOrderService } from '../orders/order.service';
import { PlaybackService } from '../playback/playback.service';
import { ReplayEmitter } from '../playback/replay-emitter';
import { ReplayGateway } from '../playback/replay.gateway';
import { ReplayStateService } from '../playback/replay-state.service';
import { ReplaySessionController } from '../session/session.controller';
import { ReplaySessionService } from '../session/session.service';
import { ReplayTradesService } from '../session/trades.service';
import { replayDbCredentials } from './replay-db.config';

// Bar replay over the imported history. No Kafka and no Redis: replay prices never
// leave this service except to the session owner's socket.
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        host: config.get<string>('DB_HOST', 'localhost'),
        port: config.get<number>('DB_PORT', 15432),
        ...replayDbCredentials({
          REPLAY_DB_USER: config.get<string>('REPLAY_DB_USER'),
          REPLAY_DB_PASS: config.get<string>('REPLAY_DB_PASS'),
          DB_USER: config.get<string>('DB_USER'),
        }),
        database: config.get<string>('DB_NAME', 'forexedge_db'),
        entities: [ReplaySessionEntity, ReplayPositionEntity],
        synchronize: false,
        ssl: config.get<string>('DB_SSL') === 'true'
          ? { rejectUnauthorized: false }
          : false,
      }),
      inject: [ConfigService],
    }),
    TypeOrmModule.forFeature([ReplaySessionEntity, ReplayPositionEntity]),
    AuthModule,
    JwtModule.register({}), // socket handshakes; the secret is passed on verify
    HealthModule.forRoot({ inject: [DataSource], useFactory: (db: DataSource) => ({ db: sqlCheck(db) }) }),
  ],
  controllers: [ReplaySessionController, ReplayOrderController],
  providers: [
    ReplaySessionService, PairContextService, SessionLock,
    PlaybackService, ReplayStateService, ReplayEmitter, ReplayGateway, ReplayOrderService, ReplayTradesService,
  ],
})
export class AppModule {}
