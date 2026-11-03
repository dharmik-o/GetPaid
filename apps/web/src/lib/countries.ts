import { getAllCountries, getTimezonesForCountry, type Timezone } from "countries-and-timezones";
import { IANAZone } from "luxon";

// Server-only: country list and time zones for client records. Pages pass the small
// `COUNTRIES` array to client components as props, so the data package stays on the server.

export type CountryOption = {
  code: string;
  name: string;
  /** The country's own IANA zones; the default is one of them. */
  timeZones: string[];
  defaultTimeZone: string;
};

/** No permanent population, so never a client's country. */
const EXCLUDED = new Set(["AQ", "HM"]);

/** Countries with several zones default to the capital's or most populous one. */
const DEFAULT_ZONE_OVERRIDES: Record<string, string> = {
  AR: "America/Argentina/Buenos_Aires",
  AU: "Australia/Sydney",
  BR: "America/Sao_Paulo",
  CA: "America/Toronto",
  CD: "Africa/Kinshasa",
  CL: "America/Santiago",
  CN: "Asia/Shanghai",
  CY: "Asia/Nicosia",
  EC: "America/Guayaquil",
  ER: "Africa/Asmara",
  ES: "Europe/Madrid",
  GL: "America/Nuuk",
  ID: "Asia/Jakarta",
  KI: "Pacific/Tarawa",
  KZ: "Asia/Almaty",
  ML: "Africa/Bamako",
  MN: "Asia/Ulaanbaatar",
  MX: "America/Mexico_City",
  NZ: "Pacific/Auckland",
  PF: "Pacific/Tahiti",
  PG: "Pacific/Port_Moresby",
  PS: "Asia/Hebron",
  PT: "Europe/Lisbon",
  RU: "Europe/Moscow",
  SJ: "Arctic/Longyearbyen",
  UM: "Pacific/Midway",
  US: "America/New_York",
  UZ: "Asia/Tashkent",
  VI: "America/St_Thomas",
};

/** Real place-based zones only (no `CET`, `EST5EDT`, `US/Eastern` style names). */
const REGION_ZONE =
  /^(Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific)\//;

const ownedBy = (code: string, zones: Timezone[] | null): string[] =>
  (zones ?? [])
    .filter((zone) => zone.countries[0] === code && REGION_ZONE.test(zone.name))
    .map((zone) => zone.name)
    .sort();

/**
 * A country's own zones. Where tzdata merged a country's zone into a neighbour's
 * (e.g. Europe/Amsterdam into Europe/Brussels), the country's own name is used instead.
 */
const zonesOf = (code: string): string[] => {
  const canonical = ownedBy(code, getTimezonesForCountry(code));
  return canonical.length > 0
    ? canonical
    : ownedBy(code, getTimezonesForCountry(code, { deprecated: true }));
};

const buildCountries = (): CountryOption[] =>
  Object.values(getAllCountries())
    .filter((country) => !EXCLUDED.has(country.id))
    .map((country) => {
      const timeZones = zonesOf(country.id);
      const defaultZone = DEFAULT_ZONE_OVERRIDES[country.id] ?? timeZones[0] ?? "UTC";
      return {
        code: country.id,
        name: country.name,
        timeZones,
        defaultTimeZone: defaultZone,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

export const COUNTRIES: readonly CountryOption[] = buildCountries();

const BY_CODE = new Map(COUNTRIES.map((country) => [country.code, country]));

export const isCountryCode = (code: string): boolean => BY_CODE.has(code);

const countryOrThrow = (code: string): CountryOption => {
  const country = BY_CODE.get(code);
  if (!country) throw new Error(`Unknown country "${code}". Pick a country from the list.`);
  return country;
};

export const countryName = (code: string): string => countryOrThrow(code).name;

export const timeZonesFor = (code: string): string[] => [...countryOrThrow(code).timeZones];

export const defaultTimeZone = (code: string): string => countryOrThrow(code).defaultTimeZone;

export const isValidTimeZone = (zone: string): boolean =>
  zone.length > 0 && IANAZone.isValidZone(zone);

/** Every IANA zone this runtime knows, for clients outside their country's usual zones. */
export const allTimeZones = (): string[] => Intl.supportedValuesOf("timeZone");
