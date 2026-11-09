import { Readable } from "node:stream";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { isBlockedAddress, safeFetchText, type Transport } from "@/lib/safe-fetch";

// A-S3: the guarded fetch. Calendar addresses are typed in by users but called by this server, so
// anything that could reach a private network, or run long, is refused. DNS is faked; web servers are
// msw, so no real network is used. A refusal is checked to have made no request at all.

const PUBLIC = [{ address: "93.184.216.34", family: 4 as const }];
const ICS = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n";
const requests: string[] = [];
const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" });
});
afterEach(() => {
  server.resetHandlers();
  requests.length = 0;
});
afterAll(() => {
  server.close();
});

const feed = (url: string, respond: () => Response): void => {
  server.use(
    http.get(url, () => {
      requests.push(url);
      return respond();
    }),
  );
};

const resolvesTo = (answers: { address: string; family: 4 | 6 }[]) =>
  vi.fn(() => Promise.resolve(answers));

describe("refused before any request", () => {
  it.each([
    ["plain http", "http://calendar.example.test/a.ics"],
    ["loopback address", "https://127.0.0.1/a.ics"],
    ["localhost", "https://localhost/a.ics"],
    ["a name under .localhost", "https://calendar.localhost/a.ics"],
    ["cloud metadata address", "https://169.254.169.254/latest/meta-data/"],
    ["private address", "https://10.0.0.5/a.ics"],
    ["private address in the 172.16 range", "https://172.31.0.9/a.ics"],
    ["private address in the 192.168 range", "https://192.168.1.1/a.ics"],
    ["carrier-grade NAT address", "https://100.64.0.1/a.ics"],
    ["IPv6 loopback", "https://[::1]/a.ics"],
    ["IPv6 unique local (the AWS metadata range)", "https://[fd00:ec2::254]/a.ics"],
    ["IPv4 hidden in IPv6", "https://[::ffff:10.0.0.5]/a.ics"],
    ["IPv4 written as one number", "https://2130706433/a.ics"],
    ["a name with no dot", "https://intranet/a.ics"],
    ["a user name and password", "https://user:secret@calendar.example.test/a.ics"],
    ["another port", "https://calendar.example.test:8443/a.ics"],
  ])("%s", async (_label, address) => {
    const resolve = resolvesTo(PUBLIC);
    const transport = vi.fn<Transport>();
    expect(await safeFetchText(address, {}, { resolve, transport })).toEqual({
      ok: false,
      reason: "blocked_address",
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it("refuses a host that resolves to a private address", async () => {
    const transport = vi.fn<Transport>();
    const result = await safeFetchText(
      "https://calendar.example.test/a.ics",
      {},
      { resolve: resolvesTo([{ address: "10.1.2.3", family: 4 }]), transport },
    );
    expect(result).toEqual({ ok: false, reason: "blocked_address" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("refuses when any one of several answers is private", async () => {
    const transport = vi.fn<Transport>();
    const result = await safeFetchText(
      "https://calendar.example.test/a.ics",
      {},
      { resolve: resolvesTo([...PUBLIC, { address: "fe80::1", family: 6 }]), transport },
    );
    expect(result).toEqual({ ok: false, reason: "blocked_address" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("knows the ranges", () => {
    for (const address of [
      "0.0.0.0",
      "127.0.0.1",
      "224.0.0.1",
      "255.255.255.255",
      "::",
      "ff02::1",
      "64:ff9b::a00:1",
    ]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
    for (const address of ["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111"]) {
      expect(isBlockedAddress(address), address).toBe(false);
    }
  });
});

describe("redirects", () => {
  it("refuses a redirect from a public host to a private address, and never requests it", async () => {
    feed(
      "https://calendar.example.test/a.ics",
      () =>
        new HttpResponse(null, {
          status: 302,
          headers: { location: "https://10.0.0.5/secret.ics" },
        }),
    );
    const result = await safeFetchText(
      "https://calendar.example.test/a.ics",
      {},
      { resolve: resolvesTo(PUBLIC) },
    );
    expect(result).toEqual({ ok: false, reason: "blocked_address" });
    expect(requests).toEqual(["https://calendar.example.test/a.ics"]);
  });

  it("checks a redirect's host name by DNS too", async () => {
    feed(
      "https://calendar.example.test/a.ics",
      () =>
        new HttpResponse(null, {
          status: 302,
          headers: { location: "https://other.example.test/b.ics" },
        }),
    );
    const resolve = vi.fn((host: string) =>
      Promise.resolve(
        host === "other.example.test" ? [{ address: "192.168.0.7", family: 4 as const }] : PUBLIC,
      ),
    );
    expect(await safeFetchText("https://calendar.example.test/a.ics", {}, { resolve })).toEqual({
      ok: false,
      reason: "blocked_address",
    });
  });

  it("refuses a redirect to plain http", async () => {
    feed(
      "https://calendar.example.test/a.ics",
      () =>
        new HttpResponse(null, {
          status: 301,
          headers: { location: "http://calendar.example.test/b.ics" },
        }),
    );
    expect(
      await safeFetchText(
        "https://calendar.example.test/a.ics",
        {},
        { resolve: resolvesTo(PUBLIC) },
      ),
    ).toEqual({ ok: false, reason: "blocked_address" });
  });

  it("follows a harmless redirect, and gives up after 3", async () => {
    feed(
      "https://calendar.example.test/a.ics",
      () => new HttpResponse(null, { status: 302, headers: { location: "/b.ics" } }),
    );
    feed("https://calendar.example.test/b.ics", () => new HttpResponse(ICS));
    expect(
      await safeFetchText(
        "https://calendar.example.test/a.ics",
        {},
        { resolve: resolvesTo(PUBLIC) },
      ),
    ).toEqual({ ok: true, text: ICS });

    server.resetHandlers();
    requests.length = 0;
    feed(
      "https://calendar.example.test/loop.ics",
      () => new HttpResponse(null, { status: 302, headers: { location: "/loop.ics" } }),
    );
    expect(
      await safeFetchText(
        "https://calendar.example.test/loop.ics",
        {},
        { resolve: resolvesTo(PUBLIC) },
      ),
    ).toEqual({ ok: false, reason: "http_error" });
    expect(requests).toHaveLength(4);
  });
});

describe("the answer", () => {
  it("connects to the address it checked, never to a second lookup", async () => {
    const transport = vi.fn<Transport>(() =>
      Promise.resolve({
        status: 200,
        location: null,
        body: Readable.from([Buffer.from(ICS)]),
        close: () => undefined,
      }),
    );
    const resolve = resolvesTo(PUBLIC);
    await safeFetchText("https://calendar.example.test/a.ics", {}, { resolve, transport });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]?.[0].address).toEqual(PUBLIC[0]);
  });

  it("stops a body over 5 MB with too_large", async () => {
    feed(
      "https://calendar.example.test/big.ics",
      () => new HttpResponse(`BEGIN:VCALENDAR\r\n${"x".repeat(5 * 1024 * 1024)}`),
    );
    expect(
      await safeFetchText(
        "https://calendar.example.test/big.ics",
        {},
        { resolve: resolvesTo(PUBLIC) },
      ),
    ).toEqual({ ok: false, reason: "too_large" });
  });

  it("calls a body that isn't iCalendar not_ics", async () => {
    feed("https://calendar.example.test/page.html", () => new HttpResponse("<html>Sign in</html>"));
    expect(
      await safeFetchText(
        "https://calendar.example.test/page.html",
        {},
        { resolve: resolvesTo(PUBLIC) },
      ),
    ).toEqual({ ok: false, reason: "not_ics" });
  });

  it("accepts a byte order mark and blank lines before BEGIN:VCALENDAR", async () => {
    feed("https://calendar.example.test/a.ics", () => new HttpResponse(`\uFEFF\r\n${ICS}`));
    const result = await safeFetchText(
      "https://calendar.example.test/a.ics",
      {},
      { resolve: resolvesTo(PUBLIC) },
    );
    expect(result.ok).toBe(true);
  });

  it("calls an error status http_error", async () => {
    feed("https://calendar.example.test/a.ics", () => new HttpResponse("gone", { status: 404 }));
    expect(
      await safeFetchText(
        "https://calendar.example.test/a.ics",
        {},
        { resolve: resolvesTo(PUBLIC) },
      ),
    ).toEqual({ ok: false, reason: "http_error" });
  });

  it("gives up after the time limit, and when DNS fails says unreachable", async () => {
    const slow: Transport = () => new Promise(() => undefined);
    expect(
      await safeFetchText(
        "https://calendar.example.test/a.ics",
        { timeoutMs: 50 },
        { resolve: resolvesTo(PUBLIC), transport: slow },
      ),
    ).toEqual({ ok: false, reason: "timeout" });
    const broken = vi.fn(() => Promise.reject(new Error("ENOTFOUND")));
    expect(
      await safeFetchText("https://calendar.example.test/a.ics", {}, { resolve: broken }),
    ).toEqual({ ok: false, reason: "unreachable" });
  });
});
