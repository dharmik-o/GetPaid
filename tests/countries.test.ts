import { describe, expect, it } from "vitest";
import {
  COUNTRIES,
  countryName,
  defaultTimeZone,
  isCountryCode,
  isValidTimeZone,
  timeZonesFor,
} from "@/lib/countries";

describe("countries", () => {
  it("lists countries by name with ISO codes", () => {
    expect(COUNTRIES.length).toBeGreaterThan(200);
    expect(COUNTRIES.every((c) => /^[A-Z]{2}$/.test(c.code))).toBe(true);
    const names = COUNTRIES.map((c) => c.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(countryName("IN")).toBe("India");
  });

  it("leaves out places with no permanent population", () => {
    expect(isCountryCode("AQ")).toBe(false);
    expect(isCountryCode("HM")).toBe(false);
  });

  it("knows which codes are real", () => {
    expect(isCountryCode("US")).toBe(true);
    expect(isCountryCode("us")).toBe(false);
    expect(isCountryCode("XX")).toBe(false);
  });

  it.each([
    ["IN", "Asia/Kolkata"],
    ["PH", "Asia/Manila"],
    ["LK", "Asia/Colombo"],
    ["GB", "Europe/London"],
    ["US", "America/New_York"],
    ["CA", "America/Toronto"],
    ["AU", "Australia/Sydney"],
    ["BR", "America/Sao_Paulo"],
    ["MX", "America/Mexico_City"],
    ["ES", "Europe/Madrid"],
    ["NL", "Europe/Amsterdam"],
    ["NZ", "Pacific/Auckland"],
  ])("defaults %s to %s", (country, zone) => {
    expect(defaultTimeZone(country)).toBe(zone);
  });

  it("gives every country a default that is one of its own zones and valid", () => {
    for (const { code } of COUNTRIES) {
      const zones = timeZonesFor(code);
      expect(zones.length, code).toBeGreaterThan(0);
      expect(zones, code).toContain(defaultTimeZone(code));
      expect(zones.every(isValidTimeZone), code).toBe(true);
    }
  });

  it("lists a country's own zones, not zones borrowed from neighbours", () => {
    expect(timeZonesFor("AU")).not.toContain("Asia/Tokyo");
    expect(timeZonesFor("US")).toContain("America/Los_Angeles");
  });

  it("throws a clear error for an unknown country", () => {
    expect(() => defaultTimeZone("XX")).toThrow(/Unknown country "XX"/);
  });

  it("checks IANA time zones", () => {
    expect(isValidTimeZone("America/New_York")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});
