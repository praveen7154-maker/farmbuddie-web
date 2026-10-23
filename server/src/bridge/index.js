import { config } from "../config.js";
import { ensureSchema, startRetentionCleanup } from "./postgres.js";
import { ensureFarmConfigCacheSchema } from "./farmConfigCache.js";
import { connectBridge, publishCommand, setOtaStatusHandler, setDeviceReplyHandler } from "./mqttBridge.js";
import { ensureOtaSchema } from "./otaStore.js";
import { ensureAnnouncementSchema } from "./announcementStore.js";
import { ensureReportSchema } from "./reportStore.js";
import { ensureDistributorSchema } from "./distributorStore.js";
import { ensurePricingSchema } from "./pricingStore.js";
import { ensureAdminGateSchema } from "./adminGateStore.js";
import { TOKEN_PREFIX } from "./distributors.js";
import { auth } from "../firebaseAdmin.js";
import { startFarmerDocCacheRefresh, startOfflineSweep } from "./firestoreMirror.js";
import { attachLiveGateway } from "./liveGateway.js";
import { app, ota, broadcast, reports, distributors, eventLog } from "./server.js";

async function main() {
  await ensureSchema();
  await ensureFarmConfigCacheSchema();
  await ensureOtaSchema();
  await ensureAnnouncementSchema();
  await ensureReportSchema();
  await ensureDistributorSchema();
  await ensurePricingSchema();
  await ensureAdminGateSchema();
  setOtaStatusHandler(ota.handleOtaStatus);
  setDeviceReplyHandler(eventLog.handleResponse);
  startRetentionCleanup();
  broadcast.startScheduler();
  reports.startRollUp();
  startFarmerDocCacheRefresh();
  startOfflineSweep();
  connectBridge();

  // publishCommand is passed in rather than imported by liveGateway.js
  // itself - see that file's own doc comment on why (avoids a circular
  // import with mqttBridge.js, which imports broadcastToFarm from here).
  const httpServer = app.listen(config.bridgePort, "0.0.0.0", () => {
    console.log(`farmbuddie bridge API listening on :${config.bridgePort}`);
  });
  // Live channel: Firebase logins, or a distributor's session token.
  attachLiveGateway(httpServer, {
    publishCommand,
    authenticate: async (token) => {
      if (!token.startsWith(TOKEN_PREFIX)) return auth.verifyIdToken(token);
      const who = await distributors.authenticate(token);
      if (!who || who.mustChange) throw new Error("not a valid distributor session");
      return who;
    }
  });
}

main().catch((err) => {
  console.error("[bridge] fatal startup error:", err);
  process.exit(1);
});
