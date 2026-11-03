const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "postgres"]);
const SUPABASE_DOMAINS = ["supabase.co", "supabase.com"];

const hostOf = (connectionString: string): string => {
  try {
    return new URL(connectionString).hostname.toLowerCase();
  } catch {
    throw new Error(
      "DATABASE_URL is not a valid connection URL. Use the postgres://user:password@host:port/db form from .env.example.",
    );
  }
};

const isSupabase = (host: string): boolean =>
  SUPABASE_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));

/**
 * Throws unless the database is on this machine (or the compose `postgres` service).
 * Guards the dev auth stub, which must never reach Supabase. Errors name the host only,
 * never the full URL, so the password is not printed.
 */
export const assertLocalDatabase = (connectionString: string): void => {
  const host = hostOf(connectionString);
  if (isSupabase(host)) {
    throw new Error(
      `Refusing to continue: DATABASE_URL points at Supabase (${host}). The dev auth stub is for local Postgres only; Supabase already provides auth.uid().`,
    );
  }
  if (!LOCAL_HOSTS.has(host)) {
    throw new Error(
      `Refusing to continue: ${host || "(no host)"} is not a local database. Point DATABASE_URL at localhost or the compose "postgres" service.`,
    );
  }
};
