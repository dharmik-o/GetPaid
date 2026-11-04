import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DemoClockBanner } from "@/components/DemoClockBanner";
import { appNow, demoOffsetDays, setDemoOffsetDays } from "@/lib/clock";
import { demoClockHandlers } from "@/lib/demo-clock-handlers";

// The demo clock: dev only, and the one place routes and pages read the time from.

const REAL = new Date("2026-11-05T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const DEV = { NODE_ENV: "development" };

afterEach(() => {
  setDemoOffsetDays(undefined);
  vi.unstubAllEnvs();
});

describe("appNow", () => {
  it("is the real time with no offset", () => {
    expect(appNow(DEV, REAL)).toEqual(REAL);
  });

  it("moves by the offset in development", () => {
    const env = { ...DEV, DEMO_CLOCK_OFFSET_DAYS: "18" };
    expect(appNow(env, REAL)).toEqual(new Date(REAL.getTime() + 18 * DAY));
  });

  it("takes part of a day, to land inside a send window", () => {
    const env = { ...DEV, DEMO_CLOCK_OFFSET_DAYS: "0.5" };
    expect(appNow(env, REAL)).toEqual(new Date(REAL.getTime() + DAY / 2));
  });

  it("never moves in production, whatever is set", () => {
    const env = { NODE_ENV: "production", DEMO_CLOCK_OFFSET_DAYS: "18" };
    expect(appNow(env, REAL)).toEqual(REAL);
    expect(() => {
      setDemoOffsetDays(5, env);
    }).toThrow(/development/);
    expect(demoOffsetDays(env)).toBe(0);
  });

  it.each(["soon", "-1", "99999", "Infinity"])("says what's wrong with an offset of %s", (raw) => {
    expect(() => appNow({ ...DEV, DEMO_CLOCK_OFFSET_DAYS: raw }, REAL)).toThrow(
      /DEMO_CLOCK_OFFSET_DAYS/,
    );
  });

  it("treats an empty offset as none", () => {
    expect(appNow({ ...DEV, DEMO_CLOCK_OFFSET_DAYS: " " }, REAL)).toEqual(REAL);
  });

  it("a jump from Settings wins over the env value until restart", () => {
    const env = { ...DEV, DEMO_CLOCK_OFFSET_DAYS: "18" };
    setDemoOffsetDays(3, env);
    expect(demoOffsetDays(env)).toBe(3);
    setDemoOffsetDays(0, env);
    expect(appNow(env, REAL)).toEqual(REAL);
  });
});

describe("every route and page reads the clock through appNow", () => {
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sources(path);
      return /\.tsx?$/.test(entry.name) ? [path] : [];
    });

  it("no `new Date()` for the current time under app/", () => {
    const direct = sources("apps/web/src/app").filter((file) =>
      /new Date\(\)/.test(readFileSync(file, "utf8")),
    );
    expect(direct).toEqual([]);
  });
});

describe("POST /api/dev/clock", () => {
  const post = (body: unknown) =>
    new Request("http://127.0.0.1:3000/api/dev/clock", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("sets the offset in development", async () => {
    const response = await demoClockHandlers({ env: DEV }).post(post({ days: 18 }));
    expect(response.status).toBe(200);
    expect(demoOffsetDays(DEV)).toBe(18);
  });

  it("isn't there in production", async () => {
    const env = { NODE_ENV: "production" };
    const response = await demoClockHandlers({ env }).post(post({ days: 18 }));
    expect(response.status).toBe(404);
    expect(demoOffsetDays(env)).toBe(0);
  });

  it.each([{ days: -1 }, { days: 99999 }, { days: "18" }, {}, { days: 1, extra: true }])(
    "refuses %j",
    async (body) => {
      const response = await demoClockHandlers({ env: DEV }).post(post(body));
      expect(response.status).toBe(400);
      expect(demoOffsetDays(DEV)).toBe(0);
    },
  );
});

describe("the banner", () => {
  const banner = (env: Record<string, string>) =>
    renderToStaticMarkup(createElement(DemoClockBanner, { env, real: REAL })).replace(
      /<!-- -->/gu,
      "",
    );

  it("shows nothing with no offset, so a normal run looks normal", () => {
    expect(banner(DEV)).toBe("");
  });

  it("says how far ahead the clock is, and what day it thinks it is", () => {
    const html = banner({ ...DEV, DEMO_CLOCK_OFFSET_DAYS: "18" });
    expect(html).toContain("18 days ahead");
    expect(html).toContain("23 Nov");
  });

  it("shows nothing in production", () => {
    expect(banner({ NODE_ENV: "production", DEMO_CLOCK_OFFSET_DAYS: "18" })).toBe("");
  });
});
