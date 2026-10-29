import { FieldValue, FieldPath } from "firebase-admin/firestore";
import { db } from "../firebaseAdmin.js";
import { UNIQUE_FIELDS, NODE_TYPES, NODE_FIRST, NODE_LAST } from "./production.js";

// Firestore side of production.js: the same "controllers" collection the
// MCU / Controller page's Excel upload writes, same fields.

const col = () => db.collection("controllers");
const sims = () => db.collection("simInventory");
const ms = (ts) => (ts && typeof ts.toMillis === "function" ? ts.toMillis() : null);

async function clashesIn(get, values) {
  const out = [];
  for (const field of UNIQUE_FIELDS) {
    const value = values[field];
    if (!value) continue;
    const snap = await get(col().where(field, "==", value).limit(1));
    if (!snap.empty) {
      const d = snap.docs[0];
      out.push({ field, value, controllerId: d.id, uniqueId: d.get("uniqueId") || null });
    }
  }
  return out;
}

export const firestoreControllers = {
  clashes(values) {
    return clashesIn((q) => q.get(), values);
  },

  // Checked and written in one transaction: the reads lock what they saw,
  // so a second save of the same IMEI/SIM in between makes this one retry
  // and then see it. With a SIM: it must be in the SIM inventory and not
  // given to a controller yet; its MSISDN and IMSI come from the inventory
  // (never from what was typed), and it is marked assigned in the same go.
  async create(doc) {
    return db.runTransaction(async (t) => {
      let simRef = null;
      if (doc.simNumber) {
        simRef = sims().doc(doc.simNumber);
        const sim = await t.get(simRef);
        if (!sim.exists) throw Object.assign(new Error("sim"), { simError: "This SIM isn't in the SIM inventory - upload it first" });
        if (sim.get("status") === "assigned") {
          throw Object.assign(new Error("sim"), { simError: `This SIM is already on controller ${sim.get("uniqueId") || sim.get("controllerId")}` });
        }
        doc = { ...doc, simMsisdn: sim.get("msisdn") || "", simImsi: sim.get("imsi") || "" };
      }
      const clashes = await clashesIn((q) => t.get(q), doc);
      if (clashes.length) throw Object.assign(new Error("clash"), { clashes });
      const ref = col().doc();
      t.create(ref, { ...doc, createdAt: FieldValue.serverTimestamp() });
      if (simRef) {
        t.update(simRef, { status: "assigned", controllerId: ref.id, uniqueId: doc.uniqueId, assignedAt: FieldValue.serverTimestamp() });
      }
      return { id: ref.id, doc };
    });
  },

  // ---- SIM inventory ("simInventory", one document per SIM, id = its ICCID) ----
  async simInventory() {
    const snap = await sims().get();
    return snap.docs.map((d) => ({
      iccid: d.id, msisdn: d.get("msisdn") || "", imsi: d.get("imsi") || "", status: d.get("status") || "available",
      uniqueId: d.get("uniqueId") || null, controllerId: d.get("controllerId") || null
    }));
  },

  // SIM numbers already on a controller (an Excel upload doesn't go
  // through the inventory, so this catches those too).
  async usedSimNumbers() {
    const snap = await col().select("simNumber", "uniqueId").get();
    const used = new Map();
    for (const d of snap.docs) {
      const n = d.get("simNumber");
      if (n) used.set(String(n), { controllerId: d.id, uniqueId: d.get("uniqueId") || null });
    }
    return used;
  },

  async markSimAssigned(iccid, { controllerId, uniqueId }) {
    await sims().doc(iccid).update({ status: "assigned", controllerId, uniqueId: uniqueId || null, assignedAt: FieldValue.serverTimestamp() });
  },

  /** Adds new SIMs; ones already in the inventory are left as they are. -> { added: [iccid], existing: [iccid] } */
  async addSims(rows, by, fileName) {
    const added = [], existing = [];
    for (let i = 0; i < rows.length; i += 400) {
      const chunk = rows.slice(i, i + 400);
      const refs = chunk.map((r) => sims().doc(r.iccid));
      const snaps = await db.getAll(...refs);
      const batch = db.batch();
      snaps.forEach((snap, k) => {
        const r = chunk[k];
        if (snap.exists) { existing.push(r.iccid); return; }
        batch.create(refs[k], {
          iccid: r.iccid, msisdn: r.msisdn, imsi: r.imsi,
          status: r.usedBy ? "assigned" : "available",
          controllerId: r.usedBy?.controllerId || null, uniqueId: r.usedBy?.uniqueId || null,
          uploadedBy: by, uploadedAt: FieldValue.serverTimestamp(), file: fileName || null
        });
        added.push(r.iccid);
      });
      await batch.commit();
    }
    return { added, existing };
  },

  async list({ from, to, createdById = null }) {
    let q = col().where("createdAt", ">=", new Date(from)).where("createdAt", "<", new Date(to));
    const snap = await q.get();
    return snap.docs
      .map((d) => ({ id: d.id, ...d.data(), createdAtMs: ms(d.get("createdAt")) }))
      .filter((c) => !createdById || c.createdBy?.id === createdById);
  },

  async countBy(createdById) {
    const snap = await col().where("createdBy.id", "==", createdById).count().get();
    return snap.data().count;
  },

  // The newest controller's serial of each variant - the format new ones follow.
  async lastSerials() {
    const snap = await col().orderBy("createdAt", "desc").limit(200).get();
    const out = {};
    for (const d of snap.docs) {
      const v = d.get("variant"), sn = d.get("serialNumber");
      if (v && sn && !out[v]) out[v] = String(sn);
    }
    return out;
  },

  // One more than the highest 4-digit Unique ID in use - a suggestion only.
  async nextUniqueId() {
    const snap = await col().orderBy("uniqueId", "desc").limit(20).get();
    const ids = snap.docs.map((d) => String(d.get("uniqueId") || "")).filter((u) => /^\d{4}$/.test(u)).map(Number);
    const next = (ids.length ? Math.max(...ids) : 0) + 1;
    return next > 9999 ? null : String(next).padStart(4, "0");
  }
};

// ---- nodes ("nodes", one document per node, id = its serial number) ----
// The farm pages (onboarding, Add Farm, Edit) offer the "available" ones of
// a type and mark them "assigned" to the farm, as with controllers.
const nodesCol = () => db.collection("nodes");
// The last running number given out per serial stem ("FBMN26" -> 10003).
const nodeCounter = (stem) => db.collection("counters").doc(`nodes_${stem}`);

// The highest running number already used with this stem - for a stem
// without a counter yet (or one that was lost).
async function highestNumber(get, stem) {
  const snap = await get(nodesCol()
    .where(FieldPath.documentId(), ">=", stem)
    .where(FieldPath.documentId(), "<", stem + "~")
    .orderBy(FieldPath.documentId(), "desc").limit(20));
  const nums = snap.docs.map((d) => d.id.slice(stem.length)).filter((x) => /^\d{5}$/.test(x)).map(Number);
  return nums.length ? Math.max(...nums) : NODE_FIRST - 1;
}

export const firestoreNodes = {
  // The counter and the new documents in one transaction: two saves at the
  // same moment get different numbers (the second one retries), and
  // create() refuses a serial that somehow exists already.
  async createMany({ stem, count, doc }) {
    return db.runTransaction(async (t) => {
      const ref = nodeCounter(stem);
      const ctr = await t.get(ref);
      let last = Math.max(NODE_FIRST - 1, ctr.exists ? Number(ctr.get("last")) || 0 : 0, await highestNumber((q) => t.get(q), stem));
      if (last + count > NODE_LAST) throw Object.assign(new Error("full"), { full: true });
      const out = [];
      for (let i = 1; i <= count; i++) {
        const serialNumber = stem + (last + i);
        t.create(nodesCol().doc(serialNumber), { ...doc, serialNumber, createdAt: FieldValue.serverTimestamp() });
        out.push({ id: serialNumber, ...doc, serialNumber });
      }
      t.set(ref, { last: last + count, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      return out;
    });
  },

  async nextNumbers(stems) {
    const snaps = await db.getAll(...stems.map(nodeCounter));
    const out = {};
    await Promise.all(stems.map(async (stem, i) => {
      const fromCounter = snaps[i].exists ? Number(snaps[i].get("last")) || 0 : 0;
      out[stem] = Math.max(fromCounter, await highestNumber((q) => q.get(), stem)) + 1;
    }));
    return out;
  },

  async list({ from, to, createdById = null }) {
    const snap = await nodesCol().where("createdAt", ">=", new Date(from)).where("createdAt", "<", new Date(to)).get();
    return snap.docs
      .map((d) => ({ id: d.id, ...d.data(), createdAtMs: ms(d.get("createdAt")) }))
      .filter((n) => !createdById || n.createdBy?.id === createdById);
  },

  async countBy(createdById) {
    const snap = await nodesCol().where("createdBy.id", "==", createdById).count().get();
    return snap.data().count;
  },

  async stock() {
    const count = async (q) => (await q.count().get()).data().count;
    const rows = await Promise.all(NODE_TYPES.map(async ({ type }) => {
      const [total, available] = await Promise.all([
        count(nodesCol().where("type", "==", type)),
        count(nodesCol().where("type", "==", type).where("status", "==", "available"))
      ]);
      return [type, { available, assigned: total - available, total }];
    }));
    return Object.fromEntries(rows);
  }
};
