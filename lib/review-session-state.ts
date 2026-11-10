/**
 * Session-state freshness rules for the review queue.
 *
 * The review session persists per-word positions plus an aggregate
 * reviewedCount (localStorage + server sync) so a reload can resume
 * mid-session. That state is only meaningful within the same calendar day:
 * on a new local day the due backlog is a new session, and resurrecting
 * yesterday's reviewedCount would produce phantom totals that mix two
 * batches (e.g. "Card 46 of 95" counting yesterday's work against today's
 * queue). These helpers decide when saved state must be dropped.
 */

/** True when both instants fall on the same calendar day in the device's
 * local timezone. The review page runs client-side, so the device timezone
 * is the user's timezone. */
export function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * True when saved session state should be discarded instead of restored:
 * its last update is from an earlier local calendar day, or it cannot be
 * parsed. A future updatedAt (device clock ran ahead) is kept — dropping
 * state over clock skew would lose real progress.
 */
export function isSessionStateStale(
  state: { updatedAt: string },
  now: Date = new Date()
): boolean {
  const updated = new Date(state.updatedAt);
  if (Number.isNaN(updated.getTime())) return true;
  return !isSameLocalDay(updated, now) && updated.getTime() < now.getTime();
}
