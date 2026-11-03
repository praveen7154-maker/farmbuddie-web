// Fake Firebase Auth (web simulation - see ../run.js). The signed-in user is
// kept in localStorage like the real SDK keeps it in IndexedDB, so it
// survives the full page loads between admin pages. The ID token is a
// readable "fake.<base64 JSON>" the harness server checks.
const KEY = "__fakeAuthUser";
const listeners = new Set();
const b64 = (o) => btoa(unescape(encodeURIComponent(JSON.stringify(o))));

function makeUser(u) {
  if (!u) return null;
  return {
    ...u,
    displayName: u.displayName || null,
    phoneNumber: null,
    getIdToken: async () => "fake." + b64({ uid: u.uid, email: u.email || undefined, ...(u.claims || {}) }),
    getIdTokenResult: async () => ({ claims: { ...(u.claims || {}) }, token: "fake." + b64(u) })
  };
}
function load() { try { return makeUser(JSON.parse(localStorage.getItem(KEY) || "null")); } catch { return null; } }

const auth = { currentUser: null, _ready: false };
export function getAuth() { return auth; }

function setUser(u) {
  if (u) localStorage.setItem(KEY, JSON.stringify(u)); else localStorage.removeItem(KEY);
  auth.currentUser = makeUser(u);
  for (const fn of [...listeners]) { try { fn(auth.currentUser); } catch (e) { setTimeout(() => { throw e; }); } }
}
// Like the SDK: the first state arrives a moment after load.
setTimeout(() => { auth.currentUser = load(); auth._ready = true; for (const fn of [...listeners]) fn(auth.currentUser); }, 30);

export function onAuthStateChanged(_auth, next) {
  const fn = typeof next === "function" ? next : next.next;
  listeners.add(fn);
  if (auth._ready) setTimeout(() => fn(auth.currentUser), 0);
  return () => listeners.delete(fn);
}

async function post(path, body) {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(j.message || "auth error"), { code: j.code || "auth/error" });
  return j;
}
export async function signInWithEmailAndPassword(_auth, email, password) {
  const { user } = await post("/__auth/login", { email, password });
  setUser(user);
  return { user: auth.currentUser };
}
export async function signInWithCustomToken(_auth, token) {
  const { user } = await post("/__auth/custom", { token });
  setUser(user);
  return { user: auth.currentUser };
}
export async function signOut() { setUser(null); }
