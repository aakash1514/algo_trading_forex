import { assertTestDatabaseName } from './test-database';

describe('test database guard', () => {
  it.each(['forexedge_test', 'ci_test'])('accepts %s', (name) => {
    expect(() => assertTestDatabaseName(name)).not.toThrow();
  });

  it.each(['forexedge', 'forexedge_test_copy', 'test', 'forexedge-test', ''])('refuses %j', (name) => {
    expect(() => assertTestDatabaseName(name)).toThrow(`Refusing to use database "${name}" for tests`);
  });
});
