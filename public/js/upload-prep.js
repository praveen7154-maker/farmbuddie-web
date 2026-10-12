// Every document/photo upload goes through here first, so Storage only ever
// holds small files:
//   - a photo or scan (JPG / PNG / WebP) becomes a WebP image, longest side
//     at most 1600 px (sharp enough to read an Aadhaar or GST certificate),
//     shrunk further until it is under ~400 KB - a phone photo of 4-6 MB
//     typically ends up 150-300 KB;
//   - a PDF is kept as it is (a browser can't recompress a PDF without
//     turning its text into pictures), up to 2 MB - scanner apps' "small"
//     or "email" size is well under that.
// storage.rules accepts only these types, at most 5 MB.

export const MAX_PDF_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_INPUT_BYTES = 25 * 1024 * 1024;   // the original photo or scan, before shrinking
const TARGET_IMAGE_BYTES = 400 * 1024;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];

function toWebp(bitmap, maxSide, quality) {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));   // never enlarge
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";                      // a transparent PNG gets a white page, not black
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't convert the image"))), "image/webp", quality));
}

/**
 * file -> { blob, ext, contentType } ready for uploadBytes(), or throws an
 * Error whose message can be shown to the admin as it is.
 * maxSide: 1600 for documents (default); 800 is plenty for a profile photo.
 */
export async function prepareUpload(file, label = "File", { maxSide = 1600 } = {}) {
  if (!file) return null;
  if (file.type === "application/pdf") {
    if (file.size > MAX_PDF_BYTES) {
      throw new Error(`${label}: PDF is ${(file.size / 1048576).toFixed(1)} MB - must be under 2 MB. Scan it at a lower quality, or upload a photo instead (photos are shrunk automatically).`);
    }
    return { blob: file, ext: "pdf", contentType: "application/pdf" };
  }
  if (!IMAGE_TYPES.includes(file.type)) {
    throw new Error(`${label}: must be a PDF or a JPG / PNG photo`);
  }
  if (file.size > MAX_IMAGE_INPUT_BYTES) {
    throw new Error(`${label}: photo is too large (over 25 MB)`);
  }
  const bitmap = await createImageBitmap(file);
  try {
    let side = maxSide;
    let quality = 0.8;
    let blob = await toWebp(bitmap, side, quality);
    // Step down until it's small enough (or as small as still readable).
    while (blob.size > TARGET_IMAGE_BYTES && (quality > 0.55 || side > 1000)) {
      if (quality > 0.55) quality -= 0.1;
      else side = Math.round(side * 0.8);
      blob = await toWebp(bitmap, side, quality);
    }
    return { blob, ext: "webp", contentType: "image/webp" };
  } finally {
    bitmap.close?.();
  }
}

// Hides the given file inputs' fields (and `card`, if given) while document
// uploads are off (config.js DOCUMENT_UPLOADS), leaving a short note
// instead. Returns whether uploads are on.
export function applyDocumentUploadSetting(enabled, inputIds, { card = null, note = "Documents: paper copies are kept for now - uploads are off." } = {}) {
  if (enabled) return true;
  const fields = inputIds.map((id) => document.getElementById(id)?.closest(".fb-field")).filter(Boolean);
  const target = card || fields[0];
  if (target) {
    const p = document.createElement("p");
    p.className = "fb-doc-note";
    p.style.cssText = "color:#6b7280;font-size:13px;margin:6px 0 12px";
    p.textContent = note;
    target.insertAdjacentElement("beforebegin", p);
  }
  if (card) card.hidden = true;
  fields.forEach((f) => { f.hidden = true; });
  return false;
}
