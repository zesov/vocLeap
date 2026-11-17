import type {
  HistoryEntry,
  HistoryPage,
  ReviewSnapshot,
  ReviewWithWord,
  SaveWordEntryResult,
  SaveWordsResult,
  SrsAlgorithm,
  Stats,
  WordRecord,
  WordSort,
  WordsPage,
} from "../data/types";
import { uuidv7 } from "../uuid";
import type { SqlExecutor, SqlStep } from "./executor";
import { wordRowToPayload } from "./payloads";
import { enqueueOpStep } from "./sync/oplog";

const WORD_SORT_CLAUSES: Record<WordSort, string> = {
  date_desc: "w.updated_at DESC, w.uuid DESC",
  date_asc: "w.updated_at ASC, w.uuid ASC",
  alpha_asc: "w.word COLLATE NOCASE ASC, w.uuid ASC",
  alpha_desc: "w.word COLLATE NOCASE DESC, w.uuid DESC",
};

const REVIEW_WORD_SELECT = `
  SELECT
    w.uuid AS uuid, w.server_id AS server_id, w.word AS word,
    w.translation AS translation, w.definitions AS definitions,
    w.examples AS examples, w.phonetic AS phonetic, w.audio_url AS audio_url,
    w.source_language AS source_language, w.target_language AS target_language,
    w.created_at AS word_created_at, w.updated_at AS word_updated_at,
    r.ease_factor AS ease_factor, r.interval AS interval,
    r.repetitions AS repetitions, r.next_review_date AS next_review_date,
    r.last_reviewed AS last_reviewed, r.stability AS stability,
    r.difficulty AS difficulty, r.fsrs_state AS fsrs_state, r.lapses AS lapses,
    r.fsrs_reps AS fsrs_reps, r.fsrs_last_review AS fsrs_last_review,
    r.updated_at AS review_updated_at
  FROM words w
`;

function jsonArray(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

function wordFromRow(row: Record<string, unknown>): WordRecord {
  return {
    id: Number(row.server_id ?? 0),
    uuid: String(row.uuid),
    word: String(row.word),
    translation: String(row.translation),
    definitions: jsonArray(row.definitions),
    examples: jsonArray(row.examples),
    phonetic: row.phonetic == null ? undefined : String(row.phonetic),
    audioUrl: row.audio_url == null ? undefined : String(row.audio_url),
    sourceLanguage: String(row.source_language ?? "en"),
    targetLanguage: String(row.target_language ?? "zh-CN"),
    createdAt:
      row.word_created_at == null
        ? row.created_at == null
          ? undefined
          : String(row.created_at)
        : String(row.word_created_at),
    updatedAt:
      row.word_updated_at == null
        ? row.updated_at == null
          ? undefined
          : String(row.updated_at)
        : String(row.word_updated_at),
  };
}

function fsrsFromRow(row: Record<string, unknown>) {
  if (row.stability == null && row.fsrs_state == null) return null;
  return {
    stability: Number(row.stability ?? 0),
    difficulty: Number(row.difficulty ?? 0),
    state: Number(row.fsrs_state ?? 0),
    lapses: Number(row.lapses ?? 0),
    reps: Number(row.fsrs_reps ?? 0),
    due: String(row.next_review_date),
    lastReview:
      row.fsrs_last_review == null ? null : String(row.fsrs_last_review),
  };
}

function reviewWithWordFromRow(row: Record<string, unknown>): ReviewWithWord {
  const word = wordFromRow(row);
  return {
    uuid: word.uuid,
    wordId: word.id,
    word,
    easeFactor: Number(row.ease_factor ?? 2.5),
    interval: Number(row.interval ?? 0),
    repetitions: Number(row.repetitions ?? 0),
    nextReviewDate: String(row.next_review_date),
    lastReviewed:
      row.last_reviewed == null ? undefined : String(row.last_reviewed),
    fsrsState: fsrsFromRow(row),
    createdAt: word.createdAt,
    updatedAt:
      row.review_updated_at == null
        ? word.updatedAt
        : String(row.review_updated_at),
  };
}

function historyFromRow(row: Record<string, unknown>): HistoryEntry {
  let snapshot: ReviewSnapshot | undefined;
  if (row.snapshot != null) {
    try {
      const parsed = JSON.parse(String(row.snapshot)) as ReviewSnapshot;
      if (parsed?.before !== undefined && parsed?.after !== undefined) {
        snapshot = parsed;
      }
    } catch {
      snapshot = undefined;
    }
  }
  return {
    id: Number(row.id ?? 0),
    uuid: String(row.uuid),
    wordId: Number(row.server_id ?? 0),
    rating: Number(row.rating),
    previousEaseFactor: Number(row.previous_ease_factor),
    previousInterval: Number(row.previous_interval),
    previousRepetitions: Number(row.previous_repetitions),
    newEaseFactor: Number(row.new_ease_factor),
    newInterval: Number(row.new_interval),
    newRepetitions: Number(row.new_repetitions),
    algorithm: row.algorithm === "fsrs" ? "fsrs" : "sm2",
    snapshot,
    reviewedAt: String(row.reviewed_at),
    word: String(row.word_text),
    translation: String(row.word_translation),
  };
}

export async function getWordByUuid(
  db: SqlExecutor,
  uuid: string
): Promise<WordRecord | null> {
  const rows = await db.all(
    "SELECT * FROM words WHERE uuid = ? AND deleted_at IS NULL",
    [uuid]
  );
  return rows[0] ? wordFromRow(rows[0]) : null;
}

export async function getWordByText(
  db: SqlExecutor,
  text: string
): Promise<WordRecord | null> {
  const rows = await db.all(
    "SELECT * FROM words WHERE word = ? AND deleted_at IS NULL",
    [text]
  );
  return rows[0] ? wordFromRow(rows[0]) : null;
}

export async function getWordsPage(
  db: SqlExecutor,
  limit: number,
  offset: number,
  sort: WordSort
): Promise<WordsPage> {
  const orderBy = WORD_SORT_CLAUSES[sort] ?? WORD_SORT_CLAUSES.date_desc;
  const totalRows = await db.all<{ count: number }>(
    "SELECT COUNT(*) AS count FROM words w WHERE w.deleted_at IS NULL"
  );
  const total = Number(totalRows[0]?.count ?? 0);
  const rows = await db.all(
    `SELECT * FROM words w WHERE w.deleted_at IS NULL
     ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
    [limit, offset]
  );
  return {
    words: rows.map(wordFromRow),
    total,
    limit,
    offset,
    sort,
    hasMore: offset + rows.length < total,
  };
}

export async function getDueReviews(
  db: SqlExecutor,
  limit: number,
  now: Date = new Date()
): Promise<ReviewWithWord[]> {
  const rows = await db.all(
    `${REVIEW_WORD_SELECT}
     JOIN reviews r ON r.word_uuid = w.uuid
     WHERE w.deleted_at IS NULL
       AND julianday(r.next_review_date) <= julianday(?)
     ORDER BY julianday(r.next_review_date) ASC, w.uuid ASC
     LIMIT ?`,
    [now.toISOString(), limit]
  );
  return rows.map(reviewWithWordFromRow);
}

export async function getNewWords(
  db: SqlExecutor,
  limit: number
): Promise<ReviewWithWord[]> {
  const rows = await db.all(
    `${REVIEW_WORD_SELECT}
     LEFT JOIN reviews r ON r.word_uuid = w.uuid
     WHERE w.deleted_at IS NULL AND r.word_uuid IS NULL
     ORDER BY julianday(w.created_at) DESC, w.uuid DESC
     LIMIT ?`,
    [limit]
  );
  return rows.map(reviewWithWordFromRow);
}

export async function getStats(
  db: SqlExecutor,
  now: Date = new Date()
): Promise<Stats> {
  const rows = await db.all<{ due: number; total: number; new_words: number }>(
    `SELECT
       (SELECT COUNT(*) FROM reviews r JOIN words w ON w.uuid = r.word_uuid
        WHERE w.deleted_at IS NULL
          AND julianday(r.next_review_date) <= julianday(?)) AS due,
       (SELECT COUNT(*) FROM words WHERE deleted_at IS NULL) AS total,
       (SELECT COUNT(*) FROM words w LEFT JOIN reviews r ON r.word_uuid = w.uuid
        WHERE w.deleted_at IS NULL AND r.word_uuid IS NULL) AS new_words`,
    [now.toISOString()]
  );
  return {
    due: Number(rows[0]?.due ?? 0),
    total: Number(rows[0]?.total ?? 0),
    newWords: Number(rows[0]?.new_words ?? 0),
  };
}

export async function getHistoryPage(
  db: SqlExecutor,
  limit: number,
  offset: number
): Promise<HistoryPage> {
  const totalRows = await db.all<{ count: number }>(
    `SELECT COUNT(*) AS count FROM review_history rh
     JOIN words w ON w.uuid = rh.word_uuid
     WHERE w.deleted_at IS NULL`
  );
  const total = Number(totalRows[0]?.count ?? 0);
  const rows = await db.all(
    `SELECT rh.*, w.word AS word_text, w.translation AS word_translation,
            w.server_id AS server_id
     FROM review_history rh
     JOIN words w ON w.uuid = rh.word_uuid
     WHERE w.deleted_at IS NULL
     ORDER BY julianday(rh.reviewed_at) DESC, rh.uuid DESC
     LIMIT ? OFFSET ?`,
    [limit, offset]
  );
  return {
    history: rows.map(historyFromRow),
    total,
    limit,
    offset,
    hasMore: offset + rows.length < total,
  };
}

export async function getWordHistory(
  db: SqlExecutor,
  wordUuid: string
): Promise<HistoryEntry[]> {
  const rows = await db.all(
    `SELECT rh.*, w.word AS word_text, w.translation AS word_translation,
            w.server_id AS server_id
     FROM review_history rh
     JOIN words w ON w.uuid = rh.word_uuid
     WHERE rh.word_uuid = ? AND w.deleted_at IS NULL
     ORDER BY julianday(rh.reviewed_at) DESC, rh.uuid DESC`,
    [wordUuid]
  );
  return rows.map(historyFromRow);
}

export async function getAlgorithm(db: SqlExecutor): Promise<SrsAlgorithm> {
  const rows = await db.all<{ value: string }>(
    "SELECT value FROM meta WHERE key = 'srs_algorithm'"
  );
  return rows[0]?.value === "fsrs" ? "fsrs" : "sm2";
}

export async function setAlgorithmLocal(
  db: SqlExecutor,
  algorithm: SrsAlgorithm
): Promise<void> {
  const op = enqueueOpStep("settings", "upsert", { srsAlgorithm: algorithm });
  await db.batch([
    {
      sql: `INSERT INTO meta (key, value) VALUES ('srs_algorithm', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      params: [algorithm],
    },
    op.step,
  ]);
}

export async function updateWordLocal(
  db: SqlExecutor,
  uuid: string,
  updates: Partial<Pick<WordRecord, "translation" | "definitions" | "examples" | "phonetic" | "audioUrl" | "sourceLanguage" | "targetLanguage">>
): Promise<boolean> {
  const rows = await db.all(
    "SELECT * FROM words WHERE uuid = ? AND deleted_at IS NULL",
    [uuid]
  );
  const existing = rows[0];
  if (!existing) return false;

  const now = new Date().toISOString();
  const merged = {
    ...existing,
    translation: updates.translation ?? existing.translation,
    definitions:
      updates.definitions === undefined
        ? existing.definitions
        : JSON.stringify(updates.definitions),
    examples:
      updates.examples === undefined
        ? existing.examples
        : JSON.stringify(updates.examples),
    phonetic: updates.phonetic === undefined ? existing.phonetic : updates.phonetic,
    audio_url:
      updates.audioUrl === undefined ? existing.audio_url : updates.audioUrl,
    source_language:
      updates.sourceLanguage === undefined
        ? existing.source_language
        : updates.sourceLanguage,
    target_language:
      updates.targetLanguage === undefined
        ? existing.target_language
        : updates.targetLanguage,
    updated_at: now,
  };

  const op = enqueueOpStep("word", "upsert", {
    ...wordRowToPayload(merged),
  });
  const steps: SqlStep[] = [
    {
      sql: `UPDATE words SET translation = ?, definitions = ?, examples = ?,
              phonetic = ?, audio_url = ?, source_language = ?,
              target_language = ?, updated_at = ?
            WHERE uuid = ?`,
      params: [
        merged.translation,
        merged.definitions,
        merged.examples,
        merged.phonetic,
        merged.audio_url,
        merged.source_language,
        merged.target_language,
        now,
        uuid,
      ],
    },
    op.step,
  ];
  await db.batch(steps);
  return true;
}

export async function deleteWordLocal(
  db: SqlExecutor,
  uuid: string
): Promise<boolean> {
  const now = new Date().toISOString();
  const op = enqueueOpStep("word", "delete", { uuid, deletedAt: now });
  const result = await db.run(
    `UPDATE words SET deleted_at = ?, updated_at = ?
     WHERE uuid = ? AND deleted_at IS NULL`,
    [now, now, uuid]
  );
  if (result.changes === 0) return false;
  await db.run(op.step.sql, op.step.params);
  return true;
}

export interface SaveWordLocalInput {
  word: string;
  translation: string;
  definitions?: string[];
  examples?: string[];
  phonetic?: string;
  audioUrl?: string;
  sourceLanguage?: string;
  targetLanguage?: string;
}

function normalizeSaveInput(input: SaveWordLocalInput) {
  return {
    word: input.word.trim(),
    translation: input.translation ?? "",
    definitions: input.definitions ?? [],
    examples: input.examples ?? [],
    phonetic: input.phonetic ?? null,
    audioUrl: input.audioUrl ?? null,
    sourceLanguage: input.sourceLanguage || "en",
    targetLanguage: input.targetLanguage || "zh-CN",
  };
}

function wordRowFromSave(
  uuid: string,
  input: ReturnType<typeof normalizeSaveInput>,
  now: string
): Record<string, unknown> {
  return {
    uuid,
    server_id: null,
    word: input.word,
    translation: input.translation,
    definitions: JSON.stringify(input.definitions),
    examples: JSON.stringify(input.examples),
    phonetic: input.phonetic,
    audio_url: input.audioUrl,
    source_language: input.sourceLanguage,
    target_language: input.targetLanguage,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
}

const INSERT_WORD_SQL = `
  INSERT INTO words (
    uuid, server_id, word, translation, definitions, examples, phonetic,
    audio_url, source_language, target_language, created_at, updated_at, deleted_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

/**
 * Local-first single-word save, mirroring the server's single POST (an
 * intentional upsert). Writes the row and the sync op in ONE batch so a
 * crash cannot produce a word the server will never learn about. Works
 * offline: the op waits in the oplog until connectivity returns.
 */
export async function saveWordLocal(
  db: SqlExecutor,
  input: SaveWordLocalInput
): Promise<WordRecord> {
  const normalized = normalizeSaveInput(input);
  if (!normalized.word) throw new Error("Word is required");

  const rows = await db.all<{ uuid: string }>(
    "SELECT uuid FROM words WHERE word = ? AND deleted_at IS NULL",
    [normalized.word]
  );
  const existingUuid = rows[0]?.uuid;

  if (existingUuid) {
    await updateWordLocal(db, existingUuid, {
      translation: normalized.translation,
      definitions: normalized.definitions,
      examples: normalized.examples,
      phonetic: normalized.phonetic ?? undefined,
      audioUrl: normalized.audioUrl ?? undefined,
      sourceLanguage: normalized.sourceLanguage,
      targetLanguage: normalized.targetLanguage,
    });
    const updated = await db.all(
      "SELECT * FROM words WHERE uuid = ?",
      [existingUuid]
    );
    return wordFromRow(updated[0]);
  }

  const now = new Date().toISOString();
  const row = wordRowFromSave(uuidv7(), normalized, now);
  const op = enqueueOpStep("word", "upsert", { ...wordRowToPayload(row) });
  await db.batch([
    {
      sql: INSERT_WORD_SQL,
      params: [
        row.uuid,
        row.server_id,
        row.word,
        row.translation,
        row.definitions,
        row.examples,
        row.phonetic,
        row.audio_url,
        row.source_language,
        row.target_language,
        row.created_at,
        row.updated_at,
        row.deleted_at,
      ],
    },
    op.step,
  ]);
  return wordFromRow(row);
}

/**
 * Local-first bulk import, mirroring the server's bulk POST semantics:
 * entries missing word/translation fail, existing words count as failed
 * ("Word already exists") and are not overwritten. Every accepted entry
 * becomes one row + one op inside a single batch.
 */
export async function saveWordsLocal(
  db: SqlExecutor,
  entries: SaveWordLocalInput[]
): Promise<SaveWordsResult> {
  const results: SaveWordEntryResult[] = [];
  const inserts: Array<{ row: Record<string, unknown> }> = [];

  const candidates = entries
    .map((entry) => ({ entry, normalized: normalizeSaveInput(entry) }))
    .filter(({ entry, normalized }) => {
      if (normalized.word && normalized.translation) return true;
      results.push({
        word: normalized.word || String((entry as { word?: unknown }).word ?? ""),
        success: false,
        error: "Word and translation are required",
      });
      return false;
    });

  const existingRows =
    candidates.length > 0
      ? await db.all<{ word: string; server_id: number | null }>(
          `SELECT word, server_id FROM words
           WHERE word IN (${placeholders(candidates.length)})
             AND deleted_at IS NULL`,
          candidates.map(({ normalized }) => normalized.word)
        )
      : [];
  const existingWords = new Set(existingRows.map((row) => row.word));
  // The server processes bulk entries sequentially, so an in-batch repeat
  // collides with the first copy; mirror that as a failed entry.
  const seenInBatch = new Set<string>();

  for (const { normalized } of candidates) {
    if (existingWords.has(normalized.word) || seenInBatch.has(normalized.word)) {
      results.push({ word: normalized.word, success: false, error: "Word already exists" });
      continue;
    }
    seenInBatch.add(normalized.word);
    inserts.push({
      row: wordRowFromSave(uuidv7(), normalized, new Date().toISOString()),
    });
    results.push({ word: normalized.word, success: true });
  }

  if (inserts.length > 0) {
    const steps: SqlStep[] = [];
    for (const { row } of inserts) {
      steps.push({
        sql: INSERT_WORD_SQL,
        params: [
          row.uuid,
          row.server_id,
          row.word,
          row.translation,
          row.definitions,
          row.examples,
          row.phonetic,
          row.audio_url,
          row.source_language,
          row.target_language,
          row.created_at,
          row.updated_at,
          row.deleted_at,
        ],
      });
      steps.push(enqueueOpStep("word", "upsert", { ...wordRowToPayload(row) }).step);
    }
    await db.batch(steps);
  }

  const imported = results.filter((r) => r.success).length;
  return {
    imported,
    failed: results.length - imported,
    total: results.length,
    results,
  };
}

/**
 * Locally-created words still missing their server enrichment (saved bare
 * while offline). Oldest first so the backfill drains in save order.
 */
export async function listBareWords(
  db: SqlExecutor,
  limit: number = 3
): Promise<Array<{ uuid: string; word: string; sourceLanguage: string; targetLanguage: string }>> {
  const rows = await db.all<{
    uuid: string;
    word: string;
    source_language: string;
    target_language: string;
  }>(
    `SELECT uuid, word, source_language, target_language FROM words
     WHERE translation = '' AND deleted_at IS NULL
     ORDER BY created_at ASC, rowid ASC LIMIT ?`,
    [limit]
  );
  return rows.map((row) => ({
    uuid: String(row.uuid),
    word: String(row.word),
    sourceLanguage: String(row.source_language || "en"),
    targetLanguage: String(row.target_language || "zh-CN"),
  }));
}
