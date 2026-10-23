import express from "express";

// Admin panel > Event Log. Each V2 hub keeps a "black box" in its own EEPROM
// (Motor repo, event_log.h): a warranty card (serial, install date, firmware
// history), lifetime counters and the last ~476 events. Nothing is uploaded
// by the hub on its own - this module asks for it when an admin opens the
// page, over the hub's normal command topic:
//   eventlog_info                  -> reply carries "info" (card + counters)
//   eventlog_read {from, max}      -> reply carries "rec" (raw 16-byte records, hex)
//   eventlog_set_serial {serial}   -> write-once on the hub
// and waits for the hub's reply on its response topic (matched by id). The
// page decodes the records itself (public/js/eventlog-decode.js). The log is
// never cleared from here - only at the hub's service console.
//
// publishCommand is injected so this can be tested without MQTT - see
// createEventLogModule().

const FARM_RE = /^\d{1,6}$/;
const NODE_RE = /^[A-Za-z0-9_-]{1,32}$/;
export const SERIAL_RE = /^IRRIGO\d{2}[A-Z]{2}\d{5}$/;
// A GSM hub answers in a few seconds; a busy or weak link takes longer.
const DEFAULT_TIMEOUT_MS = 45000;
const MAX_PAGE = 40;

const HUB_ERRORS = {
  no_eeprom: [404, "This hub has no event log (V1 board, or its EEPROM is missing)"],
  loading: [503, "The hub is still loading its log after a restart - try again in a few seconds"],
  serial_already_set: [409, "This hub already has a serial number - it can only be changed at the hub's service console"],
  bad_serial_format: [400, "Serial format: IRRIGO + year (2 digits) + series (2 letters) + unit (5 digits), e.g. IRRIGO26AA10001"],
  bad_test_result: [400, "Test result must be pass or fail"],
  eeprom_read_error: [502, "The hub could not read its EEPROM at boot - restart it and try again"],
  unknown_cmd: [501, "This hub's firmware has no event log - update it first"]
};

export function createEventLogModule({ publishCommand, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const pending = new Map();   // "farmId|id" -> { resolve, timer }
  let counter = 0;

  // Below 2^53, so it survives JSON both ways; the hub echoes it back.
  const nextId = () => Date.now() * 1000 + (counter++ % 1000);

  function ask(farmId, nodeId, payload) {
    const id = nextId();
    const key = `${farmId}|${id}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(key);
        const err = new Error(`No reply from the hub in ${Math.round(timeoutMs / 1000)} s - is it online?`);
        err.status = 504;
        reject(err);
      }, timeoutMs);
      pending.set(key, { resolve, timer });
      Promise.resolve()
        .then(() => publishCommand(farmId, nodeId, "1", { ...payload, id }))
        .catch((e) => {
          clearTimeout(timer);
          pending.delete(key);
          const err = new Error("Bridge is not connected to the broker - try again shortly");
          err.status = 503;
          err.cause = e;
          reject(err);
        });
    });
  }

  // Called for every message on a motor response topic (mqttBridge.js).
  // True = it was an event log reply: handled here, not stored or sent to
  // the farm's phones.
  function handleResponse(farmId, nodeId, payload) {
    if (!payload || typeof payload !== "object" || typeof payload.cmd !== "string" ||
        !payload.cmd.startsWith("eventlog_")) return false;
    const key = `${farmId}|${payload.id}`;
    const p = pending.get(key);
    if (p) {
      clearTimeout(p.timer);
      pending.delete(key);
      p.resolve(payload);
    }
    return true;
  }

  function target(req, res) {
    const farmId = String(req.params.farmId || "");
    const nodeId = String(req.query.node || req.body?.node || "MOTOR_1");
    if (!FARM_RE.test(farmId) || !NODE_RE.test(nodeId)) {
      res.status(400).json({ error: "Invalid farm or node" });
      return null;
    }
    return { farmId, nodeId };
  }

  async function relay(res, farmId, nodeId, payload, pick) {
    try {
      const reply = await ask(farmId, nodeId, payload);
      if (!reply.ok) {
        const [status, message] = HUB_ERRORS[reply.error] || [502, `The hub refused: ${reply.error || "unknown error"}`];
        return res.status(status).json({ error: message, code: reply.error || null, info: reply.info || null });
      }
      return res.json({ ok: true, ...pick(reply) });
    } catch (err) {
      if (!err.status) console.error("[eventlog] request failed:", err);
      return res.status(err.status || 500).json({ error: err.message || "Request failed" });
    }
  }

  const adminRouter = express.Router();
  adminRouter.use(express.json({ limit: "4kb" }));

  // GET /event-log/:farmId/info?node=MOTOR_1 - warranty card + counters.
  adminRouter.get("/:farmId/info", async (req, res) => {
    const t = target(req, res);
    if (!t) return;
    await relay(res, t.farmId, t.nodeId, { cmd: "eventlog_info" }, (r) => ({ info: r.info || {} }));
  });

  // GET /event-log/:farmId/records?node=MOTOR_1&from=1&max=40 - one page
  // of raw records, oldest first; the page keeps asking while "more".
  adminRouter.get("/:farmId/records", async (req, res) => {
    const t = target(req, res);
    if (!t) return;
    const from = Number(req.query.from ?? 1);
    const max = Number(req.query.max ?? MAX_PAGE);
    if (!Number.isInteger(from) || from < 1 || from > 0xffffffff || !Number.isInteger(max) || max < 1 || max > MAX_PAGE) {
      return res.status(400).json({ error: "Invalid from/max" });
    }
    await relay(res, t.farmId, t.nodeId, { cmd: "eventlog_read", from, max }, (r) => ({
      rec: Array.isArray(r.rec) ? r.rec.filter((h) => typeof h === "string" && /^[0-9a-f]{32}$/.test(h)) : [],
      next: r.next, more: !!r.more, oldest: r.oldest, newest: r.newest, records: r.records
    }));
  });

  // POST /event-log/:farmId/serial {node, serial, test} - write-once.
  adminRouter.post("/:farmId/serial", async (req, res) => {
    const t = target(req, res);
    if (!t) return;
    const serial = String(req.body?.serial || "").trim().toUpperCase();
    const testResult = String(req.body?.test || "");
    if (!SERIAL_RE.test(serial)) return res.status(400).json({ error: HUB_ERRORS.bad_serial_format[1] });
    if (!["", "pass", "fail"].includes(testResult)) return res.status(400).json({ error: HUB_ERRORS.bad_test_result[1] });
    await relay(res, t.farmId, t.nodeId, { cmd: "eventlog_set_serial", serial, test: testResult }, (r) => ({ info: r.info || {} }));
  });

  return { adminRouter, handleResponse, pendingCount: () => pending.size };
}
