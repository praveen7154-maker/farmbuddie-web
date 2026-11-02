import { auth, db } from "/js/firebase-init.js";

import {
  collection,
  onSnapshot,
  getDocsFromCache
} from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";

// Each page asks only for what it shows (startDataStore(["farmers"]) ...):
// fewer listeners, fewer Firestore reads. A listener re-opened within 30
// min on this browser (the persistent cache in firebase-init.js) is only
// charged for documents that changed since - so moving between pages
// costs next to nothing.
//
// warmDataStore(): paints the page straight away from this browser's own
// copy (no network, no reads) while the login check and the live listener
// start. Only when this browser was signed in last time (flag below) - a
// signed-out visitor never sees cached data.
const ALL = ["farmers", "controllers", "distributors"];
const SIGNED_IN = "fbAdminSignedIn";
onAuthStateChanged(auth, (user) => {
  try { user ? localStorage.setItem(SIGNED_IN, "1") : localStorage.removeItem(SIGNED_IN); } catch {}
});
const liveFrom = { farmers: false, controllers: false, distributors: false };   // the live listener has answered
const refs = () => ({
  farmers: collection(db, "farmers"),
  controllers: collection(db, "controllers"),
  distributors: collection(db, "distributors")
});

export async function warmDataStore(which = ALL) {
  let signedIn = false;
  try { signedIn = localStorage.getItem(SIGNED_IN) === "1"; } catch {}
  if (!signedIn) return;
  const r = refs();
  await Promise.all(which.map(async (name) => {
    try {
      const snap = await getDocsFromCache(r[name]);
      if (liveFrom[name] || snap.empty) return;   // the live data got here first
      const docs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      if (name === "farmers") farmers = docs;
      else if (name === "controllers") controllers = docs.sort((a, b) => tsMs(a.createdAt) - tsMs(b.createdAt));
      else distributors = docs;
      notify();
    } catch { /* nothing cached yet - the live listener will fill it */ }
  }));
}

/* ================= CACHE ================= */

let farmers = [];
let controllers = [];
let distributors = [];

let subscribers = [];

/* ================= START STORE ================= */


const startedOne = { farmers: false, controllers: false, distributors: false };

export function startDataStore(which = ALL){

  // Each collection's listener at most once per page.
  if (which.includes("farmers") && !startedOne.farmers) { startedOne.farmers = true; startFarmers(); }
  if (which.includes("controllers") && !startedOne.controllers) { startedOne.controllers = true; startControllers(); }
  if (which.includes("distributors") && !startedOne.distributors) { startedOne.distributors = true; startDistributors(); }

}

/* ================= LIVE LISTENER ================= */

const tsMs = (t) => (t?.toMillis ? t.toMillis() : t?.seconds ? t.seconds * 1000 : Number(t) || 0);

// A listener that fails (signed-in token not ready yet, network dropped,
// permission) used to stop silently - the page stayed empty until a
// reload, and sometimes a reload didn't help either. Now it is opened
// again after a short wait, as many times as it takes.
function listen(name, ref, set, attempt = 0) {
  onSnapshot(ref, (snap) => {
    attempt = 0;
    liveFrom[name] = true;
    set(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    notify();
  }, (err) => {
    console.warn(`[data] ${name} listener stopped (${err.code || err.message}) - retrying`);
    setTimeout(() => listen(name, ref, set, attempt + 1), Math.min(1000 * 2 ** attempt, 15000));
  });
}

/* ================= FARMERS ================= */

function startFarmers(){

  listen("farmers", collection(db,"farmers"), (docs) => { farmers = docs; });

}

/* ================= CONTROLLERS ================= */

function startControllers(){

  // No orderBy in the query: Firestore leaves out every document without
  // createdAt, so such controllers never showed. Sorted here instead.
  listen("controllers", collection(db,"controllers"), (docs) => {
    controllers = docs.sort((a, b) => tsMs(a.createdAt) - tsMs(b.createdAt));
  });

}

/* ================= DISTRIBUTORS ================= */

function startDistributors(){

  listen("distributors", collection(db,"distributors"), (docs) => { distributors = docs; });

}

/* ================= GET DATA ================= */

export function getFarmers(){ return farmers; }
export function getControllers(){ return controllers; }
export function getDistributors(){ return distributors; }
// The live listener has answered for this collection - until then an empty
// list may just mean "not loaded yet" (a page shows skeletons, not "none").
export function isLive(name){ return !!liveFrom[name]; }

/* ================= SUBSCRIBE ================= */

export function subscribe(fn){
  subscribers.push(fn);
}

function notify(){
  subscribers.forEach(fn => fn());
}