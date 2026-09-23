import crypto from "node:crypto";
import QRCode from "qrcode";

/**
 * Node port of public/js/qrCrypto.js's encryptRaw() (itself a port of
 * irrigo-admin's old qr/QrCrypto.kt, since removed along with QR
 * Provisioning) - MUST stay byte-for-byte identical (same fixed
 * AES-256-GCM key, same IV length/tag length, same IV||ciphertext+tag
 * layout) so the farmer-facing Irrigo app's QrCrypto.decryptRaw() can
 * read a QR generated here. This is now the SECOND independent encrypt
 * implementation of this same fixed key (the browser one backs
 * provisioning.js's own on-screen QR at credential-issue time; this one
 * backs GET /fleet/device/:farmId/qr, for re-fetching that same farm's QR
 * later from the Irrigo Admin app). If this key is ever rotated, update
 * this file, public/js/qrCrypto.js, AND the Irrigo app's QrCrypto.kt
 * together.
 */
const KEY = Buffer.from([
  255, 28, 253, 104, 226, 190, 53, 38, 137, 78, 252, 130, 174, 105, 181, 182,
  133, 241, 105, 243, 189, 182, 56, 31, 156, 176, 55, 207, 67, 184, 236, 178
]);
const IV_LEN = 12;

function encryptRaw(plaintext) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv, { authTagLength: 16 });
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, ciphertext, authTag]);
}

/**
 * Same JSON shape as provisioning.js's on-screen QR (matches
 * irrigo-admin's old model/FarmSetupPayload.kt, which the farmer app's QR
 * scanner decodes into) - a device credential re-issued as a scannable QR
 * on demand, not a new credential.
 */
export async function buildDeviceQrPng({ farmerName, brokerUrl, port, username, password, farmId, nodeId }) {
  const payload = JSON.stringify({
    name: farmerName || "",
    mqtt_host: brokerUrl,
    mqtt_port: port,
    mqtt_username: username,
    mqtt_password: password,
    farm_id: farmId,
    node_id: nodeId
  });

  const encrypted = encryptRaw(payload);

  return QRCode.toBuffer([{ data: encrypted, mode: "byte" }], {
    type: "png",
    width: 480,
    margin: 2
  });
}
