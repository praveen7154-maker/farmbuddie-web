import { API_BASE_URL } from "/js/config.js";
import { encryptRaw } from "/js/qrCrypto.js";

/**
 * Calls POST /provision/device — issues (or rotates) MQTT credentials for
 * a controller already assigned to a farmer. Shared by the onboarding
 * flows (auto-called right after a controller is assigned) and the
 * controller panel's manual Generate/Rotate button.
 */
export async function provisionDeviceCredentials(auth, controllerDocId, { rotate = false } = {}) {
  const idToken = await auth.currentUser.getIdToken();

  const res = await fetch(`${API_BASE_URL}/provision/device`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${idToken}`
    },
    body: JSON.stringify({ controllerDocId, rotate })
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }

  return data;
}

/**
 * Renders the credential + QR into the given container element. `data` is
 * provisionDeviceCredentials()'s return value. The credential is durably
 * stored (controllers/{id}.mqttPasswordPlaintext, farmers/{id}.controller.
 * mqtt.password - see deviceProvisioning.js) and this same function is
 * used both right after issue/rotate AND every time the farmer panel is
 * simply reopened - founders can look at or re-share it anytime, no
 * Rotate (which actually changes the password) needed just to view it.
 */
export async function renderMqttCredentialReveal(container, data) {
  container.innerHTML = `
    <div class="mqtt-reveal-box">
      <div class="mqtt-creds">
        <div><b>Broker:</b> ${data.brokerUrl}:${data.port}</div>
        <div><b>Client ID / Username:</b> ${data.username}</div>
        <div><b>Password:</b> ${data.password}</div>
      </div>
      <div class="mqtt-qr-row">
        <div class="mqtt-qr-visual">
          <canvas id="mqttQrCanvas"></canvas>
          <button id="mqttQrDownloadBtn" class="fb-btn-primary small" style="display:none;">
            ⬇ Download QR
          </button>
        </div>
        <div class="mqtt-qr-info">
          <div class="mqtt-qr-title">Scan for Irrigo Login</div>
          <div class="mqtt-qr-field"><span>Farm Buddie ID</span><b>${data.farmBuddieId || "-"}</b></div>
          <div class="mqtt-qr-field"><span>Farmer Name</span><b>${data.farmerName || "-"}</b></div>
          <div class="mqtt-qr-hint">Scan this with the Irrigo app to pair this device to the farmer's account.</div>
        </div>
      </div>
    </div>
  `;

  // Same JSON shape as irrigo-admin's model/FarmSetupPayload.kt (which the
  // farmer app's QR scanner decodes into), encrypted the same way (see
  // qrCrypto.js) — an already-provisioned scanning flow needs no changes
  // on the farmer app's side.
  const qrPayload = JSON.stringify({
    name: data.farmerName || "",
    mqtt_host: data.brokerUrl,
    mqtt_port: data.port,
    mqtt_username: data.username,
    mqtt_password: data.password,
    farm_id: data.farmId,
    node_id: data.nodeId
  });

  try {
    const encryptedBytes = await encryptRaw(qrPayload);
    const clampedBytes = new Uint8ClampedArray(encryptedBytes);
    const canvas = container.querySelector("#mqttQrCanvas");
    await QRCode.toCanvas(canvas, [{ data: clampedBytes, mode: "byte" }], { width: 220 });

    // Onboarding (office) and physical install (field) are usually
    // different people/visits — the QR has to travel between them
    // somehow, so give the office admin an image file to send over
    // WhatsApp/etc. rather than assuming they're standing at the device.
    // The downloaded file bakes in the same identity context shown
    // on-screen (Farm Buddie ID/farmer name) plus a confidentiality
    // notice, since once it leaves this panel (WhatsApp, email) there's
    // no surrounding page to carry that context anymore.
    const downloadBtn = container.querySelector("#mqttQrDownloadBtn");
    if (downloadBtn) {
      downloadBtn.style.display = "block";
      downloadBtn.onclick = () => {
        const composite = buildDownloadableQrImage(canvas, data);
        const link = document.createElement("a");
        link.download = `${data.username || "device"}-setup-qr.png`;
        link.href = composite.toDataURL("image/png");
        link.click();
      };
    }
  } catch (qrErr) {
    console.error("QR generation error:", qrErr);
  }
}

function wrapCanvasText(ctx, text, centerX, startY, maxWidth, lineHeight) {
  const words = text.split(" ");
  let line = "";
  let y = startY;
  for (const word of words) {
    const testLine = line ? `${line} ${word}` : word;
    if (ctx.measureText(testLine).width > maxWidth && line) {
      ctx.fillText(line, centerX, y);
      line = word;
      y += lineHeight;
    } else {
      line = testLine;
    }
  }
  if (line) ctx.fillText(line, centerX, y);
  return y;
}

/**
 * Composites the QR with the same identity context shown on-screen
 * (Farm Buddie ID, farmer name) and a confidentiality notice into one
 * self-contained image - the on-screen reveal has the surrounding panel
 * for that context, but a downloaded PNG shared over WhatsApp/email has
 * nothing else around it.
 */
function buildDownloadableQrImage(qrCanvas, data) {
  const W = 480;
  const H = 640;
  const QR_SIZE = 300;

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  const mono = "'SFMono-Regular', Consolas, monospace";

  ctx.fillStyle = "#0b1f14";
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = "center";

  ctx.fillStyle = "#ffffff";
  ctx.font = `bold 22px ${mono}`;
  ctx.fillText("Scan for Irrigo Login", W / 2, 46);

  const qrX = (W - QR_SIZE) / 2;
  const qrY = 70;
  ctx.drawImage(qrCanvas, qrX, qrY, QR_SIZE, QR_SIZE);

  let y = qrY + QR_SIZE + 42;
  ctx.font = `11px ${mono}`;
  ctx.fillStyle = "#6ee7b7";
  ctx.fillText("FARM BUDDIE ID", W / 2, y);
  y += 24;
  ctx.font = `bold 19px ${mono}`;
  ctx.fillStyle = "#ffffff";
  ctx.fillText(data.farmBuddieId || "-", W / 2, y);

  y += 36;
  ctx.font = `11px ${mono}`;
  ctx.fillStyle = "#6ee7b7";
  ctx.fillText("FARMER NAME", W / 2, y);
  y += 24;
  ctx.font = `bold 19px ${mono}`;
  ctx.fillStyle = "#ffffff";
  ctx.fillText(data.farmerName || "-", W / 2, y);

  ctx.fillStyle = "#fca5a5";
  ctx.font = `bold 14px ${mono}`;
  wrapCanvasText(ctx, "CONFIDENTIAL INFORMATION - DO NOT SHARE WITH OUTSIDERS", W / 2, H - 40, W - 60, 20);

  return canvas;
}

/**
 * Full-screen modal version of the reveal, for pages with no existing
 * side panel to render into (add-farm.html, farmer-onboarding.html).
 * Resolves once the admin dismisses it — the credential is durably
 * stored (see deviceProvisioning.js), so it's also viewable again later
 * from that farmer's panel in controller-database.html, not just here.
 */
export function showMqttCredentialModal(data) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.style.cssText =
      "position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:9999;" +
      "display:flex;align-items:center;justify-content:center;padding:20px;";

    const card = document.createElement("div");
    card.style.cssText =
      "background:#fff;border-radius:16px;padding:24px;max-width:420px;width:100%;" +
      "max-height:85vh;overflow-y:auto;";
    card.innerHTML = `<h3 style="margin-top:0;">📡 Device MQTT Credentials</h3><div id="mqttModalBody"></div>`;

    const continueBtn = document.createElement("button");
    continueBtn.textContent = "I've saved this — Continue";
    continueBtn.className = "fb-btn-primary";
    continueBtn.style.cssText = "margin-top:16px;width:100%;";
    continueBtn.onclick = () => {
      document.body.removeChild(overlay);
      resolve();
    };

    card.appendChild(continueBtn);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    renderMqttCredentialReveal(card.querySelector("#mqttModalBody"), data);
  });
}
