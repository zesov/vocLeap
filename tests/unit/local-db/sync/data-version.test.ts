import { beforeEach, describe, expect, test } from "bun:test";
import type { SqlExecutor } from "../../../../lib/local-db/executor";
import { createNodeExecutor } from "../../../../lib/local-db/testing/executor";
import { migrateLocalSchema } from "../../../../lib/local-db/schema";
import { getDataVersion } from "../../../../lib/data/data-version";
import { runSyncOnce } from "../../../../lib/local-db/sync/engine";
import { ZERO_CURSOR } from "../../../../lib/sync/cursor";
import type { PullPage } from "../../../../lib/sync/server-pull";
import type { WordPayload } from "../../../../lib/sync/types";

let db: SqlExecutor;

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const word: WordPayload = {
  uuid: "u1",
  serverId: 1,
  word: "apple",
  translation: "蘋果",
  definitions: [],
  examples: [],
  phonetic: null,
  audioUrl: null,
  sourceLanguage: "en",
  targetLanguage: "zh-CN",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  deletedAt: null,
};

beforeEach(async () => {
  db = createNodeExecutor();
  await migrateLocalSchema(db);
});

describe("dataVersion bump on successful merge", () => {
  test("bumps when a pull merges data and stays flat on empty pulls", async () => {
    const withData: PullPage = {
      words: [word],
      reviews: [],
      history: [],
      settings: { srsAlgorithm: "sm2" },
      nextCursor: ZERO_CURSOR,
    };
    const empty: PullPage = { ...withData, words: [] };

    const fetchWithWords = (async () => json(withData)) as typeof fetch;
    const fetchEmpty = (async () => json(empty)) as typeof fetch;

    const before = getDataVersion();
    await runSyncOnce(db, { fetchImpl: fetchWithWords });
    expect(getDataVersion()).toBeGreaterThan(before);

    const afterFirst = getDataVersion();
    await runSyncOnce(db, { fetchImpl: fetchEmpty });
    expect(getDataVersion()).toBe(afterFirst);
  });
});
