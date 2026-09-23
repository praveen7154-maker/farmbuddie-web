import { db } from "/js/firebase-init.js";

import {
  collection,
  query,
  orderBy,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";

/* ================= CACHE ================= */

let farmers = [];
let controllers = [];
let distributors = [];

let subscribers = [];

/* ================= START STORE ================= */

let started = false;

export function startDataStore(){

  if(started) return;   // prevent duplicate listeners
  started = true;

  startFarmers();
  startControllers();
  startDistributors();

}

/* ================= FARMERS ================= */

function startFarmers(){

  const col = collection(db,"farmers");

  onSnapshot(col,(snap)=>{

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