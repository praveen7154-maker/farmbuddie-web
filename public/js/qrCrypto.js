/**
 * Browser port of irrigo-admin's qr/QrCrypto.kt (encryptRaw) — MUST stay
 * byte-for-byte identical (same fixed AES-256-GCM key, same IV length/tag
 * length, same IV||ciphertext+tag layout) so the farmer-facing Irrigo
 * app's QrCrypto.decryptRaw() can read a QR generated here. See that
 * file's own doc comment for the full threat model (this stops a printed
 * sticker from handing out plaintext MQTT credentials to any camera
 * pointed at it — it is NOT a defense against decompiling either app).
 *
 * IMPORTANT: KEY must stay byte-for-byte identical to both Kotlin copies.
 * If it's ever rotated, update all three places together.
 */
const KEY_BYTES = new Uint8Array([
  255, 28, 253, 104, 226, 190, 53, 38, 137, 78, 252, 130, 174, 105, 181, 182,
  133, 241, 105, 243, 189, 182, 56, 31, 156, 176, 55, 207, 67, 184, 236, 178
]);
const IV_LEN = 12;

async function importKey() {
  return crypto.subtle.importKey("raw", KEY_BYTES, { name: "AES-GCM" }, false, ["encrypt"]);
}

/**
 * plaintext string -> Uint8Array(IV || ciphertext+tag), matching
 * QrCrypto.encryptRaw()'s output exactly. Web Crypto's AES-GCM appends the
 * auth tag to the end of the ciphertext automatically, same convention as
 * Java's Cipher.doFinal() for GCM — no separate tag handling needed here.
 */
export async function encryptRaw(plaintext) {
  const key = await importKey();
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const plaintextBytes = new TextEncoder().encode(plaintext);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, tagLength: 128 }, key, plaintextBytes);
  const combined = new Uint8Array(IV_LEN + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), IV_LEN);
  return combined;
}
