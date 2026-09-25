// A farm's Motor / TNEB configuration, as entered in the admin panel's
// onboarding / Add Farm / Edit pages (farmers/<doc>.motorConfig,
// tnebServices, pumpServiceMapping), normalized to numbers for the Irrigo
// app's TNEB load limit: a motor may start only while the running HP on its
// service, plus its own HP, stays within that service's sanctioned HP.
//
// The admin panel stores HP as option labels ("7.5 HP") and service numbers
// as select values ("2") - parsed here once so the app never has to.

const hpNumber = (v) => {
  const n = parseFloat(String(v ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
};
const intNumber = (v) => {
  const n = parseInt(String(v ?? "").replace(/\D/g, ""), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export function normalizeFarmElectrical(farmId, doc) {
  const motorCount = intNumber(doc?.motorConfig?.motorCount) || 0;
  const pumpHp = Array.isArray(doc?.motorConfig?.pumpHp) ? doc.motorConfig.pumpHp : [];
  const mapping = Array.isArray(doc?.pumpServiceMapping) ? doc.pumpServiceMapping : [];

  const pumps = [];
  for (let i = 1; i <= motorCount; i++) {
    const m = mapping.find((e) => intNumber(e?.pumpNumber) === i) || {};
    pumps.push({
      pumpNumber: i,
      hp: hpNumber(m.hp) ?? hpNumber(pumpHp[i - 1]),
      service: intNumber(m.service)
    });
  }

  const services = (Array.isArray(doc?.tnebServices?.services) ? doc.tnebServices.services : [])
    .map((s, i) => ({ serviceNumber: intNumber(s?.serviceNumber) || i + 1, sanctionedHp: hpNumber(s?.sanctionedHp) }));

  return {
    farmId,
    pumps: pumps.filter((p) => p.hp !== null && p.service !== null),
    services: services.filter((s) => s.sanctionedHp !== null)
  };
}

// ---- Pushing the configuration to the hub (Motor firmware's TnebLoadLimit) ----
// The hub keeps its own copy (NVS) and enforces the limit itself - including
// manual starts at a panel. Its health report carries "tneb_sig"; when that
// differs from the admin panel's configuration, the bridge sends
// set_tneb_config on the hub's motor/1/cmd topic.

// The hub stores at most this many of each (tneb_load_limit.h).
const HUB_MAX_ENTRIES = 4;

export function hubTnebConfig(cfg) {
  const services = [...(cfg?.services || [])].sort((a, b) => a.serviceNumber - b.serviceNumber).slice(0, HUB_MAX_ENTRIES);
  const pumps = [...(cfg?.pumps || [])].sort((a, b) => a.pumpNumber - b.pumpNumber).slice(0, HUB_MAX_ENTRIES);
  if (!services.length || !pumps.length) return { services: [], pumps: [] };
  return {
    services: services.map((s) => ({ n: s.serviceNumber, hp: s.sanctionedHp })),
    pumps: pumps.map((p) => ({ n: p.pumpNumber, hp: p.hp, service: p.service }))
  };
}

// Same string as the firmware's TnebLoadLimit::signature() - HP x10.
export function tnebSignature(hubCfg) {
  if (!hubCfg.services.length || !hubCfg.pumps.length) return "";
  const t = (hp) => Math.round(hp * 10);
  return hubCfg.services.map((s) => `S${s.n}=${t(s.hp)}`).join(",") + "|" +
    hubCfg.pumps.map((p) => `P${p.n}=${t(p.hp)}@${p.service}`).join(",");
}

export async function loadFarmElectrical(db, farmId) {
  const snap = await db.collection("farmers").where("controller.uniqueId", "==", farmId).limit(1).get();
  return snap.empty ? null : normalizeFarmElectrical(farmId, snap.docs[0].data());
}

// Called for every health message. Firmware without the load limit sends no
// tneb_sig - skipped. The same configuration is sent to a farm at most once
// per RESEND_MS (the hub's next health report shows whether it took).
export function createTnebSync({ loadConfig, publish, now = () => Date.now(), resendMs = 10 * 60 * 1000 }) {
  const lastSent = new Map(); // farmId -> { sig, at }
  return async function onHealth(farmId, nodeId, payload) {
    if (typeof payload?.tneb_sig !== "string") return;
    const cfg = await loadConfig(farmId);
    if (!cfg) return; // no farm record - leave the hub's copy alone
    const hubCfg = hubTnebConfig(cfg);
    const want = tnebSignature(hubCfg);
    if (payload.tneb_sig === want) {
      lastSent.delete(farmId);
      return;
    }
    const prev = lastSent.get(farmId);
    if (prev && prev.sig === want && now() - prev.at < resendMs) return;
    lastSent.set(farmId, { sig: want, at: now() });
    await publish(`farm/${farmId}/${nodeId}/motor/1/cmd`, { cmd: "set_tneb_config", id: now(), tneb: hubCfg });
    console.log(`[tneb] farm ${farmId}: hub had "${payload.tneb_sig}", sent "${want}"`);
  };
}
