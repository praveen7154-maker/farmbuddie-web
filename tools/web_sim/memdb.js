// In-memory Firestore for the web simulation (see run.js). One store, two
// faces:
//  - an Admin-SDK-like facade (db.collection().where().get(), transactions,
//    batches, FieldValue/FieldPath/Timestamp) for the server modules, which
//    run here unchanged against it;
//  - a small JSON protocol (handle()) for the browser's fake Firestore
//    (fake-firebase/firebase-firestore.js), so the pages read exactly what
//    the server wrote and the other way round.
// Values are stored plain; a timestamp is { __ts: millis } on the wire and a
// Timestamp object in the Admin facade.

export class Timestamp {
  constructor(ms) { this._ms = ms; }
  static now() { return new Timestamp(Date.now()); }
  static fromDate(d) { return new Timestamp(d.getTime()); }
  static fromMillis(ms) { return new Timestamp(ms); }
  toMillis() { return this._ms; }
  toDate() { return new Date(this._ms); }
  get seconds() { return Math.floor(this._ms / 1000); }
  get nanoseconds() { return (this._ms % 1000) * 1e6; }
  isEqual(o) { return o instanceof Timestamp && o._ms === this._ms; }
  valueOf() { return this._ms; }
}

const SERVER_TS = { __sv: "ts" };
export const FieldValue = {
  serverTimestamp: () => SERVER_TS,
  delete: () => ({ __sv: "delete" }),
  increment: (n) => ({ __sv: "inc", n }),
  arrayUnion: (...v) => ({ __sv: "union", v }),
  arrayRemove: (...v) => ({ __sv: "remove", v })
};
const DOC_ID = { __docId: true };
export const FieldPath = { documentId: () => DOC_ID };

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const isTs = (v) => isObj(v) && typeof v.__ts === "number" && Object.keys(v).length === 1;

// Anything coming in (Admin values, wire values) -> stored form.
function toStored(v, now) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (v instanceof Timestamp) return { __ts: v.toMillis() };
  if (v instanceof Date) return { __ts: v.getTime() };
  if (Array.isArray(v)) return v.map((x) => toStored(x, now));
  if (isObj(v)) {
    if (v.__sv === "ts") return { __ts: now };
    if (isTs(v)) return { __ts: v.__ts };
    const out = {};
    for (const [k, x] of Object.entries(v)) { const s = toStored(x, now); if (s !== undefined) out[k] = s; }
    return out;
  }
  return v;
}
// Stored form -> Admin values (Timestamp objects).
function toAdmin(v) {
  if (Array.isArray(v)) return v.map(toAdmin);
  if (isTs(v)) return new Timestamp(v.__ts);
  if (isObj(v)) { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = toAdmin(x); return o; }
  return v;
}

function getPath(obj, path) {
  let cur = obj;
  for (const p of path.split(".")) { if (!isObj(cur)) return undefined; cur = cur[p]; }
  return cur;
}
// One field write that may be a sentinel (delete / increment / array ops).
function putField(cur, key, value, now) {
  if (isObj(value) && value.__sv && value.__sv !== "ts") {
    const a = Array.isArray(cur[key]) ? cur[key] : [];
    const same = (x, y) => JSON.stringify(toStored(x, now)) === JSON.stringify(y);
    if (value.__sv === "delete") delete cur[key];
    else if (value.__sv === "inc") cur[key] = (Number(cur[key]) || 0) + value.n;
    else if (value.__sv === "union") { for (const x of value.v) if (!a.some((y) => same(x, y))) a.push(toStored(x, now)); cur[key] = a; }
    else if (value.__sv === "remove") cur[key] = a.filter((y) => !value.v.some((x) => same(x, y)));
    return;
  }
  cur[key] = toStored(value, now);
}
// update(): "a.b.c" is a path.
function writePath(obj, path, value, now) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) { if (!isObj(cur[parts[i]]) || isTs(cur[parts[i]])) cur[parts[i]] = {}; cur = cur[parts[i]]; }
  putField(cur, parts[parts.length - 1], value, now);
}
// set(): keys are field names; with merge, maps are merged field by field.
function deepMerge(target, patch, now, merge) {
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (merge && isObj(v) && !v.__sv && !isTs(v)) {
      if (!isObj(target[k]) || isTs(target[k])) target[k] = {};
      deepMerge(target[k], v, now, true);
    } else putField(target, k, v, now);
  }
}

function cmpVal(a, b) {
  const n = (v) => (isTs(v) ? v.__ts : v instanceof Timestamp ? v.toMillis() : v instanceof Date ? v.getTime() : v);
  a = n(a); b = n(b);
  if (a === b) return 0;
  if (a === undefined || a === null) return -1;
  if (b === undefined || b === null) return 1;
  if (typeof a === typeof b) return a < b ? -1 : 1;
  const rank = (v) => (typeof v === "boolean" ? 1 : typeof v === "number" ? 2 : typeof v === "string" ? 3 : 4);
  return rank(a) - rank(b);
}
const eqVal = (a, b) => JSON.stringify(toStored(a, 0)) === JSON.stringify(toStored(b, 0));

function matches(id, data, [field, op, value]) {
  const v = field === DOC_ID || field === "__name__" ? id : getPath(data, field);
  switch (op) {
    case "==": return v !== undefined && eqVal(v, value);
    case "!=": return v !== undefined && !eqVal(v, value);
    case "<": return v !== undefined && v !== null && cmpVal(v, value) < 0;
    case "<=": return v !== undefined && v !== null && cmpVal(v, value) <= 0;
    case ">": return v !== undefined && v !== null && cmpVal(v, value) > 0;
    case ">=": return v !== undefined && v !== null && cmpVal(v, value) >= 0;
    case "in": return v !== undefined && value.some((x) => eqVal(v, x));
    case "not-in": return v !== undefined && !value.some((x) => eqVal(v, x));
    case "array-contains": return Array.isArray(v) && v.some((x) => eqVal(x, value));
    case "array-contains-any": return Array.isArray(v) && v.some((x) => value.some((y) => eqVal(x, y)));
    default: throw new Error("memdb: unsupported operator " + op);
  }
}

export function createMemDb() {
  const docs = new Map();            // "col/id[/sub/id]" -> stored data
  let version = 0;
  let autoN = 0;
  const stats = { reads: 0, writes: 0, queries: 0 };
  const autoId = () => "auto" + (++autoN).toString(36).padStart(4, "0") + Math.random().toString(36).slice(2, 10);
  const parentOf = (path) => path.slice(0, path.lastIndexOf("/"));

  function getDoc(path) { stats.reads++; const d = docs.get(path); return d === undefined ? null : clone(d); }
  function setDoc(path, data, merge = false) {
    const now = Date.now();
    const cur = merge ? (docs.get(path) || {}) : {};
    deepMerge(cur, data, now, merge);
    docs.set(path, cur); version++; stats.writes++;
  }
  function updateDoc(path, data) {
    const cur = docs.get(path);
    if (!cur) throw Object.assign(new Error(`No document to update: ${path}`), { code: 5, clientCode: "not-found" });
    const now = Date.now();
    for (const [k, v] of Object.entries(data)) writePath(cur, k, v, now);
    version++; stats.writes++;
  }
  function createDoc(path, data) {
    if (docs.has(path)) throw Object.assign(new Error(`Document already exists: ${path}`), { code: 6, clientCode: "already-exists" });
    setDoc(path, data);
  }
  function deleteDoc(path) { if (docs.delete(path)) { version++; stats.writes++; } }

  // q: { collection, filters: [[field, op, value]], orderBy: [[field, dir]], limit, select }
  function runQuery(q) {
    stats.queries++;
    const out = [];
    for (const [path, data] of docs) {
      if (parentOf(path) !== q.collection) continue;
      const id = path.slice(q.collection.length + 1);
      if ((q.filters || []).every((f) => matches(id, data, f))) out.push({ id, path, data: clone(data) });
    }
    const order = q.orderBy || [];
    if (order.length) {
      out.sort((a, b) => {
        for (const [f, dir] of order) {
          const va = f === DOC_ID ? a.id : getPath(a.data, f), vb = f === DOC_ID ? b.id : getPath(b.data, f);
          const c = cmpVal(va, vb);
          if (c) return dir === "desc" ? -c : c;
        }
        return 0;
      });
      // Firestore leaves out documents without an orderBy field.
      for (const [f] of order) if (f !== DOC_ID) for (let i = out.length - 1; i >= 0; i--) if (getPath(out[i].data, f) === undefined) out.splice(i, 1);
    } else out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return q.limit ? out.slice(0, q.limit) : out;
  }

  // ---------------- Admin-SDK-like facade ----------------
  class DocSnap {
    constructor(id, path, data) { this.id = id; this.ref = new DocRef(path); this._d = data; this.exists = data !== null; }
    data() { return this._d === null ? undefined : toAdmin(this._d); }
    get(field) { return this._d === null ? undefined : toAdmin(getPath(this._d, field)); }
  }
  class QuerySnap {
    constructor(rows) { this.docs = rows.map((r) => new DocSnap(r.id, r.path, r.data)); this.size = this.docs.length; this.empty = !this.size; }
    forEach(fn) { this.docs.forEach(fn); }
  }
  class Query {
    constructor(collection, q = {}) { this._c = collection; this._q = { collection, filters: [], orderBy: [], ...q }; }
    where(f, op, v) { return new Query(this._c, { ...this._q, filters: [...this._q.filters, [f, op, v]] }); }
    orderBy(f, dir = "asc") { return new Query(this._c, { ...this._q, orderBy: [...this._q.orderBy, [f, dir]] }); }
    limit(n) { return new Query(this._c, { ...this._q, limit: n }); }
    select() { return this; }
    async get() { return new QuerySnap(runQuery(this._q)); }
    count() { const q = this._q; return { get: async () => ({ data: () => ({ count: runQuery({ ...q, limit: 0 }).length }) }) }; }
  }
  class ColRef extends Query {
    constructor(path) { super(path); this.path = path; this.id = path.split("/").pop(); }
    doc(id = autoId()) { return new DocRef(`${this.path}/${id}`); }
    async add(data) { const r = this.doc(); setDoc(r.path, data); return r; }
  }
  class DocRef {
    constructor(path) { this.path = path; this.id = path.split("/").pop(); }
    collection(name) { return new ColRef(`${this.path}/${name}`); }
    async get() { return new DocSnap(this.id, this.path, getDoc(this.path)); }
    async set(data, opts) { setDoc(this.path, data, !!opts?.merge); }
    async update(data) { updateDoc(this.path, data); }
    async create(data) { createDoc(this.path, data); }
    async delete() { deleteDoc(this.path); }
  }
  // Writes are applied in order at the end (reads see the state before).
  function writer() {
    const ops = [];
    const w = {
      set(ref, data, opts) { ops.push(() => setDoc(ref.path, data, !!opts?.merge)); return w; },
      update(ref, data) { ops.push(() => updateDoc(ref.path, data)); return w; },
      create(ref, data) { ops.push(() => createDoc(ref.path, data)); return w; },
      delete(ref) { ops.push(() => deleteDoc(ref.path)); return w; },
      _commit() {
        const backup = new Map([...docs].map(([k, v]) => [k, clone(v)]));
        try { ops.forEach((f) => f()); } catch (e) { docs.clear(); for (const [k, v] of backup) docs.set(k, v); throw e; }
      }
    };
    return w;
  }
  const admin = {
    collection: (name) => new ColRef(name),
    doc: (path) => new DocRef(path),
    async getAll(...refs) { return refs.map((r) => new DocSnap(r.id, r.path, getDoc(r.path))); },
    batch() { const w = writer(); w.commit = async () => w._commit(); return w; },
    async runTransaction(fn) {
      const w = writer();
      w.get = async (refOrQuery) => (refOrQuery instanceof DocRef ? refOrQuery.get() : refOrQuery.get());
      const result = await fn(w);
      w._commit();
      return result;
    }
  };

  // ---------------- wire protocol (browser fake Firestore) ----------------
  function handle(req) {
    switch (req.op) {
      case "version": return { version };
      case "get": return { data: getDoc(req.path) };
      case "query": return { docs: runQuery(fromWireQuery(req.q)).map(({ id, data }) => ({ id, data })) };
      case "count": return { count: runQuery({ ...fromWireQuery(req.q), limit: 0 }).length };
      case "add": { const id = autoId(); setDoc(`${req.collection}/${id}`, req.data); return { id }; }
      case "commit": {
        const w = writer();
        for (const o of req.writes) {
          const ref = { path: o.path };
          if (o.kind === "set") w.set(ref, o.data, { merge: o.merge });
          else if (o.kind === "update") w.update(ref, o.data);
          else if (o.kind === "delete") w.delete(ref);
        }
        w._commit();
        return { ok: true };
      }
      case "newId": return { id: autoId() };
      default: throw new Error("memdb: unknown op " + req.op);
    }
  }
  const fromWireQuery = (q) => ({
    ...q,
    filters: (q.filters || []).map(([f, op, v]) => [f === "__name__" ? DOC_ID : f, op, v]),
    orderBy: (q.orderBy || []).map(([f, d]) => [f === "__name__" ? DOC_ID : f, d])
  });

  return {
    admin, handle, stats,
    version: () => version,
    // Test helpers.
    put: (path, data) => setDoc(path, data),
    raw: (path) => (docs.has(path) ? clone(docs.get(path)) : null),
    list: (collection) => runQuery({ collection }),
    paths: () => [...docs.keys()]
  };
}
