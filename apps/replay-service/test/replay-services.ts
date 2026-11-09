// The replay services wired as in AppModule, on a ReplayTestDb's replay login, with an
// emitter that records what would reach the user's sockets (after its own no-future
// check). Test code only.
import { ReplayPositionEntity, ReplaySessionEntity } from '@forexedge/database';
import { SessionLock } from '../src/engine/session-lock';
import { PairContextService } from '../src/history/pair-context.service';
import { ReplayOrderService } from '../src/orders/order.service';
import { PlaybackService } from '../src/playback/playback.service';
import { ReplayEmitter } from '../src/playback/replay-emitter';
import { ReplayStateService } from '../src/playback/replay-state.service';
import { ReplaySessionService } from '../src/session/session.service';
import { ReplayTestDb } from './replay-test-db';

export interface RecordedEvent {
  userId: string;
  event: string;
  payload: unknown;
  clock: Date;
}

export class RecordingEmitter extends ReplayEmitter {
  readonly events: RecordedEvent[] = [];
  override toUser(userId: string, event: string, payload: unknown, clock: Date): void {
    super.toUser(userId, event, payload, clock);
    this.events.push({ userId, event, payload: JSON.parse(JSON.stringify(payload)), clock });
  }
}

export interface ReplayServices {
  sessions: ReplaySessionService;
  playback: PlaybackService;
  orders: ReplayOrderService;
  state: ReplayStateService;
  emitter: RecordingEmitter;
}

export function replayServices(db: ReplayTestDb, emitter = new RecordingEmitter()): ReplayServices {
  const ds = db.replay;
  const sessionRepo = ds.getRepository(ReplaySessionEntity);
  const positionRepo = ds.getRepository(ReplayPositionEntity);
  const pairs = new PairContextService(ds);
  const lock = new SessionLock();
  const state = new ReplayStateService(positionRepo, ds, pairs);
  return {
    sessions: new ReplaySessionService(sessionRepo, ds, pairs, lock),
    playback: new PlaybackService(sessionRepo, ds, pairs, lock, emitter, state),
    orders: new ReplayOrderService(sessionRepo, positionRepo, ds, pairs, lock, state, emitter),
    state,
    emitter,
  };
}
