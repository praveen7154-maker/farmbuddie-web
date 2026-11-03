// Exploration pass: sign in as admin, open every admin page, record what goes
// wrong and what each page shows (for writing the scenarios in run.js).
//   node tools/web_sim/explore.js [page ...]
import fs from "node:fs";
import path from "node:path";
import { startHarness, ADMIN } from "./harness.js";
import { openBrowser, newPage } from "./browser.js";

const OUT = process.env.WEB_SIM_OUT || "/tmp/web_sim";
fs.mkdirSync(OUT, { recursive: true });
const only = process.argv.slice(2);

const h = await startHarness();
const { browser, context, external } = await openBrowser(h);
const issues = [];
const page = await newPage(context, issues);

await page.goto(h.url + "/login.html");
await page.fill("#email", ADMIN.email);
await page.fill("#password", ADMIN.password);
await page.click("#loginBtn");
await page.waitForURL(/\/admin\/(home|index)\.html/, { timeout: 10000 });
console.log("signed in ->", new URL(page.url()).pathname);

const pages = fs.readdirSync(path.resolve("public/admin")).filter((f) => f.endsWith(".html")).map((f) => f.replace(".html", ""));
for (const p of pages) {
  if (only.length && !only.includes(p)) continue;
  const before = issues.length;
  await page.goto(`${h.url}/admin/${p}.html`);
  await page.waitForTimeout(1500);
  const info = await page.evaluate(() => {
    const vis = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const fields = [...document.querySelectorAll("input,select,textarea,button")].filter(vis)
      .map((el) => `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${el.name ? "[" + el.name + "]" : ""}${el.type && el.tagName === "INPUT" ? ":" + el.type : ""}${el.tagName === "BUTTON" ? "'" + el.textContent.trim().slice(0, 24) + "'" : ""}`);
    return { title: document.title, h1: document.querySelector("h1,h2")?.textContent.trim().slice(0, 60), fields: fields.slice(0, 80), stats: window.__fbStats || null, text: document.body.innerText.slice(0, 400).replace(/\s+/g, " ") };
  });
  await page.screenshot({ path: path.join(OUT, `${p}.png`), fullPage: false });
  console.log(`\n== ${p} (${new URL(page.url()).pathname}) "${info.h1}" listeners=${info.stats?.listeners} reads=${info.stats?.reads}`);
  console.log("   fields:", info.fields.join(" "));
  console.log("   text:", info.text.slice(0, 250));
  for (const i of issues.slice(before)) console.log(`   !! ${i.kind}: ${i.text}`);
}
console.log("\nexternal requests blocked:", [...new Set(external)].join(" | ") || "none");
console.log("server-side 404/500:", h.log.serverErrors.join(" | ") || "none");
await browser.close();
await h.close();
