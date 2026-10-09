import { FOREXEDGE_VERSION } from './common';

describe('FOREXEDGE_VERSION', () => {
  it('is a semver string', () => {
    expect(FOREXEDGE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
