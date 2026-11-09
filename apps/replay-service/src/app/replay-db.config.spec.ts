import { replayDbCredentials } from './replay-db.config';

describe('replay-service DB login', () => {
  it('uses REPLAY_DB_USER / REPLAY_DB_PASS', () => {
    expect(replayDbCredentials({ REPLAY_DB_USER: 'forexedge_replay', REPLAY_DB_PASS: 'x'.repeat(20), DB_USER: 'forexedge' }))
      .toEqual({ username: 'forexedge_replay', password: 'x'.repeat(20) });
  });

  it.each([{}, { REPLAY_DB_USER: 'forexedge_replay' }, { REPLAY_DB_PASS: 'secret' }])('refuses to start without both (%p)', (env) => {
    expect(() => replayDbCredentials(env)).toThrow('set REPLAY_DB_USER and REPLAY_DB_PASS');
  });

  it('refuses the main DB user', () => {
    expect(() => replayDbCredentials({ REPLAY_DB_USER: 'forexedge', REPLAY_DB_PASS: 'secret', DB_USER: 'forexedge' }))
      .toThrow('must differ from DB_USER');
  });
});
