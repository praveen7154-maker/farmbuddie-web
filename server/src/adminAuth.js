import { config } from "./config.js";

// Who counts as an admin (web panel / Irrigo Admin) on both servers.
//
// An email-authenticated Firebase login - farmers sign in by phone and
// carry no email. On its own that trusts anyone who can create an email
// account in the Firebase project, so set ADMIN_EMAILS in server/.env
// (comma-separated) and only those accounts are admins. Unset keeps the
// old "any email login" rule, with a warning at startup.
const allow = new Set(config.adminEmails.map((e) => e.toLowerCase()));
if (allow.size === 0) {
  console.warn("[auth] ADMIN_EMAILS is not set - ANY email login is treated as an admin. Set it in server/.env.");
}

export function isAdmin(decodedToken) {
  const email = typeof decodedToken?.email === "string" ? decodedToken.email.toLowerCase() : "";
  if (!email) return false;
  return allow.size === 0 || allow.has(email);
}

// Express middleware: 403 unless isAdmin().
export function requireAdmin(req, res, next) {
  if (!isAdmin(req.decodedToken)) return res.status(403).json({ error: "Admin identity required" });
  next();
}
