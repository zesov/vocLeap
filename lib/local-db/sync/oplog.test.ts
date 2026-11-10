import { beforeEach, describe, expect, test } from "bun:test";
import type { SqlExecutor } from "../executor";
import { createNodeExecutor } from "../testing/executor";
import { migrateLocalSchema } from "../schema";
import {
  ackOps,
  clearOplog,
  enqueueOp,
  getPendingOps,
  pendingCount,
  pendingReviewWordUuids,
  pendingWordUuids,
} from "./oplog";

let db: SqlExecutor;

beforeEach(async () => {
  db = createNodeExecutor();
  await migrateLocalSchema(db);
});

describe("oplog", () => {
  test("enqueues and reads ops back in insertion order", async () => {
    const first = await enqueueOp(db, "word", "upsert", { uuid: "u1" });
    const second = await enqueueOp(db, "settings", "upsert", { srsAlgorithm: "fsrs" });

    const ops = await getPendingOps(db);
    expect(ops.map((op) => op.opId)).toEqual([first, second]);
    expect(ops[0].payload).toEqual({ uuid: "u1" });
    expect(await pendingCount(db)).toBe(2);
  });

  test("respects the batch limit", async () => {
    for (let i = 0; i < 5; i++) {
      await enqueueOp(db, "word", "upsert", { uuid: `u${i}` });
    }
    expect(await getPendingOps(db, 3)).toHaveLength(3);
  });

  test("acknowledging removes only the acknowledged ops", async () => {
    const first = await enqueueOp(db, "word", "upsert", { uuid: "u1" });
    const second = await enqueueOp(db, "word", "upsert", { uuid: "u2" });

    await ackOps(db, [first]);
    expect((await getPendingOps(db)).map((op) => op.opId)).toEqual([second]);
  });

  test("reports which words have pending ops", async () => {
    await enqueueOp(db, "word", "upsert", { uuid: "u1" });
    await enqueueOp(db, "review", "upsert", { wordUuid: "u1", interval: 1 });
    await enqueueOp(db, "review", "upsert", { wordUuid: "u2", interval: 1 });

    expect([...(await pendingWordUuids(db))]).toEqual(["u1"]);
    expect([...(await pendingReviewWordUuids(db))].sort()).toEqual(["u1", "u2"]);
  });

  test("clearOplog empties the queue", async () => {
    await enqueueOp(db, "word", "upsert", { uuid: "u1" });
    await clearOplog(db);
    expect(await pendingCount(db)).toBe(0);
  });
});
