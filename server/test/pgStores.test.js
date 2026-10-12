// Every Postgres store against a real database - the other tests use fakes.
// Opt-in: PG_TEST_URL=postgres://user@host:port/emptydb npm test
// (the database's tables are created and filled - use a throwaway one).
import { test } from "node:test";
import assert from "node:assert/strict";

const url = process.env.PG_TEST_URL;

test("postgres stores work against a real database", { skip: url ? false : "set PG_TEST_URL to run" }, async () => {
  process.env.BRIDGE_PG_CONNECTION_STRING = url;
  const S = "../src/bridge/";
  const { pool, ensureSchema, insertEvent, queryEvents, queryAlerts } = await import(S + "postgres.js");
  const { ensureOtaSchema, pgOtaStore: ota } = await import(S + "otaStore.js");
  const { ensureAnnouncementSchema, pgAnnouncementStore: ann } = await import(S + "announcementStore.js");
  const { ensureReportSchema, pgReportStore: rep } = await import(S + "reportStore.js");
  const fc = await import(S + "farmConfigCache.js");
  const { ensureDistributorSchema, pgDistributorStore: dist } = await import(S + "distributorStore.js");
  const ok = () => {};
  try {

    for (const sch of [ensureSchema, fc.ensureFarmConfigCacheSchema, ensureOtaSchema, ensureAnnouncementSchema, ensureReportSchema]) { await sch(); await sch(); }
    ok("all schemas create, and re-run safely");

    // events
    const t0 = new Date();
    await insertEvent({ farmId: "0001", nodeId: "MOTOR_1", eventType: "motor1_status", payload: { state: 1, event: 7 } });
    await insertEvent({ farmId: "0001", nodeId: "MOTOR_1", eventType: "motor2_status", payload: { state: 0 } });
    await insertEvent({ farmId: "0001", nodeId: "MOTOR_1", eventType: "valves_status", payload: { open: [] } });
    assert.equal((await queryEvents("0001", new Date(Date.now() - 60000))).length, 3);
    assert.equal((await queryAlerts("0001", new Date(Date.now() - 60000), 10)).length, 1);
    ok("device events insert / query / alerts");
    assert.ok((await rep.samples("0001", ["motor1_status"], Date.now() - 60000, Date.now() + 1000)).length === 1);
    await rep.saveDays("0001", "1", [{ day: "2026-10-12", x: 1 }]);
    await rep.saveDays("0001", "1", [{ day: "2026-10-12", x: 2 }]);
    assert.equal((await rep.savedDays("0001", "1", ["2026-10-12"])).get("2026-10-12").x, 2);
    assert.deepEqual((await rep.activeMotors(Date.now() - 60000, Date.now() + 1000)).map((m) => m.motor).sort(), ["1", "2"]);
    ok("report store");
    await fc.setCachedConfigFromResponse("0001", "1", { type: "config_safety", a: 1 });
    await fc.setCachedConfigFromResponse("0001", "1", { type: "config_safety", a: 2 });
    assert.equal((await fc.getCachedConfig("0001", "motor", "1", "safety")).config.a, 2);
    assert.equal((await fc.getCachedConfigsForFarm("0001")).length, 1);
    ok("farm config cache");

    // OTA
    const sha1 = "a".repeat(64), sha2 = "b".repeat(64);
    await ota.saveFirmware({ sha256: sha1, version: "1.0.2", product: "hub", size: 3, data: Buffer.from([1, 2, 3]), uploadedBy: "a@x" });
    await ota.saveFirmware({ sha256: sha2, version: "1.0.3", product: "motor-node", size: 2, data: Buffer.from([9, 9]), uploadedBy: "a@x" });
    assert.deepEqual([...(await ota.getFirmwareData(sha1))], [1, 2, 3]);
    const at = new Date();
    const r1 = await ota.createRelease({ sha256: sha1, version: "1.0.2", product: "hub", url: "u", signature: "s", mode: "farms", createdBy: "a@x" },
      [{ farmId: "0001", nodeId: "MOTOR_1" }, { farmId: "0002", nodeId: "MOTOR_1" }], at);
    const r2 = await ota.createRelease({ sha256: sha2, version: "1.0.3", product: "motor-node", url: "u", signature: "s", mode: "farms", createdBy: "b@y" },
      [{ farmId: "0001", nodeId: "MOTOR_1" }], at);
    const r3 = await ota.createRelease({ sha256: sha2, version: "1.0.3", product: "motor-node", url: "u", signature: "s", mode: "farms", createdBy: "b@y" },
      [{ farmId: "0002", nodeId: "MOTOR_1" }], new Date(at.getTime() + 1000));
    await ota.recordStatus("0001", { state: "downloading", percent: 40, version: "1.0.2", transport: "gsm" }, new Date());
    await ota.recordStatus("0001", { state: "staged", product: "motor-node", version: "1.0.3" }, new Date());
    await ota.recordNodeStatus("0001", { node: "MOTOR_2", product: "motor-node", state: "receiving", percent: 10 }, new Date());
    await ota.recordNodeStatus("0001", { node: "MOTOR_2", product: "motor-node", state: "validated", version: "1.0.3" }, new Date());
    let g = await ota.getRelease(r1);
    assert.equal(g.targets.find((t) => t.farmId === "0001").state, "downloading");
    assert.equal(g.release.stoppedAt, null);
    g = await ota.getRelease(r2);
    assert.equal(g.targets[0].state, "staged");
    assert.equal(g.nodes[0].state, "validated");
    ok("OTA create / status / node status / get");
    assert.equal((await ota.listReleases(10, 0)).length, 3);
    assert.equal((await ota.listReleases(10, 0, "motor-node")).length, 2);
    assert.equal(await ota.countReleases("hub"), 1);
    assert.deepEqual((await ota.listReleases(10, 0, null, "0002")).map((r) => r.release.id).sort(), [r1, r3]);
    assert.deepEqual((await ota.listReleases(10, 0, null, "B@Y")).map((r) => r.release.id).sort(), [r2, r3]);
    assert.ok((await ota.listReleases(10, 0, null, String(r1))).some((r) => r.release.id === r1));
    assert.equal(await ota.countReleases(null, "1.0.3"), 2);
    assert.equal(await ota.countReleases(null, "%"), 0);   // a % typed in the search is a literal? (ILIKE wildcard)
    ok("OTA list / count / search");
    assert.deepEqual(await ota.latestReleaseVersions(), { hub: "1.0.2", "motor-node": "1.0.3" });
    assert.deepEqual(await ota.farmsWithNewerNodeRelease(r2, ["0001", "0002"]), ["0002"]);
    await ota.markStopped(r2, "a@x", new Date());
    assert.ok((await ota.getRelease(r2)).release.stoppedAt);
    await ota.markSent(r1, ["0002"], new Date());
    assert.equal((await ota.getRelease(r1)).targets.find((t) => t.farmId === "0002").attempts, 2);
    ok("OTA latest / newer / stop / markSent");
    assert.equal(await ota.deleteReleases([r2]), 1);
    assert.ok(await ota.getFirmwareMeta(sha2), "sha2 still used by r3");
    assert.equal(await ota.deleteReleases([r3, 9999]), 1);
    assert.equal(await ota.getFirmwareMeta(sha2), null);
    assert.ok(await ota.getFirmwareMeta(sha1));
    const { rows: orphan } = await pool.query("SELECT count(*)::int n FROM ota_node_status");
    assert.equal(orphan[0].n, 0);
    ok("OTA delete (cascade + orphan .bin removed, shared .bin kept)");

    // announcements
    const a1 = await ann.create({ category: "general", title: "T", body: "B", titleTa: null, bodyTa: null, important: false, audience: "farms", farmIds: ["0001"], sendAt: new Date(Date.now() - 1000), expiresAt: null, createdBy: "a@x" });
    const a2 = await ann.create({ category: "general", title: "T2", body: "B", titleTa: null, bodyTa: null, important: true, audience: "all", farmIds: [], sendAt: new Date(Date.now() + 3600e3), expiresAt: null, createdBy: "a@x" });
    assert.deepEqual(await ann.dueIds(), [a1]);
    assert.ok(await ann.claim(a1));
    assert.equal(await ann.claim(a1), null);
    await ann.recordDelivery(a1, { targetFarms: 1, targetPhones: 2, targetDevices: 3, pushOk: 3, pushFailed: 0 });
    assert.equal((await ann.feed(["0001"], "9000000001", 50, 30)).length, 1);
    assert.equal((await ann.feed(["0002"], "9000000001", 50, 30)).length, 0);
    assert.deepEqual(await ann.visibleIds([a1, a2], ["0001"]), [a1]);
    await ann.markRead([a1], "9000000001"); await ann.markRead([a1], "9000000001");
    assert.equal((await ann.reads(a1)).length, 1);
    assert.equal((await ann.feed(["0001"], "9000000001", 50, 30))[0].read, true);
    assert.equal(await ann.count(), 2);
    assert.equal(await ann.count("scheduled"), 1);
    assert.equal((await ann.list(10, 0, "sent")).length, 1);
    assert.ok((await ann.get(a1)).title);
    assert.equal(await ann.recall(a2, "a@x"), true);
    assert.equal(await ann.recall(a2, "a@x"), false);
    assert.equal(await ann.remove([a1, 12345]), 1);
    assert.equal((await pool.query("SELECT count(*)::int n FROM announcement_reads")).rows[0].n, 0);
    ok("announcements: create / due / claim once / feed / read / recall / delete");
    // Farm Buddie Official - distributors
    const mk = (extra) => ann.create({ category: "general", title: extra.title, body: "b", titleTa: null, bodyTa: null, important: false,
      farmIds: null, sendAt: null, expiresAt: null, createdBy: "a@x", ...extra });
    const toAllFarmers = await mk({ title: "all farmers", audience: "all" });
    const toFarm1 = await mk({ title: "farm 0001", audience: "farms", farmIds: ["0001"] });
    const toFarm9 = await mk({ title: "farm 0009", audience: "farms", farmIds: ["0009"] });
    const toAllDist = await mk({ title: "all distributors", audience: "distributors", distributorIds: [] });
    const toDist1 = await mk({ title: "dist 1", audience: "distributors", distributorIds: ["D26FBA0001"] });
    const toDist2 = await mk({ title: "dist 2", audience: "distributors", distributorIds: ["D26FBA0002"] });
    for (const id of [toAllFarmers, toFarm1, toFarm9, toAllDist, toDist1, toDist2]) await ann.claim(id);
    const titles = async (farms, reader, dist) => (await ann.feed(farms, reader, 50, 30, dist)).map((a) => a.title).sort();
    // Distributor 1, whose farmer is on farm 0001.
    assert.deepEqual(await titles(["0001"], "dist:D26FBA0001", "D26FBA0001"), ["all distributors", "all farmers", "dist 1", "farm 0001"]);
    // Distributor 2 with no farmers yet.
    assert.deepEqual(await titles([], "dist:D26FBA0002", "D26FBA0002"), ["all distributors", "all farmers", "dist 2"]);
    // A farmer on 0001 never sees distributor messages.
    assert.deepEqual(await titles(["0001"], "9000000001", null), ["all farmers", "farm 0001"]);
    assert.deepEqual((await ann.visibleIds([toDist1, toDist2, toFarm9], ["0001"], "D26FBA0001")), [toDist1]);
    await ann.markRead([toDist1], "dist:D26FBA0001");
    assert.equal((await ann.feed(["0001"], "dist:D26FBA0001", 50, 30, "D26FBA0001")).find((a) => a.id === toDist1).read, true);

    // distributor logins
    await ensureDistributorSchema(); await ensureDistributorSchema();
    assert.equal(await dist.getAccount("FB-DIST-0001"), null);
    await dist.setPassword("FB-DIST-0001", "h1", true);
    await dist.setPassword("FB-DIST-0001", "h2", false);
    assert.deepEqual(await dist.getAccount("FB-DIST-0001"), { passwordHash: "h2", mustChange: false });
    await dist.createSession("s1", "FB-DIST-0001", new Date(Date.now() + 60000));
    await dist.createSession("s2", "FB-DIST-0001", new Date(Date.now() + 60000));
    await dist.createSession("old", "FB-DIST-0001", new Date(Date.now() - 1000));
    assert.equal((await dist.getSession("s1")).distributorId, "FB-DIST-0001");
    assert.equal(await dist.getSession("old"), null);
    await dist.deleteSessions("FB-DIST-0001", "s1");
    assert.equal(await dist.getSession("s2"), null);
    assert.ok(await dist.getSession("s1"));
    await dist.deleteSession("s1");
    assert.equal(await dist.getSession("s1"), null);
    await dist.saveDevice("tokA", "D26FBA0001");
    await dist.saveDevice("tokA", "D26FBA0002");   // same phone, now another distributor
    await dist.saveDevice("tokB", "D26FBA0001");
    assert.deepEqual((await dist.devices()).map((d) => `${d.token}:${d.distributorId}`).sort(), ["tokA:D26FBA0002", "tokB:D26FBA0001"]);
    await dist.removeDevices(["tokA"]);
    await dist.removeDevicesOf("D26FBA0001");
    assert.deepEqual(await dist.devices(), []);
    await dist.deleteAccount("FB-DIST-0001");
    assert.equal(await dist.getAccount("FB-DIST-0001"), null);
  } finally {
    await pool.end();
  }
});
