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

// While document uploads are off (config.js DOCUMENT_UPLOADS) the file
// inputs are hidden and a "hard copy collected?" Yes / No checklist takes
// their place, so the record still says which paper documents are on file.
//   checklist: [{ key, label }]   existing: { key: true|false } (edit pages)
// Returns { uploadsOn, readHardcopies } - readHardcopies() gives
// { key: true|false } for the record (null while uploads are on).
export function applyDocumentUploadSetting(enabled, inputIds, { card = null, checklist = [], existing = {} } = {}) {
  if (enabled) return { uploadsOn: true, readHardcopies: () => null };
  const fields = inputIds.map((id) => document.getElementById(id)?.closest(".fb-field")).filter(Boolean);
  fields.forEach((f) => { f.hidden = true; });
  if (card) card.hidden = true;

  const box = document.createElement("div");
  box.className = "fb-card hardcopy-card";
  box.innerHTML = `
    <h2>📄 Hard Copy Documents Collected</h2>
    <p style="color:#6b7280;font-size:13px;margin:-4px 0 12px">Uploads are off for now - tick which paper copies you have collected.</p>
    <div class="fb-grid">
      ${checklist.map(({ key, label }) => `
        <div class="fb-field">
          <label>${label}</label>
          <div style="display:flex;gap:18px;align-items:center;padding:8px 0">
            <label style="display:flex;gap:6px;align-items:center;font-weight:500"><input type="radio" name="hc_${key}" value="yes" ${existing?.[key] === true ? "checked" : ""}> Yes</label>
            <label style="display:flex;gap:6px;align-items:center;font-weight:500"><input type="radio" name="hc_${key}" value="no" ${existing?.[key] === true ? "" : "checked"}> No</label>
          </div>
        </div>`).join("")}
    </div>`;
  // Where the documents were: in place of their own card, or right after
  // the card that holds the file fields.
  const anchor = card || fields[0]?.closest(".fb-card");
  if (card) card.insertAdjacentElement("beforebegin", box);
  else if (anchor) anchor.insertAdjacentElement("afterend", box);

  return {
    uploadsOn: false,
    readHardcopies: () => Object.fromEntries(checklist.map(({ key }) =>
      [key, box.querySelector(`input[name="hc_${key}"]:checked`)?.value === "yes"]))
  };
}

// "✅ Collected / ❌ Not collected" rows for the View pages.
export function hardcopyRows(checklist, hardcopies) {
  if (!hardcopies) return "";
  return checklist.map(({ key, label }) => `
    <div class="info-item"><b>${label}:</b> ${hardcopies[key] ? "✅ Hard copy collected" : "❌ Not collected"}</div>`).join("");
}

// The documents each record tracks (upload field / hard copy).
export const DISTRIBUTOR_DOCS = [
  { key: "gst", label: "GST Certificate" },
  { key: "pan", label: "PAN Card" },
  { key: "aadhaar", label: "Aadhaar" },
  { key: "cheque", label: "Cancelled Cheque" },
  { key: "msme", label: "MSME Certificate" },
  { key: "itr", label: "Last Year ITR" },
  { key: "other1", label: "Other Document 1" },
  { key: "other2", label: "Other Document 2" },
  { key: "other3", label: "Other Document 3" }
];
export const FARMER_DOCS = [
  { key: "aadhaar", label: "Aadhaar" },
  { key: "other", label: "Other Document" },
  { key: "photo", label: "Farmer Photo" }
];
