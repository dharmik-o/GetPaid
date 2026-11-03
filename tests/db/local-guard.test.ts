import { describe, expect, it } from "vitest";
import { assertLocalDatabase } from "../../scripts/lib/local-db";

const PASSWORD = "s3cret-pass";
const url = (host: string): string => `postgres://postgres:${PASSWORD}@${host}:5432/app`;

describe("assertLocalDatabase", () => {
  it.each(["localhost", "127.0.0.1", "[::1]", "postgres"])("allows %s", (host) => {
    expect(() => {
      assertLocalDatabase(url(host));
    }).not.toThrow();
  });

  it.each(["db.abcdefghij.supabase.co", "aws-0-us-east-1.pooler.supabase.com"])(
    "refuses Supabase host %s",
    (host) => {
      expect(() => {
        assertLocalDatabase(url(host));
      }).toThrow(/points at Supabase/);
    },
  );

  it("refuses any other remote host", () => {
    expect(() => {
      assertLocalDatabase(url("db.example.com"));
    }).toThrow(/not a local database/);
  });

  it("refuses a value that isn't a connection URL", () => {
    expect(() => {
      assertLocalDatabase("not a url");
    }).toThrow(/not a valid connection URL/);
  });

  it.each(["db.abcdefghij.supabase.co", "db.example.com"])(
    "never puts the password in the error for %s",
    (host) => {
      const message = ((): string => {
        try {
          assertLocalDatabase(url(host));
          return "";
        } catch (error) {
          return String(error);
        }
      })();
      expect(message).not.toBe("");
      expect(message).not.toContain(PASSWORD);
    },
  );
});
