import { FieldValue } from "firebase-admin/firestore";
import { db } from "../firebaseAdmin.js";
import { UNIQUE_FIELDS } from "./production.js";

// Firestore side of production.js: the same "controllers" collection the
// MCU / Controller page's Excel upload writes, same fields.

const col = () => db.collection("controllers");
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
  // and then see it.
  async create(doc) {
    return db.runTransaction(async (t) => {
      const clashes = await clashesIn((q) => t.get(q), doc);
      if (clashes.length) throw Object.assign(new Error("clash"), { clashes });
      const ref = col().doc();
      t.create(ref, { ...doc, createdAt: FieldValue.serverTimestamp() });
      return { id: ref.id };
    });
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
