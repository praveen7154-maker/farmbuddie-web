import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { createEventLogModule } from "../src/bridge/eventLog.js";
import { decodeRecord, crc8 } from "../../public/js/eventlog-decode.js";

// A fake hub: answers each published command through handleResponse(), the
// way mqttBridge.js hands over the hub's reply on its response topic.
async function withServer(hub, fn, { timeoutMs = 2000 } = {}) {
  const published = [];
  let mod;
  const publishCommand = async (farmId, nodeId, motorNum, payload) => {
    published.push({ farmId, nodeId, motorNum, payload });
    const reply = hub(payload);
    if (reply) setTimeout(() => mod.handleResponse(farmId, nodeId, { cmd: payload.cmd, id: payload.id, ...reply }), 5);
  };
  mod = createEventLogModule({ publishCommand, timeoutMs });
  const app = express();
  app.use("/event-log", mod.adminRouter);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = "GET", body } = {}) => {
    const r = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body && JSON.stringify(body)
    });
    return { status: r.status, body: await r.json() };
  };
  try { await fn({ call, published, mod }); } finally { server.close(); }
}

test("info: asks the hub, returns its card", async () => {
  await withServer(() => ({ ok: true, info: { serial: "IRRIGO26AA10001", counters: { run_sec: 3600 } } }), async ({ call, published }) => {
    const r = await call("/event-log/123/info?node=MOTOR_1");
    assert.equal(r.status, 200);
    assert.equal(r.body.info.serial, "IRRIGO26AA10001");
    assert.equal(published.length, 1);
    assert.equal(published[0].farmId, "123");
    assert.equal(published[0].motorNum, "1");
    assert.equal(published[0].payload.cmd, "eventlog_info");
    assert.ok(Number.isSafeInteger(published[0].payload.id));
  });
});

test("records: paging fields passed through, bad hex dropped", async () => {
  const hub = (p) => ({ ok: true, rec: ["0400000000c0cf6a020100ce04e8032c", "zz", 5], next: p.from + 1, more: true, newest: 9, oldest: 1, records: 9 });
  await withServer(hub, async ({ call, published }) => {
    const r = await call("/event-log/7/records?from=4&max=40");
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.rec, ["0400000000c0cf6a020100ce04e8032c"]);
    assert.equal(r.body.next, 5);
    assert.equal(r.body.more, true);
    assert.deepEqual(published[0].payload.cmd, "eventlog_read");
    assert.equal(published[0].payload.from, 4);
    assert.equal(published[0].payload.max, 40);
  });
});

test("bad input refused before anything is sent", async () => {
  await withServer(() => ({ ok: true }), async ({ call, published }) => {
    assert.equal((await call("/event-log/abc/info")).status, 400);
    assert.equal((await call("/event-log/1/info?node=a/b")).status, 400);
    assert.equal((await call("/event-log/1/records?from=0")).status, 400);
    assert.equal((await call("/event-log/1/records?max=41")).status, 400);
    assert.equal((await call("/event-log/1/serial", { method: "POST", body: { serial: "IRRIGO26A10001" } })).status, 400);
    assert.equal((await call("/event-log/1/serial", { method: "POST", body: { serial: "IRRIGO26AA10001", test: "maybe" } })).status, 400);
    assert.equal(published.length, 0);
  });
});

test("serial: upper-cased, write-once error mapped", async () => {
  await withServer((p) => (p.serial === "IRRIGO26AA10001" ? { ok: false, error: "serial_already_set" } : { ok: true, info: { serial: p.serial } }),
    async ({ call, published }) => {
      const ok = await call("/event-log/1/serial", { method: "POST", body: { serial: "irrigo26ab00042", test: "pass" } });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.info.serial, "IRRIGO26AB00042");
      assert.equal(published[0].payload.test, "pass");
      const dup = await call("/event-log/1/serial", { method: "POST", body: { serial: "IRRIGO26AA10001" } });
      assert.equal(dup.status, 409);
      assert.match(dup.body.error, /service console/);
    });
});

test("hub errors and silence become clear messages", async () => {
  await withServer(() => ({ ok: false, error: "no_eeprom" }), async ({ call }) => {
    const r = await call("/event-log/1/info");
    assert.equal(r.status, 404);
    assert.match(r.body.error, /no event log/);
  });
  await withServer(() => ({ ok: false, error: "unknown_cmd" }), async ({ call }) => {
    assert.equal((await call("/event-log/1/info")).status, 501);
  });
  await withServer(() => null, async ({ call, mod }) => {
    const r = await call("/event-log/1/info");
    assert.equal(r.status, 504);
    assert.equal(mod.pendingCount(), 0);
  }, { timeoutMs: 100 });
});

test("only event log replies are taken from the response topic", async () => {
  await withServer(() => null, async ({ mod }) => {
    assert.equal(mod.handleResponse("1", "MOTOR_1", { cmd: "motor_on", id: 5, ok: true }), false);
    assert.equal(mod.handleResponse("1", "MOTOR_1", { type: "config_safety" }), false);
    assert.equal(mod.handleResponse("1", "MOTOR_1", null), false);
    // A late reply nobody waits for any more: still not passed on to phones.
    assert.equal(mod.handleResponse("1", "MOTOR_1", { cmd: "eventlog_read", id: 99, ok: true }), true);
  });
});

test("publish failure: 503, nothing left waiting", async () => {
  const publishCommand = async () => { throw new Error("Bridge is not connected to TBMQ"); };
  const mod = createEventLogModule({ publishCommand, timeoutMs: 1000 });
  const app = express();
  app.use("/event-log", mod.adminRouter);
  const server = app.listen(0);
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/event-log/1/info`);
    assert.equal(r.status, 503);
    assert.equal(mod.pendingCount(), 0);
  } finally { server.close(); }
});

// Vectors written by the hub firmware itself (Motor repo,
// tools/eventlog_host_test), decoded there by tools/hub_eventlog.py - the
// page must read them the same way.
test("decoder matches the firmware's records", () => {
  const vectors = [
    ["0100000000c0cf6a8100001127000085", 1, "Firmware changed", "Hub", "? -> 1.0.1"],
    ["0200000000c0cf6a80000001000000b0", 2, "Boot", "Hub", "power on"],
    ["0300000000c0cf6a8f000001000000fc", 3, "Serial set", "Hub", "test PASS"],
    ["0400000000c0cf6a020100ce04e8032c", 4, "Overload", "Motor 1", "12.30 A (limit 10.00 A)"],
    ["0900000000c0cf6a87850004000200cd", 9, "Node offline", "Valve 5", "4 valves, LoRa"]
  ];
  for (const [hex, seq, event, unit, details] of vectors) {
    const r = decodeRecord(hex);
    assert.ok(r, hex);
    assert.equal(r.seq, seq);
    assert.equal(r.event, event);
    assert.equal(r.unit, unit);
    assert.equal(r.details, details);
    assert.equal(r.time, "2026-10-14 23:16:40");
  }
  assert.equal(decodeRecord("0400000000c0cf6a020100ce04e8032c").kind, "critical");
  assert.equal(decodeRecord("0900000000c0cf6a87850004000200cd").kind, "routine");
  // One flipped bit, a blank slot, junk: rejected.
  assert.equal(decodeRecord("0400000000c0cf6a020100ce04e8032d"), null);
  assert.equal(decodeRecord("ffffffffffffffffffffffffffffffff"), null);
  assert.equal(decodeRecord("xyz"), null);
  assert.equal(crc8([]), 0);
});
