import { beforeEach, describe, expect, test } from "bun:test";
import type { SqlExecutor } from "./executor";
import { createNodeExecutor } from "./testing/executor";
import { getMeta, migrateLocalSchema, setMeta } from "./schema";

let db: SqlExecutor;

beforeEach(() => {
  db = createNodeExecutor();
});

describe("migrateLocalSchema", () => {
  test("creates the schema and records user_version = 1", async () => {
    await migrateLocalSchema(db);
    const version = await db.all<{ user_version: number }>("PRAGMA user_version");
    expect(version[0].user_version).toBe(1);
  });

  test("is idempotent", async () => {
    await migrateLocalSchema(db);
    await migrateLocalSchema(db);
    const tables = await db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    );
    expect(tables.map((t) => t.name)).toContain("words");
    expect(tables.map((t) => t.name)).toContain("sync_ops");
  });

  test("only one live word per spelling", async () => {
    await migrateLocalSchema(db);
    const insert = (uuid: string, deletedAt: string | null) =>
      db.run(
        `INSERT INTO words (uuid, word, translation, created_at, updated_at, deleted_at)
         VALUES (?, 'apple', 'x', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z', ?)`,
        [uuid, deletedAt]
      );

    await insert("u1", null);
    await expect(insert("u2", null)).rejects.toThrow();
    await insert("u2", "2026-11-11T00:00:00.000Z");
  });
});

describe("meta", () => {
  test("round-trips values", async () => {
    await migrateLocalSchema(db);
    await setMeta(db, "srs_algorithm", "fsrs");
    expect(await getMeta(db, "srs_algorithm")).toBe("fsrs");
    expect(await getMeta(db, "missing")).toBeNull();
  });
});
