// A farm's saved "Motor + Valve Mode" sequences, shared by every phone on
// the farm. The Irrigo app used to keep them only in each phone's own
// database, so a sequence saved on one phone never showed on another
// (schedules did, because the hub itself holds those). Stored as one
// Firestore doc per farm: farmValveSequences/<farmId>.

export const MAX_SEQUENCES = 5;      // Irrigo's MAX_VALVE_CYCLIC_PRESETS
export const MAX_STEPS = 28;         // hub's MAX_VALVE_CYCLIC_STEPS
export const MAX_VALVE = 50;
export const MAX_STEP_SEC = 24 * 3600;

const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

// Returns the cleaned list, or throws { status: 400, message } on bad input.
export function validateSequences(input) {
  if (!Array.isArray(input)) throw { status: 400, message: "sequences must be an array" };
  if (input.length > MAX_SEQUENCES) throw { status: 400, message: `At most ${MAX_SEQUENCES} sequences` };
  return input.map((s, i) => {
    const name = typeof s?.name === "string" ? s.name.trim().slice(0, 40) : "";
    if (!name) throw { status: 400, message: `Sequence ${i + 1}: name is required` };
    if (!Array.isArray(s.steps) || s.steps.length < 1 || s.steps.length > MAX_STEPS) {
      throw { status: 400, message: `Sequence "${name}": 1-${MAX_STEPS} steps required` };
    }
    const steps = s.steps.map((st, j) => {
      if (!intIn(st?.valve, 1, MAX_VALVE) || !intIn(st?.duration_sec, 1, MAX_STEP_SEC)) {
        throw { status: 400, message: `Sequence "${name}" step ${j + 1}: invalid valve or duration` };
      }
      return { valve: st.valve, duration_sec: st.duration_sec };
    });
    const stopMode = intIn(s.stop_mode, 0, 2) ? s.stop_mode : 0;
    const stopValue = intIn(s.stop_value, 0, 65535) ? s.stop_value : 0;
    return { name, steps, stop_mode: stopMode, stop_value: stopValue };
  });
}

export async function loadValveSequences(db, farmId) {
  const snap = await db.collection("farmValveSequences").doc(farmId).get();
  if (!snap.exists) return { farmId, sequences: [], updatedAt: null };
  const d = snap.data();
  return { farmId, sequences: Array.isArray(d.sequences) ? d.sequences : [], updatedAt: d.updatedAt || null };
}

export async function saveValveSequences(db, farmId, sequences, updatedBy) {
  const updatedAt = new Date().toISOString();
  await db.collection("farmValveSequences").doc(farmId).set({ sequences, updatedAt, updatedBy: updatedBy || null });
  return { farmId, sequences, updatedAt };
}
