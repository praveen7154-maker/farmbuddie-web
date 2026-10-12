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
//     backwash block's pressure_data_online.
// The hub's valves list doesn't say which unit is the backwash node, so a
// farm whose app never synced pairedUnits counts its backwash node as a
// valve unit there - harmless: a valve image sent to it is refused by the
// unit itself (wrong_product).

const MOTOR_NODE_NUMBERS = ["2", "3", "4"];

export function farmUnitCounts(farmer) {
  const paired = farmer?.pairedUnits || {};
  const status = farmer?.deviceStatus || {};
  const motor1 = status.motor1 || {};

  const pairedMotor = Object.keys(paired.motorNodes || {}).length;
  const reportedMotor = motor1.motor_nodes && typeof motor1.motor_nodes === "object"
    ? Object.keys(motor1.motor_nodes).length
    : (typeof motor1.motor2_online === "boolean" ? 1 : 0);
  const relayedMotor = MOTOR_NODE_NUMBERS.filter((n) => status[`motor${n}`]).length;

  const pairedValveUnits = Object.values(paired.valves || {});
  const pairedBackwash = pairedValveUnits.filter((u) => u && u.hasPressureSensors === true).length;
  const pairedValves = pairedValveUnits.length - pairedBackwash;
  const liveUnits = Array.isArray(status.valves?.units) ? status.valves.units.length : 0;

  return {
    motorNodes: Math.max(pairedMotor, reportedMotor, relayedMotor),
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
