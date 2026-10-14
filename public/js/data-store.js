import { auth, db } from "/js/firebase-init.js";

import {
  collection,
  query,
  orderBy,
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
  controllers: query(collection(db, "controllers"), orderBy("createdAt", "asc")),
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
      else if (name === "controllers") controllers = docs;
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

/* ================= FARMERS ================= */

function startFarmers(){

  const col = collection(db,"farmers");

  onSnapshot(col,(snap)=>{

    liveFrom.farmers = true;
    farmers = snap.docs.map(d => ({
      id: d.id,
      ...d.data()
    }));

    notify();

  });

}

/* ================= CONTROLLERS ================= */

function startControllers(){

  const q = query(
    collection(db,"controllers"),
    orderBy("createdAt","asc")
  );

  onSnapshot(q,(snap)=>{

    liveFrom.controllers = true;
    controllers = snap.docs.map(d => ({
      id: d.id,
      ...d.data()
    }));

    notify();

  });

}

/* ================= DISTRIBUTORS ================= */

function startDistributors(){

  const col = collection(db,"distributors");

  onSnapshot(col,(snap)=>{

    liveFrom.distributors = true;
    distributors = snap.docs.map(d => ({
      id: d.id,
      ...d.data()
    }));

    notify();

  });

}

/* ================= GET DATA ================= */

export function getFarmers(){ return farmers; }
export function getControllers(){ return controllers; }
export function getDistributors(){ return distributors; }

/* ================= SUBSCRIBE ================= */

export function subscribe(fn){
  subscribers.push(fn);
}

function notify(){
  subscribers.forEach(fn => fn());
}