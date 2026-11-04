/* global process, URL, Request, Headers */

// Loaded into the E2E's Next server before anything else (NODE_OPTIONS). Every outbound fetch goes
// to the fake services, or is refused, so a run can't reach PayPal, Google or any AI provider,
// whatever the app's code asks for. Only the server's own local address gets through untouched.

const fakeUrl = process.env.E2E_FAKE_URL;
const realFetch = globalThis.fetch;

const LOCAL = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
/** Local, but real services on your machine: the fake stands in for them too. */
const LOCAL_SERVICE_PORTS = new Set(["11434", "4000", "5678"]);

const FAKED_HOSTS = new Set([
  "api-m.sandbox.paypal.com",
  "gmail.googleapis.com",
  "oauth2.googleapis.com",
  "api.anthropic.com",
]);

const urlOf = (input) => {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return input;
  return new URL(input.url);
};

globalThis.fetch = async (input, init) => {
  const url = urlOf(input);
  const isLocal = LOCAL.has(url.hostname);
  if (isLocal && !LOCAL_SERVICE_PORTS.has(url.port)) return realFetch(input, init);
  if (!isLocal && !FAKED_HOSTS.has(url.hostname)) {
    throw new TypeError(`E2E: refused a call to ${url.hostname}. Add it to the fake services.`);
  }
  const request = new Request(input, init);
  const body = ["GET", "HEAD"].includes(request.method) ? undefined : await request.text();
  const headers = new Headers(request.headers);
  headers.set("x-e2e-original-url", url.href);
  return realFetch(`${fakeUrl}/__fake`, { method: request.method, headers, body });
};
