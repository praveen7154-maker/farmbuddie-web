// Motor numbers on a farm: "1" is the hub's own directly-wired motor,
// "2".."4" are motor nodes (Motor-Node units on the hub's mesh, relayed on
// farm/<farm>/<node>/motor/<n>/*). Mirrors the Motor firmware's
// FIRST_MOTOR_NODE..LAST_MOTOR_NODE (config.h) - one more motor node there
// means raising MAX_MOTOR_NUMBER here.
export const MAX_MOTOR_NUMBER = 4;
export const MOTOR_NUMBERS = Array.from({ length: MAX_MOTOR_NUMBER }, (_, i) => String(i + 1));

// "1".."4" as a string; anything else (missing, bad input) falls back to "1".
export function normalizeMotorNum(motorNum) {
  const n = String(motorNum ?? "1");
  return MOTOR_NUMBERS.includes(n) ? n : "1";
}

// The app's pump letter for a motor number: "1" -> "A", "2" -> "B", "3" -> "C" ...
export const PUMP_LETTERS = MOTOR_NUMBERS.map((n) => String.fromCharCode(64 + Number(n)));
