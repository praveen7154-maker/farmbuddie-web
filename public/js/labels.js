// Serial number labels for new controllers - 2 x 1 inch (50.8 x 25.4 mm),
// one label per printed page, for label printers (TSC, Zebra, TVS, Xprinter
// ... set to 2 x 1 in labels). By default two of each: one for the module
// box, one for the carton.
//
//               FARM BUDDIE · IRRIGO PLUS
//   ||| ||||| || |||| ||| || ||||| || | ||| ||
//              IRRIGOPLUS26PP10001
//
// Nodes (motor, valve ... nodes) get a QR label instead - the QR holds the
// serial, which is also printed large beside it:
//
//   ▛▀▀▀▜   FARM BUDDIE
//   ▌QR ▐   MOTOR NODE
//   ▙▄▄▄▟   FBMN2610001
//
// Printed through the browser's print dialog (choose the label printer
// there once - Chrome remembers it). Started with --kiosk-printing, Chrome
// prints straight to the default printer without asking.
import { bars128 } from "/js/barcode128.js";
import { qrSvg } from "/js/qr-lib.js";
import { nodeTypeName } from "/js/node-types.js";

const LABEL_W = 50.8, LABEL_H = 25.4;          // mm
const QUIET = 2.0;                              // mm of white each side of the bars (scanners need it)
const VARIANT_NAMES = { IRRIGO: "IRRIGO", IRRIGO_PLUS: "IRRIGO PLUS", IRRIGO_SMART_PLUS: "IRRIGO SMART PLUS" };

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function barcodeSvg(text) {
  const { bars, modules } = bars128(text);
  // As wide as the label allows; a narrow bar ("module") of at most 0.33 mm.
  const width = Math.min(LABEL_W - 2 * QUIET, modules * 0.33);
  const rects = bars.map(([x, w]) => `<rect x="${x}" y="0" width="${w}" height="10"/>`).join("");
  return `<svg class="bc" viewBox="0 0 ${modules} 10" preserveAspectRatio="none" style="width:${width.toFixed(2)}mm"` +
    ` shape-rendering="crispEdges" aria-hidden="true"><g fill="#000">${rects}</g></svg>`;
}

/** The label sheet's HTML: each controller, `copies` times. */
export function labelsHtml(controllers, copies = 2) {
  const one = (c) => `
    <section class="label">
      <header><b>FARM BUDDIE</b>${c.variant ? ` · ${esc(VARIANT_NAMES[c.variant] || c.variant)}` : ""}</header>
      ${barcodeSvg(c.serialNumber)}
      <div class="sn">${esc(c.serialNumber)}</div>
    </section>`;
  const pages = controllers.flatMap((c) => Array.from({ length: Math.max(1, copies) }, () => one(c))).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Labels</title><style>
    @page { size: ${LABEL_W}mm ${LABEL_H}mm; margin: 0; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { background: #fff; color: #000; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    body { font-family: "Segoe UI", Roboto, Arial, sans-serif; }
    .label {
      width: ${LABEL_W}mm; height: ${LABEL_H}mm; padding: 1.6mm ${QUIET}mm 1.4mm;
      display: flex; flex-direction: column; align-items: center; justify-content: space-between;
      overflow: hidden; page-break-after: always; break-after: page;
    }
    .label:last-child { page-break-after: auto; break-after: auto; }
    header { width: 100%; text-align: center; font-size: 6.4pt; line-height: 1; letter-spacing: 0.06em;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    header b { font-weight: 800; }
    .bc { display: block; height: 12.2mm; }
    .sn { font: 700 9.5pt/1 "Consolas", "Roboto Mono", "DejaVu Sans Mono", monospace; letter-spacing: 0.08em; white-space: nowrap; }
    @media screen { body { background: #ccc; padding: 8px; } .label { background: #fff; margin: 0 auto 8px; box-shadow: 0 1px 4px rgba(0,0,0,.3); } }
  </style></head><body>${pages}</body></html>`;
}

/** The node label sheet's HTML: each node, `copies` times. qrs: serial -> QR SVG. */
export function nodeLabelsHtml(nodes, copies = 2, qrs = {}) {
  const QR = LABEL_H - 3.2;                     // mm, the label's height less its top + bottom padding
  const TEXT_W = LABEL_W - 2 * QUIET - QR - 1.6;
  // The serial as large as fits beside the QR (monospace: ~0.62 em per character).
  const snSize = (sn) => Math.min(11, (TEXT_W / (Math.max(8, sn.length) * 0.62)) * 2.835).toFixed(2);
  const one = (n) => `
    <section class="label node">
      ${qrs[n.serialNumber] || ""}
      <div class="txt">
        <b class="brand">FARM BUDDIE</b>
        <span class="type">${esc(nodeTypeName(n.type).toUpperCase())}</span>
        <span class="nsn" style="font-size:${snSize(n.serialNumber)}pt">${esc(n.serialNumber)}</span>
      </div>
    </section>`;
  const pages = nodes.flatMap((n) => Array.from({ length: Math.max(1, copies) }, () => one(n))).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Node labels</title><style>
    @page { size: ${LABEL_W}mm ${LABEL_H}mm; margin: 0; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { background: #fff; color: #000; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    body { font-family: "Segoe UI", Roboto, Arial, sans-serif; }
    .label {
      width: ${LABEL_W}mm; height: ${LABEL_H}mm; padding: 1.6mm 1.4mm 1.6mm ${QUIET}mm;
      display: flex; align-items: center; gap: 1.6mm;
      overflow: hidden; page-break-after: always; break-after: page;
    }
    .label:last-child { page-break-after: auto; break-after: auto; }
    .qr { display: block; width: ${QR}mm; height: ${QR}mm; flex: none; }
    .txt { flex: 1; min-width: 0; height: 100%; display: flex; flex-direction: column; justify-content: center; gap: 1.5mm; }
    .brand { font-size: 8pt; font-weight: 800; letter-spacing: 0.1em; line-height: 1; white-space: nowrap; }
    .type { font-size: 6pt; font-weight: 600; letter-spacing: 0.04em; line-height: 1.1; padding-bottom: 1.2mm; border-bottom: 0.25mm solid #000; }
    .nsn { font-family: "Consolas", "Roboto Mono", "DejaVu Sans Mono", monospace; font-weight: 700; line-height: 1; white-space: nowrap; }
    @media screen { body { background: #ccc; padding: 8px; } .label { background: #fff; margin: 0 auto 8px; box-shadow: 0 1px 4px rgba(0,0,0,.3); } }
  </style></head><body>${pages}</body></html>`;
}

/** Prints the labels (opens the browser's print dialog); resolves when it closes. */
export function printLabels(controllers, copies = 2) {
  const list = (Array.isArray(controllers) ? controllers : [controllers]).filter((c) => c && c.serialNumber);
  if (!list.length) return Promise.resolve(false);
  return printHtml(labelsHtml(list, copies));
}

/** Node labels (QR + serial); resolves when the print dialog closes. */
export async function printNodeLabels(nodes, copies = 2) {
  const list = (Array.isArray(nodes) ? nodes : [nodes]).filter((n) => n && n.serialNumber);
  if (!list.length) return false;
  const qrs = {};
  for (const n of list) qrs[n.serialNumber] = await qrSvg(n.serialNumber);
  return printHtml(nodeLabelsHtml(list, copies, qrs));
}

function printHtml(html) {
  return new Promise((resolve) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
    frame.srcdoc = html;
    frame.onload = () => {
      const w = frame.contentWindow;
      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        setTimeout(() => frame.remove(), 500);
        resolve(true);
      };
      // fonts first, so the serial line isn't drawn in a fallback font
      (w.document.fonts?.ready || Promise.resolve()).then(() => {
        w.focus();
        w.print();     // waits while the print dialog is open (Chrome, Edge, Firefox)
        done();
      });
    };
    document.body.appendChild(frame);
  });
}
