// node --test server/test  (from the repo root) - GET /alerts paging.
import { test } from "node:test";
import assert from "node:assert/strict";
import { alertsSince, alertPage, DEFAULT_LOOKBACK_MS, MAX_LOOKBACK_MS, SETTLE_MS } from "../src/bridge/alertHistory.js";

const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);

test("since: defaults to a week back and stays within what's stored", () => {
  assert.equal(alertsSince(undefined, NOW), NOW - DEFAULT_LOOKBACK_MS);
  assert.equal(alertsSince("abc", NOW), NOW - DEFAULT_LOOKBACK_MS);
  assert.equal(alertsSince(String(NOW - 3600000), NOW), NOW - 3600000);
  assert.equal(alertsSince("1", NOW), NOW - MAX_LOOKBACK_MS);
  assert.equal(alertsSince(String(NOW + 60000), NOW), NOW);
});

test("page: motor from the event type (others skipped), oldest first, settle margin when it's the last page", () => {
  const rows = [
    { event_type: "motor1_status", recorded_at: new Date(NOW - 7200000), payload: { event: 5, ts: 1 } },
    { event_type: "motor3_status", recorded_at: new Date(NOW - 60000), payload: { event: 9, ts: 2 } },
    { event_type: "motorX_status", recorded_at: new Date(NOW - 30000), payload: { event: 9, ts: 3 } },
  ];
  const page = alertPage(rows, NOW - 86400000, NOW);
  assert.deepEqual(page.alerts.map((a) => [a.motor, a.recordedAt, a.alert.event]), [
    ["1", NOW - 7200000, 5],
    ["3", NOW - 60000, 9],
  ]);
  assert.equal(page.more, false);
  assert.equal(page.until, NOW - SETTLE_MS);
});

test("page: a full page continues just before its last row; an empty page never goes backwards", () => {
  const rows = [1, 2, 3].map((k) => ({ event_type: "motor2_status", recorded_at: new Date(NOW - 10000 + k), payload: { event: 1, ts: k } }));
  const full = alertPage(rows, NOW - 20000, NOW, 3);
  assert.equal(full.more, true);
  assert.equal(full.until, NOW - 10000 + 3 - 1);

  const since = NOW - 1000;
  const empty = alertPage([], since, NOW);
  assert.deepEqual(empty, { alerts: [], until: since, more: false });
});
