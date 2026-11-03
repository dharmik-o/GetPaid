import { join } from "node:path";

export const DB_DIR = join(import.meta.dirname, "..", "..", "db");
export const MIGRATIONS_DIR = join(DB_DIR, "migrations");
export const SEED_FILE = join(DB_DIR, "seed.sql");
/** Dev only: never applied to Supabase. See scripts/lib/local-db.ts. */
export const AUTH_STUB_FILE = join(DB_DIR, "dev", "000_supabase_auth_stub.sql");
