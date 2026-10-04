import { PUMP_LETTERS } from "./motorNumbers.js";

// A farm's saved "Motor Only" cyclic programs (ON/OFF timers), shared by
// every phone on the farm - the plain-cyclic twin of valveSequences.js.
// Kept per motor ("A" = Motor 1, "B" = Motor 2, "C" = Motor 3 ...), one Firestore doc each:
// farmCyclicPresets/<farmId>_<pump>.

export const MAX_PRESETS = 5;              // Irrigo's MAX_PRESETS_PER_PUMP
export const MAX_PHASE_SEC = 24 * 3600;

const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

export function validPump(pump) {
  return PUMP_LETTERS.includes(pump);
}

// Returns the cleaned list, or throws { status: 400, message } on bad input.
export function validatePresets(input) {
  if (!Array.isArray(input)) throw { status: 400, message: "presets must be an array" };
  if (input.length > MAX_PRESETS) throw { status: 400, message: `At most ${MAX_PRESETS} presets` };
  return input.map((p, i) => {
    const name = typeof p?.name === "string" ? p.name.trim().slice(0, 40) : "";
    if (!name) throw { status: 400, message: `Preset ${i + 1}: name is required` };
    if (!intIn(p.on_sec, 1, MAX_PHASE_SEC) || !intIn(p.off_sec, 0, MAX_PHASE_SEC)) {
      throw { status: 400, message: `Preset "${name}": invalid ON/OFF time` };
    }
    return {
      name,
      on_sec: p.on_sec,
      off_sec: p.off_sec,
      stop_mode: intIn(p.stop_mode, 0, 2) ? p.stop_mode : 0,
      stop_value: intIn(p.stop_value, 0, 65535) ? p.stop_value : 0,
      use_valve: p.use_valve === true,
    };
  });
}

const docRef = (db, farmId, pump) => db.collection("farmCyclicPresets").doc(`${farmId}_${pump}`);

export async function loadCyclicPresets(db, farmId, pump) {
  const snap = await docRef(db, farmId, pump).get();
  if (!snap.exists) return { farmId, pump, presets: [], updatedAt: null };
  const d = snap.data();
  return { farmId, pump, presets: Array.isArray(d.presets) ? d.presets : [], updatedAt: d.updatedAt || null };
}

export async function saveCyclicPresets(db, farmId, pump, presets, updatedBy) {
  const updatedAt = new Date().toISOString();
  await docRef(db, farmId, pump).set({ presets, updatedAt, updatedBy: updatedBy || null });
  return { farmId, pump, presets, updatedAt };
}
