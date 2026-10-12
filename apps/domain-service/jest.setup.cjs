// The default test suite never reaches the network: the economic calendar's tests use recorded pages
// (src/economic-calendar/__fixtures__). Any real request fails the test that makes it.
// Re-recording the fixtures is opt-in: tools/ops/record-calendar-fixtures.ts.
globalThis.fetch = async (input) => {
  throw new Error(`Network access is disabled in domain-service tests (attempted: ${String(input)})`);
};
