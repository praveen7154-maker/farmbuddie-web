import { fmtIstDateTime } from "./time-format.js";
// Decodes a hub's raw event log records (Motor repo, include/event_log.h) -
// used by the admin Event Log page and the bridge's tests. Same tables as
// the firmware's codeName()/describe() and tools/hub_eventlog.py.
//
// Record (16 bytes, little endian): seq u32 | ts u32 | code u8 | unit u8 |
// flags u8 | value u16 | aux u16 | crc8 (poly 0x07, init 0, bytes 0-14).

export const CODES = {
  1: "Dry run", 2: "Overload", 3: "Low voltage", 4: "High voltage", 5: "Phase loss", 6: "Phase imbalance",
  7: "Phase order reversed", 11: "Power cut", 12: "Power back", 16: "Started at panel", 17: "Fault cleared", 18: "Cyclic interrupted",
  19: "Cyclic resumed", 20: "Cyclic complete", 22: "Stop not confirmed", 23: "GSM/WiFi switched",
  24: "Phase restored", 25: "Dry run auto restart", 26: "Phase mode switched", 27: "Start retry",
  28: "Stop retry", 29: "Stopped at panel", 30: "Cyclic paused (panel stop)", 31: "Motor started",
  32: "Motor stopped", 33: "Cyclic started", 34: "Dry run limit", 35: "Overload limit",
  39: "Valve cmd failed", 40: "Valve program started", 44: "Valve program interrupted",
  45: "Valve program resumed", 46: "Valve program complete", 47: "Valve program paused",
  51: "Valve not open - no start", 53: "Valve skipped", 54: "All valves failed", 55: "Two valves open",
  57: "Valve closed mid run", 58: "Backwash started", 60: "Backwash valves failed",
  62: "Backwash timed out", 63: "Backwash complete", 64: "Voltage restored", 65: "Restarted while running",
  66: "Load limit stop", 67: "Load limit blocked", 68: "Schedule not started", 69: "Valve did not open",
  70: "Valve not opening", 71: "Phase order OK",
  128: "Boot", 129: "Firmware changed", 130: "OTA start", 131: "OTA failed", 132: "OTA ok",
  133: "OTA rollback", 134: "Cloud back", 135: "Node offline", 136: "Node online", 137: "Node OTA ok",
  138: "Node OTA failed", 139: "EEPROM error", 140: "RTC error", 141: "Clock corrected",
  142: "Log cleared", 143: "Serial set", 144: "Service mode", 145: "Records skipped",
  146: "Calibration changed", 147: "Calibration restored", 148: "Installed", 149: "Farm changed",
  150: "App motor command"
};

// Kept in the hub's "critical" ring - never pushed out by routine events.
export const CRITICAL = new Set([1, 2, 3, 4, 5, 6, 22, 34, 35, 54, 55, 57, 65, 128, 129, 130, 131, 132, 133,
  137, 138, 139, 140, 142, 143, 146, 147, 148, 149]);
// Shown in red: something went wrong (not just "a reset happened").
export const FAULTS = new Set([1, 2, 3, 4, 5, 6, 22, 34, 35, 54, 55, 57, 65, 131, 133, 138, 139, 140]);

const RESET_REASONS = ["unknown", "power on", "reset pin", "software", "crash", "interrupt watchdog",
  "task watchdog", "watchdog", "deep sleep", "brownout", "sdio", "usb", "jtag", "efuse", "power glitch", "cpu lockup"];
const RESTART_CAUSES = { 0: "", 1: "app reboot", 2: "GSM task hung", 3: "memory low", 4: "cloud offline too long",
  5: "MQTT task hung", 6: "node update staged", 7: "OTA failed", 8: "OTA rollback", 9: "OTA update",
  10: "safety task failed", 11: "SMS task hung", 12: "valve config changed",
  // Task watchdog resets - which task froze (hub Watchdog::lastHang()).
  13: "main loop froze", 14: "safety task froze", 15: "mesh task froze", 16: "froze while starting up",
  17: "CPU 0 overloaded", 18: "several tasks froze", 19: "event log writer stuck",
  20: "mesh task failed to start", 255: "other" };
const OTA_ERRORS = { 0: "error", 1: "busy", 2: "motor running", 3: "bad request", 4: "signature", 5: "download",
  6: "checksum", 7: "flash write", 8: "wrong chip", 9: "no units", 10: "did not validate" };
const LINKS = { 1: "WiFi mesh", 2: "LoRa", 3: "RS485" };
const FLAG_UPTIME = 0x01, FLAG_RUNNING = 0x02, FLAG_ONLINE = 0x04;

export function crc8(bytes) {
  let c = 0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
  }
  return c;
}

export const version = (v) => (v === 0 ? "?" : `${Math.floor(v / 10000)}.${Math.floor(v / 100) % 100}.${v % 100}`);

export function unitName(u) {
  if (u === 0) return "Hub";
  if (u < 16) return `Motor ${u}`;
  if (u > 0x80 && u <= 0x80 + 64) return `Valve ${u - 0x80}`;
  return `Unit ${u}`;
}

function duration(sec) {
  if (sec < 120) return `${sec}s`;
  if (sec < 7200) return `${Math.floor(sec / 60)} min`;
  return `${Math.floor(sec / 3600)} h ${Math.floor((sec % 3600) / 60)} min`;
}

export function describe(code, value, aux) {
  switch (code) {
    case 1: case 2: return `${(value / 100).toFixed(2)} A (limit ${(aux / 100).toFixed(2)} A)`;
    case 3: case 4: return `${value} V (limit ${aux} V)`;
    case 5: case 6: return `lowest ${value} V, highest ${aux} V`;
    case 128: {
      const cause = RESTART_CAUSES[aux] ?? "other";
      return (RESET_REASONS[value] || "unknown") + (cause ? ` - ${cause}` : "");
    }
    case 129: return `${version(aux)} -> ${version(value)}`;
    case 130: case 132: case 137: return `v${version(value)}`;
    case 133: return `back on v${version(value)}`;
    case 131: return `${OTA_ERRORS[value] || "error"} (v${version(aux)})`;
    case 138: return `v${version(value)} - ${OTA_ERRORS[aux] || "error"}`;
    case 134: return `offline ${duration(value === 65535 && aux ? aux * 60 : value)}`;
    case 135: return (value > 1 ? `${value} valves, ` : "") + (LINKS[aux] || "");
    case 136: return `after ${duration(value)}${value === 65535 ? "+" : ""}, ${LINKS[aux] || ""}`;
    case 139: return aux === 1 ? "read error at boot" : `${value} failed writes`;
    case 140: return value === 1 ? "RTC not found" : "lost time - check backup cell";
    case 141: return `moved ${aux ? "back " : ""}${value} min`;
    case 142: return aux === 1 ? "counters reset" : `${value} records erased`;
    case 143: return `test ${value === 1 ? "PASS" : value === 2 ? "FAIL" : "not recorded"}`;
    case 145: return `${value} records skipped (hourly limit)`;
    case 148: return `farm ${value}`;
    case 149: return `farm ${aux} -> ${value}`;
    case 150: return (value ? "ON" : "OFF") + (aux ? " - refused" : "");
    case 144: case 146: case 147: return "";
    default: return value === 0 && aux === 0 ? "" : `${value} V, ${(aux / 100).toFixed(2)} A`;
  }
}

// "22 Oct 2026, 6:05:33 PM" in IST (the farms' time), whatever the viewer's zone.
export function istTime(unix) {
  return fmtIstDateTime(unix * 1000, { seconds: true });
}

// One record from its 32 hex characters; null if empty or corrupt.
export function decodeRecord(hex) {
  if (typeof hex !== "string" || !/^[0-9a-fA-F]{32}$/.test(hex)) return null;
  const b = new Uint8Array(16);
  for (let i = 0; i < 16; i++) b[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  if (crc8(b.subarray(0, 15)) !== b[15]) return null;
  const dv = new DataView(b.buffer);
  const seq = dv.getUint32(0, true);
  const ts = dv.getUint32(4, true);
  const code = b[8], unit = b[9], flags = b[10];
  const value = dv.getUint16(11, true), aux = dv.getUint16(13, true);
  if (seq === 0 || seq === 0xffffffff || code === 0) return null;
  const clockSet = !(flags & FLAG_UPTIME);
  return {
    seq,
    unix: clockSet ? ts : 0,
    time: clockSet ? istTime(ts) : `boot +${ts}s`,
    code,
    event: CODES[code] || `Event ${code}`,
    unit: unitName(unit),
    unitId: unit,
    value,
    aux,
    details: describe(code, value, aux),
    kind: CRITICAL.has(code) ? "critical" : "routine",
    fault: FAULTS.has(code),
    motorRunning: !!(flags & FLAG_RUNNING),
    cloudOnline: !!(flags & FLAG_ONLINE),
    raw: hex.toLowerCase()
  };
}
