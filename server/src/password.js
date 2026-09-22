import { randomBytes } from "crypto";

export function generateMqttPassword() {
  return randomBytes(24).toString("base64url");
}
