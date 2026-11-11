import { beforeEach, describe, expect, test } from "bun:test";
import { ZERO_CURSOR } from "../../../../lib/sync/cursor";
import type { PullPage } from "../../../../lib/sync/server-pull";
import type { SqlExecutor } from "../../../../lib/local-db/executor.ts";
import { createNodeExecutor } from "../../../../lib/local-db/testing/executor.ts";
import { migrateLocalSchema } from "../../../../lib/local-db/schema.ts";
import { enqueueOp } from "../../../../lib/local-db/sync/oplog.ts";
import { mergePullPage } from "../../../../lib/local-db/sync/merge.ts";

let db: SqlExecutor;

const SETTINGS = { srsAlgorithm: "sm2" as const };

function page(partial: Partial<PullPage>): PullPage {
  return {
    words: [],
    reviews: [],
    history: [],
    settings: SETTINGS,
    nextCursor: ZERO_CURSOR,
    ...partial,
  };
}

function word(
  uuid: string,
  updatedAt: string,
  deletedAt: string | null = null,
  serverId: number | null = null
) {
  return {
    uuid,
    serverId,
    word: `w-${uuid}`,
    translation: "t",
    definitions: ["d"],
    examples: ["e"],
    phonetic: null,
    audioUrl: null,
    sourceLanguage: "en",
    targetLanguage: "zh-CN",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt,
    deletedAt,
  };
}

async function seedWord(uuid: string, updatedAt: string) {
  await db.run(
    `INSERT INTO words (uuid, server_id, word, translation, definitions, examples,
       source_language, target_language, created_at, updated_at)
     VALUES (?, 1, 'local', 't', '[]', '[]', 'en', 'zh-CN', ?, ?)`,
    [uuid, updatedAt, updatedAt]
  );
}

beforeEach(async () => {
  db = createNodeExecutor();
  await migrateLocalSchema(db);
});

describe("mergePullPage", () => {
  test("inserts new words, reviews and history", async () => {
    const result = await mergePullPage(
      db,
      page({
        words: [word("u1", "2026-11-02T00:00:00.000Z", null, 42)],
        reviews: [
          {
            wordUuid: "u1",
            easeFactor: 2.6,
            interval: 4,
            repetitions: 2,
            nextReviewDate: "2026-11-20 00:00:00",
            lastReviewed: "2026-11-10 00:00:00",
            stability: null,
            difficulty: null,
            fsrsState: null,
            lapses: null,
            fsrsReps: null,
            fsrsLastReview: null,
            updatedAt: "2026-11-10T00:00:00.000Z",
          },
        ],
        history: [
          {
            uuid: "h1",
            wordUuid: "u1",
            rating: 3,
            previousEaseFactor: 2.5,
            previousInterval: 1,
            previousRepetitions: 1,
            newEaseFactor: 2.6,
            newInterval: 4,
            newRepetitions: 2,
            algorithm: "sm2",
            snapshot: null,
            reviewedAt: "2026-11-10T00:00:00.000Z",
          },
        ],
      })
    );

    expect(result).toEqual({ words: 1, reviews: 1, history: 1 });

    const rows = await db.all(
      "SELECT uuid, server_id FROM words WHERE uuid = 'u1'"
    );
    // The numeric id from the server keeps local queue ids stable for callers
    // that talk to the HTTP API (e.g. review-state sync).
    expect(rows[0].server_id).toBe(42);
    const reviews = await db.all("SELECT * FROM reviews WHERE word_uuid = 'u1'");
    expect(reviews).toHaveLength(1);
    const history = await db.all("SELECT * FROM review_history");
    expect(history).toHaveLength(1);
  });

  test("newer server word wins, older is ignored", async () => {
    await seedWord("u1", "2026-11-02T00:00:00.000Z");
    await mergePullPage(db, page({ words: [word("u1", "2026-11-01T00:00:00.000Z")] }));
    let rows = await db.all("SELECT word FROM words WHERE uuid = 'u1'");
    expect(rows[0].word).toBe("local");

    await mergePullPage(db, page({ words: [word("u1", "2026-11-03T00:00:00.000Z")] }));
    rows = await db.all("SELECT word FROM words WHERE uuid = 'u1'");
    expect(rows[0].word).toBe("w-u1");
  });

  test("an update backfills a missing server id without clearing a known one", async () => {
    await seedWord("u1", "2026-11-02T00:00:00.000Z");
    await db.run("UPDATE words SET server_id = NULL WHERE uuid = 'u1'");

    await mergePullPage(
      db,
      page({ words: [word("u1", "2026-11-03T00:00:00.000Z", null, 7)] })
    );
    let rows = await db.all("SELECT server_id FROM words WHERE uuid = 'u1'");
    expect(rows[0].server_id).toBe(7);

    // A payload without an id must not erase the one already stored.
    await mergePullPage(
      db,
      page({ words: [word("u1", "2026-11-04T00:00:00.000Z", null, null)] })
    );
    rows = await db.all("SELECT server_id FROM words WHERE uuid = 'u1'");
    expect(rows[0].server_id).toBe(7);
  });

  test("an echo of a just-pushed word still adopts its server id", async () => {
    const updatedAt = "2026-11-02T00:00:00.000Z";
    await seedWord("u1", updatedAt);
    await db.run("UPDATE words SET server_id = NULL WHERE uuid = 'u1'");

    // The server keeps the client timestamp, so the row is not "newer".
    await mergePullPage(db, page({ words: [word("u1", updatedAt, null, 9)] }));

    const rows = await db.all("SELECT word, server_id FROM words WHERE uuid = 'u1'");
    expect(rows[0].server_id).toBe(9);
    expect(rows[0].word).toBe("local");
  });

  test("local pending word op wins over pulled row", async () => {
    await seedWord("u1", "2026-11-02T00:00:00.000Z");
    await enqueueOp(db, "word", "upsert", { ...word("u1", "2026-11-05T00:00:00.000Z") });

    await mergePullPage(db, page({ words: [word("u1", "2026-11-06T00:00:00.000Z")] }));
    const rows = await db.all("SELECT word FROM words WHERE uuid = 'u1'");
    expect(rows[0].word).toBe("local");
  });

  test("tombstones are sticky", async () => {
    await seedWord("u1", "2026-11-02T00:00:00.000Z");
    await mergePullPage(
      db,
      page({ words: [word("u1", "2026-11-03T00:00:00.000Z", "2026-11-03T00:00:00.000Z")] })
    );
    await mergePullPage(db, page({ words: [word("u1", "2026-11-09T00:00:00.000Z")] }));

    const rows = await db.all("SELECT deleted_at FROM words WHERE uuid = 'u1'");
    expect(rows[0].deleted_at).toBe("2026-11-03T00:00:00.000Z");
  });

  test("reviews for unknown words are skipped", async () => {
    const result = await mergePullPage(
      db,
      page({
        reviews: [
          {
            wordUuid: "missing",
            easeFactor: 2.5,
            interval: 1,
            repetitions: 1,
            nextReviewDate: "2026-11-20 00:00:00",
            lastReviewed: null,
            stability: null,
            difficulty: null,
            fsrsState: null,
            lapses: null,
            fsrsReps: null,
            fsrsLastReview: null,
            updatedAt: "2026-11-10T00:00:00.000Z",
          },
        ],
      })
    );
    expect(result.reviews).toBe(0);
  });

  test("duplicate history uuids are ignored", async () => {
    const entry = {
      uuid: "h1",
      wordUuid: "u1",
      rating: 3,
      previousEaseFactor: 2.5,
      previousInterval: 0,
      previousRepetitions: 0,
      newEaseFactor: 2.5,
      newInterval: 1,
      newRepetitions: 1,
      algorithm: "sm2" as const,
      snapshot: null,
      reviewedAt: "2026-11-10T00:00:00.000Z",
    };
    await mergePullPage(
      db,
      page({ words: [word("u1", "2026-11-02T00:00:00.000Z")], history: [entry] })
    );
    const result = await mergePullPage(db, page({ history: [entry] }));
    expect(result.history).toBe(0);
    const rows = await db.all("SELECT * FROM review_history");
    expect(rows).toHaveLength(1);
  });

  test("applies server settings unless a local settings op is pending", async () => {
    await mergePullPage(db, page({ settings: { srsAlgorithm: "fsrs" } }));
    let meta = await db.all("SELECT value FROM meta WHERE key = 'srs_algorithm'");
    expect(meta[0].value).toBe("fsrs");

    await enqueueOp(db, "settings", "upsert", { srsAlgorithm: "sm2" });
    await mergePullPage(db, page({ settings: { srsAlgorithm: "sm2" } }));
    meta = await db.all("SELECT value FROM meta WHERE key = 'srs_algorithm'");
    expect(meta[0].value).toBe("fsrs");
  });
});
