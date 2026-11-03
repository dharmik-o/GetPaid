import { describe, expect, it } from "vitest";
import { orderMigrations, pendingMigrations } from "../scripts/lib/migrations";

describe("orderMigrations", () => {
  it("sorts by numeric prefix, not by string", () => {
    expect(orderMigrations(["010_late.sql", "002_indexes.sql", "001_init.sql"])).toEqual([
      "001_init.sql",
      "002_indexes.sql",
      "010_late.sql",
    ]);
  });

  it("ignores files that are not numbered .sql migrations", () => {
    expect(orderMigrations(["README.md", "001_init.sql", "notes.sql", "002_a.sql.bak"])).toEqual([
      "001_init.sql",
    ]);
  });

  it("rejects two migrations with the same number", () => {
    expect(() => orderMigrations(["001_init.sql", "001_other.sql"])).toThrow(/001/);
  });
});

describe("pendingMigrations", () => {
  it("skips migrations already recorded in schema_migrations", () => {
    const all = ["001_init.sql", "002_indexes.sql", "003_more.sql"];
    expect(pendingMigrations(all, new Set(["001_init.sql"]))).toEqual([
      "002_indexes.sql",
      "003_more.sql",
    ]);
  });

  it("returns nothing when every migration is applied", () => {
    const all = ["001_init.sql"];
    expect(pendingMigrations(all, new Set(all))).toEqual([]);
  });
});
