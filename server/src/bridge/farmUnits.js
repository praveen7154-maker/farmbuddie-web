// Which kinds of node a farm has - for the OTA page, so a motor-node /
// valve / filter-backwash image is only offered to (and only sent to) farms
// that actually have that kind of unit.
//
// Two sources, either one is enough:
//   - farmers/{id}.pairedUnits (written by the Irrigo app when a unit is
//     paired or removed - see its PairedUnitsRepository). A Filter-Backwash-
//     Node pairs as a valve unit with hasPressureSensors = true.
//   - what the hub itself reports: motor_nodes in Motor 1's status (every
//     motor node paired to the hub), the valves topic's units list, and the
//     backwash block's pressure_data_online. (Not a motorN status left in
//     the record - that can outlive the node.)
// The hub's valves list doesn't say which unit is the backwash node, so a
// farm whose app never synced pairedUnits counts its backwash node as a
// valve unit there - harmless: a valve image sent to it is refused by the
// unit itself (wrong_product).

// A unit paired at or before its removal note is a removed one that a phone
// on an old app version uploaded again (Irrigo PairedUnitsRepository.removedAt()).
function livePaired(paired, kind, labelKey) {
  const removed = paired.removed?.[kind] || {};
  return Object.values(paired[kind] || {}).filter((u) => {
    const at = removed[u?.[labelKey]];
    return !(typeof at === "number" && (u?.provisionedAtMs || 0) <= at);
  });
}

export function farmUnitCounts(farmer) {
  const paired = farmer?.pairedUnits || {};
  const status = farmer?.deviceStatus || {};
  const motor1 = status.motor1 || {};

  const pairedMotor = livePaired(paired, "motorNodes", "nodeLabel").length;
  const reportedMotor = motor1.motor_nodes && typeof motor1.motor_nodes === "object"
    ? Object.keys(motor1.motor_nodes).length
    : (typeof motor1.motor2_online === "boolean" ? 1 : 0);

  const pairedValveUnits = livePaired(paired, "valves", "unitLabel");
  const pairedBackwash = pairedValveUnits.filter((u) => u && u.hasPressureSensors === true).length;
  const pairedValves = pairedValveUnits.length - pairedBackwash;
  const liveUnits = Array.isArray(status.valves?.units) ? status.valves.units.length : 0;

  return {
    motorNodes: Math.max(pairedMotor, reportedMotor),
    valves: Math.max(pairedValves, liveUnits - pairedBackwash, 0),
    backwash: Math.max(pairedBackwash, motor1.backwash?.pressure_data_online === true ? 1 : 0)
  };
}

// The count that matters for an OTA product (null = the hub itself).
export function unitsForProduct(units, product) {
  if (product === "motor-node") return units?.motorNodes || 0;
  if (product === "valve") return units?.valves || 0;
  if (product === "filter-backwash") return units?.backwash || 0;
  return null;
}
