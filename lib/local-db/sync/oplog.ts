import { uuidv7 } from "../../uuid";
import type { SyncEntity, SyncOp, SyncOpKind } from "../../sync/types";
import type { SqlExecutor, SqlStep } from "../executor";

/** Op id and insert step, for callers that must enqueue inside a batch. */
export function enqueueOpStep(
  entity: SyncEntity,
  op: SyncOpKind,
  payload: Record<string, unknown>,
  opId: string = uuidv7()
): { opId: string; step: SqlStep } {
  return {
    opId,
    step: {
      sql: `INSERT INTO sync_ops (op_id, entity, op, payload, created_at)
            VALUES (?, ?, ?, ?, ?)`,
      params: [opId, entity, op, JSON.stringify(payload), new Date().toISOString()],
    },
  };
}

export async function enqueueOp(
  db: SqlExecutor,
  entity: SyncEntity,
  op: SyncOpKind,
  payload: Record<string, unknown>
): Promise<string> {
  const { opId, step } = enqueueOpStep(entity, op, payload);
  await db.run(step.sql, step.params);
  return opId;
}

export async function getPendingOps(
  db: SqlExecutor,
  limit: number = 200
): Promise<SyncOp[]> {
  const rows = await db.all<{
    op_id: string;
    entity: SyncEntity;
    op: SyncOpKind;
    payload: string;
  }>(
    "SELECT op_id, entity, op, payload FROM sync_ops ORDER BY created_at, rowid LIMIT ?",
    [limit]
  );

  return rows.map((row) => ({
    opId: row.op_id,
    entity: row.entity,
    op: row.op,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
  }));
}

/** Removes one op by id — the escape hatch for a poison op the server always rejects. */
export async function discardOp(db: SqlExecutor, opId: string): Promise<void> {
  await db.run("DELETE FROM sync_ops WHERE op_id = ?", [opId]);
}

export async function ackOps(db: SqlExecutor, opIds: string[]): Promise<void> {
  const CHUNK = 400;
  for (let start = 0; start < opIds.length; start += CHUNK) {
    const chunk = opIds.slice(start, start + CHUNK);
    const placeholders = chunk.map(() => "?").join(", ");
    await db.run(`DELETE FROM sync_ops WHERE op_id IN (${placeholders})`, chunk);
  }
}

export async function pendingCount(db: SqlExecutor): Promise<number> {
  const rows = await db.all<{ count: number }>(
    "SELECT COUNT(*) AS count FROM sync_ops"
  );
  return Number(rows[0]?.count ?? 0);
}

export async function pendingWordUuids(db: SqlExecutor): Promise<Set<string>> {
  const rows = await db.all<{ uuid: string | null }>(
    `SELECT DISTINCT json_extract(payload, '$.uuid') AS uuid
     FROM sync_ops WHERE entity = 'word'`
  );
  return new Set(rows.map((row) => row.uuid).filter((v): v is string => !!v));
}

export async function pendingReviewWordUuids(
  db: SqlExecutor
): Promise<Set<string>> {
  const rows = await db.all<{ uuid: string | null }>(
    `SELECT DISTINCT json_extract(payload, '$.wordUuid') AS uuid
     FROM sync_ops WHERE entity = 'review'`
  );
  return new Set(rows.map((row) => row.uuid).filter((v): v is string => !!v));
}

export async function clearOplog(db: SqlExecutor): Promise<void> {
  await db.run("DELETE FROM sync_ops");
}
