// The production team's sign-in on this browser (see server/src/bridge/
// production.js): an opaque session token from our server, not a Firebase
// login. Kept in localStorage so every tab of the Production page shares
// it; it ends at the server after 12 hours, on Sign out, or when the admin
// changes the password or switches the account off.
const KEY = "fb.prodSession";

export function saveStaffSession({ token, username, name, expiresInHours }) {
  const session = { token, username, name, expiresAt: Date.now() + (expiresInHours || 12) * 3600 * 1000 };
  try { localStorage.setItem(KEY, JSON.stringify(session)); } catch (e) { /* private mode */ }
}

/** { token, username, name, expiresAt } or null. */
export function staffSession() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || "null");
    if (s && s.token && s.expiresAt > Date.now()) return s;
  } catch (e) { /* none */ }
  return null;
}

export function clearStaffSession() {
  try { localStorage.removeItem(KEY); } catch (e) { /* private mode */ }
}

// An onboarding team member's sign-in is a Firebase one (a custom token our
// server made); this only remembers which team, for the menus
// (admin-shell.js) - the Firestore rules decide what they can really do.
const TEAM_KEY = "fb.team";

export function saveTeamSession({ team, username, name }) {
  try { localStorage.setItem(TEAM_KEY, JSON.stringify({ team, username, name })); } catch (e) { /* private mode */ }
}

export function clearTeamSession() {
  try { localStorage.removeItem(TEAM_KEY); } catch (e) { /* private mode */ }
}
