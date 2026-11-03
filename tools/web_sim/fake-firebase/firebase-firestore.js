// Fake Firestore for the web simulation (see ../run.js): the same calls the
// pages make, answered by the harness's in-memory database over /__fs, so
// the server modules and the pages share one set of documents.
// window.__fbStats counts live listeners - a page that keeps opening them
// (and never closes the old ones) shows up as a leak.

const stats = (window.__fbStats = window.__fbStats || { listeners: 0, peakListeners: 0, opened: 0, closed: 0, reads: 0, writes: 0, errors: [] });

async function call(req) {
  const r = await fetch("/__fs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(req) });
  const j = await r.json();
  if (!r.ok) {
    const e = new Error(j.message || "firestore error");
    e.code = j.code || "internal";
    stats.errors.push(e.code + ": " + e.message);
    throw e;
  }
  return j;
}

// ---------------- values ----------------
export class Timestamp {
  constructor(seconds, nanoseconds = 0) { this.seconds = seconds; this.nanoseconds = nanoseconds; }
  static now() { return Timestamp.fromMillis(Date.now()); }
  static fromDate(d) { return Timestamp.fromMillis(d.getTime()); }
  static fromMillis(ms) { return new Timestamp(Math.floor(ms / 1000), (ms % 1000) * 1e6); }
  toMillis() { return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6); }
  toDate() { return new Date(this.toMillis()); }
  isEqual(o) { return o instanceof Timestamp && o.toMillis() === this.toMillis(); }
  valueOf() { return String(this.toMillis()).padStart(16, "0"); }
  toJSON() { return { seconds: this.seconds, nanoseconds: this.nanoseconds }; }
}
class Sentinel { constructor(kind) { this.__sv = kind; } }
export const serverTimestamp = () => new Sentinel("ts");
export const deleteField = () => new Sentinel("delete");

function toWire(v) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (v instanceof Sentinel) return { __sv: v.__sv };
  if (v instanceof Timestamp) return { __ts: v.toMillis() };
  if (v instanceof Date) return { __ts: v.getTime() };
  if (Array.isArray(v)) return v.map(toWire);
  if (v instanceof DocumentReference) return { __ref: v.path };
  if (typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (x === undefined) throw Object.assign(new Error(`Function setDoc() called with invalid data. Unsupported field value: undefined (found in field ${k})`), { code: "invalid-argument" });
      o[k] = toWire(x);
    }
    return o;
  }
  if (typeof v === "number" && !Number.isFinite(v)) return v;
  return v;
}
function fromWire(v) {
  if (Array.isArray(v)) return v.map(fromWire);
  if (v && typeof v === "object") {
    if (typeof v.__ts === "number" && Object.keys(v).length === 1) return Timestamp.fromMillis(v.__ts);
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = fromWire(x);
    return o;
  }
  return v;
}

// ---------------- references ----------------
export function initializeFirestore() { return { type: "firestore" }; }
export function getFirestore() { return { type: "firestore" }; }
export function persistentLocalCache() { return {}; }
export function persistentMultipleTabManager() { return {}; }
export function memoryLocalCache() { return {}; }

const autoId = () => "w" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
const joinPath = (parts) => parts.flatMap((p) => String(p).split("/")).filter(Boolean).join("/");

class DocumentReference {
  constructor(path) { this.path = path; this.id = path.split("/").pop(); this.type = "document"; }
  get parent() { return new CollectionReference(this.path.slice(0, this.path.lastIndexOf("/"))); }
}
class Query {
  constructor(collection, constraints = []) { this._collection = collection; this._constraints = constraints; this.type = "query"; }
  _wire() {
    const q = { collection: this._collection, filters: [], orderBy: [], limit: 0 };
    for (const c of this._constraints) {
      if (c.kind === "where") q.filters.push([c.field, c.op, toWire(c.value)]);
      else if (c.kind === "orderBy") q.orderBy.push([c.field, c.dir]);
      else if (c.kind === "limit") q.limit = c.n;
    }
    return q;
  }
}
class CollectionReference extends Query {
  constructor(path) { super(path); this.path = path; this.id = path.split("/").pop(); this.type = "collection"; }
}

export function collection(base, ...parts) {
  const head = base instanceof DocumentReference ? [base.path] : [];
  return new CollectionReference(joinPath([...head, ...parts]));
}
export function doc(base, ...parts) {
  if (base instanceof CollectionReference) return new DocumentReference(joinPath([base.path, parts.length ? parts[0] : autoId()]));
  if (base instanceof DocumentReference) return new DocumentReference(joinPath([base.path, ...parts]));
  return new DocumentReference(joinPath(parts));
}
export const documentId = () => "__name__";
export function where(field, op, value) { return { kind: "where", field: typeof field === "string" ? field : "__name__", op, value }; }
export function orderBy(field, dir = "asc") { return { kind: "orderBy", field, dir }; }
export function limit(n) { return { kind: "limit", n }; }
export function query(q, ...constraints) { return new Query(q._collection, [...q._constraints, ...constraints]); }

// ---------------- snapshots ----------------
class DocumentSnapshot {
  constructor(ref, data) { this.ref = ref; this.id = ref.id; this._data = data; this.metadata = { fromCache: false, hasPendingWrites: false }; }
  exists() { return this._data !== null && this._data !== undefined; }
  data() { return this.exists() ? fromWire(this._data) : undefined; }
  get(field) {
    if (!this.exists()) return undefined;
    let cur = this._data;
    for (const p of field.split(".")) { if (!cur || typeof cur !== "object") return undefined; cur = cur[p]; }
    return fromWire(cur);
  }
}
class QuerySnapshot {
  constructor(collection, rows) {
    this.docs = rows.map((r) => new DocumentSnapshot(new DocumentReference(`${collection}/${r.id}`), r.data));
    this.size = this.docs.length; this.empty = !this.size;
    this.metadata = { fromCache: false, hasPendingWrites: false };
  }
  forEach(fn) { this.docs.forEach(fn); }
  docChanges() { return this.docs.map((d, i) => ({ type: "added", doc: d, oldIndex: -1, newIndex: i })); }
}

// ---------------- reads ----------------
async function readDoc(ref) { stats.reads++; const { data } = await call({ op: "get", path: ref.path }); return new DocumentSnapshot(ref, data); }
async function readQuery(q) { stats.reads++; const { docs } = await call({ op: "query", q: q._wire() }); return new QuerySnapshot(q._collection, docs); }
export const getDoc = readDoc;
export const getDocFromServer = readDoc;
export const getDocFromCache = readDoc;
export const getDocs = readQuery;
export const getDocsFromServer = readQuery;
export const getDocsFromCache = readQuery;
export async function getCountFromServer(q) {
  const { count } = await call({ op: "count", q: q._wire() });
  return { data: () => ({ count }) };
}

// ---------------- writes ----------------
async function commit(writes) { stats.writes += writes.length; await call({ op: "commit", writes }); }
export async function setDoc(ref, data, opts) { await commit([{ kind: "set", path: ref.path, data: toWire(data), merge: !!opts?.merge }]); }
export async function updateDoc(ref, data) { await commit([{ kind: "update", path: ref.path, data: toWire(data) }]); }
export async function deleteDoc(ref) { await commit([{ kind: "delete", path: ref.path }]); }
export async function addDoc(colRef, data) {
  stats.writes++;
  const { id } = await call({ op: "add", collection: colRef.path, data: toWire(data) });
  return new DocumentReference(`${colRef.path}/${id}`);
}
function batchWriter() {
  const writes = [];
  return {
    writes,
    set(ref, data, opts) { writes.push({ kind: "set", path: ref.path, data: toWire(data), merge: !!opts?.merge }); return this; },
    update(ref, data) { writes.push({ kind: "update", path: ref.path, data: toWire(data) }); return this; },
    delete(ref) { writes.push({ kind: "delete", path: ref.path }); return this; }
  };
}
export function writeBatch() { const w = batchWriter(); w.commit = () => commit(w.writes); return w; }
export async function runTransaction(_db, fn) {
  const w = batchWriter();
  w.get = (ref) => readDoc(ref);
  const out = await fn(w);
  await commit(w.writes);
  return out;
}

// ---------------- live listeners ----------------
const live = new Set();
let lastVersion = -1, timer = null, polling = false;

async function refresh(l) {
  try {
    const snap = l.target instanceof DocumentReference ? await readDoc(l.target) : await readQuery(l.target);
    if (!l.active) return;
    const key = JSON.stringify(l.target instanceof DocumentReference ? snap._data : snap.docs.map((d) => [d.id, d._data]));
    if (key === l.last) return;
    l.last = key;
    l.next(snap);
  } catch (e) {
    if (l.active && l.error) l.error(e);
  }
}
async function poll() {
  if (polling) return;
  polling = true;
  try {
    const { version } = await call({ op: "version" });
    if (version !== lastVersion) { lastVersion = version; await Promise.all([...live].map(refresh)); }
  } catch { /* harness gone - the run is over */ }
  polling = false;
}
export function onSnapshot(target, ...args) {
  if (args[0] && typeof args[0] === "object" && !("next" in args[0]) && typeof args[1] === "function") args.shift();   // options
  const obs = typeof args[0] === "object" ? args[0] : { next: args[0], error: args[1] };
  const l = { target, next: obs.next, error: obs.error, active: true, last: null };
  live.add(l);
  stats.listeners++; stats.opened++; stats.peakListeners = Math.max(stats.peakListeners, stats.listeners);
  setTimeout(() => refresh(l), 0);
  if (!timer) timer = setInterval(poll, 200);
  return () => {
    if (!l.active) return;
    l.active = false; live.delete(l);
    stats.listeners--; stats.closed++;
    if (!live.size && timer) { clearInterval(timer); timer = null; }
  };
}
