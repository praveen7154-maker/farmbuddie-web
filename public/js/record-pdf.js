// PDFs drawn directly with jsPDF - text and lines, not a screenshot of the
// page. The old Save as PDF (html2pdf: html2canvas renders the page into an
// image) came out cropped on the right on some PCs (browser zoom, display
// scaling, fonts), and an image can't be a fill-in form. Drawn, the layout
// is the same on every PC, text stays sharp, and the forms are exact.
//
//   recordPdf(o)              the Farmer / Distributor record (record-doc.js's look)
//   onboardingFormPdf(f, co)  Customer Onboarding Form, filled from the farmer record
//   workCompletionPdf(f, co)  Work Completion Certificate, filled, with a
//                             field-observations box the customer initials
//
// Needs window.jspdf (jspdf.umd.min.js, loaded by the page).

const PAGE_W = 210, PAGE_H = 297;
const GREEN = [21, 128, 61], DARK_GREEN = [20, 83, 45], TINT = [236, 246, 238], INK = [17, 24, 39];
const GREY = [107, 114, 128], LINE = [210, 214, 220], FAINT = [156, 163, 175];

// Word wrap in the doc's CURRENT font and size (jsPDF's splitTextToSize let
// some lines run past the margin). A word longer than the width is cut.
function wrapLines(doc, text, width) {
  const out = [];
  for (const para of String(text ?? "").split(/\n/)) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const tryLine = line ? `${line} ${word}` : word;
      if (doc.getTextWidth(tryLine) <= width) { line = tryLine; continue; }
      if (line) out.push(line);
      let w = word;
      while (doc.getTextWidth(w) > width && w.length > 1) {
        let n = w.length - 1;
        while (n > 1 && doc.getTextWidth(w.slice(0, n)) > width) n--;
        out.push(w.slice(0, n)); w = w.slice(n);
      }
      line = w;
    }
    out.push(line);
  }
  return out.length ? out : [""];
}

function newDoc() {
  const J = window.jspdf?.jsPDF;
  if (!J) throw new Error("PDF library didn't load - check the internet connection and reload the page");
  return new J({ unit: "mm", format: "a4", orientation: "portrait", compress: true });
}

const s = (v) => (v === null || v === undefined ? "" : String(v)).trim();
const up = (v) => s(v).toUpperCase();
const dash = (v) => s(v) || "-";

async function imageData(url) {
  try {
    const r = await fetch(url, { cache: "force-cache" });
    if (!r.ok) return null;
    const blob = await r.blob();
    return await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => res(null); fr.readAsDataURL(blob); });
  } catch { return null; }
}

function drawImage(doc, data, x, y, maxW, maxH) {
  if (!data) return 0;
  try {
    const p = doc.getImageProperties(data);
    const k = Math.min(maxW / p.width, maxH / p.height);
    const w = p.width * k, h = p.height * k;
    doc.addImage(data, p.fileType || "PNG", x, y, w, h);
    return w;
  } catch { return 0; }
}

function pageFooters(doc, left, font = "helvetica") {
  const n = doc.getNumberOfPages();
  for (let i = 1; i <= n; i++) {
    doc.setPage(i);
    doc.setDrawColor(...LINE); doc.setLineWidth(0.2);
    doc.line(15, PAGE_H - 13, PAGE_W - 15, PAGE_H - 13);
    doc.setFont(font, "normal"); doc.setFontSize(7.5); doc.setTextColor(...GREY);
    doc.text(left, 15, PAGE_H - 9);
    doc.text(`Page ${i} of ${n}`, PAGE_W - 15, PAGE_H - 9, { align: "right" });
  }
}

// ============================================================ RECORD
/**
 * The Farmer / Distributor record. o: { title, ref, refLabel, meta: [[k, v]],
 * sections: [{title, rows: [{label, value, full} | {note}]}], company, signLeft,
 * photoUrl, printedBy, filename }
 */
export async function recordPdf(o) {
  const doc = newDoc();
  const c = o.company || {};
  const L = 11, R = PAGE_W - 11, W = R - L;
  const BOTTOM = PAGE_H - 18;
  const logo = await imageData(`${location.origin}/assets/logo.png`);
  const photo = o.photoUrl ? await imageData(o.photoUrl) : null;

  // Letterhead
  let y = 12;
  const lw = drawImage(doc, logo, L, y, 34, 15);
  const cx = L + (lw ? lw + 5 : 0);
  doc.setFont("helvetica", "bold"); doc.setFontSize(12); doc.setTextColor(...DARK_GREEN);
  doc.text(s(c.name) || "Farm Buddie", cx, y + 4);
  doc.setFont("helvetica", "normal"); doc.setFontSize(7.8); doc.setTextColor(55, 65, 81);
  const coLines = [...s(c.address).split(/\n/), [c.gstin && `GSTIN: ${c.gstin}`, c.phone && `Ph: ${c.phone}`].filter(Boolean).join(" · "),
    [c.email, c.website].filter(Boolean).join(" · ")].map(s).filter(Boolean);
  let cy = y + 8;
  for (const ln of coLines) for (const part of wrapLines(doc, ln, 80)) { doc.text(part, cx, cy); cy += 3.4; }
  doc.setFont("helvetica", "bold"); doc.setFontSize(15); doc.setTextColor(...DARK_GREEN);
  doc.text(s(o.title), R, y + 5, { align: "right" });
  doc.setFontSize(9.5); doc.setTextColor(...INK);
  doc.text(`${s(o.refLabel) || "ID"}: ${dash(o.ref)}`, R, y + 10.5, { align: "right" });
  doc.setFont("helvetica", "normal"); doc.setFontSize(7.2); doc.setTextColor(...GREY);
  const gen = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  doc.text(`Generated ${gen} IST`, R, y + 14.5, { align: "right" });
  y = Math.max(cy, y + 18) + 1;
  doc.setDrawColor(...GREEN); doc.setLineWidth(0.8); doc.line(L, y, R, y);
  y += 4;

  // Summary strip
  const meta = o.meta || [];
  if (meta.length) {
    doc.setFillColor(240, 253, 244); doc.setDrawColor(187, 247, 208); doc.setLineWidth(0.25);
    doc.roundedRect(L, y, W, 11, 1.5, 1.5, "FD");
    const cw = W / meta.length;
    meta.forEach(([k, v], i) => {
      const x = L + 3 + i * cw;
      doc.setFont("helvetica", "normal"); doc.setFontSize(7); doc.setTextColor(...GREY); doc.text(s(k), x, y + 4);
      doc.setFont("helvetica", "bold"); doc.setFontSize(8.5); doc.setTextColor(...INK);
      doc.text(wrapLines(doc, dash(v), cw - 4)[0], x, y + 8.6);
    });
    y += 15;
  }

  // Sections: green title bar + a 4-column key/value table (full rows span).
  const K = W * 0.19, V = W * 0.31, PAD = 1.8, LH = 3.6;
  const ensure = (h) => { if (y + h > BOTTOM) { doc.addPage(); y = 14; return true; } return false; };
  const cell = (x, yy, w, h, text, head) => {
    if (head) { doc.setFillColor(249, 250, 251); doc.rect(x, yy, w, h, "F"); }
    doc.setDrawColor(229, 231, 235); doc.setLineWidth(0.2); doc.rect(x, yy, w, h, "S");
    doc.setFont("helvetica", head ? "bold" : "normal"); doc.setFontSize(head ? 7.6 : 8.2);
    doc.setTextColor(...(head ? [55, 65, 81] : INK));
    doc.text(text, x + PAD, yy + PAD + 2.6);
  };
  (o.sections || []).forEach((sec, si) => {
    // Rows into table lines: two pairs per line, a full row on its own.
    const lines = [];
    let pend = null;
    for (const r of sec.rows || []) {
      if (r.note !== undefined) { if (pend) { lines.push([pend]); pend = null; } lines.push([{ note: r.note }]); continue; }
      if (r.full) { if (pend) { lines.push([pend]); pend = null; } lines.push([{ ...r, full: true }]); continue; }
      if (pend) { lines.push([pend, r]); pend = null; } else pend = r;
    }
    if (pend) lines.push([pend]);
    const photoW = si === 0 && photo ? 30 : 0;
    const tw = W - (photoW ? photoW + 4 : 0);
    const k = tw * 0.19, v = tw * 0.31;
    const measure = (ln) => {
      doc.setFontSize(8.2);
      if (ln[0].note !== undefined) return { parts: [wrapLines(doc, s(ln[0].note), tw - 2 * PAD)], h: 0 };
      if (ln[0].full) {
        const kp = wrapLines(doc, s(ln[0].label), k - 2 * PAD), vp = wrapLines(doc, dash(ln[0].value), tw - k - 2 * PAD);
        return { parts: [kp, vp], h: 0 };
      }
      const parts = [];
      for (const r of ln) { parts.push(wrapLines(doc, s(r.label), k - 2 * PAD), wrapLines(doc, dash(r.value), v - 2 * PAD)); }
      return { parts, h: 0 };
    };
    const firstH = lines.length ? Math.max(...measure(lines[0]).parts.map((p) => p.length)) * LH + 2 * PAD : 0;
    ensure(7 + firstH);
    const top = y;
    doc.setFillColor(...GREEN); doc.roundedRect(L, y, tw, 6.2, 1.2, 1.2, "F"); doc.rect(L, y + 3, tw, 3.2, "F");
    doc.setFont("helvetica", "bold"); doc.setFontSize(8); doc.setTextColor(255, 255, 255);
    doc.text(up(sec.title), L + 3, y + 4.2);
    y += 6.2;
    for (const ln of lines) {
      const { parts } = measure(ln);
      const h = Math.max(...parts.map((p) => p.length)) * LH + 2 * PAD - 0.6;
      if (ensure(h)) { /* continued on the next page */ }
      if (ln[0].note !== undefined) {
        doc.setDrawColor(229, 231, 235); doc.rect(L, y, tw, h, "S");
        doc.setFont("helvetica", "italic"); doc.setFontSize(8); doc.setTextColor(...GREY);
        doc.text(parts[0], L + PAD, y + PAD + 2.6);
      } else if (ln[0].full) {
        cell(L, y, k, h, parts[0], true); cell(L + k, y, tw - k, h, parts[1], false);
      } else {
        cell(L, y, k, h, parts[0], true); cell(L + k, y, v, h, parts[1], false);
        if (ln[1]) { cell(L + k + v, y, k, h, parts[2], true); cell(L + 2 * k + v, y, v, h, parts[3], false); }
        else { cell(L + k + v, y, k, h, [""], true); cell(L + 2 * k + v, y, v, h, [""], false); }
      }
      y += h;
    }
    if (photoW) {
      drawImage(doc, photo, R - photoW, top, photoW, 36);
      y = Math.max(y, top + 37);
    }
    y += 4;
  });

  // Signatures + the confidentiality line.
  ensure(30);
  y += 12;
  doc.setDrawColor(...FAINT); doc.setLineWidth(0.3);
  doc.line(L + 4, y, L + 64, y); doc.line(R - 64, y, R - 4, y);
  doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(...INK);
  doc.text(s(o.signLeft) || "Signature", L + 34, y + 4, { align: "center" });
  doc.text(`For ${s(c.name) || "Farm Buddie"}`, R - 34, y + 4, { align: "center" });
  doc.setFontSize(7); doc.setTextColor(...GREY); doc.text("Authorised signatory", R - 34, y + 7.5, { align: "center" });
  y += 13;
  doc.setDrawColor(229, 231, 235); doc.setLineWidth(0.2); doc.line(L, y, R, y);
  doc.setFont("helvetica", "bold"); doc.setFontSize(7); doc.setTextColor(185, 28, 28);
  const conf = wrapLines(doc, `Confidential - ${s(c.name) || "Farm Buddie"} internal record. Contains personal data; don't share outside ${s(c.name) || "Farm Buddie"}.`, W * 0.62);
  doc.text(conf, L, y + 4);
  if (o.printedBy) {
    doc.setFont("helvetica", "normal"); doc.setTextColor(...GREY);
    doc.text(wrapLines(doc, `Printed by ${o.printedBy}`, W * 0.35), R, y + 4, { align: "right" });
  }
  pageFooters(doc, s(c.name) || "Farm Buddie");
  doc.save(o.filename || "record.pdf");
}

// ============================================================ FORMS
// Shared drawing for the two forms (the printed forms' look: Times, a pale
// green section band with a green bar, label + line with the value on it).
function form(doc) {
  const L = 15, R = PAGE_W - 15;
  const f = {
    L, R, y: 0, font: "times",
    text(t, x, yy, opt = {}) {
      doc.setFont(this.font, opt.style || "normal"); doc.setFontSize(opt.size || 9.5);
      doc.setTextColor(...(opt.color || INK)); doc.text(t, x, yy, opt.align ? { align: opt.align } : undefined);
      return doc.getTextWidth(Array.isArray(t) ? t[0] : t);
    },
    secGap: 13,
    section(title) {
      doc.setFillColor(...TINT); doc.rect(L, this.y, R - L, 7, "F");
      doc.setFillColor(...GREEN); doc.rect(L, this.y, 1.2, 7, "F");
      this.text(title, L + 4.5, this.y + 4.8, { style: "bold", size: 10, color: GREEN });
      this.y += this.secGap;
    },
    // "Label * ____value____" - returns the end x.
    field(label, value, x, w, opt = {}) {
      const lx = this.text(label, x, this.y, { style: "bold" }) + 2;
      const x0 = x + lx, x1 = x + w;
      doc.setDrawColor(...FAINT); doc.setLineWidth(0.25); doc.line(x0, this.y + 1, x1, this.y + 1);
      const v = opt.raw ? s(value) : up(value);
      if (v) {
        doc.setFont("helvetica", "bold"); doc.setFontSize(9); doc.setTextColor(30, 64, 175);
        doc.text(wrapLines(doc, v, x1 - x0 - 1)[0] || "", x0 + 1, this.y - 0.4);
      }
      return x1;
    },
    // A full-width blank/filled multi-line area: lines n, text wrapped onto them.
    lines(value, n, opt = {}) {
      doc.setFont("helvetica", "bold"); doc.setFontSize(9);
      const parts = value ? wrapLines(doc, opt.raw ? s(value) : up(value), R - L - 2) : [];
      for (let i = 0; i < n; i++) {
        this.y += 6.5;
        doc.setDrawColor(...FAINT); doc.setLineWidth(0.25); doc.line(L, this.y, R, this.y);
        if (parts[i]) { doc.setTextColor(30, 64, 175); doc.text(parts[i], L + 1, this.y - 1.3); }
      }
      this.y += 2;
    },
    box(x, yy, checked) {
      doc.setDrawColor(...INK); doc.setLineWidth(0.25); doc.rect(x, yy - 2.7, 2.9, 2.9, "S");
      if (checked) {
        doc.setDrawColor(30, 64, 175); doc.setLineWidth(0.5);
        doc.line(x + 0.5, yy - 1.3, x + 1.2, yy - 0.4); doc.line(x + 1.2, yy - 0.4, x + 2.6, yy - 2.4);
        doc.setDrawColor(...INK); doc.setLineWidth(0.25);   // the tick's colour stays off what's drawn next
      }
    },
    // "Label  [] A  [] B ..." choices, the matching ones ticked.
    choices(label, opts, isOn, x = L, gap = 4) {
      let cx = x;
      if (label) cx += this.text(label, x, this.y, { style: "bold" }) + 3;
      for (const o of opts) {
        this.box(cx, this.y, isOn(o));
        cx += 4 + this.text(o, cx + 4, this.y) + gap;
      }
      return cx;
    },
    wrap(t, opt = {}) {
      doc.setFont(this.font, opt.style || "normal"); doc.setFontSize(opt.size || 8.6);
      const parts = wrapLines(doc, t, R - L);
      doc.setTextColor(...(opt.color || INK));
      for (const p of parts) { doc.text(p, L, this.y); this.y += (opt.size || 8.6) * 0.42; }
    },
    gapY(h) { this.y += h; }
  };
  return f;
}

async function formHeader(doc, F, logoUrl, title, subtitle, photoBox) {
  const logo = await imageData(logoUrl);
  F.y = 14;
  drawImage(doc, logo, F.L, F.y, 45, 17);
  F.text(title, 108, F.y + 7, { style: "bold", size: 15, color: GREEN, align: "center" });
  F.text(subtitle, 108, F.y + 12, { style: "italic", size: 8.5, color: [55, 65, 81], align: "center" });
  if (photoBox) {
    doc.setDrawColor(...INK); doc.setLineWidth(0.3); doc.rect(F.R - 32, F.y - 4, 32, 38, "S");
    F.text("Affix Passport", F.R - 16, F.y + 10, { size: 7, color: GREY, align: "center" });
    F.text("Size Photo", F.R - 16, F.y + 13.5, { size: 7, color: GREY, align: "center" });
    F.text("(3.5 x 4.5 cm)", F.R - 16, F.y + 17, { size: 6.5, color: FAINT, align: "center" });
  }
  F.text("(TO BE FILLED IN CAPITAL / BLOCK LETTERS ONLY)", 108, F.y + 24, { style: "bolditalic", size: 7, color: [55, 65, 81], align: "center" });
  F.y += photoBox ? 37 : 29;
  doc.setDrawColor(...GREEN); doc.setLineWidth(0.3); doc.line(F.L, F.y, F.R, F.y);
  F.y += 7;
}

// Farmer record -> plain values.
function farmerValues(f) {
  const valveCfg = f.valveConfig || {};
  const num = (v) => Number(v) || 0;
  const aad = s(f.aadhaarNumber).replace(/\D/g, "");
  const mapping = Array.isArray(f.pumpServiceMapping) ? f.pumpServiceMapping : [];
  return {
    title: s(f.title), name: s(f.name), primary: s(f.primaryMobile), secondary: s(f.secondaryMobile),
    // Aadhaar on paper: last 4 digits only (UIDAI practice for copies) - same as the record PDF.
    aadhaar: aad.length >= 8 ? `XXXX XXXX ${aad.slice(-4)}` : s(f.aadhaarNumber),
    email: s(f.emailId), address: s(f.address),
    location: s(f.farmDetails?.location),
    latlong: [f.farmDetails?.latitude, f.farmDetails?.longitude].map(s).filter(Boolean).join(", "),
    appUsers: Array.isArray(f.appUsers) ? f.appUsers : [],
    distributor: f.leadSource?.type === "DISTRIBUTOR"
      ? [s(f.leadSource?.distributorName), s(f.leadSource?.distributorCode || f.leadSource?.distributorId)].filter(Boolean).join(" - ")
      : "Farm Buddie Smart Irrigation (direct)",
    network: s(f.network?.type), simNumber: s(f.sim?.simNumber), simType: s(f.sim?.simType) || "M2M",
    billing: s(f.sim?.billingCycle) || "Yearly", activation: s(f.sim?.activationDate),
    variant: s(f.controller?.variant), serial: s(f.controller?.serialNumber),
    warrantyStart: s(f.controller?.warranty?.start), warrantyEnd: s(f.controller?.warranty?.end),
    serviceCount: num(f.tnebServices?.serviceCount),
    services: Array.isArray(f.tnebServices?.services) ? f.tnebServices.services : [],
    pumpCount: num(f.motorConfig?.motorCount),
    pumpHp: Array.isArray(f.motorConfig?.pumpHp) ? f.motorConfig.pumpHp : [],
    pumpService: (i) => s(mapping.find((m) => Number(m.pumpNumber) === i + 1)?.service),
    valve24: num(valveCfg.valve24Count), valve9: num(valveCfg.valve9Count),
    valvesTotal: num(valveCfg.valve24Count) + num(valveCfg.valve9Count) + num(valveCfg.butterfly230AcCount) + num(valveCfg.butterfly24DcCount),
    waterLevel: num(valveCfg.waterLevelMonitoring) > 0, backwash: num(valveCfg.filterBackwashCount) > 0,
    hard: f.hardcopies || {}
  };
}

const TERMS = [
  "In this form, “the Company” refers to Farm Buddie Smart Irrigation, the manufacturer and service provider of the Irrigo smart irrigation system.",
  ["1. Installation & Commissioning", " — Farm Buddie Smart Irrigation (the Company) — either directly or through its authorized dealer/distributor — shall install and commission the smart irrigation controller and associated sensors/valves at the farm location declared in this form. Any additional civil, electrical or wiring work required at the site is the customer's responsibility unless agreed otherwise in writing."],
  ["2. Warranty", " — The Irrigo device (MCU/controller unit) carries a standard warranty of one (1) year from the Warranty Start Date recorded in Section 4, covering manufacturing defects only. The warranty excludes damage caused by lightning/power surge, water ingress, physical damage, unauthorized repair, or misuse."],
  ["3. SIM / Connectivity & Billing", " — Where a SIM-based network is used, the SIM card and its M2M data plan are provided/facilitated by the Company and billed on the Yearly cycle selected in Section 3. Timely renewal is the customer's responsibility; loss of connectivity due to telecom network issues or non-renewal is outside the Company's control."],
  ["4. Annual Maintenance (AMC)", " — The annual SIM data-recharge and platform/database maintenance charge will be collected once every year, one (1) month before the due date. This covers SIM/data connectivity renewal and routine system maintenance. Continued service is subject to timely payment — failure to pay by the due date may result in the SIM connectivity, cloud/database access, and app-based monitoring service being suspended (halted) until payment is received."],
  ["5. Customer Responsibilities", " — The customer shall provide accurate farm, motor, pump and TNEB service details as declared in this form; provide safe site access for installation/service visits; maintain a stable electrical supply matching the sanctioned load; and not tamper with, relocate, or open the device/wiring without prior written authorization from the Company."],
  ["6. Data & Privacy", " — Farm location, usage and sensor data collected via the Irrigo app/device is used solely to provide monitoring, alerts and support services, and is not shared with third parties except as required by law or for service delivery (e.g., telecom/SIM partners)."],
  ["7. Limitation of Liability", " — The Company's liability is limited to repair or replacement of the defective device during the warranty period. The Company is not liable for crop loss, water loss, or consequential damages arising from motor operation, network downtime, power failure, or causes beyond its reasonable control."],
  ["8. App Access", " — Access to the Irrigo mobile application is provided to the Primary Mobile number and any Additional App Access Users declared in Section 2. The customer is responsible for the confidentiality of login credentials."],
  ["9. Force Majeure", " — The Company is not responsible for delays or failures in installation, service, or connectivity caused by events beyond its reasonable control, including natural calamities, telecom outages, or government restrictions."],
  ["10. Governing Law", " — This agreement is governed by the laws of India, and disputes are subject to the jurisdiction of the courts at the Company's registered office location."]
];

/** Customer Onboarding Form (4 pages), filled from the farmer record. */
export async function onboardingFormPdf(farmer, filename) {
  const doc = newDoc();
  const F = form(doc);
  const v = farmerValues(farmer);
  const { L, R } = F;
  const mid = 108;

  // -------- Page 1
  await formHeader(doc, F, `${location.origin}/assets/irrigo-logo.png`, "CUSTOMER ONBOARDING FORM",
    "Smart Irrigation Controller — KYC & Installation Record", true);
  F.section("1.  FARMER IDENTITY DETAILS");
  const known = ["Mr", "Mrs", "Ms"];
  const t = v.title.replace(/\.$/, "");
  let x = F.choices("Title:", ["Mr", "Mrs", "Ms", "Other"], (o) => (o === "Other" ? !!t && !known.includes(t) : o === t));
  F.field("", !known.includes(t) ? t : "", x - 3, 28);
  F.gapY(8);
  F.field("Farmer Full Name *", v.name, L, 130);
  F.gapY(10);
  F.field("Primary Mobile (App Login) *", v.primary, L, 86, { raw: true });
  F.field("Secondary Mobile", v.secondary, mid, R - mid, { raw: true });
  F.gapY(10);
  F.field("Aadhaar Number *", v.aadhaar, L, 86, { raw: true });
  F.field("Email ID", v.email, mid, R - mid, { raw: true });
  F.gapY(10);
  F.text("Full Address *", L, F.y, { style: "bold" });
  F.lines(v.address, 2);
  F.gapY(8);
  F.section("2.  FARM & APP USER DETAILS");
  F.text("Farm Location (Village / Taluk / District) *", L, F.y, { style: "bold" });
  F.lines(v.location, 2);
  F.gapY(3);
  F.field("Farm Lat–Long", v.latlong, L, 120, { raw: true });
  F.gapY(8);
  F.text("Additional App Access Users (if any)", L, F.y, { style: "bold" });
  F.gapY(3);
  const cols = [L, L + 9, L + 77, L + 130, R];
  const heads = ["#", "Name", "Mobile Number", "Relation"];
  const rows = Math.max(2, v.appUsers.length);
  doc.setDrawColor(...INK); doc.setLineWidth(0.25);
  doc.setFillColor(243, 244, 246); doc.rect(L, F.y, R - L, 7, "FD");
  heads.forEach((h, i) => F.text(h, cols[i] + 2, F.y + 4.8, { style: "bold", size: 8.5 }));
  for (let i = 0; i < rows; i++) {
    const yy = F.y + 7 + i * 8;
    doc.rect(L, yy, R - L, 8, "S");
    F.text(String(i + 1), cols[0] + 2, yy + 5.2, { size: 8.5 });
    const u = v.appUsers[i];
    if (u) {
      F.text(up(u.name), cols[1] + 2, yy + 5.2, { style: "bold", size: 8.5, color: [30, 64, 175] });
      F.text(s(u.mobile), cols[2] + 2, yy + 5.2, { style: "bold", size: 8.5, color: [30, 64, 175] });
      if (u.relation) F.text(up(u.relation), cols[3] + 2, yy + 5.2, { style: "bold", size: 8.5, color: [30, 64, 175] });
    }
  }
  for (let c = 1; c < 4; c++) doc.line(cols[c], F.y, cols[c], F.y + 7 + rows * 8);
  F.y += 7 + rows * 8 + 10;
  F.section("2A.  DISTRIBUTOR / DEALER DETAILS");
  F.field("Distributor / Dealer Name & Code *", v.distributor, L, 160);

  // -------- Page 2
  doc.addPage(); F.y = 18;
  F.section("3.  NETWORK MANAGEMENT");
  F.choices("Network Type *", ["SIM_BASED", "WIFI_FARMER"], (o) => o === v.network, L, 14);
  F.gapY(7);
  F.text("If SIM Based:", L, F.y, { style: "bolditalic" });
  F.gapY(7);
  F.field("SIM Number *", v.network === "WIFI_FARMER" ? "" : v.simNumber, L, 95, { raw: true });
  F.gapY(7);
  F.text("SIM Type:", L, F.y, { style: "bold" }); F.text(up(v.simType), L + 18, F.y, { style: "bold" });
  F.gapY(6);
  const bx = F.text("Billing Cycle:", L, F.y, { style: "bold" }) + L + 2;
  const bw = F.text(v.billing, bx, F.y, { style: "bold" });
  F.text("(SIM / database recharge collected 30 days before renewal)", bx + bw + 2, F.y, { style: "italic", size: 8, color: GREY });
  F.gapY(7);
  F.field("SIM / AMC Activation Date *", v.activation, L, 110, { raw: true });
  F.gapY(12);
  F.section("4.  MCU / DEVICE MAPPING");
  F.choices("Variant *", ["IRRIGO", "IRRIGO_PLUS", "IRRIGO_SMART_PLUS"], (o) => o === v.variant, L, 10);
  F.gapY(7);
  F.field("Serial Number *", v.serial, L, 105);
  F.gapY(7);
  F.field("Warranty Start Date (1 Year Standard Warranty) *", v.warrantyStart, L, 150, { raw: true });
  F.gapY(12);
  F.section("5.  TNEB SERVICE DETAILS");
  F.choices("No. of EB Services *", ["1 TNEB Service", "2 TNEB Service", "3 TNEB Service"], (o) => Number(o[0]) === v.serviceCount, L, 7);
  F.gapY(6);
  for (let i = 0; i < 3; i++) {
    const svc = v.services[i];
    const on = i < v.serviceCount;
    F.box(L, F.y, on);
    F.text(`${i + 1} TNEB Service (S${i + 1})`, L + 4, F.y);
    F.field("TNEB Sanctioned Load (in HP) *", on && svc ? s(svc.sanctionedHp) : "", L + 45, 85, { raw: true });
    F.gapY(6);
  }
  F.gapY(6);
  F.section("6.  MOTOR CONFIGURATION");
  F.choices("No. of Pumps *", ["1 Pump", "2 Pump", "3 Pump"], (o) => Number(o[0]) === v.pumpCount, L, 7);
  F.gapY(6);
  for (let i = 0; i < 3; i++) {
    const on = i < v.pumpCount;
    F.box(L, F.y, on);
    F.text(`${i + 1} Pump`, L + 4, F.y);
    F.field("HP *", on ? s(v.pumpHp[i]) : "", L + 25, 30, { raw: true });
    const svc = on ? v.pumpService(i) : "";
    F.choices("", ["S1", "S2", "S3"], (o) => !!svc && o === `S${svc}`, L + 60, 3);
    F.gapY(6);
  }
  F.gapY(6);
  F.section("7.  VALVE CONFIGURATION");
  F.gapY(2);
  F.field("24V AC Valves", String(v.valve24), L, 60, { raw: true });
  F.field("9V DC Valves", String(v.valve9), 125, 45, { raw: true });
  F.gapY(8);
  F.choices("Water Level Monitoring:", ["Yes", "No"], (o) => (o === "Yes") === v.waterLevel);
  F.gapY(6);
  F.choices("Filter Backwash:", ["Yes", "No"], (o) => (o === "Yes") === v.backwash);

  // -------- Page 3
  doc.addPage(); F.y = 18;
  F.section("8.  DOCUMENTS REQUIRED (KYC) — SIM REGISTERED IN COMPANY NAME");
  F.wrap("• The following documents must be collected from the customer at the time of onboarding. The SIM card used for connectivity is registered under the company's account; these documents are required for KYC and SIM-allotment records.", { style: "italic", size: 8.3 });
  F.gapY(4);
  const dc = [L, L + 105, L + 140, R];
  const docsRows = [["Aadhaar Card (copy — front & back) *", v.hard.aadhaar], ["Passport-size Photograph (1 copy) *", v.hard.photo],
    ["SIM / ID Proof document for company-registered SIM *", undefined]];
  doc.setDrawColor(...INK); doc.setLineWidth(0.25); doc.setFillColor(243, 244, 246);
  doc.rect(L, F.y, R - L, 7, "FD");
  ["Document", "Submitted", "Remarks / Received By"].forEach((h, i) => F.text(h, dc[i] + 2, F.y + 4.8, { style: "bold", size: 8.5 }));
  docsRows.forEach(([label, got], i) => {
    const yy = F.y + 7 + i * 9;
    doc.rect(L, yy, R - L, 9, "S");
    F.text(label, dc[0] + 2, yy + 5.8, { size: 8.5 });
    const saved = F.y; F.y = yy + 5.8;
    F.choices("", ["Yes", "No"], (o) => (got === undefined ? false : (o === "Yes") === !!got), dc[1] + 3, 3);
    F.y = saved;
  });
  for (let c = 1; c < 3; c++) doc.line(dc[c], F.y, dc[c], F.y + 7 + docsRows.length * 9);
  F.y += 7 + docsRows.length * 9 + 10;
  F.section("9.  TERMS & CONDITIONS");
  F.wrap(TERMS[0], { style: "italic", size: 8.3 });
  F.gapY(1.5);
  for (const [head, body] of TERMS.slice(1)) {
    // Bold heading, then the clause flowing on after it: the first line's
    // words fit in what's left of the width after the heading.
    doc.setFont("times", "bold"); doc.setFontSize(8.3); doc.setTextColor(...INK);
    const hw = doc.getTextWidth(head);
    doc.text(head, L, F.y);
    doc.setFont("times", "normal");
    const words = body.trim().split(/\s+/);
    let first = "";
    while (words.length && doc.getTextWidth(` ${first ? first + " " : ""}${words[0]}`) <= R - L - hw) first = first ? `${first} ${words.shift()}` : words.shift();
    doc.text(` ${first}`, L + hw, F.y);
    F.y += 3.5;
    if (words.length) for (const p of wrapLines(doc, words.join(" "), R - L)) { doc.text(p, L, F.y); F.y += 3.5; }
    F.y += 1.2;
  }

  // -------- Page 4
  doc.addPage(); F.y = 18;
  F.section("10.  CUSTOMER DECLARATION & SIGNATURE");
  F.wrap("I, the undersigned, have read (or have had read to me) and understood the Terms & Conditions stated in Section 9, and agree to be bound by them. I confirm that the information and documents provided in this form are true and correct to the best of my knowledge.", { size: 8.6 });
  F.gapY(8);
  F.field("Customer / Farmer Name *", v.name, L, 85);
  F.field("Date *", "", mid, 60);
  F.gapY(10);
  F.field("Place", "", L, 85);
  F.gapY(22);
  doc.setDrawColor(...INK); doc.setLineWidth(0.25); doc.line(L, F.y, R - 3, F.y);
  F.text("Customer / Farmer Signature", L, F.y + 5, { style: "bold", size: 8 });
  F.gapY(16);
  F.section("11.  INSTALLATION CONFIRMATION (For Office / Technician Use)");
  F.gapY(2);
  F.field("Installation Date *", "", L, 75);
  F.field("Installed By (Technician Name) *", "", mid, R - mid);
  F.gapY(24);
  doc.line(L, F.y, L + 82, F.y); doc.line(mid, F.y, R, F.y);
  F.text("Technician Signature", L, F.y + 5, { style: "bold", size: 8 });
  F.text("Farmer Signature", mid, F.y + 5, { style: "bold", size: 8 });

  pageFooters(doc, "Farm Buddie Smart Irrigation", "times");
  doc.save(filename || "Customer_Onboarding_Form.pdf");
}

/** Work Completion Certificate (1 page), filled, with a field-observations box. */
export async function workCompletionPdf(farmer, filename) {
  const doc = newDoc();
  const F = form(doc);
  const v = farmerValues(farmer);
  const { L, R } = F;
  const mid = 115;
  F.secGap = 11;   // one page, with the observations box
  await formHeader(doc, F, `${location.origin}/assets/logo.png`, "WORK COMPLETION CERTIFICATE",
    "Smart Irrigation System — Installation & Commissioning", false);
  F.wrap("This is to certify that the installation and commissioning of the Farm Buddie Smart Irrigation System has been successfully completed and handed over to the customer named below, and that the system was found to be in good working condition at the time of handover.", { size: 8.8 });
  F.gapY(3);
  F.section("A.  CUSTOMER / FARMER DETAILS");
  F.field("Customer / Farmer Name:", [v.title, v.name].filter(Boolean).join(" "), L, 140);
  F.gapY(7);
  F.field("Contact Number:", v.primary, L, 90, { raw: true });
  F.gapY(7);
  F.text("Farm Address / Location:", L, F.y, { style: "bold" });
  F.lines([v.address, v.location && v.location !== v.address ? `Farm: ${v.location}` : ""].filter(Boolean).join("\n"), 2);
  F.gapY(3);
  F.section("B.  INSTALLED SYSTEM DETAILS");
  F.choices("Variant / Model:", ["IRRIGO", "IRRIGO PLUS", "IRRIGO SMART PLUS"], (o) => o.replace(/ /g, "_") === v.variant, L, 10);
  F.gapY(7);
  F.field("Device Serial Number:", v.serial, L, 92);
  F.field("Installation Date:", "", mid, R - mid);
  F.gapY(7);
  F.choices("Network Type:", ["SIM Based", "WiFi"], (o) => (o === "SIM Based" ? v.network === "SIM_BASED" : v.network === "WIFI_FARMER"), L, 10);
  F.gapY(7);
  F.field("No. of Motors / Pumps Configured:", v.pumpCount ? String(v.pumpCount) : "", L, 92, { raw: true });
  F.field("No. of Valves Configured:", v.valvesTotal ? String(v.valvesTotal) : "", mid, R - mid, { raw: true });
  F.gapY(7);
  F.field("Warranty Valid Till (1 Year from Installation):", v.warrantyEnd, L, 150, { raw: true });
  F.gapY(8);
  F.section("C.  SCOPE OF WORK COMPLETED");
  for (const line of ["Installation and wiring of the Irrigo device, motor connections, and valve/sensor configuration completed at the site.",
    "Irrigo mobile app linked to the farmer's mobile number, with a guided walkthrough of the app provided.",
    "System tested end-to-end and confirmed working satisfactorily before handover."]) {
    F.box(L, F.y, false); F.text(line, L + 4.5, F.y, { size: 8.8 }); F.gapY(5.5);
  }
  F.gapY(3);
  // D (new): what the technician saw at the site - written in, and the
  // customer initials it at signing.
  F.section("D.  FIELD OBSERVATIONS / REMARKS");
  F.text("Site conditions, wiring, supply, issues found or pending work - to be read to the customer before signing.", L, F.y - 1.5, { style: "italic", size: 8, color: GREY });
  const boxTop = F.y + 1, boxH = 36, initW = 34;
  doc.setDrawColor(...INK); doc.setLineWidth(0.3); doc.rect(L, boxTop, R - L, boxH, "S");
  doc.setDrawColor(...LINE); doc.setLineWidth(0.2);
  for (let yy = boxTop + 7; yy < boxTop + boxH - 2; yy += 6.5) doc.line(L + 3, yy, R - initW - 5, yy);
  doc.setDrawColor(...INK); doc.setLineWidth(0.3); doc.rect(R - initW, boxTop + boxH - 16, initW - 2, 14, "S");
  F.text("Customer initials", R - initW / 2 - 1, boxTop + boxH - 17.5, { style: "bold", size: 7.5, align: "center" });
  F.y = boxTop + boxH + 6;
  F.section("E.  DECLARATION");
  F.wrap("We hereby confirm the above work was completed as per the agreed scope, demonstrated to the customer, and handed over to their satisfaction. This certificate is issued for the customer's records, subject to the applicable warranty terms.", { size: 8.8 });
  F.gapY(3);
  const bw = (R - L - 8) / 2, bh = 25, by = F.y;
  doc.setDrawColor(...INK); doc.setLineWidth(0.3);
  doc.rect(L, by, bw, bh, "S"); doc.rect(L + bw + 8, by, bw, bh, "S");
  doc.setDrawColor(...LINE); doc.line(L + 4, by + 10, L + bw - 4, by + 10); doc.line(L + bw + 12, by + 10, R - 4, by + 10);
  F.text("Signature", L + bw / 2, by + 9, { style: "italic", size: 7, color: FAINT, align: "center" });
  F.text("Signature / Thumb Impression", L + bw + 8 + bw / 2, by + 9, { style: "italic", size: 7, color: FAINT, align: "center" });
  F.text("Technician / Farm Buddie / Distributor (Installer Signature)", L + 2, by + 15, { style: "bold", size: 8 });
  F.text("Customer Signature", L + bw + 10, by + 15, { style: "bold", size: 8 });
  F.y = by + 23;
  F.field("Date:", "", L + 2, bw - 10);
  F.field("Date:", "", L + bw + 10, bw - 10);
  pageFooters(doc, "Farm Buddie Smart Irrigation", "times");
  doc.save(filename || "Work_Completion_Certificate.pdf");
}
