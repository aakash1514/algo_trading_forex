// jsdom has no fetch. Component tests that go through RTK Query's real fetchBaseQuery use this
// environment: jsdom plus Node's own fetch classes (the signal must be Node's AbortSignal, or
// Node's Request rejects it). Tests still mock fetch itself; nothing reaches the network.
const { TestEnvironment } = require('jest-environment-jsdom');

class JsdomWithFetch extends TestEnvironment {
  constructor(config, context) {
    super(config, context);
    Object.assign(this.global, {
      fetch, Request, Response, Headers, AbortController, AbortSignal, DOMException,
      TextEncoder, TextDecoder, ReadableStream, structuredClone,
    });
  }
}

module.exports = JsdomWithFetch;
