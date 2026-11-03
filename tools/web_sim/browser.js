// Chromium for the web simulation: the admin panel is loaded from the
// harness, with its Firebase SDK swapped for fake-firebase/ and every call to
// api.farmbuddie.com answered by the harness's real server modules. Each
// page's console errors, uncaught exceptions, failed requests and API errors
// are collected per page.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

const CDN_DIR = path.join(process.env.WEB_SIM_OUT || path.join(HERE, ".gen"), "cdn");
const CDN_HOSTS = ["cdn.jsdelivr.net", "cdnjs.cloudflare.com"];

// The pages' CDN libraries (Chart.js, xlsx, qrcode, html2pdf): the real
// files, fetched once with curl (the proxy-aware tool here) and kept.
function cdnFile(url) {
  fs.mkdirSync(CDN_DIR, { recursive: true });
  const f = path.join(CDN_DIR, crypto.createHash("sha1").update(url).digest("hex") + ".js");
  if (!fs.existsSync(f)) execFileSync("curl", ["-sSfL", "-o", f, url], { timeout: 60000 });
  return f;
}

export async function openBrowser(h) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const cors = (origin) => ({
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS"
  });
  const external = [];

  // Anything else leaving the page (fonts, analytics, maps) is noted and
  // blocked. First: Playwright tries the newest route first.
  await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => { external.push(route.request().url()); route.abort(); });
  await context.route("https://www.gstatic.com/firebasejs/**", async (route) => {
    const name = route.request().url().split("/").pop();
    const file = path.join(HERE, "fake-firebase", name);
    if (!fs.existsSync(file)) { external.push("missing fake " + name); return route.fulfill({ status: 404, body: "" }); }
    route.fulfill({ status: 200, contentType: "application/javascript", headers: { "Access-Control-Allow-Origin": "*" }, body: fs.readFileSync(file) });
  });
  await context.route("https://api.farmbuddie.com/**", async (route) => {
    const req = route.request();
    const origin = req.headers()["origin"];
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors(origin) });
    const u = new URL(req.url());
    const target = h.url + "/__api" + u.pathname + u.search;
    const headers = { ...req.headers() };
    delete headers.host; delete headers.origin; delete headers.referer;
    const body = req.postDataBuffer();
    const r = await fetch(target, { method: req.method(), headers, body: ["GET", "HEAD"].includes(req.method()) ? undefined : body });
    const buf = Buffer.from(await r.arrayBuffer());
    const out = { ...cors(origin) };
    const ct = r.headers.get("content-type"); if (ct) out["Content-Type"] = ct;
    const cd = r.headers.get("content-disposition"); if (cd) out["Content-Disposition"] = cd;
    route.fulfill({ status: r.status, headers: out, body: buf });
  });
  for (const host of CDN_HOSTS) {
    await context.route(`https://${host}/**`, async (route) => {
      try {
        route.fulfill({ status: 200, contentType: "application/javascript", headers: { "Access-Control-Allow-Origin": "*" }, body: fs.readFileSync(cdnFile(route.request().url())) });
      } catch (e) { external.push("cdn failed " + route.request().url()); route.fulfill({ status: 502, body: "" }); }
    });
  }
  return { browser, context, external };
}

// A page with its problems recorded: console errors, uncaught exceptions,
// failed requests and HTTP errors from the API.
export async function newPage(context, issues) {
  const page = await context.newPage();
  const where = () => { try { return new URL(page.url()).pathname; } catch { return "?"; } };
  page.on("console", (m) => {
    if (m.type() === "error") issues.push({ page: where(), kind: "console.error", text: m.text().slice(0, 300) });
    if (m.type() === "warning" && !/Download the React DevTools/.test(m.text())) issues.push({ page: where(), kind: "console.warn", text: m.text().slice(0, 300) });
  });
  page.on("pageerror", (e) => issues.push({ page: where(), kind: "uncaught", text: String(e.message || e).slice(0, 300) }));
  page.on("requestfailed", (r) => {
    const f = r.failure()?.errorText || "";
    if (!/ERR_ABORTED|net::ERR_FAILED/.test(f) || /127\.0\.0\.1/.test(r.url())) issues.push({ page: where(), kind: "request failed", text: `${r.method()} ${r.url()} ${f}` });
  });
  page.on("response", (r) => {
    if (r.status() >= 400 && /api\.farmbuddie\.com|\/__fs|\/__auth/.test(r.url())) issues.push({ page: where(), kind: `HTTP ${r.status()}`, text: `${r.request().method()} ${r.url().replace(/^https:\/\/api\.farmbuddie\.com/, "")}` });
    else if (r.status() === 404) issues.push({ page: where(), kind: "HTTP 404", text: r.url().replace(/^http:\/\/127\.0\.0\.1:\d+/, "") });
  });
  page.on("dialog", (d) => { issues.push({ page: where(), kind: "dialog", text: `${d.type()}: ${d.message().slice(0, 200)}` }); d.accept().catch(() => {}); });
  return page;
}
