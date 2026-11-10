export interface SyncCursor {
  /** Highest words.updated_at seen (ISO-8601, may also be SQLite DATETIME). */
  wTs: string;
  /** words.id tie-breaker for equal timestamps. */
  wId: number;
  /** Highest reviews.updated_at seen. */
  rTs: string;
  /** reviews.id tie-breaker. */
  rId: number;
  /** Highest review_history.id seen. */
  hId: number;
}

export const ZERO_CURSOR: SyncCursor = {
  wTs: "1970-01-01T00:00:00.000Z",
  wId: 0,
  rTs: "1970-01-01T00:00:00.000Z",
  rId: 0,
  hId: 0,
};

function toBase64Url(json: string): string {
  return globalThis
    .btoa(json)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  return globalThis.atob(
    padded + "=".repeat((4 - (padded.length % 4)) % 4)
  );
}

function nonNegativeInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

export function encodeCursor(cursor: SyncCursor): string {
  return toBase64Url(JSON.stringify(cursor));
}

/** Invalid cursors degrade to the zero cursor: a full bootstrap pull, never an error. */
export function decodeCursor(raw: string | null | undefined): SyncCursor {
  if (!raw) return ZERO_CURSOR;
  try {
    const parsed = JSON.parse(fromBase64Url(raw)) as Partial<SyncCursor>;
    const wId = nonNegativeInt(parsed.wId);
    const rId = nonNegativeInt(parsed.rId);
    const hId = nonNegativeInt(parsed.hId);
    if (
      !isTimestamp(parsed.wTs) ||
      !isTimestamp(parsed.rTs) ||
      wId === null ||
      rId === null ||
      hId === null
    ) {
      return ZERO_CURSOR;
    }
    return { wTs: parsed.wTs, wId, rTs: parsed.rTs, rId, hId };
  } catch {
    return ZERO_CURSOR;
  }
}
