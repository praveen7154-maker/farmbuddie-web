// A record page (Farmer / Distributor view) as a proper A4 document - the
// same look as the Module Pricing quotation: logo and company details on top,
// a title band, the record's reference, then each section as a bordered
// table. Used for both Print and Save as PDF, so the two always match.
//
// The sections are read from the page as it shows the record (each
// .section-title and the .info-item rows under it, "<b>Label:</b> value"),
// so every field the page shows is in the document, and nothing else.
import { auth } from "/js/firebase-init.js";
import { BRIDGE_BASE_URL } from "/js/config.js";

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Section titles carry an emoji on screen; the document is plain.
const plain = (t) => String(t || "").replace(/[\p{Extended_Pictographic}️‍]/gu, "").replace(/\s+/g, " ").trim();

const FALLBACK = {
  name: "Farm Buddie",
  address: "14/218/1, Sankaragoundanpalayam\nVarathanallur Post, Bhavani Taluk\nErode, Tamil Nadu 638311",
  gstin: "", phone: "", email: "", website: ""
};

/** The company lines from Module Pricing > Settings > Company details (the quotation's), or the standard ones. */
export async function loadCompany() {
  try {
    const token = await auth.currentUser?.getIdToken();
    if (!token) return FALLBACK;
    const r = await fetch(`${BRIDGE_BASE_URL}/pricing/admin/settings`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return FALLBACK;
    const s = (await r.json()).settings || {};
    return {
      name: s.companyName || FALLBACK.name, address: s.companyAddress || FALLBACK.address, gstin: s.companyGstin || "",
      phone: s.companyPhone || "", email: s.companyEmail || "", website: s.companyWebsite || ""
    };
  } catch { return FALLBACK; }
}

/** [{ title, rows: [{ label, value, full, note }] }] from the record page's sections. */
export function sectionsFromView(root) {
  const out = [];
  let cur = null;
  for (const el of root.children) {
    if (el.classList.contains("section-title")) { cur = { title: plain(el.textContent), rows: [] }; out.push(cur); continue; }
    if (!cur || !el.classList.contains("info-grid")) continue;
    for (const it of el.querySelectorAll(".info-item")) {
      const b = it.querySelector("b");
      const full = it.classList.contains("full");
      if (!b) { cur.rows.push({ note: plain(it.textContent), full: true }); continue; }
      const label = plain(b.textContent).replace(/[:→]\s*$/, "");
      const clone = it.cloneNode(true);
      clone.querySelector("b").remove();
      // A link ("View Document") becomes a plain word on paper.
      clone.querySelectorAll("a").forEach((a) => a.replaceWith(document.createTextNode("Uploaded")));
      let value = plain(clone.textContent).replace(/^✅\s*/, "").replace(/^❌\s*/, "") || "-";
      // Aadhaar on paper: only the last 4 digits (UIDAI practice for copies).
      if (/aadhaar/i.test(label) && !/document|file|hard copy/i.test(label)) {
        const d = value.replace(/\D/g, "");
        if (d.length >= 8) value = `XXXX XXXX ${d.slice(-4)}`;
      }
      cur.rows.push({ label, value, full: full || value.length > 46 });
    }
  }
  return out.filter((s) => s.rows.length);
}

// Two label/value pairs a row; a long value takes the whole row.
function tableHtml(rows) {
  const trs = [];
  let pair = [];
  const flush = () => {
    if (!pair.length) return;
    trs.push(`<tr>${pair.map((r) => `<th>${esc(r.label)}</th><td>${esc(r.value)}</td>`).join("")}${pair.length === 1 ? "<th></th><td></td>" : ""}</tr>`);
    pair = [];
  };
  for (const r of rows) {
    if (r.note) { flush(); trs.push(`<tr><td colspan="4" class="note">${esc(r.note)}</td></tr>`); continue; }
    if (r.full) { flush(); trs.push(`<tr><th>${esc(r.label)}</th><td colspan="3">${esc(r.value)}</td></tr>`); continue; }
    pair.push(r);
    if (pair.length === 2) flush();
  }
  flush();
  return `<table class="kv"><colgroup><col class="k"><col class="v"><col class="k"><col class="v"></colgroup>${trs.join("")}</table>`;
}

const CSS = `
.fbdoc { font-family: "Segoe UI", Roboto, Arial, sans-serif; color: #111827; font-size: 11.5px; line-height: 1.45; width: 100%; }
.fbdoc * { box-sizing: border-box; }
.fbdoc .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; border-bottom: 3px solid #15803d; padding-bottom: 12px; }
.fbdoc .brand { display: flex; gap: 14px; align-items: center; }
.fbdoc .brand img { height: 54px; }
.fbdoc .co { font-size: 10.5px; color: #374151; line-height: 1.5; }
.fbdoc .co b { font-size: 15px; color: #14532d; }
.fbdoc .ttl { text-align: right; }
.fbdoc .ttl h1 { margin: 0 0 4px; font-size: 19px; letter-spacing: .6px; color: #14532d; }
.fbdoc .ttl .ref { font-size: 13px; font-weight: 700; }
.fbdoc .ttl small { color: #6b7280; }
.fbdoc .meta { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px 14px; margin: 12px 0 4px; font-size: 10.5px;
  background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 8px 12px; }
.fbdoc .meta span { color: #6b7280; display: block; }
.fbdoc .meta b { font-size: 11.5px; }
.fbdoc .top { display: flex; gap: 16px; align-items: flex-start; }
.fbdoc .top .grow { flex: 1; min-width: 0; }
.fbdoc .photo { width: 104px; height: 124px; object-fit: cover; border-radius: 8px; border: 1px solid #d1d5db; margin-top: 10px; }
.fbdoc h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .6px; color: #fff; background: #15803d; margin: 14px 0 0;
  padding: 5px 10px; border-radius: 6px 6px 0 0; page-break-after: avoid; break-after: avoid; }
.fbdoc table.kv { width: 100%; border-collapse: collapse; table-layout: fixed; }
.fbdoc table.kv col.k { width: 19%; } .fbdoc table.kv col.v { width: 31%; }
.fbdoc table.kv th, .fbdoc table.kv td { border: 1px solid #e5e7eb; padding: 5px 8px; vertical-align: top; text-align: left; word-wrap: break-word; }
.fbdoc table.kv th { background: #f9fafb; color: #374151; font-weight: 600; font-size: 10.5px; }
.fbdoc table.kv td.note { color: #6b7280; font-style: italic; }
.fbdoc table.kv tr { page-break-inside: avoid; break-inside: avoid; }
.fbdoc .sec { page-break-inside: avoid; break-inside: avoid; }
.fbdoc .foot { margin-top: 18px; border-top: 1px solid #e5e7eb; padding-top: 8px; font-size: 9.5px; color: #6b7280; display: flex; justify-content: space-between; gap: 12px; }
.fbdoc .conf { color: #b91c1c; font-weight: 700; }
.fbdoc .sign { display: flex; justify-content: space-between; gap: 40px; margin-top: 34px; font-size: 10.5px; page-break-inside: avoid; }
.fbdoc .sign div { flex: 0 1 220px; border-top: 1px solid #9ca3af; padding-top: 5px; text-align: center; }
`;

/**
 * opts: { title ("FARMER RECORD"), ref (Farm Buddie ID), refLabel, meta: [[label, value]],
 *   photoUrl, sections, company, signLeft, signRight }
 */
export function recordDocHtml(o) {
  const c = o.company || FALLBACK;
  const coLines = [c.address, [c.gstin && `GSTIN: ${c.gstin}`, c.phone && `Ph: ${c.phone}`].filter(Boolean).join(" · "),
    [c.email, c.website].filter(Boolean).join(" · ")].filter(Boolean).map((l) => esc(l).replace(/\n/g, "<br>")).join("<br>");
  const generated = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const who = auth.currentUser?.email || "";
  const [first, ...rest] = o.sections;
  const sec = (s) => `<div class="sec"><h2>${esc(s.title)}</h2>${tableHtml(s.rows)}</div>`;
  return `<style>${CSS}</style><div class="fbdoc">
    <div class="head">
      <div class="brand"><img src="${location.origin}/assets/logo.png" alt="">
        <div class="co"><b>${esc(c.name)}</b>${coLines ? `<br>${coLines}` : ""}</div></div>
      <div class="ttl"><h1>${esc(o.title)}</h1><div class="ref">${esc(o.refLabel || "ID")}: ${esc(o.ref || "-")}</div>
        <small>Generated ${esc(generated)} IST</small></div>
    </div>
    <div class="meta">${(o.meta || []).map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v || "-")}</b></div>`).join("")}</div>
    ${first ? `<div class="top"><div class="grow">${sec(first)}</div>${o.photoUrl ? `<img class="photo" src="${esc(o.photoUrl)}" crossorigin="anonymous" alt="">` : ""}</div>` : ""}
    ${rest.map(sec).join("")}
    <div class="sign"><div>${esc(o.signLeft || "Signature")}</div><div>For ${esc(c.name)}<br><small>Authorised signatory</small></div></div>
    <div class="foot"><span class="conf">Confidential - ${esc(c.name)} internal record. Contains personal data; don't share outside ${esc(c.name)}.</span>
      <span>${who ? `Printed by ${esc(who)}` : ""}</span></div>
  </div>`;
}

const waitImages = (root) => Promise.all([...root.querySelectorAll("img")].map((img) => (img.complete ? null
  : new Promise((r) => { img.onload = r; img.onerror = r; }))));

/** Print: the document alone in its own window (A4, margins, page numbers). */
export function printRecord(html, title) {
  const w = window.open("", "_blank");
  if (!w) { alert("Allow pop-ups for this site to print"); return; }
  w.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${esc(title)}</title>
    <style>@page { size: A4; margin: 12mm 11mm 14mm; @bottom-right { content: "Page " counter(page) " of " counter(pages); font-size: 9px; color: #6b7280; } }
      body { margin: 24px; -webkit-print-color-adjust: exact; print-color-adjust: exact; } @media print { body { margin: 0; } }</style></head>
    <body>${html}<script>window.onload = () => setTimeout(() => window.print(), 250);<\/script></body></html>`);
  w.document.close();
}

/** Save as PDF: the same document, A4, with "Page x of y" on every page. */
export async function pdfRecord(html, filename) {
  // Pictures first (the farmer photo), so they're in the PDF.
  const probe = document.createElement("div");
  probe.innerHTML = html;
  await waitImages(probe);
  // From the HTML text: html2pdf lays it out in its own overlay (an
  // element moved off-screen comes out blank).
  await window.html2pdf().set({
    margin: [12, 11, 14, 11],
    filename,
    image: { type: "jpeg", quality: 0.96 },
    html2canvas: { scale: 2, useCORS: true, backgroundColor: "#ffffff" },
    jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
    pagebreak: { mode: ["css", "legacy"], avoid: [".sec", "tr", ".sign"] }
  }).from(`<div style="width:188mm;background:#fff">${html}</div>`, "string").toPdf().get("pdf").then((pdf) => {
    const n = pdf.internal.getNumberOfPages();
    for (let i = 1; i <= n; i++) {
      pdf.setPage(i);
      pdf.setFontSize(8);
      pdf.setTextColor(107, 114, 128);
      pdf.text(`Page ${i} of ${n}`, 210 - 11, 297 - 6, { align: "right" });
    }
  }).save();
}
