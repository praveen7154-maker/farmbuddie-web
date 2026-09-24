function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT || 4000),
  adminOrigins: (process.env.ADMIN_ORIGIN || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  tbmqBaseUrl: process.env.TBMQ_BASE_URL || "http://tbmq:8083",
  tbmqAdminEmail: () => required("TBMQ_ADMIN_EMAIL"),
  tbmqAdminPassword: () => required("TBMQ_ADMIN_PASSWORD"),
  mqttBrokerHost: process.env.MQTT_BROKER_HOST || "mqtt.farmbuddie.com",
  mqttBrokerPort: Number(process.env.MQTT_BROKER_PORT || 8883),

  // Bridge service only (server/src/bridge) — a persistent MQTT connection,
  // not the REST API. Uses TBMQ's plain internal port over the docker
  // network (service name, not the public TLS host/port) since it never
  // leaves the VPS — no TLS overhead or cert trust needed for a
  // container-to-container hop on a private network.
  bridgeMqttUrl: process.env.BRIDGE_MQTT_URL || "mqtt://tbmq:1883",
  bridgeMqttUsername: () => required("BRIDGE_MQTT_USERNAME"),
  bridgeMqttPassword: () => required("BRIDGE_MQTT_PASSWORD"),
  bridgePort: Number(process.env.BRIDGE_PORT || 4100),
  // provision-api's own view of the bridge service, over the docker network
  // (container hostname, not the public host) - used only by GET
  // /provision/status (routes/status.js) to relay the bridge's own health
  // (its MQTT session, its Postgres pool) into the admin panel's "VPS &
  // TBMQ" page. Same "service:port" pattern as tbmqBaseUrl/bridgeMqttUrl -
  // "bridge" assumes that's the docker-compose service name; set
  // BRIDGE_INTERNAL_URL explicitly if yours differs (a wrong hostname just
  // shows as "bridge unreachable" on the status page, nothing breaks).
  bridgeInternalUrl: process.env.BRIDGE_INTERNAL_URL || "http://bridge:4100",
  bridgePgConnectionString: () => required("BRIDGE_PG_CONNECTION_STRING"),
  bridgeAdminOrigins: (process.env.ADMIN_ORIGIN || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  // One shared secret compiled into every device's firmware — proves "this
  // is a Farm Buddie device" to /provision/bootstrap and /provision/bind.
  // NOT enough on its own: it's in every unit's flash, so it's treated as
  // extractable. A bound farm additionally requires its own device key
  // (see deviceBinding.js).
  deviceProvisioningSecret: () => required("DEVICE_PROVISIONING_SECRET"),

  // Refuse bootstrap requests that carry no deviceKey (firmware older than
  // per-device key binding - see deviceBinding.js). Off by default so units
  // still on that firmware can provision; turn on once none remain.
  bootstrapRequireDeviceKey: process.env.BOOTSTRAP_REQUIRE_DEVICE_KEY === "true",
  // Alert pushes as data-only messages, which the Irrigo app turns into one
  // notification per fault / per recovery (see bridge/pushNotifications.js).
  // App builds from before that change can't show data-only pushes, so this
  // stays off (notification-style pushes) until most farmers have updated.
  pushDataOnly: process.env.PUSH_DATA_ONLY === "true",
  // Where hubs download web-panel OTA firmware from - the bridge's public
  // HTTPS address (nginx maps /bridge to it). Must be https://.
  otaPublicBaseUrl: process.env.OTA_PUBLIC_BASE_URL || "https://api.farmbuddie.com/bridge"
};
