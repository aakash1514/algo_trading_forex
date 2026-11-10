// The real replay-service (AppModule + configureApp, as main.ts) in-process on a
// random port, connected to a ReplayTestDb as its replay login, plus a socket client
// that records every event it receives. Test code only.
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { io, Socket } from 'socket.io-client';
import { ACCESS_TOKEN_SIGN_OPTIONS } from '@forexedge/common';
import { rootEnv } from '@forexedge/database/testing';
import { AppModule } from '../src/app/app.module';
import { configureApp } from '../src/app/configure-app';
import { ReplayTestDb } from './replay-test-db';

export interface ReplayApp {
  app: INestApplication;
  url: string; // http://127.0.0.1:<port>
  close(): Promise<void>;
}

// ConfigService reads process.env before .env, so these point the real module at the test database
export async function startReplayApp(db: ReplayTestDb): Promise<ReplayApp> {
  Object.assign(process.env, {
    DB_HOST: db.testDb.connection.host, DB_PORT: String(db.testDb.connection.port), DB_NAME: db.testDb.name,
    REPLAY_DB_USER: db.login.username, REPLAY_DB_PASS: db.login.password, DB_SSL: 'false',
    JWT_ACCESS_SECRET: rootEnv()['JWT_ACCESS_SECRET'],
  });
  const app = await NestFactory.create(AppModule, { logger: false });
  configureApp(app);
  await app.listen(0, '127.0.0.1');
  const url = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  return { app, url, close: () => app.close() };
}

// An access token as auth-service issues it (same secret, sub = user id)
export function accessToken(userId: string, expiresIn: number | '15m' = '15m'): string {
  const secret = rootEnv()['JWT_ACCESS_SECRET'];
  if (!secret) throw new Error('JWT_ACCESS_SECRET is not set in .env');
  return new JwtService().sign(
    { sub: userId, email: `${userId}@example.com`, role: 'TRADER' },
    { ...ACCESS_TOKEN_SIGN_OPTIONS, secret, expiresIn },
  );
}

export async function http<T = unknown>(
  url: string, token: string, method: string, path: string, body?: unknown,
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${url}/api/replay${path}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

export interface Received {
  event: string;
  payload: unknown;
}

export interface ReplayClient {
  socket: Socket;
  events: Received[];
  state: Record<string, unknown>;   // the state sent on connect
  command<T = unknown>(name: string, body?: unknown): Promise<{ ok: boolean; result?: T; error?: string }>;
  next(event: string, timeoutMs?: number): Promise<unknown>;
  close(): Promise<void>;
}

// Connects to /replay and waits for the state the server sends on connect
export async function connectClient(url: string, token: string): Promise<ReplayClient> {
  const socket = io(`${url}/replay`, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
  const events: Received[] = [];
  socket.onAny((event: string, payload: unknown) => events.push({ event, payload }));
  const state = await new Promise<Record<string, unknown>>((resolve, reject) => {
    socket.once('state', resolve);
    socket.once('connect_error', reject);
    socket.once('disconnect', () => reject(new Error('disconnected before the state')));
  });
  return {
    socket, events, state,
    command: (name, body) => new Promise((resolve) => socket.emit(name, body ?? {}, resolve)),
    next: (event, timeoutMs = 5_000) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${event} within ${timeoutMs} ms`)), timeoutMs);
      socket.once(event, (payload: unknown) => { clearTimeout(timer); resolve(payload); });
    }),
    close: () => new Promise<void>((resolve) => {
      if (socket.disconnected) return resolve();
      socket.once('disconnect', () => resolve());
      socket.disconnect();
    }),
  };
}
