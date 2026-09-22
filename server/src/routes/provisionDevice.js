import { Router } from "express";
import { issueDeviceCredential } from "../deviceProvisioning.js";

export const provisionDeviceRouter = Router();

/**
 * POST /provision/device
 * body: { controllerDocId: string, rotate?: boolean }
 *
 * Issues (or rotates) MQTT credentials for a controller that has already
 * been assigned to a farmer in the admin panel. Called from
 * farmbuddie-web (controller panel / onboarding flows) by a signed-in
 * admin — see deviceProvisioning.js for the actual logic, shared with
 * POST /provision/bootstrap (the device's own first-boot fetch).
 */
provisionDeviceRouter.post("/", async (req, res) => {
  const { controllerDocId, rotate } = req.body || {};

  if (!controllerDocId || typeof controllerDocId !== "string") {
    return res.status(400).json({ error: "controllerDocId is required" });
  }

  try {
    const result = await issueDeviceCredential(controllerDocId, { rotate: !!rotate });
    return res.json(result);
  } catch (err) {
    if (err && err.status) {
      const { status, message, ...rest } = err;
      return res.status(status).json({ error: message, ...rest });
    }
    console.error("provision/device error:", err);
    return res.status(500).json({ error: "Failed to provision device credentials" });
  }
});
