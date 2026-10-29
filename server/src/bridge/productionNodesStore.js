import { NODE_TYPES, NODE_FIRST, NODE_LAST } from "./production.js";

// Firestore side of the nodes (production.js): the "nodes" collection, one
// document per node, id = its serial number. The farm pages (onboarding,
// Add Farm, Edit) offer the "available" ones of a type and mark them
// "assigned" to the farm, as with controllers.
//
// The last running number given out per serial stem is kept in
// counters/nodes_<stem> ("FBMN26" -> { last: 10003 }). Only a stem with no
// counter yet (its first node) looks at the nodes themselves - by document
// id, ascending: Firestore keeps that order without any extra index (a
// descending one would need a composite index - the summary failed on it).
//
// deps: { db, FieldValue, FieldPath } from firebase-admin (or fakes).
export function createFirestoreNodes({ db, FieldValue, FieldPath }) {
  const nodesCol = () => db.collection("nodes");
  const nodeCounter = (stem) => db.collection("counters").doc(`nodes_${stem}`);

  // The highest running number already used with this stem (ids only, no fields read).
  async function highestNumber(get, stem) {
    const snap = await get(nodesCol()
      .where(FieldPath.documentId(), ">=", stem)
      .where(FieldPath.documentId(), "<", stem + "~")
      .select());
    const nums = snap.docs.map((d) => d.id.slice(stem.length)).filter((x) => /^\d{5}$/.test(x)).map(Number);
    return nums.length ? Math.max(...nums) : NODE_FIRST - 1;
  }

  // The counter and the new documents in one transaction: two saves at the
  // same moment get different numbers (the second one retries), and
  // create() refuses a serial that exists already. If one does (a counter
  // behind the nodes), the nodes are looked at and it goes once more.
  async function createMany({ stem, count, doc }, rescan = false) {
    try {
      return await db.runTransaction(async (t) => {
        const ref = nodeCounter(stem);
        const ctr = await t.get(ref);
        const fromCounter = ctr.exists ? Number(ctr.get("last")) || 0 : 0;
        const fromNodes = !ctr.exists || rescan ? await highestNumber((q) => t.get(q), stem) : 0;
        const last = Math.max(NODE_FIRST - 1, fromCounter, fromNodes);
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
    } catch (err) {
      if (err?.code === 6 && !rescan) return createMany({ stem, count, doc }, true);    // 6 = ALREADY_EXISTS
      throw err;
    }
  }

  return {
    createMany: (args) => createMany(args),

    // What createMany() takes next, per stem (the form shows it before saving).
    async nextNumbers(stems) {
      const snaps = await db.getAll(...stems.map(nodeCounter));
      const out = {};
      await Promise.all(stems.map(async (stem, i) => {
        const last = snaps[i].exists ? Number(snaps[i].get("last")) || 0 : await highestNumber((q) => q.get(), stem);
        out[stem] = Math.max(NODE_FIRST - 1, last) + 1;
      }));
      return out;
    },

    async list({ from, to, createdById = null }) {
      const snap = await nodesCol().where("createdAt", ">=", new Date(from)).where("createdAt", "<", new Date(to)).get();
      return snap.docs
        .map((d) => ({ id: d.id, ...d.data(), createdAtMs: d.get("createdAt")?.toMillis?.() ?? null }))
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
}
