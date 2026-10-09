import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { config } from 'process';
import * as path from 'path';
import { AuthModule } from '../auth/auth.module';
import { RedisModule } from '../redis/redis.module';
import { UserEntity, InstrumentEntity } from '@forexedge/database';


@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal:true,
      envFilePath: path.resolve(process.cwd(), '.env'),
    }),

    TypeOrmModule.forRootAsync({
      imports:[ConfigModule],
      inject:[ConfigService],
      useFactory:(config: ConfigService)=>({
        type:'postgres',
        host:config.get<string>('DB_HOST'),
        port: config.get<number>('DB_PORT'),
        username: config.get<string>('DB_USER'),
        password: config.get<string>('DB_PASS'),
        database: config.get<string>('DB_NAME'),
        entities: [UserEntity, InstrumentEntity],
        migrations: [__dirname + '/../migrations/*{.ts,.js}'],
        synchronize: false,  
        logging: config.get<string>('DB_LOGGING') === 'true',
        // ADD THIS:
        ssl: config.get<string>('DB_SSL') === 'true' 
          ? { rejectUnauthorized: false } 
          : false,
})
    }),
    RedisModule,
    AuthModule
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
