import type { DatabaseAdapter } from "../db/adapter";
import type {
  HistoryPayload,
  ReviewPayload,
  SettingsPayload,
  SyncOp,
  SyncOpResult,
  WordPayload,
} from "./types";

const WORD_UPSERT_SQL = `
  INSERT INTO words (
    user_id, uuid, word, translation, definitions, examples, phonetic,
    audio_url, source_language, target_language, created_at, updated_at, deleted_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(uuid) DO UPDATE SET
    word = excluded.word,
    translation = excluded.translation,
    definitions = excluded.definitions,
    examples = excluded.examples,
    phonetic = excluded.phonetic,
    audio_url = excluded.audio_url,
    source_language = excluded.source_language,
    target_language = excluded.target_language,
    updated_at = excluded.updated_at,
    deleted_at = excluded.deleted_at
  WHERE words.user_id = excluded.user_id
    AND julianday(excluded.updated_at) > julianday(words.updated_at)
`;

const REVIEW_UPSERT_SQL = `
  INSERT INTO reviews (
    word_id, ease_factor, interval, repetitions, next_review_date, last_reviewed,
    stability, difficulty, fsrs_state, lapses, fsrs_reps, fsrs_last_review,
    created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(word_id) DO UPDATE SET
    ease_factor = excluded.ease_factor,
    interval = excluded.interval,
    repetitions = excluded.repetitions,
    next_review_date = excluded.next_review_date,
    last_reviewed = excluded.last_reviewed,
    stability = excluded.stability,
    difficulty = excluded.difficulty,
    fsrs_state = excluded.fsrs_state,
    lapses = excluded.lapses,
    fsrs_reps = excluded.fsrs_reps,
    fsrs_last_review = excluded.fsrs_last_review,
    updated_at = excluded.updated_at
  WHERE COALESCE(julianday(excluded.last_reviewed), 0) > COALESCE(julianday(reviews.last_reviewed), 0)
`;

function jsonOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

async function wordIdForUuid(
  db: DatabaseAdapter,
  userId: number,
  uuid: string
): Promise<number | null> {
  const row = await db
    .prepare("SELECT id FROM words WHERE uuid = ? AND user_id = ?")
    .get(uuid, userId);
  return row ? Number(row.id) : null;
}

async function applyWordUpsert(
  db: DatabaseAdapter,
  userId: number,
  payload: WordPayload
): Promise<string | undefined> {
  const existing = await db
    .prepare("SELECT id, uuid FROM words WHERE user_id = ? AND word = ?")
    .get(userId, payload.word);

  if (existing && String(existing.uuid ?? "") !== payload.uuid) {
    // UNIQUE(user_id, word) already owns this term. Keep that identity and
    // update it if the incoming state is newer; the client adopts the server
    // uuid on the next pull.
    await db
      .prepare(`
        UPDATE words SET
          translation = ?, definitions = ?, examples = ?, phonetic = ?,
          audio_url = ?, source_language = ?, target_language = ?,
          updated_at = ?, deleted_at = NULL
        WHERE id = ? AND julianday(?) > julianday(updated_at)
      `)
      .run(
        payload.translation,
        jsonOrNull(payload.definitions),
        jsonOrNull(payload.examples),
        payload.phonetic,
        payload.audioUrl,
        payload.sourceLanguage,
        payload.targetLanguage,
        payload.updatedAt,
        Number(existing.id),
        payload.updatedAt
      );
    return "merged";
  }

  await db
    .prepare(WORD_UPSERT_SQL)
    .run(
      userId,
      payload.uuid,
      payload.word,
      payload.translation,
      jsonOrNull(payload.definitions),
      jsonOrNull(payload.examples),
      payload.phonetic,
      payload.audioUrl,
      payload.sourceLanguage,
      payload.targetLanguage,
      payload.createdAt,
      payload.updatedAt,
      payload.deletedAt
    );
  return undefined;
}

async function applyWordDelete(
  db: DatabaseAdapter,
  userId: number,
  payload: { uuid?: unknown; deletedAt?: unknown }
): Promise<string | undefined> {
  const uuid = String(payload.uuid ?? "");
  if (!uuid) return "missing-uuid";
  const deletedAt =
    typeof payload.deletedAt === "string"
      ? payload.deletedAt
      : new Date().toISOString();
  const result = await db
    .prepare(`
      UPDATE words SET deleted_at = ?, updated_at = ?
      WHERE uuid = ? AND user_id = ?
    `)
    .run(deletedAt, deletedAt, uuid, userId);
  return result.changes === 0 ? "not-found" : undefined;
}

async function applyReviewUpsert(
  db: DatabaseAdapter,
  userId: number,
  payload: ReviewPayload
): Promise<string | undefined> {
  const wordId = await wordIdForUuid(db, userId, payload.wordUuid);
  if (wordId === null) return "word-not-found";
  await db
    .prepare(REVIEW_UPSERT_SQL)
    .run(
      wordId,
      payload.easeFactor,
      payload.interval,
      payload.repetitions,
      payload.nextReviewDate,
      payload.lastReviewed,
      payload.stability,
      payload.difficulty,
      payload.fsrsState,
      payload.lapses,
      payload.fsrsReps,
      payload.fsrsLastReview,
      payload.updatedAt,
      payload.updatedAt
    );
  return undefined;
}

async function applyHistoryInsert(
  db: DatabaseAdapter,
  userId: number,
  payload: HistoryPayload
): Promise<string | undefined> {
  const wordId = await wordIdForUuid(db, userId, payload.wordUuid);
  if (wordId === null) return "word-not-found";
  await db
    .prepare(`
      INSERT OR IGNORE INTO review_history (
        uuid, word_id, rating, previous_ease_factor, previous_interval,
        previous_repetitions, new_ease_factor, new_interval, new_repetitions,
        algorithm, snapshot, reviewed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      payload.uuid,
      wordId,
      payload.rating,
      payload.previousEaseFactor,
      payload.previousInterval,
      payload.previousRepetitions,
      payload.newEaseFactor,
      payload.newInterval,
      payload.newRepetitions,
      payload.algorithm,
      jsonOrNull(payload.snapshot),
      payload.reviewedAt
    );
  return undefined;
}

async function applySettings(
  db: DatabaseAdapter,
  userId: number,
  payload: SettingsPayload
): Promise<string | undefined> {
  if (payload.srsAlgorithm !== "sm2" && payload.srsAlgorithm !== "fsrs") {
    return "invalid-settings";
  }
  await db
    .prepare("UPDATE users SET srs_algorithm = ? WHERE id = ?")
    .run(payload.srsAlgorithm, userId);
  return undefined;
}

/**
 * Applies pushed ops one by one. A failure is scoped to its op: the result
 * reports `accepted: false`, the rest of the batch still applies, and the
 * client keeps retrying that op. `accepted: true` with a `reason` means the op
 * is settled even though nothing was written (stale/merged/not-found).
 */
export async function applyOps(
  db: DatabaseAdapter,
  userId: number,
  ops: SyncOp[]
): Promise<SyncOpResult[]> {
  const results: SyncOpResult[] = [];

  for (const op of ops) {
    try {
      let reason: string | undefined;
      if (op.entity === "word" && op.op === "upsert") {
        reason = await applyWordUpsert(db, userId, op.payload as unknown as WordPayload);
      } else if (op.entity === "word" && op.op === "delete") {
        reason = await applyWordDelete(db, userId, op.payload);
      } else if (op.entity === "review" && op.op === "upsert") {
        reason = await applyReviewUpsert(db, userId, op.payload as unknown as ReviewPayload);
      } else if (op.entity === "history" && op.op === "upsert") {
        reason = await applyHistoryInsert(db, userId, op.payload as unknown as HistoryPayload);
      } else if (op.entity === "settings") {
        reason = await applySettings(db, userId, op.payload as unknown as SettingsPayload);
      } else {
        results.push({
          opId: op.opId,
          accepted: false,
          reason: `unsupported:${op.entity}/${op.op}`,
        });
        continue;
      }
      results.push(
        reason
          ? { opId: op.opId, accepted: true, reason }
          : { opId: op.opId, accepted: true }
      );
    } catch (error) {
      results.push({
        opId: op.opId,
        accepted: false,
        reason: error instanceof Error ? error.message : "apply-failed",
      });
    }
  }

  return results;
}
