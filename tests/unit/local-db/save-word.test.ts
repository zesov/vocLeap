import { beforeEach, describe, expect, test } from "bun:test";
import type { SqlExecutor } from "../../../lib/local-db/executor";
import { createNodeExecutor } from "../../../lib/local-db/testing/executor";
import { migrateLocalSchema } from "../../../lib/local-db/schema";
import {
  listBareWords,
  saveWordLocal,
  saveWordsLocal,
} from "../../../lib/local-db/operations";
import { getPendingOps } from "../../../lib/local-db/sync/oplog";

let db: SqlExecutor;

beforeEach(async () => {
  db = createNodeExecutor();
  await migrateLocalSchema(db);
});

describe("saveWordLocal", () => {
  test("inserts a new row and enqueues one word op in the same batch", async () => {
    const saved = await saveWordLocal(db, {
      word: "  serendipity  ",
      translation: "因緣際會",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });

    expect(saved.word).toBe("serendipity");
    expect(saved.id).toBe(0); // server id arrives with the next pull
    expect(saved.uuid).toBeTruthy();

    const rows = await db.all("SELECT * FROM words");
    expect(rows).toHaveLength(1);
    expect(String(rows[0].word)).toBe("serendipity");
    expect(rows[0].server_id).toBeNull();

    const ops = await getPendingOps(db);
    expect(ops).toHaveLength(1);
    expect(ops[0].entity).toBe("word");
    expect(ops[0].op).toBe("upsert");
    const payload = ops[0].payload as { uuid: string; word: string; serverId: number | null };
    expect(payload.uuid).toBe(saved.uuid);
    expect(payload.word).toBe("serendipity");
    expect(payload.serverId).toBeNull();
  });

  test("re-saving an existing word updates it instead of duplicating", async () => {
    const first = await saveWordLocal(db, {
      word: "apple",
      translation: "舊譯",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });
    const second = await saveWordLocal(db, {
      word: "apple",
      translation: "蘋果",
      sourceLanguage: "en",
      targetLanguage: "zh-CN",
    });

    expect(second.uuid).toBe(first.uuid);
    const rows = await db.all("SELECT translation FROM words");
    expect(rows).toHaveLength(1);
    expect(String(rows[0].translation)).toBe("蘋果");

    // One op per save, both referencing the surviving uuid.
    const ops = await getPendingOps(db);
    expect(ops).toHaveLength(2);
    for (const op of ops) {
      expect((op.payload as { uuid: string }).uuid).toBe(first.uuid);
    }
  });

  test("rejects an empty word", async () => {
    await expect(
      saveWordLocal(db, { word: "   ", translation: "x" })
    ).rejects.toThrow("Word is required");
    expect(await db.all("SELECT * FROM words")).toHaveLength(0);
  });
});

describe("saveWordsLocal", () => {
  test("imports new entries as rows + ops in one batch and mirrors server bulk semantics", async () => {
    const result = await saveWordsLocal(db, [
      { word: "apple", translation: "蘋果" },
      { word: "banana", translation: "香蕉" },
      { word: "", translation: "no word" },
      { word: "banana", translation: "重複" },
    ]);

    expect(result.total).toBe(4);
    expect(result.imported).toBe(2);
    expect(result.failed).toBe(2);
    expect(result.results.find((r) => r.word === "" )?.error).toBe(
      "Word and translation are required"
    );
    expect(result.results.find((r) => r.word === "banana" && !r.success)?.error).toBe(
      "Word already exists"
    );

    const rows = await db.all("SELECT word FROM words");
    expect(rows.map((r) => String(r.word)).sort()).toEqual(["apple", "banana"]);
    expect(await getPendingOps(db)).toHaveLength(2);
  });

  test("does not touch the oplog when every entry failed", async () => {
    const result = await saveWordsLocal(db, [
      { word: "apple", translation: "" },
    ]);
    expect(result.imported).toBe(0);
    expect(await getPendingOps(db)).toHaveLength(0);
  });
});

describe("listBareWords", () => {
  test("returns oldest-first words with an empty translation, skipping deleted ones", async () => {
    await saveWordLocal(db, { word: "zebra", translation: "" });
    await saveWordLocal(db, { word: "apple", translation: "" });
    await saveWordLocal(db, { word: "full", translation: "有譯" });

    const bare = await listBareWords(db, 10);
    expect(bare.map((w) => w.word)).toEqual(["zebra", "apple"]);
    expect(bare[0].sourceLanguage).toBe("en");
    expect(bare[0].targetLanguage).toBe("zh-CN");
  });
});
