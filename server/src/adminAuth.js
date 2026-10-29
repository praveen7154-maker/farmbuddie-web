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

// /provision/device: the onboarding pages give a newly mapped controller its
// MQTT login right after the farm is saved - an active onboarding team
// member (isActive: teamAccess.js's isActiveOnboarding) may do that;
// changing (rotating) a device's password stays admin-only.
export function requireAdminOrOnboarding(isActive) {
  return async (req, res, next) => {
    if (isAdmin(req.decodedToken)) return next();
    try {
      if (await isActive(req.decodedToken)) {
        if (req.body?.rotate) return res.status(403).json({ error: "Only an admin can change a device's password" });
        return next();
      }
    } catch (err) {
      console.error("[team] onboarding access check failed:", err);
      return res.status(500).json({ error: "Couldn't check your access - try again" });
    }
    return res.status(403).json({ error: "Admin identity required" });
  };
}
