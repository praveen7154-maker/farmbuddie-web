// The QR drawing library (node-qrcode's browser build), loaded on first use
// - the credential QR (provisioning.js) and the node labels (labels.js).
// Pinned to 1.5.1: 1.5.3 and later no longer ship build/qrcode.min.js (a
// 404 - the QR box just stayed empty).
const QR_LIB_URL = "https://cdn.jsdelivr.net/npm/qrcode@1.5.1/build/qrcode.min.js";
let qrLibPromise = null;

export function loadQrLib() {
  if (window.QRCode) return Promise.resolve(window.QRCode);
  if (!qrLibPromise) {
    qrLibPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = QR_LIB_URL;
      script.onload = () => (window.QRCode ? resolve(window.QRCode) : reject(new Error("QR library didn't start")));
      script.onerror = () => {
        qrLibPromise = null;   // let the next try load it again
        reject(new Error("QR library couldn't be downloaded"));
      };
      document.head.appendChild(script);
    });
  }
  return qrLibPromise;
}

/**
 * The QR code of `text` as an SVG string (black squares, `margin` modules of
 * white around) - for printing, where a canvas could come out blurred.
 */
export async function qrSvg(text, { margin = 2, ecl = "M" } = {}) {
  const QRCode = await loadQrLib();
  const { modules } = QRCode.create(String(text), { errorCorrectionLevel: ecl });
  const n = modules.size, dim = n + 2 * margin;
  let path = "";
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (modules.get(y, x)) path += `M${x + margin} ${y + margin}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" class="qr" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" aria-hidden="true">` +
    `<rect width="${dim}" height="${dim}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
