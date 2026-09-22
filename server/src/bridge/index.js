import { config } from "../config.js";
import { ensureSchema, startRetentionCleanup } from "./postgres.js";
import { connectBridge } from "./mqttBridge.js";
import { startFarmerDocCacheRefresh } from "./firestoreMirror.js";
import { app } from "./server.js";

async function main() {
  await ensureSchema();
  startRetentionCleanup();
  startFarmerDocCacheRefresh();
  connectBridge();

  app.listen(config.bridgePort, "0.0.0.0", () => {
    console.log(`farmbuddie bridge API listening on :${config.bridgePort}`);
  });
}

main().catch((err) => {
  console.error("[bridge] fatal startup error:", err);
  process.exit(1);
});
