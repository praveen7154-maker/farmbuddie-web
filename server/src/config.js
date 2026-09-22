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
  mqttBrokerPort: Number(process.env.MQTT_BROKER_PORT || 8883)
};
