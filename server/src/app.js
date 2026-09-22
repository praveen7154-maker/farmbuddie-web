import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";

import { config } from "./config.js";
import { verifyFirebaseToken } from "./middleware/verifyFirebaseToken.js";
import { provisionDeviceRouter } from "./routes/provisionDevice.js";
import { provisionAppRouter } from "./routes/provisionApp.js";
import { provisionMonitorRouter } from "./routes/provisionMonitor.js";

export const app = express();

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
