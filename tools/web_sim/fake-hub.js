// A hub answering the Event Log page (eventlog_info / eventlog_read /
// eventlog_set_serial) for the web simulation: 60 records, as the Motor
// firmware's EventLog would hold them, incl. the butterfly "valve stuck".
import { crc8 } from "../../public/js/eventlog-decode.js";

const T0 = Math.floor(Date.UTC(2026, 10, 1, 4, 0, 0) / 1000);
function record(seq, ts, code, unit, value, aux) {
  const b = Buffer.alloc(16);
  b.writeUInt32LE(seq, 0); b.writeUInt32LE(ts, 4); b[8] = code; b[9] = unit; b[10] = 0;
  b.writeUInt16LE(value, 11); b.writeUInt16LE(aux, 13);
  b[15] = crc8(new Uint8Array(b.subarray(0, 15)));
  return b.toString("hex");
}
const CODES = [128, 11, 12, 31, 32, 1, 17, 48, 49, 72, 69, 70, 135, 136, 3, 64];
const RECORDS = Array.from({ length: 60 }, (_, i) => {
  const code = CODES[i % CODES.length];
  const [value, aux] = code === 72 ? [9, i % 2] : code === 1 ? [210, 900] : code === 3 ? [178, 180] : code === 128 ? [1, 0] : [232, 450];
  return record(i + 1, T0 + i * 600, code, code === 72 ? 0x80 + 9 : 0, value, aux);
});
const cards = new Map();
export function hubReply(farmId, p) {
  if (farmId === "0999") return null;           // a hub that never answers (offline)
  const card = cards.get(farmId) || { serial: "", board: "v2-s3", mfg_test: "unknown", fw: [{ v: "1.0.1", since: T0 }] };
  cards.set(farmId, card);
  if (p.cmd === "eventlog_info") {
    return { ok: true, info: { eeprom: true, ready: true, ...card, farm: Number(farmId), counters: { run_sec: 7200, starts: 14, faults: 3, power_cuts: 2 }, records: RECORDS.length } };
  }
  if (p.cmd === "eventlog_read") {
    const from = Math.max(1, p.from || 1);
    const rec = RECORDS.slice(from - 1, from - 1 + (p.max || 40));
    const next = from + rec.length;
    return { ok: true, rec, next, more: next <= RECORDS.length, oldest: 1, newest: RECORDS.length, records: RECORDS.length };
  }
  if (p.cmd === "eventlog_set_serial") {
    if (card.serial) return { ok: false, error: "serial_already_set" };
    card.serial = p.serial; card.mfg_test = p.test || "unknown";
    return { ok: true, info: { ...card } };
  }
  return { ok: false, error: "unknown_cmd" };
}
