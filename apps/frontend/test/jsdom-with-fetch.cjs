// jsdom has no fetch. Component tests that go through RTK Query's real fetchBaseQuery use this
// environment: jsdom plus Node's own fetch classes (the signal must be Node's AbortSignal, or
// Node's Request rejects it). Tests still mock fetch itself; nothing reaches the network.
const { TestEnvironment } = require('jest-environment-jsdom');

// The app calls its APIs by path (/api/...), which a browser resolves against the page. Node's Request
// has no page, so this one resolves a relative URL against jsdom's location, as a browser would.
function pageRequest(global) {
  return class PageRequest extends Request {
    constructor(input, init) {
      super(typeof input === 'string' ? new URL(input, global.location.href).href : input, init);
    }
  };
}

class JsdomWithFetch extends TestEnvironment {
  constructor(config, context) {
    super(config, context);
    Object.assign(this.global, {
      fetch, Request: pageRequest(this.global), Response, Headers, AbortController, AbortSignal, DOMException,
      TextEncoder, TextDecoder, ReadableStream, structuredClone,
    });
  }
}

module.exports = JsdomWithFetch;
