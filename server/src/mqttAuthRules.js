// TBMQ authorization rules for every kind of MQTT credential this system
// issues - one place, so new credentials (routes/provisionApp.js,
// deviceProvisioning.js) and existing ones (scripts/applyMqttAuthRules.js)
// always get the same patterns.
//
// TBMQ rules are Java regexes, fully matched against the topic (or, for a
// subscription, the literal topic filter - so "+"/"#" in a filter must be
// matched by the regex too). Lookahead works. MQTT's own "+" is NOT regex
// "+" - see README ("farm/+/.*" silently matches nothing).
//
// OTA is admin-only: only the ota-admin credential may publish an OTA
// command. Devices refuse unsigned updates anyway (ECDSA - see the Motor
// firmware's OtaManager), but a farmer's app login could otherwise still
// replay an older signed update at its own devices.

export const OTA_BROADCAST_TOPIC = "motor/ota/broadcast"; // Motor firmware's MQTT_TOPIC_OTA_BROADCAST
export const OTA_ADMIN_USERNAME = "ota-admin";

// A Motor hub (credential FBIRG<farmId>): its own farm's subtree, plus the
// fleet-wide OTA broadcast topic, which it subscribes to but can't publish.
// It can't publish an OTA command either (.../ota/cmd) - the farm's setup QR
// hands this same login to the farmer's phone (the app's direct-MQTT
// fallback), so without that exclusion a phone could send OTA commands.
export function deviceAuthRules(farmId) {
  return {
    pubAuthRulePatterns: [`farm/${farmId}/(?![^/]+/ota/cmd$).*`],
    subAuthRulePatterns: [`farm/${farmId}/.*`, OTA_BROADCAST_TOPIC]
  };
}

// The Irrigo app: read everything of its farms; publish anything except a
// device's ota/* topics (farm/<id>/<node>/ota/...).
export function appAuthRules(farmIds) {
  return {
    pubAuthRulePatterns: farmIds.map((farmId) => `farm/${farmId}/(?![^/]+/ota/).*`),
    subAuthRulePatterns: farmIds.map((farmId) => `farm/${farmId}/.*`)
  };
}

// tools/ota_admin.py: send OTA commands (one device or the whole fleet) and
// watch their progress - nothing else.
export function otaAdminAuthRules() {
  return {
    pubAuthRulePatterns: ["farm/[^/]+/[^/]+/ota/cmd", OTA_BROADCAST_TOPIC],
    subAuthRulePatterns: ["farm/[^/]+/[^/]+/ota/status"]
  };
}

// The VPS bridge (src/bridge): reads every farm, and only ever publishes
// motor commands (mqttBridge.js publishCommand()).
export function bridgeAuthRules() {
  return {
    pubAuthRulePatterns: ["farm/[^/]+/[^/]+/motor/[12]/cmd"],
    subAuthRulePatterns: ["farm/[^/]+/.*"]
  };
}

// Farm ids a credential's existing rules are scoped to ("farm/0005/..."),
// for rebuilding them with the functions above.
export function farmIdsFromRules(authRules) {
  const ids = new Set();
  for (const p of [...(authRules?.pubAuthRulePatterns || []), ...(authRules?.subAuthRulePatterns || [])]) {
    const m = /^farm\/(\d+)\//.exec(p);
    if (m) ids.add(m[1]);
  }
  return [...ids];
}
