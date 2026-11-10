import { describe, expect, test } from "bun:test";
import { createNodeExecutor } from "./testing/executor";

describe("node SqlExecutor", () => {
  test("runs DDL, writes, and reads", async () => {
    const db = createNodeExecutor();
    await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
    await db.run("INSERT INTO t (name) VALUES (?)", ["a"]);
    const rows = await db.all<{ id: number; name: string }>("SELECT * FROM t");
    expect(rows).toEqual([{ id: 1, name: "a" }]);
  });

  test("batch is atomic", async () => {
    const db = createNodeExecutor();
    await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
    await expect(
      db.batch([
        { sql: "INSERT INTO t (name) VALUES (?)", params: ["ok"] },
        { sql: "INSERT INTO t (name) VALUES (?)", params: [null] },
      ])
    ).rejects.toThrow();
    expect(await db.all("SELECT * FROM t")).toEqual([]);
  });

  test("run reports the number of changed rows", async () => {
    const db = createNodeExecutor();
    await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    expect((await db.run("INSERT INTO t DEFAULT VALUES")).changes).toBe(1);
    expect((await db.run("UPDATE t SET id = 2 WHERE id = 99")).changes).toBe(0);
  });
});
