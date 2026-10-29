import { test } from "node:test";
import assert from "node:assert/strict";
import { PATTERNS, encode128, bars128 } from "../../public/js/barcode128.js";

// The Production page's serial labels (public/js/labels.js) - a misprinted
// barcode table would make labels no scanner reads, so the table is checked
// against Code 128's own rules, and the encoder by decoding its bars back.

test("Code 128 table follows the symbology's rules", () => {
  assert.equal(PATTERNS.length, 107);
  assert.equal(new Set(PATTERNS).size, 107, "all symbols different");
  PATTERNS.forEach((p, v) => {
    const w = [...p].map(Number);
    const sum = w.reduce((a, b) => a + b, 0);
    if (v === 106) assert.deepEqual([w.length, sum], [7, 13], "stop");
    else assert.deepEqual([w.length, sum], [6, 11], `symbol ${v}`);
    assert.ok(w.every((x) => x >= 1 && x <= 4), `symbol ${v}: widths 1-4`);
    const bars = w.filter((_, i) => i % 2 === 0).reduce((a, b) => a + b, 0);
    assert.equal(bars % 2, 0, `symbol ${v}: even bar modules (parity)`);
  });
});

test("check symbol as the spec computes it", () => {
  const vals = [104, 55, 73, 75, 73, 80, 69, 68, 73, 65];   // Start B + "Wikipedia"
  let s = vals[0];
  vals.slice(1).forEach((x, i) => { s += x * (i + 1); });
  assert.deepEqual(encode128("Wikipedia"), [...vals, s % 103, 106]);
});

const inv = new Map(PATTERNS.map((p, v) => [p, v]));
function decode(text) {
  const { bars } = bars128(text);
  const widths = [];
  bars.forEach(([x, w], i) => { widths.push(w); if (i + 1 < bars.length) widths.push(bars[i + 1][0] - (x + w)); });
  const syms = [];
  for (let i = 0; i < widths.length;) { const n = widths.length - i === 7 ? 7 : 6; syms.push(inv.get(widths.slice(i, i + n).join(""))); i += n; }
  let sum = syms[0];
  for (let k = 1; k < syms.length - 2; k++) sum += syms[k] * k;
  assert.equal(sum % 103, syms.at(-2), "check symbol");
  let set = syms[0] === 105 ? "C" : "B", out = "";
  for (const v of syms.slice(1, -2)) {
    if (v === 99) set = "C"; else if (v === 100) set = "B";
    else out += set === "C" ? String(v).padStart(2, "0") : String.fromCharCode(v + 32);
  }
  return out;
}

test("serials decode back from their bars (digit runs packed in subset C)", () => {
  for (const t of ["IRRIGO26AA10001", "IRRIGOPLUS26PP10001", "IRRIGOSMART26SS10001", "SN-123", "0007", "12345", "A1234567B", "FB-26-0001", "X"]) {
    assert.equal(decode(t), t);
  }
  assert.ok(bars128("IRRIGO26AA10001").modules < bars128("IRRIGO26AA1000X").modules + 20);
  assert.throws(() => encode128("café"));
});
