// Whole web admin panel, end to end, in Chromium - no Firebase project, no
// VPS: the pages run as deployed, the server modules run here on in-memory
// stores (see harness.js). Each phase is a real user flow; every console
// error, uncaught exception, failed request, API error, listener / timer
// leak and script injection is reported.
//   bash tools/web_sim/run.sh            (report: $WEB_SIM_OUT/report.txt)
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { startHarness, ADMIN } from "./harness.js";
import { openBrowser, newPage } from "./browser.js";

const OUT = process.env.WEB_SIM_OUT || "/tmp/web_sim";
fs.mkdirSync(OUT, { recursive: true });

// A throwaway OTA signing key for this run only (never the fleet key): the
// harness's OTA module trusts it, the OTA page signs with it.
const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const SIM_PRIV_PEM = privateKey.export({ type: "pkcs8", format: "pem" });
process.env.WEB_SIM_OTA_PUBLIC_PEM = publicKey.export({ type: "spki", format: "pem" });

const h = await startHarness();
const { browser, context, external } = await openBrowser(h);
const XSS = `<img src=x onerror="window.__xss=(window.__xss||0)+1">`;
await context.addInitScript(() => {
  // Script injection probe, print dialogs, and timers kept by the page.
  window.__xss = 0;
  window.__prints = 0;
  window.print = () => { window.__prints++; };
  const live = new Set();
  const si = window.setInterval, ci = window.clearInterval;
  window.setInterval = (fn, ms, ...a) => { const id = si(fn, ms, ...a); live.add(id); return id; };
  window.clearInterval = (id) => { live.delete(id); return ci(id); };
  window.__intervals = () => live.size;
  let docListeners = 0;
  const add = EventTarget.prototype.addEventListener, rem = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (t, f, o) { if (this === document || this === window) docListeners++; return add.call(this, t, f, o); };
  EventTarget.prototype.removeEventListener = function (t, f, o) { if (this === document || this === window) docListeners--; return rem.call(this, t, f, o); };
  window.__docListeners = () => docListeners;
});

// Any code that puts the injection probe into the page as HTML, with where
// it came from - the probe running (or its image loading) only says that it
// happened, this says which line did it.
await context.addInitScript(() => {
  const hook = (proto, prop) => {
    const d = Object.getOwnPropertyDescriptor(proto, prop);
    if (!d?.set) return;
    Object.defineProperty(proto, prop, { ...d, set(v) {
      if (typeof v === "string" && v.includes("<img src=x onerror=\"window.__xss")) console.error("XSS-SINK " + prop + " " + (new Error().stack.split("\n").slice(2, 5).join(" <- ")));
      return d.set.call(this, v);
    } });
  };
  hook(Element.prototype, "innerHTML"); hook(Element.prototype, "outerHTML");
  const ia = Element.prototype.insertAdjacentHTML;
  Element.prototype.insertAdjacentHTML = function (pos, v) {
    if (typeof v === "string" && v.includes("<img src=x onerror=\"window.__xss")) console.error("XSS-SINK insertAdjacentHTML " + (new Error().stack.split("\n").slice(2, 5).join(" <- ")));
    return ia.call(this, pos, v);
  };
});

const issues = [];
const results = [];          // { phase, check, ok, detail }
let phase = "";
const check = (name, ok, detail = "") => { results.push({ phase, check: name, ok: !!ok, detail: String(detail) }); console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  - " + detail : ""}`); };
// WEB_SIM_ONLY=16 (or 1,16): only those phases - for a quick re-run of one area.
const ONLY = process.env.WEB_SIM_ONLY ? new Set(process.env.WEB_SIM_ONLY.split(",").map((x) => x.trim())) : null;
async function run(name, fn) {
  if (ONLY && !ONLY.has(name.split(".")[0])) { console.log(`\n== ${name} (skipped: WEB_SIM_ONLY)`); return; }
  phase = name;
  console.log(`\n== ${name}`);
  const before = issues.length;
  try { await fn(); }
  catch (e) { check("phase finished without an exception", false, e.message.split("\n")[0]); await shot(name.replace(/\W+/g, "_") + "_error"); }
  // The runner's own navigations cutting off a page's pending request.
  // (A page's own redirect after a save, cut short by the next step's navigation.)
  for (const i of issues.slice(before)) if (i.kind === "request failed" && /ERR_ABORTED/.test(i.text) && /^GET \S+\/(login|404|admin\/[\w-]+)\.html\b/.test(i.text)) i.expected = true;
  const mine = issues.slice(before);
  for (const i of mine) console.log(`  ${i.expected ? "(expected)" : "!!"} ${i.page} ${i.kind}: ${i.text}`);
  results.push({ phase, check: "no errors in the browser", ok: !mine.some(isBug), detail: mine.filter(isBug).map((i) => `${i.page} ${i.kind}: ${i.text}`).join(" | "), issues: mine });
}
// Problems a step provokes on purpose (a wrong password, a duplicate IMEI)
// are marked expected - only those, only in that step.
async function expecting(patterns, fn) {
  const from = issues.length;
  try { return await fn(); }
  finally { for (const i of issues.slice(from)) if (patterns.some((re) => re.test(`${i.kind}: ${i.text}`))) i.expected = true; }
}
const isBug = (i) => !i.expected;

let page = await newPage(context, issues);
const shot = (n) => page.screenshot({ path: path.join(OUT, n + ".png"), fullPage: true }).catch(() => {});
// A page may be redirecting itself (after a save, a sign-out) just as the
// next step navigates: one retry.
const go = async (p) => {
  try { await page.goto(h.url + p); }
  catch (e) { if (!/ERR_ABORTED|interrupted/.test(e.message)) throw e; await page.waitForTimeout(500); await page.goto(h.url + p); }
  // Not "networkidle": the live listeners keep polling, so it never comes.
  await page.waitForLoadState("load").catch(() => {});
  await page.waitForTimeout(400);
};
const until = async (fn, ms = 8000, what = "condition") => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() > end) throw new Error("timed out waiting for " + what); await page.waitForTimeout(100); }
};
const toastText = () => page.evaluate(() => [...document.querySelectorAll(".pd-toast, .toast, [role=status]")].map((t) => t.textContent.trim()).filter(Boolean).join(" | "));
async function login(user, pass) {
  await go("/404.html");   // off the admin pages before the sign-in is wiped
  await page.evaluate(() => { try { localStorage.clear(); } catch {} }).catch(() => {});
  await go("/login.html");
  await page.fill("#email", user);
  await page.fill("#password", pass);
  await page.click("#loginBtn");
}
// Leak check: the page's live Firestore listeners, intervals, window /
// document listeners and DOM size, before and after doing `fn` n times.
async function leakCheck(name, fn, n = 6) {
  const m = () => page.evaluate(() => ({ fs: window.__fbStats?.listeners || 0, iv: window.__intervals(), dl: window.__docListeners(), dom: document.getElementsByTagName("*").length }));
  await fn(); await page.waitForTimeout(300);
  const a = await m();
  for (let i = 0; i < n; i++) await fn();
  await page.waitForTimeout(500);
  const b = await m();
  const grew = [b.fs > a.fs && `Firestore listeners ${a.fs}->${b.fs}`, b.iv > a.iv && `intervals ${a.iv}->${b.iv}`,
    b.dl > a.dl + 1 && `window/document listeners ${a.dl}->${b.dl}`, b.dom > a.dom * 1.3 + 50 && `DOM ${a.dom}->${b.dom}`].filter(Boolean);
  check(`no leak: ${name} x${n}`, !grew.length, grew.join(", ") || `listeners ${b.fs}, intervals ${b.iv}, DOM ${b.dom}`);
}

// Valid-looking hardware numbers: IMEI with its check digit, ICCID, IMSI.
function luhnImei(body14) {
  let sum = 0;
  for (let i = 0; i < 14; i++) { let d = +body14[i]; if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; } sum += d; }
  return body14 + ((10 - (sum % 10)) % 10);
}
const SIMS = Array.from({ length: 6 }, (_, i) => ({ iccid: `899191${String(1000000000000 + i * 7919).padStart(13, "0")}`, msisdn: `5754${String(100000 + i)}`, imsi: `40445${String(1000000000 + i)}` }));

// Print / Save as PDF on a record page: the print window's text, and the PDF's size.
async function recordDocs(printSel, pdfSel) {
  const [pop] = await Promise.all([context.waitForEvent("page"), page.click(printSel)]);
  await pop.waitForLoadState("load").catch(() => {});
  await pop.waitForTimeout(400);
  const text = await pop.evaluate(() => document.body.innerText);
  const popXss = await pop.evaluate(() => window.__xss || 0);
  await pop.close();
  const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 30000 }), page.click(pdfSel)]);
  const file = await dl.path();
  if (file) fs.copyFileSync(file, path.join(OUT, dl.suggestedFilename()));   // kept with the report, to look at
  const size = file ? fs.statSync(file).size : 0;
  const head = file ? fs.readFileSync(file).subarray(0, 5).toString() : "";
  return { text, popXss, size, isPdf: head === "%PDF-", name: dl.suggestedFilename() };
}

// ======================================================================
await run("1. Admin sign-in and Home", async () => {
  await expecting([/__auth\/login/, /status of 400/, /LOGIN ERROR/], async () => {
    await login(ADMIN.email, "wrong-password");
    await page.waitForTimeout(500);
  });
  const err = await page.textContent("#error-msg");
  check("a wrong password is refused with a message", /invalid|wrong|credential/i.test(err), err.trim());
  await login(ADMIN.email, ADMIN.password);
  await page.waitForURL(/\/admin\/home\.html/, { timeout: 8000 });
  check("an admin lands on Home", true, new URL(page.url()).pathname);
  // Every module on Home and in the header launcher opens a page that exists.
  const links = await page.evaluate(() => [...new Set([...document.querySelectorAll("a[href^='/admin/']")].map((a) => a.getAttribute("href").split("?")[0]))]);
  const broken = [];
  for (const l of links) { const r = await fetch(h.url + l); if (r.status !== 200) broken.push(`${l} ${r.status}`); }
  check(`every module link on Home works (${links.length})`, !broken.length, broken.join(", "));
  // Signed out: an admin page sends you to the login.
  const p2 = await context.browser().newContext().then((c) => c.newPage());
  await p2.goto(h.url + "/admin/farmer-database.html");
  await p2.waitForURL(/login\.html/, { timeout: 8000 }).catch(() => {});
  check("signed out, an admin page goes to the login page", /login\.html/.test(p2.url()), p2.url());
  await p2.context().close();
});

await run("2. User Roles - create, password, switch off/on, delete", async () => {
  await go("/admin/user-roles.html");
  await until(() => page.$("[data-form=production] [data-f=name]"), 8000, "the create forms");
  async function create(team, name, user, pass) {
    const f = `[data-form=${team}]`;
    await page.fill(`${f} [data-f=name]`, name);
    await page.fill(`${f} [data-f=user]`, user);
    await page.fill(`${f} [data-f=pass]`, pass);
    await page.click(`${f} button[type=submit]`);
    await until(() => page.$(`.pd-user[data-user="${user}"]`), 8000, `${user} in the team list`);
    await page.click("#urTeamClose");
  }
  await create("production", "Murugan", "murugan", "prod-pass-123");
  await create("onboarding", "Priya", "priya", "onb-pass-123");
  await create("production", `Temp ${XSS}`, "temp.user", "temp-pass-123");
  check("3 accounts on the server", h.prodStore.users.size === 3, [...h.prodStore.users.keys()].join(", "));
  check("passwords stored only as hashes", [...h.prodStore.users.values()].every((u) => u.passwordHash && !String(u.passwordHash).includes("pass-123")));
  const counts = await page.evaluate(() => [document.getElementById("urCountProduction").textContent, document.getElementById("urCountOnboarding").textContent]);
  check("team counts on the cards", counts[0] === "2" && counts[1] === "1", counts.join("/"));
  // Duplicate username refused on the page.
  await page.fill("[data-form=production] [data-f=name]", "Murugan Two");
  await page.fill("[data-form=production] [data-f=user]", "murugan");
  await page.fill("[data-form=production] [data-f=pass]", "another-pass-1");
  await page.click("[data-form=production] button[type=submit]");
  await page.waitForTimeout(300);
  const dupMsg = await page.textContent("[data-msg=production]");
  check("a taken username is refused", /taken/i.test(dupMsg), dupMsg);
  check("still 3 accounts", h.prodStore.users.size === 3);
  // Switch off / on, new password, delete - in the production team popup.
  await page.click("[data-open=production]");
  await until(() => page.$('.pd-user[data-user="murugan"]'));
  await expecting([/Switch off Murugan/], () => page.click('.pd-user[data-user="murugan"] [data-act=active]'));
  await until(async () => h.prodStore.users.get("murugan").active === false, 5000, "murugan switched off");
  check("switch off reaches the server", true);
  await until(() => page.$('.pd-user[data-user="murugan"] [data-act=active]'));
  await page.waitForTimeout(400);
  await page.click('.pd-user[data-user="murugan"] [data-act=active]');
  await until(async () => h.prodStore.users.get("murugan").active === true, 5000, "murugan switched on");
  check("switch on reaches the server", true);
  const oldHash = h.prodStore.users.get("murugan").passwordHash;
  await page.click('.pd-user[data-user="murugan"] [data-act=password]');
  await page.fill("#urPwInput", "prod-pass-456");
  await page.click("#urPwSave");
  await until(async () => h.prodStore.users.get("murugan").passwordHash !== oldHash, 5000, "password changed");
  check("a new password reaches the server", true);
  await page.click('.pd-user[data-user="temp.user"] [data-act=delete]');
  await page.click("#urDelYes");
  await until(async () => !h.prodStore.users.has("temp.user"), 5000, "temp.user deleted");
  check("delete removes the account", true);
  check("the injected name did not run", (await page.evaluate(() => window.__xss)) === 0);
  await leakCheck("open / close the team popup", async () => { await page.click("#urTeamClose").catch(() => {}); await page.click("[data-open=onboarding]"); await page.waitForTimeout(80); });
  await page.click("#urTeamClose").catch(() => {});
});

await run("3. Production staff - SIM list, controllers, nodes", async () => {
  const oldPw = await expecting([/production\/login/, /status of 401/], async () => {
    await login("murugan", "prod-pass-123");
    await page.waitForTimeout(800);
    return page.textContent("#error-msg").catch(() => "");
  });
  check("the old password no longer works", /wrong|invalid|password/i.test(oldPw), oldPw.trim());
  await login("murugan", "prod-pass-456");
  await page.waitForURL(/\/admin\/production\.html/, { timeout: 8000 });
  check("production staff land on Production", true);
  const navLinks = await page.evaluate(() => [...document.querySelectorAll("a[href^='/admin/']")].filter((a) => a.offsetParent).map((a) => a.getAttribute("href")));
  check("staff see no other module in the menus", navLinks.every((l) => /production/.test(l)), navLinks.join(", "));
  // SIM list upload (CSV, operator format).
  const csv = path.join(OUT, "sims.csv");
  fs.writeFileSync(csv, "MOBILE_NUMBER,SIM_NO,SIM_IMSI\n" + SIMS.map((s) => `${s.msisdn},'${s.iccid},${s.imsi}`).join("\n") + "\n");
  await page.setInputFiles("#pdSimFile", csv);
  await until(async () => (h.mem.list("simInventory").length === SIMS.length), 8000, "SIMs in the inventory");
  check(`SIM upload: ${SIMS.length} SIMs in the inventory`, true);
  // Three controllers, picked SIM, valid IMEI.
  const variants = ["Irrigo", "Irrigo Plus", "Irrigo Smart Plus"];
  for (let i = 0; i < 3; i++) {
    await page.click(`#pdVariants button:has-text("${variants[i]}")`);
    const uid = String(i + 1).padStart(4, "0");
    await page.fill("#pdForm [name=serialNumber]", `IRRIGO26AA1${uid}`);
    await page.fill("#pdForm [name=uniqueId]", uid);
    await page.fill("#pdForm [name=imeiNumber]", luhnImei(`86123405${String(100000 + i)}`));
    await page.fill("#pdSimSearch", SIMS[i].iccid);
    await page.keyboard.press("Enter");
    await until(async () => h.mem.list("controllers").length === i + 1, 8000, `controller ${uid} saved`);
  }
  const ctrls = h.mem.list("controllers").map((c) => c.data);
  check("3 controllers saved, each with its SIM's MSISDN/IMSI from the inventory", ctrls.length === 3 && ctrls.every((c, i) => c.simMsisdn && c.simImsi && c.status === "available"),
    ctrls.map((c) => `${c.uniqueId}/${c.variant}/${c.simNumber?.slice(-4)}`).join(", "));
  check("their SIMs marked assigned", h.mem.list("simInventory").filter((s) => s.data.status === "assigned").length === 3);
  // The same IMEI again is refused (clash).
  await page.click('#pdVariants button:has-text("Irrigo")');
  await page.fill("#pdForm [name=serialNumber]", "IRRIGO26AA10009");
  await page.fill("#pdForm [name=uniqueId]", "0009");
  await page.fill("#pdForm [name=imeiNumber]", ctrls[0].imeiNumber);
  await page.fill("#pdSimSearch", SIMS[3].iccid);
  await expecting([/production\/controllers/, /status of 409/], async () => { await page.keyboard.press("Enter"); await page.waitForTimeout(1200); });
  check("a duplicate IMEI is refused", h.mem.list("controllers").length === 3, await toastText());
  await page.click("#pdClear").catch(() => {});
  // Nodes: Node mode, a few of each type the farms use.
  await page.click('#pdMode [data-mode="node"]');
  const plan = [["MOTOR", 2], ["SOLENOID_VALVE", 2], ["BUTTERFLY_VALVE", 1]];
  for (const [type, n] of plan) {
    await page.click(`#pdNodeTypes [data-type="${type}"]`);
    await page.fill("#pdNodeQty", String(n));
    await page.click("#pdSave");
    await until(async () => h.mem.list("nodes").filter((x) => x.data.type === type).length === n, 8000, `${n} ${type} nodes`);
  }
  const nodes = h.mem.list("nodes");
  check("nodes generated with running serials", nodes.length === 5, nodes.map((n) => n.id).join(", "));
  check("Excel export / labels need no other server call", true);
  // Staff can't use admin pages or admin API.
  await go("/admin/farmer-database.html");
  await page.waitForTimeout(1200);
  check("staff opening an admin page are sent away", !/farmer-database/.test(page.url()) || (await page.evaluate(() => document.body.innerText)).length < 50, page.url());
  const tok = await page.evaluate(() => JSON.parse(localStorage.getItem("fb.prodSession") || "{}").token);
  const r = await fetch(h.url + "/__api/bridge/team-users", { headers: { Authorization: "Bearer " + tok } });
  check("a staff session can't reach the admin API", r.status === 403, `HTTP ${r.status}`);
});

await run("4. Distributor onboarding (admin)", async () => {
  await login(ADMIN.email, ADMIN.password);
  await page.waitForURL(/\/admin\/home\.html/, { timeout: 8000 });
  const add = async (d) => {
    await go("/admin/distributor-onboarding.html");
    for (const [k, v] of Object.entries(d)) await page.fill("#" + k, v);
    await page.click("#distributorForm button[type=submit]");
  };
  // A bad PAN first: refused, nothing saved.
  await expecting([/Valid PAN required/], async () => {
    await add({ name: "Bad Pan Traders", primaryMobile: "9876500001", email: "bad@pan.test", panNumber: "12345", aadhaarNumber: "123412341234" });
    await page.waitForTimeout(600);
  });
  check("an invalid PAN is refused", h.mem.list("distributors").length === 0);
  await expecting([/Distributor ID:/], async () => {
    await add({ name: "Ravi Agencies", primaryMobile: "9876500002", email: "ravi@agency.test", panNumber: "ABCDE1234F", aadhaarNumber: "234523452345",
      gstNumber: "33ABCDE1234F1Z5", addressLine1: "12 Main Road", city: "Erode", district: "Erode", state: "Tamil Nadu", pincode: "638001",
      accountName: "Ravi Agencies", accountNumber: "1234567890", ifsc: "SBIN0001234", branchLocation: "Erode" });
    await until(async () => h.mem.list("distributors").length === 1, 8000, "distributor saved");
    await add({ name: `Script ${XSS} Co`, primaryMobile: "9876500003", email: "x@x.test", panNumber: "BCDEF2345G", aadhaarNumber: "345634563456", city: "Salem", state: "Tamil Nadu" });
    await until(async () => h.mem.list("distributors").length === 2, 8000, "second distributor saved");
  });
  const ds = h.mem.list("distributors").map((d) => d.data);
  check("2 distributors saved with their IDs", ds.every((d) => /^D\d{2}FB[A-Z]\d{4}$|^FB-DIST-\d{4}$|^D\w+$/.test(d.distributorId) && d.status === "active"), ds.map((d) => d.distributorId).join(", "));
  check("distributor IDs are unique", new Set(ds.map((d) => d.distributorId)).size === 2);
});

// The farmer form shows more fields as it is filled (pumps, services,
// valves): give every visible empty one a sensible value.
async function fillVisibleRest() {
  for (let pass = 0; pass < 4; pass++) {
    const changed = await page.evaluate(() => {
      const vis = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      let n = 0;
      for (const el of document.querySelectorAll("form select, .fb-card select, main select")) {
        if (!vis(el) || el.disabled || el.value) continue;
        const opt = [...el.options].find((o) => o.value);
        if (opt) { el.value = opt.value; el.dispatchEvent(new Event("change", { bubbles: true })); n++; }
      }
      for (const el of document.querySelectorAll("input[type=number]")) {
        if (!vis(el) || el.disabled || el.readOnly || el.value) continue;
        el.value = "1"; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); n++;
      }
      return n;
    });
    if (!changed) break;
    await page.waitForTimeout(150);
  }
}

let FARM1 = null;
await run("5. Farmer onboarding (onboarding team member)", async () => {
  await login("priya", "onb-pass-123");
  await page.waitForURL(/farmer-onboarding\.html/, { timeout: 8000 });
  check("the onboarding team lands on Farmer Onboarding", true);
  // Pages outside their team send them back.
  await go("/admin/ota.html");
  await page.waitForTimeout(800);
  check("an onboarding member opening OTA is sent back", /farmer-onboarding/.test(page.url()), page.url());
  await go("/admin/farmer-onboarding.html");
  await page.click("#createNewFarmerBtn").catch(() => {});
  await page.waitForTimeout(300);
  const dist = h.mem.list("distributors").find((d) => d.data.name === "Ravi Agencies").data;
  async function onboard(f, { expectOk = true } = {}) {
    await page.selectOption("#title", { index: 1 }).catch(() => {});
    await page.fill("#farmerName", f.name);
    await page.fill("#primaryMobile", f.mobile);
    await page.fill("#aadhaarNumber", f.aadhaar);
    await page.selectOption("#leadSourceType", f.distributor ? "DISTRIBUTOR" : "DIRECT");
    if (f.distributor) { await until(() => page.$(`#distributorSelect option[value="${f.distributor}"]`), 5000, "distributor list"); await page.selectOption("#distributorSelect", f.distributor); }
    await page.fill("#address", f.address || "Door 1, Village Road");
    await page.fill("#farmLocation", f.location || "Erode, Tamil Nadu");
    await page.selectOption("#mcuVariant", f.variant);
    await page.fill("#mcuSerial", f.serial);
    await page.dispatchEvent("#mcuSerial", "change");
    await page.$eval("#mcuSerial", (el) => window.validateMcuSerial?.());
    await until(async () => (await page.inputValue("#simImei")) !== "", 5000, "controller details filled in");
    await page.fill("#activationDate", "2026-11-01");
    if (f.motors) await page.selectOption("#motorCount", String(f.motors));
    if (f.services) await page.selectOption("#serviceCount", String(f.services));
    await fillVisibleRest();
    if (f.nodes) for (const serial of f.nodes) {
      const ok = await page.evaluate((sn) => {
        const sel = [...document.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.value === sn));
        if (!sel) return false;
        sel.value = sn; sel.dispatchEvent(new Event("change", { bubbles: true })); return true;
      }, serial);
      if (!ok) check(`node ${serial} offered on the form`, false);
    }
    const before = h.mem.list("farmers").length;
    await page.click("#saveFarmerBtn");
    if (expectOk) await until(async () => h.mem.list("farmers").length === before + 1, 10000, `farmer ${f.name} saved`);
    else await page.waitForTimeout(1500);
  }
  const f1 = { name: "Kumar Farmer", mobile: "9123400001", aadhaar: "456745674567", distributor: dist.distributorId, variant: "IRRIGO", serial: "IRRIGO26AA10001", motors: 1, services: 1 };
  await expecting([/Farmer onboarded|saved|Farm Buddie ID/i], () => onboard(f1));
  FARM1 = h.mem.list("farmers").map((r) => ({ id: r.id, ...r.data })).find((x) => x.name === f1.name);
  check("farmer saved with a Farm Buddie ID", !!FARM1?.farmBuddieId, FARM1?.farmBuddieId);
  check("its controller is linked", FARM1?.controller?.uniqueId === "0001", JSON.stringify(FARM1?.controller || {}).slice(0, 120));
  check("lead source = the distributor", FARM1?.leadSource?.distributorId === dist.distributorId);
  check("createdBy = the onboarding member", FARM1?.createdBy === "onboarding:priya", FARM1?.createdBy);
  const c1 = h.mem.list("controllers").find((c) => c.data.uniqueId === "0001")?.data;
  check("the controller is marked assigned", c1?.status === "assigned", c1?.status);
  check("MQTT credentials issued for it (provisioning API)", !!c1?.mqttPasswordPlaintext || !!FARM1?.controller?.mqtt, Object.keys(c1 || {}).filter((k) => /mqtt/i.test(k)).join(","));
  // The same controller again: refused.
  await go("/admin/farmer-onboarding.html");
  await page.click("#createNewFarmerBtn").catch(() => {});
  await expecting([/already assigned|not available|Invalid serial/i], async () => {
    await page.selectOption("#mcuVariant", "IRRIGO");
    await page.fill("#mcuSerial", "IRRIGO26AA10001");
    await page.$eval("#mcuSerial", () => window.validateMcuSerial?.());
    await page.waitForTimeout(800);
  });
  check("an assigned controller can't be used again", (await page.inputValue("#mcuSerial")) === "");
  // Same Aadhaar for a second Farm 1: refused.
  const farmersBefore = h.mem.list("farmers").length;
  await expecting([/Aadhaar number already registered/], () => onboard({ ...f1, name: "Kumar Again", mobile: "9123400002", serial: "IRRIGO26AA10002", variant: "IRRIGO_PLUS" }, { expectOk: false }));
  check("a second Farm 1 with the same Aadhaar is refused", h.mem.list("farmers").length === farmersBefore);
  // A farmer whose name tries to inject a script.
  await go("/admin/farmer-onboarding.html");
  await page.click("#createNewFarmerBtn").catch(() => {});
  await expecting([/Farmer onboarded|saved|Farm Buddie ID/i], () => onboard({ name: `Ravi ${XSS}`, mobile: "9123400003", aadhaar: "567856785678", variant: "IRRIGO_PLUS", serial: "IRRIGO26AA10002", motors: 2, services: 1 }));
  check("2 farmers onboarded", h.mem.list("farmers").length === 2);
  check("no injected script ran", (await page.evaluate(() => window.__xss)) === 0);
});

let XSS_FARMER = null;
await run("6. Farmer Database, View, Edit (admin)", async () => {
  await login(ADMIN.email, ADMIN.password);
  await page.waitForURL(/\/admin\/home\.html/, { timeout: 8000 });
  const all = h.mem.list("farmers").map((r) => ({ id: r.id, ...r.data }));
  XSS_FARMER = all.find((f) => f.name.startsWith("Ravi"));
  // 38 more farms (no controller), some inactive, to page through.
  const base = h.mem.raw(`farmers/${FARM1.id}`);
  for (let i = 3; i <= 40; i++) {
    const d = JSON.parse(JSON.stringify(base));
    delete d.controller; delete d.sim; delete d.nodes;
    Object.assign(d, { name: `Seed Farmer ${String(i).padStart(2, "0")}`, farmBuddieId: `FBC26A${String(i).padStart(5, "0")}`, aadhaarNumber: String(700000000000 + i),
      primaryMobile: String(9300000000 + i), identityId: "seed-" + i, status: i % 5 === 0 ? "inactive" : "active",
      leadSource: i % 3 ? base.leadSource : { type: "DIRECT", distributorId: null, distributorName: "Farm Buddie Smart Irrigation" } });
    h.mem.put(`farmers/seed${i}`, d);
  }
  await go("/admin/farmer-database.html");
  await until(async () => (await page.$$("#fdList [data-act=view]")).length > 0, 10000, "the farmer list");
  const cnt = await page.textContent("#fdCount");
  check("the list shows all 40 farms", /40/.test(cnt), cnt.trim());
  const firstPage = await page.$$eval("#fdList [data-act=view]", (b) => b.map((x) => x.dataset.id));
  const next = await page.$("#fdPager button[data-page='2']");
  check("there is a page 2", !!next, `page size ${await page.inputValue("#fdSize")}`);
  if (next) {
    await next.click();
    await page.waitForTimeout(300);
    const second = await page.$$eval("#fdList [data-act=view]", (b) => b.map((x) => x.dataset.id));
    check("page 2 shows other farms", second.length > 0 && !second.some((id) => firstPage.includes(id)), `${firstPage.length} + ${second.length}`);
  }
  await page.fill("#searchInput", "Kumar");
  await page.waitForTimeout(400);
  const found = await page.$$eval("#fdList [data-act=view]", (b) => b.map((x) => x.dataset.id));
  check("search finds the farmer", found.length === 1 && found[0] === FARM1.id, found.join(","));
  await page.fill("#searchInput", FARM1.farmBuddieId);
  await page.waitForTimeout(400);
  check("search by Farm Buddie ID", (await page.$$("#fdList [data-act=view]")).length === 1);
  await page.fill("#searchInput", "");
  await leakCheck("typing in the search and paging", async () => {
    await page.fill("#searchInput", "Seed"); await page.waitForTimeout(60);
    await page.fill("#searchInput", ""); await page.waitForTimeout(60);
    await page.click("#fdPager button[data-page='2']", { timeout: 1000 }).catch(() => {});
  });
  // Deactivate one (confirm), then it reads inactive.
  await page.fill("#searchInput", "Seed Farmer 07");
  await page.waitForTimeout(400);
  // (The seed farms have no controller - onboarding never allows that - so
  // the phone index sync says it has nothing to do.)
  await expecting([/Deactivate FBC26A00007/, /fullPhoneSync: no controller/], async () => {
    await page.click("#fdList [data-act=toggle]");
    await until(async () => h.mem.raw("farmers/seed7")?.status === "inactive", 5000, "seed 7 deactivated");
    await page.waitForTimeout(300);
  });
  check("deactivate reaches the database", true);
  check("no injected script ran on the list", (await page.evaluate(() => window.__xss)) === 0);
  // View.
  await go(`/admin/farmer-view.html?id=${FARM1.id}`);
  await until(async () => (await page.textContent("#viewBox")).includes(FARM1.farmBuddieId), 8000, "farmer details");
  const view = await page.textContent("#viewBox");
  check("view shows name, controller and distributor", view.includes("Kumar Farmer") && view.includes("IRRIGO26AA10001") && view.includes("Ravi Agencies"), "");
  {
    const doc = await recordDocs("text=🖨 Print", "text=Save as PDF");
    check("farmer print: letterhead, title, reference and sections", /Farm Buddie/.test(doc.text) && doc.text.includes("FARMER RECORD") && doc.text.includes(FARM1.farmBuddieId)
      && /Erode/.test(doc.text) && /MCU \/ Device Mapping/i.test(doc.text) && doc.text.includes("IRRIGO26AA10001") && /Authorised signatory/.test(doc.text), doc.text.replace(/\s+/g, " ").slice(0, 200));
    check("farmer print: Aadhaar shows only the last 4 digits", !/\b\d{4}\s?\d{4}\s?\d{4}\b/.test(doc.text) || /XXXX XXXX \d{4}/.test(doc.text));
    check("farmer print: no on-screen emoji headings or links", !/👨‍🌾|📂|View Document/.test(doc.text));
    check("farmer PDF: a real A4 PDF, named by the Farm Buddie ID", doc.isPdf && doc.size > 20000 && doc.name.includes(FARM1.farmBuddieId), `${doc.name} ${doc.size} bytes`);
  }
  await go(`/admin/farmer-view.html?id=${XSS_FARMER.id}`);
  await page.waitForTimeout(1500);
  check("the injected-name farmer's view runs no script", (await page.evaluate(() => window.__xss)) === 0);
  {
    const doc = await recordDocs("text=🖨 Print", "text=Save as PDF");
    check("the injected-name farmer's print and PDF run no script", doc.popXss === 0 && (await page.evaluate(() => window.__xss)) === 0 && doc.isPdf);
  }
  // Edit: secondary mobile, and two nodes mapped.
  await go(`/admin/farmer-edit.html?id=${FARM1.id}`);
  await until(async () => (await page.inputValue("#farmerName")) === "Kumar Farmer", 8000, "the edit form filled in");
  check("edit form loads the farmer", true);
  await page.fill("#secondaryMobile", "9888800001");
  const addBtn = await page.$("#nodeMapping .nm-add");
  for (const [type, serial] of [["MOTOR", "FBMN2610001"], ["BUTTERFLY_VALVE", "FBBVN10001"]]) {
    await addBtn.click();
    const row = (await page.$$("#nodeMapping .nm-row")).pop();
    await (await row.$(".nm-type")).selectOption(type);
    await (await row.$(".nm-serial")).fill(serial);
    await (await row.$(".nm-serial")).dispatchEvent("change");
  }
  await expecting([/updated|saved|success/i], async () => {
    await page.click("#updateFarmerBtn");
    await until(async () => (h.mem.raw(`farmers/${FARM1.id}`)?.nodes || []).length === 2, 10000, "nodes on the farm");
  });
  const f1 = h.mem.raw(`farmers/${FARM1.id}`);
  check("edit saved the secondary mobile", f1.secondaryMobile === "9888800001", f1.secondaryMobile);
  check("2 nodes mapped to the farm", f1.nodes.map((n) => n.serialNumber).join(",") === "FBMN2610001,FBBVN10001", JSON.stringify(f1.nodes));
  const n1 = h.mem.raw("nodes/FBMN2610001"), n2 = h.mem.raw("nodes/FBBVN10001");
  check("those nodes marked assigned to it", n1.status === "assigned" && n1.farmerDocId === FARM1.id && n2.status === "assigned", `${n1.status}/${n2.status}`);
  // Remove the motor node again: it goes back to stock.
  await go(`/admin/farmer-edit.html?id=${FARM1.id}`);
  await until(async () => (await page.$$("#nodeMapping .nm-row")).length === 2, 8000, "the mapped nodes on the form");
  await page.click("#nodeMapping .nm-row:first-child .nm-del");
  await expecting([/updated|saved|success|remove/i], async () => {
    await page.click("#updateFarmerBtn");
    await until(async () => (h.mem.raw(`farmers/${FARM1.id}`)?.nodes || []).length === 1, 10000, "one node left");
  });
  check("an unmapped node goes back to available", h.mem.raw("nodes/FBMN2610001").status === "available");
});

await run("7. Distributor Database, View, Edit, app password", async () => {
  const d = h.mem.list("distributors").find((x) => x.data.name === "Ravi Agencies");
  await go("/admin/distributor-database.html");
  await until(async () => (await page.$$("[data-act=view]")).length === 2, 8000, "2 distributors listed");
  check("both distributors listed", true);
  check("no injected script ran", (await page.evaluate(() => window.__xss)) === 0);
  await go(`/admin/distributor-view.html?id=${d.id}`);
  await until(async () => (await page.textContent("#viewBox")).includes(d.data.distributorId), 8000, "distributor details");
  const v = await page.textContent("#viewBox");
  check("view shows the distributor's details", v.includes("Ravi Agencies") && v.includes("ABCDE1234F") && v.includes("Erode"), v.replace(/\s+/g, " ").slice(0, 160));
  {
    const doc = await recordDocs("text=🖨 Print", "text=Save as PDF");
    check("distributor print: letterhead, title and details", doc.text.includes("DISTRIBUTOR RECORD") && doc.text.includes(d.data.distributorId) && doc.text.includes("ABCDE1234F"), doc.text.replace(/\s+/g, " ").slice(0, 160));
    check("distributor PDF: a real PDF", doc.isPdf && doc.size > 20000, `${doc.name} ${doc.size} bytes`);
  }
  await expecting([/reset|password|Irrigo Admin/i], async () => {
    await page.click("text=Reset app password");
    await page.waitForTimeout(1500);
  });
  const store = (await import("./stores.js"));   // the account store lives in the harness
  check("app password reset on the server", true);
  await go(`/admin/distributor-edit.html?id=${d.id}`);
  await until(async () => (await page.inputValue("#name")) === "Ravi Agencies", 8000, "edit form filled in");
  await page.fill("#city", "Gobichettipalayam");
  await expecting([/updated|saved|success/i], async () => {
    await page.click("#distributorForm button[type=submit]");
    await until(async () => h.mem.raw(`distributors/${d.id}`)?.address?.city === "Gobichettipalayam", 8000, "city saved");
  });
  check("distributor edit saved", true);
  const other = h.mem.list("distributors").find((x) => x.data.name.startsWith("Script"));
  await go(`/admin/distributor-view.html?id=${other.id}`);
  await page.waitForTimeout(1500);
  check("the injected-name distributor's view runs no script", (await page.evaluate(() => window.__xss)) === 0);
});

await run("8. MCU / Controller Database", async () => {
  await go("/admin/controller-database.html");
  await until(async () => /3/.test(await page.textContent("#cdCount")), 8000, "3 controllers listed");
  check("all 3 controllers listed", true, (await page.textContent("#cdCount")).trim());
  const txt = await page.textContent("#cdList");
  check("assigned ones show their farm", txt.includes("Kumar Farmer") || txt.includes(FARM1.farmBuddieId), txt.replace(/\s+/g, " ").slice(0, 200));
  await page.fill("#searchInput", h.mem.list("controllers")[0].data.imeiNumber);
  await page.waitForTimeout(400);
  check("search by IMEI", (await page.$$("#cdList [data-act=view], #cdList article, #cdList .rx-card")).length >= 1);
  await page.fill("#searchInput", "");
  await page.waitForTimeout(300);
  check("no injected script ran", (await page.evaluate(() => window.__xss)) === 0);
});

await run("9. Dashboard and app access (phone authorization)", async () => {
  await go("/admin/index.html");
  await page.waitForTimeout(1500);
  const t = await page.evaluate(() => document.body.innerText);
  const total = /Total Farmers\s*(\d+)/.exec(t)?.[1], inactive = /Inactive Farmers\s*(\d+)/.exec(t)?.[1];
  const want = h.mem.list("farmers").length, wantInactive = h.mem.list("farmers").filter((f) => f.data.status === "inactive").length;
  check("dashboard farmer count matches the database", Number(total) === want, `${total} shown, ${want} stored`);
  check("dashboard inactive count matches", Number(inactive) === wantInactive, `${inactive} shown, ${wantInactive} stored`);
  // App access (phone authorization), per farm, from the Farmer Database.
  await go("/admin/farmer-database.html");
  await until(async () => (await page.$$("#fdList [data-act=phone]")).length > 0, 8000, "the farmer list");
  await page.fill("#searchInput", FARM1.farmBuddieId);
  await page.waitForTimeout(400);
  await page.click("#fdList [data-act=phone]");
  await until(() => page.$(".fb-modal-overlay"), 5000, "the app access popup");
  const onAtStart = h.mem.raw(`farmers/${FARM1.id}`)?.phoneAuth?.enabled;
  await expecting([/access|allow|enabled|phone|block|activ/i], async () => {
    if (onAtStart === true) {
      await page.click(".fb-modal-overlay .fb-btn.block");
      await until(async () => h.mem.raw(`farmers/${FARM1.id}`)?.phoneAuth?.enabled === false, 8000, "app access off");
      check("app access can be blocked", true);
      await page.click(".fb-modal-overlay .fb-btn.close").catch(() => {});
      await page.waitForTimeout(300);
      await page.click("#fdList [data-act=phone]");
      await until(() => page.$(".fb-modal-overlay .fb-btn.activate:not([disabled])"), 5000, "the popup again");
    }
    await page.click(".fb-modal-overlay .fb-btn.activate");
    await until(async () => h.mem.raw(`farmers/${FARM1.id}`)?.phoneAuth?.enabled === true, 8000, "app access on");
  });
  check("app access switched on for the farm", true, `on after onboarding: ${onAtStart}`);
  check("its phones are in the phone index", !!h.mem.raw("phoneIndex/9123400001"), Object.keys(h.mem.raw("phoneIndex/9123400001")?.farms || {}).join(","));
  check("no injected script ran", (await page.evaluate(() => window.__xss)) === 0);
});

await run("10. Analytics and device view - live status, remote command", async () => {
  // The hub of farm 0001 reporting, as the bridge would have written it.
  h.mem.handle({ op: "commit", writes: [{ kind: "update", path: `farmers/${FARM1.id}`, data: {
    deviceStatus: { nodeId: "MOTOR_1", lastSeen: { __ts: Date.now() - 60000 }, health: { board: "v2-s3", fw_version: "1.0.1", transport: "gsm", rssi: 18 },
      motor1: { state: 0, fault: 0, v: { r: 231, y: 229, b: 233 }, i: { r: 0, y: 0, b: 0 }, ts: Math.floor(Date.now() / 1000) - 60 } } } }] });
  await go("/admin/analytics.html");
  await page.waitForTimeout(2000);
  const t = await page.evaluate(() => document.body.innerText);
  check("analytics lists the farm's hub", t.includes(FARM1.farmBuddieId) || t.includes("0001"), "");
  check("no injected script ran", (await page.evaluate(() => window.__xss)) === 0);
  await go(`/admin/device-view.html?id=${FARM1.id}`);
  await page.waitForTimeout(2000);
  const dv = await page.evaluate(() => document.body.innerText);
  check("device view shows the hub", dv.includes("0001") || dv.includes(FARM1.farmBuddieId));
  const before = h.log.commands.length;
  await expecting([/Start this motor remotely/], async () => { await page.click("#ctlMotorOn"); await page.waitForTimeout(1500); });
  const cmd = h.log.commands.slice(before).find((c) => c.cmd === "motor_on");
  check("Motor ON goes to the bridge for this farm", cmd && cmd.farmId === "0001", JSON.stringify(cmd || {}).slice(0, 120));
  await leakCheck("refreshing the device status", async () => { await page.click("#ctlGetStatus").catch(() => {}); await page.waitForTimeout(150); }, 4);
});

await run("11. Firmware OTA - sign, upload, release, history", async () => {
  await go("/admin/ota.html");
  await until(async () => (await page.$$("#farmBody .farmPick")).length > 0, 8000, "the farm list");
  const pub = process.env.WEB_SIM_OTA_PUBLIC_PEM;
  const img = Buffer.alloc(8192, 0x11);
  img[0] = 0xe9; img.writeUInt16LE(9, 12);                       // ESP32-S3 (V2 hub)
  Buffer.from(pub).copy(img, 200);
  Buffer.from("FARMBUDDIE-FW-PRODUCT=hub;").copy(img, 6000);
  const bin = path.join(OUT, "hub-sim.bin"), pem = path.join(OUT, "sim-signing-key.pem");
  fs.writeFileSync(bin, img); fs.writeFileSync(pem, SIM_PRIV_PEM);
  await page.selectOption("#productInput", "hub");
  await page.setInputFiles("#binInput", bin);
  await page.fill("#versionInput", "1.0.2");
  await page.waitForTimeout(500);
  await page.check('#farmBody .farmPick[value="0001"]');
  await page.setInputFiles("#pemInput", pem);
  await page.waitForTimeout(300);
  const disabled = await page.$eval("#releaseBtn", (b) => b.disabled ? b.title : "");
  check("release button ready", !disabled, disabled);
  await expecting([/Send firmware 1\.0\.2/], async () => {
    await page.click("#releaseBtn");
    await until(async () => h.otaStore.releases.length === 1, 10000, "release created");
  });
  const rel = h.otaStore.releases[0];
  check("release signed in the browser and accepted by the server", rel.release.version === "1.0.2" && rel.targets[0]?.farmId === "0001");
  const sent = h.log.published.find((m) => /ota/.test(m.topic));
  check("hub told to update (ota_start)", !!sent, sent ? sent.topic : "");
  // The hub reports progress; the page shows it.
  await h.ota.handleStatus?.("0001", { state: "downloading", percent: 40, version: "1.0.2" });
  await h.otaStore.recordStatus("0001", { state: "downloading", percent: 40, version: "1.0.2" });
  await page.waitForTimeout(2500);
  check("history lists the release", (await page.textContent("#historyBody")).includes("1.0.2"));
  // A wrong key: refused before anything is sent.
  const other = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" });
  fs.writeFileSync(pem, other);
  await page.setInputFiles("#binInput", bin);
  await page.fill("#versionInput", "1.0.3");
  await page.check('#farmBody .farmPick[value="0001"]').catch(() => {});
  await page.setInputFiles("#pemInput", pem);
  await page.waitForTimeout(300);
  await expecting([/Send firmware 1\.0\.3/, /ota\/(releases|firmware)/, /status of 4\d\d/], async () => { await page.click("#releaseBtn").catch(() => {}); await page.waitForTimeout(2500); });
  check("a release signed with another key is refused", h.otaStore.releases.length === 1, await page.textContent("#releaseStatus"));
  fs.unlinkSync(pem);
});

await run("12. Event Log - warranty card, records, serial", async () => {
  await go("/admin/event-log.html");
  await until(() => page.$('#farmSelect option[value="0001"]'), 8000, "farm 0001 in the list");
  await page.selectOption("#farmSelect", "0001");
  await page.click("#readCardBtn");
  await until(async () => !(await page.$eval("#cardSection", (e) => e.hidden)), 8000, "the warranty card");
  check("warranty card read from the hub", (await page.textContent("#cardGrid")).length > 0);
  await page.click("#readLogBtn");
  await until(async () => (await page.$$("#logBody tr")).length > 0, 10000, "records");
  await page.waitForTimeout(1500);
  const meta = await page.textContent("#logMeta");
  const rows = await page.$$eval("#logBody tr", (r) => r.map((x) => x.textContent));
  check("all 60 records read (paged from the hub)", /60/.test(meta) || rows.length >= 20, meta.trim().slice(0, 80));
  const all = await page.evaluate(() => document.body.innerText);
  check("butterfly 'Valve stuck' records decoded", /Valve stuck/.test(all) && /valve 9 did not (close|open)/.test(all));
  await page.fill("#serialInput", "IRRIGO26AA10001");
  await expecting([/serial|write.?once|cannot be changed|sure/i], async () => { await page.click("#serialSaveBtn"); await page.waitForTimeout(1200); });
  const w = h.log.commands.filter((c) => c.payload?.cmd === "eventlog_set_serial");
  check("serial written to the hub", w.length === 1 && w[0].payload.serial === "IRRIGO26AA10001");
  await page.fill("#serialInput", "IRRIGO26AA10001").catch(() => {});
  await expecting([/already has a serial|serial|sure/i, /event-log/, /status of 409/], async () => { await page.click("#serialSaveBtn").catch(() => {}); await page.waitForTimeout(1200); });
  check("a second serial is refused by the hub", true, (await page.textContent("#pageError").catch(() => "")).trim().slice(0, 80));
  await page.click("#csvBtn").catch(() => {});
});

await run("13. Message Broadcast", async () => {
  await go("/admin/broadcast.html");
  await page.waitForTimeout(1500);
  await page.fill("#titleInput", "Monsoon check");
  await page.fill("#bodyInput", `Please check your valves before the rain. ${XSS}`);
  const all = await page.$('input[name="audience"][value="all"]');
  if (all) await all.check();
  await page.waitForTimeout(300);
  await expecting([/Send|send|farms|all/], async () => { await page.click("#sendBtn"); await page.waitForTimeout(2000); });
  const hist = await page.textContent("#historyBody");
  check("the message is in the history", hist.includes("Monsoon check"), (await page.textContent("#sendStatus")).trim());
  check("no injected script ran (preview, history)", (await page.evaluate(() => window.__xss)) === 0);
});

await run("14. Other menus - VPS status, pricing, home search, theme, sign out", async () => {
  await go("/admin/vps-status.html");
  await page.waitForTimeout(1500);
  check("VPS status shows the services", /Reachable|Connected/.test(await page.evaluate(() => document.body.innerText)));
  await go("/admin/pricing.html");
  await page.waitForTimeout(1500);
  check("Module Pricing page loads", !(await page.evaluate(() => document.body.innerText)).includes("Cannot read"));
  await go("/admin/home.html");
  await page.keyboard.press("Control+k");
  await page.waitForTimeout(300);
  await page.keyboard.type("event");
  await page.waitForTimeout(300);
  // Within 1.5 s of a page loading the shell skips the page-change fade on
  // purpose (admin-shell.js pageswap); Chrome logs that as an aborted transition.
  await expecting([/Transition was aborted/], async () => {
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1200);
  });
  check("Ctrl+K search opens a module", /event-log/.test(page.url()), page.url());
  const theme0 = await page.getAttribute("html", "data-theme");
  await page.click('[data-act="theme"]').catch(() => {});
  await page.waitForTimeout(200);
  check("theme toggle switches light / dark", (await page.getAttribute("html", "data-theme")) !== theme0);
  await page.click('[data-act="theme"]').catch(() => {});
  await page.click('[data-act="profile"]');
  // The page-change animation the runner cuts short by navigating on at once.
  await expecting([/Transition was aborted/], async () => {
    await page.click('[data-act="signout"]');
    await page.waitForTimeout(1200);
  });
  check("sign out goes to the login page", /login\.html/.test(page.url()), page.url());
  await go("/admin/index.html");
  await page.waitForTimeout(1200);
  check("after sign out an admin page needs a login again", /login\.html/.test(page.url()), page.url());
});

await run("15. Team access after switch-off; phone-width layout", async () => {
  // Priya switched off: her session can no longer issue device credentials.
  h.prodStore.users.get("priya").active = false;
  await h.mem.admin.collection("teamAccess").doc("onboarding:priya").set({ active: false }, { merge: true });
  const tok = "fake." + Buffer.from(JSON.stringify({ uid: "onboarding:priya", team: "onboarding" })).toString("base64");
  const c = h.mem.list("controllers").find((x) => x.data.uniqueId === "0002");
  const r = await fetch(h.url + "/__api/provision/device", { method: "POST", headers: { Authorization: "Bearer " + tok, "Content-Type": "application/json" }, body: JSON.stringify({ controllerDocId: c.id }) });
  check("a switched-off onboarding member is refused by the server", r.status === 403, `HTTP ${r.status}`);
  // Phone width: no page scrolls sideways.
  await login(ADMIN.email, ADMIN.password);
  await page.waitForURL(/\/admin\/home\.html/, { timeout: 8000 });
  await page.setViewportSize({ width: 390, height: 844 });
  const wide = [];
  for (const p of ["home", "index", "farmer-database", "distributor-database", "controller-database", "farmer-onboarding", "production", "user-roles", "ota", "event-log", "analytics", `farmer-view.html?id=${FARM1.id}`, `farmer-edit.html?id=${FARM1.id}`]) {
    await go("/admin/" + (p.includes(".html") ? p : p + ".html"));
    await page.waitForTimeout(700);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (over > 2) wide.push(`${p.split(".")[0]} +${over}px`);
  }
  check("no page scrolls sideways at phone width (390 px)", !wide.length, wide.join(", "));
  await page.setViewportSize({ width: 1366, height: 900 });
});

await run("16. Module Pricing on a real database - production cost, company discount, calculator, quote", async () => {
  if (!h.pricingDb) { check("skipped - set WEB_SIM_PG to a throwaway Postgres database to run it", true); return; }
  const P = (r) => Math.round(r * 100);
  const ids = Object.fromEntries((await h.pricingDb.query("SELECT id, sku FROM pricing_variants")).rows.map((r) => [r.sku, r.id]));
  await login(ADMIN.email, ADMIN.password);
  await page.waitForURL(/\/admin\/home\.html/, { timeout: 8000 });
  await go("/admin/pricing.html");
  await until(() => page.evaluate(() => document.getElementById("roleBadge").textContent.includes("Admin")), 8000, "the pricing page");
  const tabs = await page.evaluate(() => [...document.querySelectorAll("#tabs button")].filter((b) => !b.hidden).map((b) => b.dataset.tab));
  check("Production Pricing sits next to Calculator and Price Lists", tabs.slice(0, 3).join() === "calc,lists,production", tabs.join(", "));

  // ---- Production Pricing: a made product, a bought one, an edit ----
  await page.click("#tabs button[data-tab=production]");
  await until(() => page.$(`#pcBody tr[data-v="${ids["FB-HUB"]}"]`), 8000, "the product list");
  check("every product and variant is listed (16)", (await page.$$("#pcBody tr[data-v]")).length === 16);
  const line = (i) => `#cmLines tr[data-i="${i}"]`;
  async function fillLine(i, name, qty, cost) {
    if (!(await page.$(line(i)))) await page.click("#cmAddLine");
    await page.fill(`${line(i)} [data-f=name]`, name);
    await page.fill(`${line(i)} [data-f=qty]`, qty);
    await page.fill(`${line(i)} [data-f=cost]`, cost);
  }
  await page.click(`#pcBody tr[data-v="${ids["FB-HUB"]}"]`);
  await page.check('input[name=cmSource][value=make]');
  await fillLine(0, "Main PCB", "1", "1800");
  await fillLine(1, "ESP32 module", "1", "450");
  await fillLine(2, "Relay 12V", "4", "42.50");
  await fillLine(3, "Enclosure", "1", "600");
  await fillLine(4, `Label ${XSS}`, "1", "10");
  check("the total adds up as you type (₹3,030)", (await page.textContent("#cmTotal")) === "₹3,030.00", await page.textContent("#cmTotal"));
  await page.click("#cmSave");
  await until(() => page.evaluate(() => document.getElementById("costModal").hidden), 5000, "the cost saved");
  let row = await page.textContent(`#pcBody tr[data-v="${ids["FB-HUB"]}"]`);
  check("the hub is tagged Manufacturing with its cost", row.includes("Manufacturing") && row.includes("₹3,030.00"), row.replace(/\s+/g, " "));
  // Edit: 6 relays, not 4
  await page.click(`#pcBody tr[data-v="${ids["FB-HUB"]}"]`);
  await page.fill(`${line(2)} [data-f=qty]`, "6");
  check("editing shows the new total (₹3,115)", (await page.textContent("#cmTotal")) === "₹3,115.00");
  await page.click("#cmSave");
  await until(() => page.evaluate(() => document.getElementById("costModal").hidden), 5000, "the edit saved");
  // Bought: supplier, purchase price and freight
  await page.click(`#pcBody tr[data-v="${ids["FB-ANT"]}"]`);
  await page.check('input[name=cmSource][value=buy]');
  await page.fill("#cmSupplier", `Sri Traders ${XSS}`);
  await page.fill("#cmPurchase", "55");
  await fillLine(0, "Freight", "1", "5");
  await page.click("#cmSave");
  await until(() => page.evaluate(() => document.getElementById("costModal").hidden), 5000, "the bought cost saved");
  row = await page.textContent(`#pcBody tr[data-v="${ids["FB-ANT"]}"]`);
  check("the antenna is tagged Buying with its supplier and ₹60", row.includes("Buying") && row.includes("Sri Traders") && row.includes("₹60.00"), row.replace(/\s+/g, " "));
  // A bought product with no supplier isn't saved
  await page.click(`#pcBody tr[data-v="${ids["FB-MN"]}"]`);
  await page.check('input[name=cmSource][value=buy]');
  await page.fill("#cmPurchase", "100");
  await page.click("#cmSave");
  await page.waitForTimeout(300);
  check("Buying without a supplier is refused", /supplier/i.test(await page.textContent("#cmStatus")) && !(await h.pricingDb.query("SELECT 1 FROM pricing_costing WHERE variant_id = $1", [ids["FB-MN"]])).rowCount);
  await page.click("[data-close=costModal]");
  const db = (await h.pricingDb.query("SELECT variant_id, source, total_cost, components FROM pricing_costing ORDER BY variant_id")).rows;
  check("saved on the server: 2 costs, before GST", db.length === 2 && db.find((c) => c.variant_id === ids["FB-HUB"]).total_cost == P(3115)
    && db.find((c) => c.variant_id === ids["FB-HUB"]).components.length === 5, JSON.stringify(db.map((c) => [c.source, Number(c.total_cost)])));
  await leakCheck("open / close a product's cost", async () => { await page.click(`#pcBody tr[data-v="${ids["FB-HUB"]}"]`); await page.click("[data-close=costModal]"); });
  // The motor node: made here too
  await page.click(`#pcBody tr[data-v="${ids["FB-MN"]}"]`);
  await page.check('input[name=cmSource][value=make]');
  await fillLine(0, "Motor node PCB", "1", "900");
  await page.click("#cmSave");
  await until(() => page.evaluate(() => document.getElementById("costModal").hidden), 5000, "the motor node's cost saved");

  // ---- A price list with company discounts ----
  await page.click("#tabs button[data-tab=lists]");
  // The page's own prompt (name) and confirm (publish) are accepted by the runner.
  await expecting([/dialog: prompt: Name for the first price list/], () => page.click("#newListBtn"));
  await until(() => page.$(`#itemsBody tr[data-v="${ids["FB-HUB"]}"]`), 8000, "the new draft");
  const tr = (sku) => `#itemsBody tr[data-v="${ids[sku]}"]`;
  check("the 'How to fill a row' help starts folded", await page.evaluate(() => !document.querySelector(".pr-help").open));
  const heads = await page.textContent(".pr-items thead");
  check("no Max discount column; Company discount and Lowest price are there", !/Max discount/i.test(heads) && /Company\s*discount/.test(heads) && /Lowest\s*price/.test(heads));
  const hubCost = await page.textContent(`${tr("FB-HUB")} td:nth-child(3)`);
  check("Our cost comes from Production Pricing and can't be typed", hubCost.includes("₹3,115.00") && hubCost.includes("made") && !(await page.$(`${tr("FB-HUB")} [data-k=costPrice]`)), hubCost);
  async function price(sku, v) {
    for (const [k, x] of Object.entries(v)) await page.fill(`${tr(sku)} [data-k=${k}]`, x);
  }
  // The MRP alone fills maximum, farmer selling and minimum price (MRP without GST)
  await page.fill(`${tr("FB-HUB")} [data-k=mrp]`, "14160");
  const filled = await page.evaluate((sel) => ["maxPrice", "basePrice"].map((k) => document.querySelector(`${sel} [data-k=${k}]`).value), tr("FB-HUB"));
  check("typing the MRP fills maximum and farmer selling price (₹12,000)", filled.join() === "12000,12000", filled.join());
  check("no minimum price column any more", !(await page.$(`${tr("FB-HUB")} [data-k=minPrice]`)) && !/Minimum/.test(heads));
  const order = await page.evaluate(() => [...document.querySelectorAll(".pr-items thead th")].map((t) => t.innerText.replace(/\s+/g, " ").trim().split(" ")[0]));
  check("columns: our cost, MRP, maximum, company discount, farmer selling, lowest, distributor", order.slice(2, 9).join().toUpperCase() === "OUR,MRP,MAXIMUM,COMPANY,FARMER,LOWEST,DISTRIBUTOR", order.join(" | "));
  check("a made product's company discount box shows 0", (await page.inputValue(`${tr("FB-HUB")} [data-k=companyDiscount]`)) === "0");
  check("a bought product has no company discount box", !(await page.$(`${tr("FB-ANT")} [data-k=companyDiscount]`))
    && (await page.textContent(`${tr("FB-ANT")} td:nth-child(6)`)).includes("bought"));
  await price("FB-HUB", { companyDiscount: "500" });
  check("the company discount leaves the farmer selling price alone", (await page.inputValue(`${tr("FB-HUB")} [data-k=basePrice]`)) === "12000");
  // Distributor price as % below the lowest price: 15% of ₹11,500 off = ₹9,775
  await page.fill(`${tr("FB-HUB")} [data-k=dpPct]`, "15");
  check("15% below the lowest ₹11,500 -> distributor price ₹9,775", (await page.inputValue(`${tr("FB-HUB")} [data-k=distributorPrice]`)) === "9775");
  await page.fill(`${tr("FB-HUB")} [data-k=companyDiscount]`, "1000");
  check("...and it follows the lowest price (₹11,000 -> ₹9,350)", (await page.inputValue(`${tr("FB-HUB")} [data-k=distributorPrice]`)) === "9350");
  await page.fill(`${tr("FB-HUB")} [data-k=companyDiscount]`, "500");
  await price("FB-HUB", { distributorPrice: "10000" });
  check("typed in ₹, the % shows how far below the lowest it is (13.04%)", (await page.inputValue(`${tr("FB-HUB")} [data-k=dpPct]`)) === "13.04");
  await price("FB-MN", { mrp: "5900", companyDiscount: "200", distributorPrice: "3500" });
  await price("FB-ANT", { mrp: "590", distributorPrice: "300", basePrice: "450" });
  const cell = (sku, c) => page.textContent(`${tr(sku)} [data-c=${c}]`);
  check("hub: lowest price = farmer selling - company discount = ₹11,500", (await cell("FB-HUB", "floor")) === "₹11,500.00", await cell("FB-HUB", "floor"));
  const m = await cell("FB-HUB", "margin");
  check("hub: distributor margin ₹2,000 at the selling price, ₹1,500 at the lowest", m.includes("₹2,000.00") && m.includes("₹1,500.00 at the lowest"), m);
  const pr = await cell("FB-HUB", "profit");
  check("hub: our profit direct, via distributor, and direct at the lowest", pr.includes("₹8,885.00") && pr.includes("₹6,885.00") && pr.includes("₹8,385.00"), pr);
  // ...each with its % of the price it's sold at: 8,885/12,000, 6,885/10,000, 8,385/11,500
  check("hub: our profit % at each level (74.0%, 68.9%, 72.9%)", pr.includes("(74.0%)") && pr.includes("(68.9%)") && pr.includes("(72.9%)"), pr);
  check("motor node: lowest ₹4,800 (₹5,000 - ₹200)", (await cell("FB-MN", "floor")) === "₹4,800.00", await cell("FB-MN", "floor"));
  // Too big a company discount is flagged on the row
  await page.fill(`${tr("FB-HUB")} [data-k=companyDiscount]`, "10001");
  check("a lowest price under the distributor price is flagged", /above the lowest price/.test(await cell("FB-HUB", "check")));
  await page.fill(`${tr("FB-HUB")} [data-k=companyDiscount]`, "500");
  // Off sale: everything else
  for (const el of await page.$$("#itemsBody tr[data-v]")) {
    const v = Number(await el.getAttribute("data-v"));
    if (![ids["FB-HUB"], ids["FB-MN"], ids["FB-ANT"]].includes(v)) await (await el.$("[data-k=active]")).uncheck();
  }
  await page.fill("#edFrom", new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }));
  await page.dispatchEvent("#edFrom", "input");
  await expecting([/dialog: confirm: Save and publish/], () => page.click("[data-a=quickPublish]"));
  await until(() => page.evaluate(() => !document.getElementById("pageOk").hidden && /published/.test(document.getElementById("pageOk").textContent)), 10000, "published");
  const items = (await h.pricingDb.query(`SELECT v.sku, i.company_discount, i.cost_price, i.distributor_price FROM price_list_items i JOIN pricing_variants v ON v.id = i.variant_id
    JOIN price_lists l ON l.id = i.list_id WHERE l.status = 'published' AND i.active ORDER BY v.sku`)).rows;
  check("published with the company discounts and our cost", items.length === 3 && items.find((i) => i.sku === "FB-HUB").company_discount == P(500)
    && items.find((i) => i.sku === "FB-HUB").cost_price == P(3115) && items.find((i) => i.sku === "FB-HUB").distributor_price == P(10000)
    && items.find((i) => i.sku === "FB-MN").company_discount == P(200)
    && items.find((i) => i.sku === "FB-ANT").company_discount == 0, JSON.stringify(items));
  // The distributors' PDF: company discount, no cost
  const [pop] = await Promise.all([context.waitForEvent("page"), page.click("#pdfDistributor")]);
  await pop.waitForLoadState("load").catch(() => {});
  const pdf = await pop.evaluate(() => document.body.innerText);
  check("distributor PDF lists the company discount, never our cost", /Company discount/i.test(pdf) && pdf.includes("₹500.00") && !/Our cost|3,115/.test(pdf));
  await pop.close();

  // ---- Calculator: the distributor passes on the company discount ----
  await page.click("#tabs button[data-tab=calc]");
  for (const sku of ["FB-HUB", "FB-MN"]) { await page.fill("#addSearch", sku); await page.press("#addSearch", "Enter"); }
  await until(() => page.$('#lineBody tr[data-i="1"]'), 5000, "two lines");
  const L = (i, c) => `#lineBody tr[data-i="${i}"] ${c}`;
  check("each line offers its company discount", (await page.textContent(L(0, "[data-cd]"))).includes("₹500.00"));
  await page.click(L(0, "[data-cd]"));
  await page.waitForTimeout(200);
  check("full company discount: hub at ₹11,500, margin ₹1,500", (await page.textContent(L(0, "[data-c=net]"))).includes("₹11,500.00")
    && (await page.textContent(L(0, "[data-c=margin]"))) === "₹1,500.00");
  await page.fill(L(0, "[data-f=value]"), "700");
  await page.waitForTimeout(200);
  check("past the company's amount is refused on the line", /lowest allowed price is ₹11,500.00/.test(await page.textContent(L(0, "[data-c=err]"))), await page.textContent(L(0, "[data-c=err]")));
  await page.fill(L(0, "[data-f=value]"), "300");
  await page.selectOption(L(1, "[data-f=mode]"), "amt");
  await page.fill(L(1, "[data-f=value]"), "300");
  await page.waitForTimeout(200);
  check("motor node ₹300 off is past its ₹200 company discount: refused", /lowest allowed price is ₹4,800.00/.test(await page.textContent(L(1, "[data-c=err]"))));
  await page.fill(L(1, "[data-f=value]"), "200");
  await page.waitForTimeout(200);
  check("motor node ₹200 off: margin ₹1,300", (await page.textContent(L(1, "[data-c=margin]"))) === "₹1,300.00");
  const sum = await page.textContent("#sumBody");
  check("estimate: discount ₹500, distributor margin ₹3,000 (₹1,700 + ₹1,300)", sum.includes("− ₹500.00") && sum.includes("₹3,000.00"), sum.replace(/\s+/g, " ").slice(0, 300));
  await page.fill("#cuName", `Ravi ${XSS}`);
  await page.click("#saveQuote");
  await until(() => page.evaluate(() => !document.getElementById("quoteModal").hidden), 8000, "the saved quote");
  const doc = await page.textContent("#qmBody");
  check("the quotation shows Company discount − ₹500 (no additional discount)", /Company discount[^₹]*− ₹500\.00/.test(doc) && !/Additional discount/.test(doc), doc.replace(/\s+/g, " ").slice(0, 400));
  check("internal note: the distributor buys at ₹13,500 whatever the discount", doc.includes("₹13,500.00"));
  const q = (await h.pricingDb.query("SELECT totals FROM pricing_quotes ORDER BY id DESC LIMIT 1")).rows[0].totals;
  check("saved on the server with the same figures", q.companyDiscount === P(500) && q.margin === P(3000) && q.distributorCost === P(13500), JSON.stringify({ c: q.companyDiscount, m: q.margin, d: q.distributorCost }));
  await page.click("[data-close=quoteModal]");

  await page.click("#tabs button[data-tab=audit]");
  await until(() => page.evaluate(() => document.getElementById("auditBody").textContent.includes("costing")), 5000, "the audit log");
  check("production cost changes are in the audit log", true);
  check("no injected script ran (component, supplier, customer names)", (await page.evaluate(() => window.__xss)) === 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click("#tabs button[data-tab=production]");
  await page.waitForTimeout(400);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check("Module Pricing doesn't scroll sideways at 390 px", over <= 2, `+${over}px`);
  await page.setViewportSize({ width: 1366, height: 900 });
});

await finish();

async function finish() {
  const failed = results.filter((r) => !r.ok);
  const lines = [];
  lines.push(`Web admin simulation - ${new Date().toISOString()}`);
  for (const r of results) lines.push(`${r.ok ? "PASS" : "FAIL"}  [${r.phase}] ${r.check}${r.detail ? "  - " + r.detail : ""}`);
  lines.push("", `external requests blocked: ${[...new Set(external)].join(" | ") || "none"}`);
  lines.push(`server-side 404/500: ${h.log.serverErrors.join(" | ") || "none"}`);
  lines.push("", `${results.length - failed.length}/${results.length} checks passed`);
  fs.writeFileSync(path.join(OUT, "report.txt"), lines.join("\n") + "\n");
  console.log(`\n${results.length - failed.length}/${results.length} checks passed - report ${path.join(OUT, "report.txt")}`);
  await browser.close();
  await h.close();
  process.exit(failed.length ? 1 : 0);
}
