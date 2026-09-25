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
