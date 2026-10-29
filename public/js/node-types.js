// The field modules ("nodes") a hub drives, each its own board with its own
// serial: made on the Production page (Node mode), mapped to a farm on
// onboarding / Add Farm / Edit Farm, counted on the Dashboard.
//
// Serial = prefix + two-digit year (types with year: true) + a running
// number from 10001: FBMN2610001, FBSVN10001. The server makes them - the
// same table is in server/src/bridge/production.js (a test checks they match).
export const NODE_TYPES = [
  { type: "MOTOR", name: "Motor node", prefix: "FBMN", year: true, icon: "fan" },
  { type: "SOLENOID_VALVE", name: "Solenoid valve node", prefix: "FBSVN", year: false, icon: "droplet" },
  { type: "BUTTERFLY_VALVE", name: "Butterfly valve node", prefix: "FBBVN", year: false, icon: "valve-disc" },
  { type: "FILTER_BACKWASH", name: "Filter backwash node", prefix: "FBBW", year: true, icon: "filter" },
  { type: "FERTIGATION", name: "Fertigation node", prefix: "FBFG", year: true, icon: "flask-conical" },
  { type: "WATER_LEVEL", name: "Water level node", prefix: "FBWL", year: true, icon: "waves" }
];

export const nodeTypeOf = (type) => NODE_TYPES.find((t) => t.type === type) || null;
export const nodeTypeName = (type) => nodeTypeOf(type)?.name || type || "";
