import { config } from "../config.js";
import { ensureSchema, startRetentionCleanup } from "./postgres.js";
import { ensureFarmConfigCacheSchema } from "./farmConfigCache.js";
import { connectBridge, publishCommand, setOtaStatusHandler } from "./mqttBridge.js";
import { ensureOtaSchema } from "./otaStore.js";
import { startFarmerDocCacheRefresh } from "./firestoreMirror.js";
import { attachLiveGateway } from "./liveGateway.js";
import { app, ota } from "./server.js";

async function main() {
  await ensureSchema();
  await ensureFarmConfigCacheSchema();
  await ensureOtaSchema();
  setOtaStatusHandler(ota.handleOtaStatus);
  startRetentionCleanup();
  startFarmerDocCacheRefresh();
  connectBridge();

  // publishCommand is passed in rather than imported by liveGateway.js
  // itself - see that file's own doc comment on why (avoids a circular
  // import with mqttBridge.js, which imports broadcastToFarm from here).
  const httpServer = app.listen(config.bridgePort, "0.0.0.0", () => {
    console.log(`farmbuddie bridge API listening on :${config.bridgePort}`);
  });
  attachLiveGateway(httpServer, { publishCommand });
}

main().catch((err) => {
  console.error("[bridge] fatal startup error:", err);
  process.exit(1);
});
