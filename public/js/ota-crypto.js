// OTA signing, entirely in the browser - the fleet's private signing key
// and its passphrase never leave this page (only the signature goes to
// the VPS). Same result as the Motor repo's tools/ota_admin.py:
//   manifest  = "farmbuddie-ota-v1\n<sha256 hex>\n<size>\n<version>"
//   signature = base64( DER ECDSA-P256-SHA256(manifest) )
// which the hub checks with mbedtls against the public key compiled into
// its firmware (include/ota_signing_key.h) before downloading anything.
//
// Reads the .pem written by `ota_admin.py --gen-key`: PKCS#8, either
// passphrase-encrypted (PBES2: PBKDF2-HMAC-SHA256/SHA1 + AES-CBC - what the
// Python cryptography library writes) or plain. Uses only WebCrypto, so it
// runs the same in a browser and in Node (for tests).

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();

export function otaManifest(sha256Hex, size, version) {
  return `farmbuddie-ota-v1\n${sha256Hex.toLowerCase()}\n${size}\n${version}`;
}

export async function sha256Hex(bytes) {
  const d = new Uint8Array(await subtle.digest("SHA-256", bytes));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// True if `image` contains `needle` (the public key PEM compiled into the
// firmware) - a build without it would lock hubs out of every later update.
export function bytesInclude(image, needle) {
  const n = typeof needle === "string" ? enc.encode(needle) : needle;
  if (n.length === 0 || image.length < n.length) return false;
  const first = n[0];
  outer: for (let i = image.indexOf(first); i !== -1 && i <= image.length - n.length; i = image.indexOf(first, i + 1)) {
    for (let j = 1; j < n.length; j++) if (image[i + j] !== n[j]) continue outer;
    return true;
  }
  return false;
}

function pemBody(pem, label) {
  const m = new RegExp(`-----BEGIN ${label}-----([\\s\\S]*?)-----END ${label}-----`).exec(pem);
  if (!m) return null;
  const bin = atob(m[1].replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---- minimal DER reader: just enough for EncryptedPrivateKeyInfo ----
function tlv(buf, pos) {
  const tag = buf[pos];
  let len = buf[pos + 1];
  let hdr = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n < 1 || n > 3) throw new Error("bad DER length");
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | buf[pos + 2 + i];
    hdr += n;
  }
  const start = pos + hdr;
  if (start + len > buf.length) throw new Error("truncated DER");
  return { tag, start, end: start + len, next: start + len };
}

function children(buf, node) {
  const out = [];
  for (let p = node.start; p < node.end; ) {
    const c = tlv(buf, p);
    out.push(c);
    p = c.next;
  }
  return out;
}

const hex = (buf, node) => [...buf.slice(node.start, node.end)].map((b) => b.toString(16).padStart(2, "0")).join("");
const OID = {
  PBES2: "2a864886f70d01050d",
  PBKDF2: "2a864886f70d01050c",
  HMAC_SHA256: "2a864886f70d0209",
  HMAC_SHA1: "2a864886f70d0207",
  AES256_CBC: "60864801650304012a",
  AES128_CBC: "608648016503040102"
};

function intValue(buf, node) {
  let v = 0;
  for (let i = node.start; i < node.end; i++) v = v * 256 + buf[i];
  return v;
}

async function decryptPkcs8(der, passphrase) {
  const top = tlv(der, 0);
  const [algId, encData] = children(der, top);
  const [algOid, params] = children(der, algId);
  if (hex(der, algOid) !== OID.PBES2) throw new Error("Unsupported key encryption (expected PBES2) - re-create the key with ota_admin.py --gen-key");
  const [kdf, cipher] = children(der, params);
  const [kdfOid, kdfParams] = children(der, kdf);
  if (hex(der, kdfOid) !== OID.PBKDF2) throw new Error("Unsupported key derivation (expected PBKDF2)");
  const kp = children(der, kdfParams);
  const salt = der.slice(kp[0].start, kp[0].end);
  const iterations = intValue(der, kp[1]);
  let hash = "SHA-1";
  for (const c of kp.slice(2)) {
    if (c.tag === 0x30) {
      const prf = hex(der, children(der, c)[0]);
      if (prf === OID.HMAC_SHA256) hash = "SHA-256";
      else if (prf !== OID.HMAC_SHA1) throw new Error("Unsupported PBKDF2 hash");
    }
  }
  const [cipherOid, ivNode] = children(der, cipher);
  const cOid = hex(der, cipherOid);
  const keyBits = cOid === OID.AES256_CBC ? 256 : cOid === OID.AES128_CBC ? 128 : 0;
  if (!keyBits) throw new Error("Unsupported key cipher (expected AES-CBC)");
  const iv = der.slice(ivNode.start, ivNode.end);

  const baseKey = await subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  const aesKey = await subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash },
    baseKey, { name: "AES-CBC", length: keyBits }, false, ["decrypt"]
  );
  try {
    return new Uint8Array(await subtle.decrypt({ name: "AES-CBC", iv }, aesKey, der.slice(encData.start, encData.end)));
  } catch {
    throw new Error("Wrong passphrase for this key file");
  }
}

// Loads the fleet signing key from the .pem text (+ passphrase if it's
// encrypted). Throws a readable Error for a wrong passphrase / wrong file.
export async function loadSigningKey(pemText, passphrase) {
  let pkcs8 = pemBody(pemText, "PRIVATE KEY");
  if (!pkcs8) {
    const encrypted = pemBody(pemText, "ENCRYPTED PRIVATE KEY");
    if (!encrypted) throw new Error("Not a private key file - choose the ota_signing_key.pem made by ota_admin.py --gen-key");
    if (!passphrase) throw new Error("This key file needs its passphrase");
    pkcs8 = await decryptPkcs8(encrypted, passphrase);
  }
  try {
    return await subtle.importKey("pkcs8", pkcs8, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  } catch {
    throw new Error("Wrong passphrase, or not an EC P-256 key");
  }
}

async function importPublicKey(publicKeyPem) {
  const spki = pemBody(publicKeyPem, "PUBLIC KEY");
  if (!spki) throw new Error("Server returned no OTA public key");
  return subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
}

// WebCrypto gives r||s (64 bytes); the hub (mbedtls) wants ASN.1 DER.
function rawToDer(raw) {
  const int = (b) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.slice(i);
    if (v[0] & 0x80) v = Uint8Array.of(0, ...v);
    return Uint8Array.of(0x02, v.length, ...v);
  };
  const r = int(raw.slice(0, 32));
  const s = int(raw.slice(32, 64));
  return Uint8Array.of(0x30, r.length + s.length, ...r, ...s);
}

function toBase64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

// Signs the manifest and double-checks the signature against the public
// key the hubs carry, so a wrong .pem is caught here, not on the farms.
export async function signRelease(privateKey, publicKeyPem, sha256, size, version) {
  const manifest = enc.encode(otaManifest(sha256, size, version));
  const raw = new Uint8Array(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, manifest));
  const pub = await importPublicKey(publicKeyPem);
  const ok = await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, raw, manifest);
  if (!ok) throw new Error("This key file doesn't match the key compiled into the hubs' firmware");
  return toBase64(rawToDer(raw));
}
