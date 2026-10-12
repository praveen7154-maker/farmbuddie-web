// Provisioning API — runs on the VPS alongside TBMQ (see /server/README.md).
export const API_BASE_URL = "https://api.farmbuddie.com";

// Bridge service (server/src/bridge) — the one holding the live MQTT
// connection, exposing POST /command/device and GET /telemetry/:farmId.
// NOT reachable yet until nginx is given a route to it (see server/
// README.md's own note on this — it was never wired up publicly before
// now). Until that's done, fleet control calls from the admin panel will
// fail with a network error, not a bug in this file.
export const BRIDGE_BASE_URL = "https://api.farmbuddie.com/bridge";

// Document and photo uploads (farmer / distributor onboarding and edit).
// Off until a Firebase Storage bucket is set up - paper copies are kept
// meanwhile, and the upload fields are hidden. Turn on when Storage is
// ready (then `firebase deploy --only hosting,storage`).
export const DOCUMENT_UPLOADS = false;
// With uploads on: the documents marked ✱ must be attached before saving.
export const DOCUMENTS_REQUIRED = false;
