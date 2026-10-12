// Farm Buddie ID formats - one place for every page that makes an ID.
//
//   Distributor:     D26FBA0001   D + year (2 digits) + FB + series letter + 4-digit number
//   Farm Buddie ID:  FBC26A00001  FBC + year (2 digits) + series letter + 5-digit number
//
// The year is the year the record is created. The number keeps counting
// across years (counters/distributorCounter, counters/farmers), so an ID is
// unique even without its year; when the digits run out the series letter
// moves on (A9999 -> B0001). Older IDs (FB-DIST-0001, FARM-2026-0001) stay
// as they are - every page and the server match IDs as stored, never by
// their shape.

function seriesAndNumber(n, digits) {
  const per = 10 ** digits - 1;                 // 9999 / 99999 per series
  const series = Math.floor((n - 1) / per);
  if (series > 25) throw new Error("ID series exhausted");
  const number = ((n - 1) % per) + 1;
  return String.fromCharCode(65 + series) + String(number).padStart(digits, "0");
}

const yy = (date) => String(date.getFullYear()).slice(-2);

export function formatDistributorId(n, date = new Date()) {
  return `D${yy(date)}FB${seriesAndNumber(n, 4)}`;
}

export function formatFarmBuddieId(n, date = new Date()) {
  return `FBC${yy(date)}${seriesAndNumber(n, 5)}`;
}

// Takes the next number from counters/<name> inside a transaction, so two
// admins saving at the same moment never get the same one. A save that
// fails afterwards just leaves that number unused.
export async function claimNextNumber(db, runTransaction, counterRef) {
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(counterRef);
    const next = (snap.exists() ? snap.data().current || 0 : 0) + 1;
    tx.set(counterRef, { current: next }, { merge: true });
    return next;
  });
}
