// Code 128 barcodes (ISO/IEC 15417) - what every handheld scanner reads.
// Our own small encoder, no library: subset B for text, switching to subset
// C (two digits per symbol) for runs of 4+ digits, which keeps the serial
// numbers' barcodes short enough for a 2 x 1 inch label.

// Bar / space widths (in modules) of symbol values 0-106; each symbol is
// 3 bars + 3 spaces = 11 modules (the stop, 106, is 13 with its final bar).
export const PATTERNS = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
  "114131", "311141", "411131", "211412", "211214", "211232", "2331112"
];
const START_B = 104, START_C = 105, CODE_B = 100, CODE_C = 99, STOP = 106;

const digitRun = (s, i) => { let n = 0; while (i + n < s.length && s[i + n] >= "0" && s[i + n] <= "9") n++; return n; };

/** Symbol values for `text` (printable ASCII), check symbol and stop included. */
export function encode128(text) {
  const s = String(text);
  if (!s.length || /[^\x20-\x7e]/.test(s)) throw new Error("Code 128: printable ASCII only");
  const out = [];
  let i = 0;
  let set;
  // Starting with 4+ digits: start in C (an odd last digit drops back to B).
  if (digitRun(s, 0) >= 4) { set = "C"; out.push(START_C); }
  else { set = "B"; out.push(START_B); }
  while (i < s.length) {
    const run = digitRun(s, i);
    if (set === "C") {
      if (run >= 2) { out.push(Number(s.substr(i, 2))); i += 2; continue; }
      out.push(CODE_B); set = "B";
      continue;
    }
    // In B: a run of 4+ digits goes to C (an odd one keeps its first digit in B).
    if (run >= 4) {
      if (run % 2 === 1) { out.push(s.charCodeAt(i) - 32); i++; }
      out.push(CODE_C); set = "C";
      continue;
    }
    out.push(s.charCodeAt(i) - 32);
    i++;
  }
  let sum = out[0];
  for (let k = 1; k < out.length; k++) sum += out[k] * k;
  out.push(sum % 103, STOP);
  return out;
}

/** Bars as [x, width] in modules, and the total width in modules. */
export function bars128(text) {
  const bars = [];
  let x = 0;
  for (const v of encode128(text)) {
    const p = PATTERNS[v];
    for (let k = 0; k < p.length; k++) {
      const w = Number(p[k]);
      if (k % 2 === 0) bars.push([x, w]);
      x += w;
    }
  }
  return { bars, modules: x };
}

/** An SVG of the barcode, `widthMm` x `heightMm` (bars only, no quiet zone). */
export function svg128(text, widthMm, heightMm) {
  const { bars, modules } = bars128(text);
  const rects = bars.map(([x, w]) => `<rect x="${x}" y="0" width="${w}" height="1"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${modules} 1" preserveAspectRatio="none" ` +
    `width="${widthMm}mm" height="${heightMm}mm" shape-rendering="crispEdges" role="img" aria-label="${String(text).replace(/[<>&"]/g, "")}">` +
    `<g fill="#000">${rects}</g></svg>`;
}
