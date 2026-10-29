import { FieldValue, FieldPath } from "firebase-admin/firestore";
import { db, auth } from "../firebaseAdmin.js";
import { UNIQUE_FIELDS } from "./production.js";
import { createFirestoreNodes } from "./productionNodesStore.js";

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
// See productionNodesStore.js.
export const firestoreNodes = createFirestoreNodes({ db, FieldValue, FieldPath });

// ---- the onboarding team's Firebase sign-in (production.js "teamAuth") ----
// teamAccess/<uid>: what the Firestore rules check on every read / write of
// an onboarding team member - off (or gone) means no access at once, not
// when their sign-in runs out.
const teamAccess = (uid) => db.collection("teamAccess").doc(uid);
const ignoreMissing = (err) => { if (err?.code !== "auth/user-not-found") throw err; };

export const firebaseTeamAuth = {
  customToken: (uid, claims) => auth.createCustomToken(uid, claims),

  async setAccess(uid, { active, username, name }) {
    await teamAccess(uid).set({ team: "onboarding", active: !!active, username, name: name || username, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    // The Firebase user appears at the first sign-in; before that there's nothing to switch.
    await auth.updateUser(uid, { disabled: !active }).catch(ignoreMissing);
    if (!active) await auth.revokeRefreshTokens(uid).catch(ignoreMissing);
  },

  async signOut(uid) {
    await auth.revokeRefreshTokens(uid).catch(ignoreMissing);
  },

  async remove(uid) {
    await teamAccess(uid).delete();
    await auth.deleteUser(uid).catch(ignoreMissing);
  },

  // Farms they saved (onboarding / Add Farm write createdBy = their uid).
  async countOnboarded(uid) {
    const snap = await db.collection("farmers").where("createdBy", "==", uid).count().get();
    return snap.data().count;
  }
};
