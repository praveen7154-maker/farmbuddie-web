import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";

import { config } from "./config.js";
import { verifyFirebaseToken } from "./middleware/verifyFirebaseToken.js";
import { provisionDeviceRouter } from "./routes/provisionDevice.js";
import { provisionAppRouter } from "./routes/provisionApp.js";
import { provisionMonitorRouter } from "./routes/provisionMonitor.js";
import { provisionBootstrapRouter } from "./routes/provisionBootstrap.js";
import { fcmTokenRouter } from "./routes/fcmToken.js";

export const app = express();

// This container only ever binds to 127.0.0.1 (see docker-compose.yml) -
// nginx on the same host is the only thing that can reach it, terminating
// TLS and setting X-Forwarded-For for the real client IP. "loopback" tells
// Express/express-rate-limit to trust that header specifically from
// loopback callers (nginx) - without it, express-rate-limit throws
// ERR_ERL_UNEXPECTED_X_FORWARDED_FOR on every request and falls back to
// treating every caller as the same IP (nginx's), which would bucket every
// farmer's device/app together under one shared rate limit once traffic
// picks up. Not a blanket `true` - that would trust X-Forwarded-For from
// literally any source, a spoofing risk this deployment doesn't need to
// take since nginx is the only real caller.
app.set("trust proxy", "loopback");

app.use(express.json());

app.get("/healthz", (req, res) => res.json({ ok: true }));

const provisionLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false
});

// /provision/device is only ever called from the admin panel's own origin.
app.use(
  "/provision/device",
  cors({ origin: config.adminOrigins }),
  provisionLimiter,
  verifyFirebaseToken,
  provisionDeviceRouter
);

// /provision/app is called by the mobile app (not a browser), so no CORS
// restriction applies — it relies entirely on Firebase token + ownership checks.
app.use("/provision/app", provisionLimiter, verifyFirebaseToken, provisionAppRouter);

// /provision/monitor is called by irrigo-admin (not a browser either) — see
// that route's own top-of-file comment for why it needs its own explicit
// admin check instead of relying on CORS.
app.use("/provision/monitor", provisionLimiter, verifyFirebaseToken, provisionMonitorRouter);

// /provision/fcm-token is called by the Irrigo app, same trust model as
// /provision/app (signed-in phone user, no CORS restriction — not a browser caller).
app.use("/provision/fcm-token", provisionLimiter, verifyFirebaseToken, fcmTokenRouter);

// /provision/bootstrap is called by a device itself, before it has ever
// touched MQTT — no Firebase token exists for it to send. Authenticated
// entirely inside the route by its own shared secret (see that file's own
// comment) instead of verifyFirebaseToken. Tighter rate limit — this is
// the one endpoint reachable with no per-caller identity at all.
const bootstrapLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false
});
app.use("/provision/bootstrap", bootstrapLimiter, provisionBootstrapRouter);
