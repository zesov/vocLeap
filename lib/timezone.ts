/**
 * User-local day-boundary helpers.
 *
 * The database stores UTC instants (`YYYY-MM-DD HH:MM:SS`). "Due at the
 * user's local midnight" is resolved here into the exact UTC instant at
 * write time, so the read-side `next_review_date <= datetime('now')`
 * comparisons (UTC vs UTC) stay correct without any SQL change.
 */

/**
 * Offset of `timeZone` at `date`, in milliseconds, such that
 * `date.getTime() + offset` equals the zone's wall-clock time read as if it
 * were UTC (i.e. localWallAsUtc - utc).
 */
function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);

  const values: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }

  const wallAsUtc = Date.UTC(
    values.year,
    values.month - 1,
    values.day,
    values.hour,
    values.minute,
    values.second
  );
  return wallAsUtc - date.getTime();
}

/**
 * The UTC instant of local midnight in `timeZone` on the calendar date
 * `days` after `date`'s local date there. Arithmetic happens on wall-clock
 * fields, so month/year roll over correctly and DST transitions cannot move
 * the boundary off midnight.
 */
export function addCalendarDaysInZone(
  timeZone: string,
  date: Date,
  days: number
): Date {
  // en-CA formats as ISO-like "YYYY-MM-DD".
  const local = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
  const [year, month, day] = local.split("-").map(Number);

  // Target local midnight, first written as if the wall clock were UTC.
  const wallAsUtc = Date.UTC(year, month - 1, day + days);
  // Resolve the zone offset at the target instant; correcting twice makes
  // instants right at a DST transition converge.
  const offset = getTimeZoneOffsetMs(new Date(wallAsUtc), timeZone);
  const timestamp = wallAsUtc - getTimeZoneOffsetMs(new Date(wallAsUtc - offset), timeZone);
  return new Date(timestamp);
}

/**
 * Returns `input` unchanged when it is a supported IANA time zone name,
 * otherwise null. Guards unvalidated client input before it reaches
 * Intl-based date math.
 */
export function resolveClientTimezone(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: trimmed });
  } catch {
    return null;
  }
  return trimmed;
}
