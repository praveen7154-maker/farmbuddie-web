import { test } from "node:test";
import assert from "node:assert/strict";
import { createFirestoreNodes } from "../src/bridge/productionNodesStore.js";

// A small stand-in for firebase-admin's Firestore - what productionNodesStore.js
// uses, with the real rules that matter here: ordering by document id
// descending needs a composite index (refused, as the live database did),
// create() of an existing document fails (code 6), and a transaction whose
// reads changed before it commits runs again.
function fakeFirestore() {
  const store = new Map();                 // "col/id" -> { data, v }
  const DOC_ID = { docId: true };
  let queries = 0;
  const TS = () => { const ms = Date.now(); return { toMillis: () => ms }; };
  const resolve = (data) => JSON.parse(JSON.stringify(data, (k, v) => (v && v.__ts ? undefined : v)), (k, v) => v);
  const withTs = (data) => Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v && v.__ts ? TS() : v]));
  const pathGet = (o, p) => p.split(".").reduce((x, k) => (x == null ? x : x[k]), o);
  const snapOf = (col, id) => {
    const e = store.get(`${col}/${id}`);
    return { id, exists: !!e, get: (f) => (e ? pathGet(e.data, f) : undefined), data: () => (e ? { ...e.data } : undefined), _v: e ? e.v : 0, _key: `${col}/${id}` };
  };
  class Query {
    constructor(col, filters = [], order = null, sel = false) { Object.assign(this, { col, filters, order, sel }); }
    where(f, op, v) { return new Query(this.col, [...this.filters, [f, op, v]], this.order, this.sel); }
    orderBy(f, dir = "asc") {
      if (f === DOC_ID && dir === "desc") {
        throw Object.assign(new Error("9 FAILED_PRECONDITION: The query requires an index."), { code: 9 });
      }
      return new Query(this.col, this.filters, [f, dir], this.sel);
    }
    limit() { return this; }
    select() { return new Query(this.col, this.filters, this.order, true); }
    _run() {
      queries++;
      const ids = [...store.keys()].filter((k) => k.startsWith(this.col + "/")).map((k) => k.slice(this.col.length + 1)).sort();
      return ids.map((id) => snapOf(this.col, id)).filter((s) => this.filters.every(([f, op, v]) => {
        const x = f === DOC_ID ? s.id : s.get(f);
        return op === "==" ? x === v : op === ">=" ? x >= v : op === "<" ? x < v : true;
      }));
    }
    async get() { const docs = this._run(); return { docs, empty: !docs.length, size: docs.length }; }
    count() { return { get: async () => ({ data: () => ({ count: this._run().length }) }) }; }
  }
  const db = {
    collection: (col) => Object.assign(new Query(col), { doc: (id) => ({ col, id, async get() { return snapOf(col, id); } }) }),
    async getAll(...refs) { return refs.map((r) => snapOf(r.col, r.id)); },
    async runTransaction(fn) {
      for (let attempt = 0; attempt < 10; attempt++) {
        const reads = [], writes = [];
        const t = {
          async get(x) {
            await new Promise((r) => setImmediate(r));        // let another transaction interleave
            if (x instanceof Query) { const res = await x.get(); res.docs.forEach((d) => reads.push(d)); return res; }
            const s = snapOf(x.col, x.id); reads.push(s); return s;
          },
          create: (ref, data) => writes.push(["create", ref, data]),
          set: (ref, data, opt) => writes.push(["set", ref, data, opt]),
          update: (ref, data) => writes.push(["update", ref, data])
        };
        const result = await fn(t);
        if (reads.some((s) => (store.get(s._key)?.v || 0) !== s._v)) continue;      // contention: run again
        for (const [op, ref] of writes) if (op === "create" && store.has(`${ref.col}/${ref.id}`)) {
          throw Object.assign(new Error("6 ALREADY_EXISTS: " + ref.id), { code: 6 });
        }
        for (const [op, ref, data, opt] of writes) {
          const key = `${ref.col}/${ref.id}`, old = store.get(key);
          const next = op === "set" && opt?.merge ? { ...(old?.data || {}), ...withTs(data) } : withTs(data);
          store.set(key, { data: next, v: (old?.v || 0) + 1 });
        }
        return result;
      }
      throw new Error("too much contention");
    }
  };
  const FieldValue = { serverTimestamp: () => ({ __ts: true }) };
  const FieldPath = { documentId: () => DOC_ID };
  return { db, FieldValue, FieldPath, store, put: (col, id, data) => store.set(`${col}/${id}`, { data, v: 1 }), queries: () => queries };
}

const DOC = { type: "MOTOR", status: "available", farmerId: null, source: "production", createdBy: { type: "staff", id: "ravi", name: "Ravi" } };

test("first node of a stem: 10001; then the counter - never a descending id query (needs an index)", async () => {
  const f = fakeFirestore();
  const nodes = createFirestoreNodes(f);
  assert.deepEqual(await nodes.nextNumbers(["FBMN26", "FBSVN"]), { FBMN26: 10001, FBSVN: 10001 }, "no counter, no nodes");
  const made = await nodes.createMany({ stem: "FBMN26", count: 3, doc: DOC });
  assert.deepEqual(made.map((n) => n.serialNumber), ["FBMN2610001", "FBMN2610002", "FBMN2610003"]);
  assert.equal(f.store.get("counters/nodes_FBMN26").data.last, 10003);
  assert.equal(f.store.get("nodes/FBMN2610002").data.type, "MOTOR");
  const before = f.queries();
  assert.deepEqual(await nodes.nextNumbers(["FBMN26"]), { FBMN26: 10004 });
  assert.equal(f.queries(), before, "a stem with a counter: the nodes aren't scanned");
  const more = await nodes.createMany({ stem: "FBMN26", count: 1, doc: DOC });
  assert.equal(more[0].serialNumber, "FBMN2610004");
  assert.equal(f.queries(), before, "...not when saving either");
});

test("nodes there but no counter (or a counter behind): carries on after the highest", async () => {
  const f = fakeFirestore();
  for (const n of [10001, 10002, 10007]) f.put("nodes", `FBSVN${n}`, { ...DOC, type: "SOLENOID_VALVE", serialNumber: `FBSVN${n}` });
  f.put("nodes", "FBSVNX", { note: "not a serial" });
  const nodes = createFirestoreNodes(f);
  assert.deepEqual(await nodes.nextNumbers(["FBSVN"]), { FBSVN: 10008 });
  assert.equal((await nodes.createMany({ stem: "FBSVN", count: 1, doc: DOC }))[0].serialNumber, "FBSVN10008");

  f.put("counters", "nodes_FBWL26", { last: 10001 });            // behind: 10002 and 10003 exist
  for (const n of [10001, 10002, 10003]) f.put("nodes", `FBWL26${n}`, { ...DOC, serialNumber: `FBWL26${n}` });
  const made = await nodes.createMany({ stem: "FBWL26", count: 2, doc: DOC });
  assert.deepEqual(made.map((n) => n.serialNumber), ["FBWL2610004", "FBWL2610005"], "collision -> rescan -> next free");
  assert.equal(f.store.get("counters/nodes_FBWL26").data.last, 10005);
});

test("two saves at the same moment get different serials", async () => {
  const f = fakeFirestore();
  const nodes = createFirestoreNodes(f);
  const [a, b] = await Promise.all([
    nodes.createMany({ stem: "FBMN26", count: 2, doc: DOC }),
    nodes.createMany({ stem: "FBMN26", count: 2, doc: DOC })
  ]);
  const all = [...a, ...b].map((n) => n.serialNumber).sort();
  assert.deepEqual(all, ["FBMN2610001", "FBMN2610002", "FBMN2610003", "FBMN2610004"]);
  assert.equal(f.store.get("counters/nodes_FBMN26").data.last, 10004);
});

test("stock and count per person", async () => {
  const f = fakeFirestore();
  const nodes = createFirestoreNodes(f);
  await nodes.createMany({ stem: "FBMN26", count: 3, doc: DOC });
  await nodes.createMany({ stem: "FBBVN", count: 1, doc: { ...DOC, type: "BUTTERFLY_VALVE", createdBy: { type: "admin", id: "a@x", name: "A" } } });
  f.store.get("nodes/FBMN2610002").data.status = "assigned";
  const s = await nodes.stock();
  assert.deepEqual(s.MOTOR, { available: 2, assigned: 1, total: 3 });
  assert.deepEqual(s.BUTTERFLY_VALVE, { available: 1, assigned: 0, total: 1 });
  assert.deepEqual(s.WATER_LEVEL, { available: 0, assigned: 0, total: 0 });
  assert.equal(await nodes.countBy("ravi"), 3);
  assert.equal(await nodes.countBy("a@x"), 1);
});
