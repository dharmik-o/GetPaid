import { promises as dns } from "node:dns";
import https from "node:https";
import { BlockList, isIP } from "node:net";

// Server-only: the ONLY way the app fetches a calendar address the user typed in (plan rule 7). The
// address is the user's, but this server calls it, so it must never be turned into a way to reach
// things only the server can reach (the database, n8n, a cloud metadata service). Every request:
//   - is https only, to port 443, with no user name or password in the address;
//   - has its host resolved here, refused if ANY answer is a private, loopback, link-local, carrier-
//     grade NAT, unspecified, multicast, reserved or metadata address, and connects to the very
//     address it checked, so a second DNS answer can't swap it;
//   - follows at most 3 redirects, repeating every check on each one;
//   - stops after 10 seconds in total and 5 MB of body, and must look like iCalendar.
// It returns a reason code only. The address is never logged and never part of an error.

export type FetchFailure =
  "blocked_address" | "timeout" | "too_large" | "not_ics" | "http_error" | "unreachable";

export type SafeFetchResult = { ok: true; text: string } | { ok: false; reason: FetchFailure };

export type SafeFetchOptions = { maxBytes?: number; timeoutMs?: number; maxRedirects?: number };

type Resolved = { address: string; family: 4 | 6 };

export type TransportResponse = {
  status: number;
  location: string | null;
  body: AsyncIterable<Uint8Array>;
  close: () => void;
};

/** Makes one https request to an address that was already checked. Replaceable in tests. */
export type Transport = (request: {
  url: URL;
  address: Resolved;
  signal: AbortSignal;
}) => Promise<TransportResponse>;

export type SafeFetchDeps = {
  resolve?: (hostname: string) => Promise<Resolved[]>;
  transport?: Transport;
};

const DEFAULTS = { maxBytes: 5 * 1024 * 1024, timeoutMs: 10_000, maxRedirects: 3 };

const BLOCKED = new BlockList();
for (const [network, bits] of [
  ["0.0.0.0", 8], // "this network", includes the unspecified address
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT (also Alibaba's metadata address)
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, includes the cloud metadata address 169.254.169.254
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, includes the broadcast address
] as const) {
  BLOCKED.addSubnet(network, bits, "ipv4");
}
for (const [network, bits] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["fc00::", 7], // unique local, includes AWS's fd00:ec2::254
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
  ["64:ff9b::", 96], // NAT64: would reach any IPv4 address, checked or not
  ["2001:db8::", 32], // documentation
] as const) {
  BLOCKED.addSubnet(network, bits, "ipv6");
}

/** IPv4-mapped IPv6 addresses (::ffff:10.0.0.5) are checked against the IPv4 list by Node. */
export const isBlockedAddress = (address: string): boolean => {
  const family = isIP(address);
  return family === 0 ? true : BLOCKED.check(address, family === 4 ? "ipv4" : "ipv6");
};

/** Names that only ever mean "this machine or this network", whatever DNS says. */
const isBlockedName = (hostname: string): boolean =>
  hostname === "localhost" ||
  hostname.endsWith(".localhost") ||
  hostname.endsWith(".local") ||
  hostname.endsWith(".internal") ||
  !hostname.includes(".");

const defaultResolve = async (hostname: string): Promise<Resolved[]> =>
  (await dns.lookup(hostname, { all: true })).map((entry) => ({
    address: entry.address,
    family: entry.family === 6 ? 6 : 4,
  }));

/** The real request: https to the checked address, with the host name kept for the certificate. */
const httpsTransport: Transport = ({ url, address, signal }) =>
  new Promise((resolve, reject) => {
    const request = https.request(
      {
        protocol: "https:",
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: {
          accept: "text/calendar, text/plain;q=0.9, */*;q=0.1",
          "user-agent": "GetPaid-calendar-sync",
        },
        signal,
        // Connect to the address that passed the check, never to a second lookup.
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [{ address: address.address, family: address.family }]);
          else callback(null, address.address, address.family);
        },
      },
      (response) => {
        const location = response.headers.location;
        resolve({
          status: response.statusCode ?? 0,
          location: typeof location === "string" ? location : null,
          body: response,
          close: () => {
            response.destroy();
          },
        });
      },
    );
    request.on("error", reject);
    request.end();
  });

/** The text must start like an iCalendar file (a byte order mark and blank space are fine). */
export const looksLikeIcs = (text: string): boolean =>
  /^\uFEFF?\s*BEGIN:VCALENDAR/i.test(text.slice(0, 64));

const readLimited = async (
  body: AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<Buffer | "too_large"> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > maxBytes) return "too_large";
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
};

const isAbort = (error: unknown): boolean =>
  error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");

/** Parses and checks one address; returns the reason it can't be used, or the URL. */
const checkUrl = (raw: string): URL | "blocked_address" => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "blocked_address";
  }
  const plainHttps =
    url.protocol === "https:" &&
    (url.port === "" || url.port === "443") &&
    !url.username &&
    !url.password;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!plainHttps || (isIP(host) === 0 && isBlockedName(host))) return "blocked_address";
  return url;
};

export const safeFetchText = async (
  address: string,
  options: SafeFetchOptions = {},
  deps: SafeFetchDeps = {},
): Promise<SafeFetchResult> => {
  const { maxBytes, timeoutMs, maxRedirects } = { ...DEFAULTS, ...options };
  const resolve = deps.resolve ?? defaultResolve;
  const transport = deps.transport ?? httpsTransport;
  // One clock for the whole call: DNS, every redirect and the body share the same 10 seconds.
  const signal = AbortSignal.timeout(timeoutMs);
  const aborted = new Promise<never>((_resolve, reject) => {
    signal.addEventListener("abort", () => {
      reject(signal.reason as Error);
    });
  });
  aborted.catch(() => undefined);
  try {
    let next = address;
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const url = checkUrl(next);
      if (url === "blocked_address") return { ok: false, reason: "blocked_address" };
      const host = url.hostname.replace(/^\[|\]$/g, "");
      const family = isIP(host);
      const answers: Resolved[] =
        family === 0
          ? await Promise.race([resolve(host), aborted])
          : [{ address: host, family: family === 6 ? 6 : 4 }];
      if (answers.length === 0) return { ok: false, reason: "unreachable" };
      if (answers.some((answer) => isBlockedAddress(answer.address))) {
        return { ok: false, reason: "blocked_address" };
      }
      const [chosen] = answers;
      if (!chosen) return { ok: false, reason: "unreachable" };
      const response = await Promise.race([transport({ url, address: chosen, signal }), aborted]);
      try {
        if (response.status >= 300 && response.status < 400 && response.location) {
          if (hop === maxRedirects) return { ok: false, reason: "http_error" };
          try {
            next = new URL(response.location, url).toString();
          } catch {
            return { ok: false, reason: "http_error" };
          }
          continue;
        }
        if (response.status !== 200) return { ok: false, reason: "http_error" };
        const body = await Promise.race([readLimited(response.body, maxBytes), aborted]);
        if (body === "too_large") return { ok: false, reason: "too_large" };
        const text = body.toString("utf8");
        return looksLikeIcs(text) ? { ok: true, text } : { ok: false, reason: "not_ics" };
      } finally {
        response.close();
      }
    }
    return { ok: false, reason: "http_error" };
  } catch (error) {
    return { ok: false, reason: isAbort(error) || signal.aborted ? "timeout" : "unreachable" };
  }
};
