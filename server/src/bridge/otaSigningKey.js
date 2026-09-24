// PUBLIC half of the fleet's OTA signing key - must be byte-identical to
// the Motor repo's include/ota_signing_key.h (compiled into every hub).
// Used to check a release's signature before sending it, and that an
// uploaded firmware.bin carries this same key (a build without it would
// lock hubs out of every later update). Rotating the key: update both.
// Safe to commit - it's the public half.
export const OTA_SIGNING_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE5ES8PnmSaAS2NVQygYZ4W4cjMhvn
NpEqFIs4eYfSy0dyEbD2jeRs+r/k5b3PLm6it+AKCLBSDWQ5/7f6AtfKFQ==
-----END PUBLIC KEY-----
`;
