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
  bridgePgConnectionString: () => required("BRIDGE_PG_CONNECTION_STRING"),
  bridgeAdminOrigins: (process.env.ADMIN_ORIGIN || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
};
