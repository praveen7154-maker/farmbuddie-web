// GET /alerts (see server.js): the controller's alerts as the bridge stored
// them, so the Irrigo app's Notifications list can catch up on everything
// that happened while the app was closed - including alerts that never
// came as a push (not push-worthy, pushes off, or the push was lost).
// The app pages through with `since` = the last `until`; anything sent
// twice is ignored there (each alert is keyed by its device time).

export const ALERTS_PAGE = 500;
// device_events is kept 15 days (postgres.js), so there's nothing older.
export const MAX_LOOKBACK_MS = 15 * 24 * 3600 * 1000;
// A first call without `since` looks back a week.
export const DEFAULT_LOOKBACK_MS = 7 * 24 * 3600 * 1000;
// Rows stamped in the last few seconds may still be committing, so `until`
// stops short of now and the next call asks for them again.
export const SETTLE_MS = 5000;

/** The `since` (epoch ms) to read from, kept within what's stored. */
export function alertsSince(sinceParam, nowMs) {
  const n = Number(sinceParam);
  const since = Number.isFinite(n) && n > 0 ? n : nowMs - DEFAULT_LOOKBACK_MS;
  return Math.min(Math.max(since, nowMs - MAX_LOOKBACK_MS), nowMs);
}

/** One page of device_events rows -> the response: alerts oldest first, where to continue, and whether there's more. */
export function alertPage(rows, sinceMs, nowMs, pageSize = ALERTS_PAGE) {
  const alerts = rows.flatMap((r) => {
    const motor = (/^motor(\d+)_status$/.exec(r.event_type) || [])[1];
    return motor ? [{ motor, recordedAt: new Date(r.recorded_at).getTime(), alert: r.payload }] : [];
  });
  const more = rows.length >= pageSize;
  // A full page continues 1 ms before its last row (recorded_at is finer
  // than ms, so rows in that same ms aren't skipped - they come again).
  const until = more ? new Date(rows[rows.length - 1].recorded_at).getTime() - 1 : Math.max(sinceMs, nowMs - SETTLE_MS);
  return { alerts, until, more };
}
