// Admin console shell, on every admin page (with /css/admin-shell.css and
// /css/theme-dark.generated.css):
//  - light / dark theme and Modern / Classic view, remembered in this
//    browser and applied here, in <head>, before the page first paints
//  - the top header: brand, Home, breadcrumbs, module launcher, search
//    (Ctrl+K), theme toggle, view switch, the signed-in admin, Sign out
//  - Modern view hides the sidebar (the header reaches every module);
//    Classic keeps the sidebar exactly as it was, plus a Home link
// It only adds UI around each page: the pages' own scripts, their auth
// checks and their Firestore calls are untouched. Sign out does what the
// sidebar's Logout does (signOut, then /login.html).
//
// Icons: Lucide (lucide.dev), ISC licence - inlined below.
(function () {
  "use strict";

  var KEY_THEME = "fb.theme", KEY_VIEW = "fb.view", KEY_RECENT = "fb.recent", KEY_FROM = "fb.from:";
  var FIREBASE_AUTH = "https://www.gstatic.com/firebasejs/12.8.0/firebase-auth.js";
  var HOME = "/admin/home.html";
  var root = document.documentElement;

  // A production team member signed in (login page -> production-session.js)
  // and on the Production page: the header shows that module only - no
  // Home, no other modules, no sidebar. (Their sign-in only works on our
  // server's /production routes anyway; every other page needs an admin.)
  var STAFF = (function () {
    if (!/\/admin\/production(\.html)?$/.test(location.pathname)) return null;
    try {
      var s = JSON.parse(localStorage.getItem("fb.prodSession") || "null");
      return s && s.token && s.expiresAt > Date.now() ? s : null;
    } catch (e) { return null; }
  })();
  if (STAFF) {
    HOME = "/admin/production.html";
    root.classList.add("fbx-staff");
  }

  // An onboarding team member (User Roles; signed in on the login page with
  // a username - a Firebase sign-in our server made, with no email): the
  // farmer pages only. The Firestore rules are what really keep them out of
  // everything else; this keeps the menus to what they can use, and any
  // other page sends them back to Farmer Onboarding.
  var TEAM_PAGES = ["farmer-onboarding", "farmer-database", "add-farm", "farmer-edit", "farmer-view"];
  var TEAM = STAFF ? null : (function () {
    try {
      var t = JSON.parse(localStorage.getItem("fb.team") || "null");
      return t && t.team === "onboarding" ? t : null;
    } catch (e) { return null; }
  })();
  var LEAVING = false;      // on the way to another page: build nothing here
  if (TEAM) {
    HOME = "/admin/farmer-onboarding.html";
    root.classList.add("fbx-team");
    var page = (/\/admin\/?([^\/?#]*?)(?:\.html)?$/.exec(location.pathname) || [])[1];
    if (page !== undefined && TEAM_PAGES.indexOf(page || "index") < 0) {
      LEAVING = true;
      root.style.visibility = "hidden";
      location.replace(HOME);
    }
  }

  function load(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function save(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  function sload(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssave(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* private mode */ } }

  var darkQuery = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  var reduceMotion = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;

  function themePref() {
    var t = load(KEY_THEME);
    if (t === "dark" || t === "light") return t;
    return darkQuery && darkQuery.matches ? "dark" : "light";
  }
  function viewPref() { return !STAFF && !TEAM && load(KEY_VIEW) === "classic" ? "classic" : "modern"; }

  function applyPrefs() {
    root.setAttribute("data-theme", themePref());
    root.setAttribute("data-view", viewPref());
  }
  applyPrefs();   // now, before <body> exists - no flash of the wrong theme

  // ---------------------------------------------------------------- icons
  var ICONS = {
    "trash-2": "<path d=\"M3 6h18\"/> <path d=\"M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6\"/> <path d=\"M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2\"/> <line x1=\"10\" x2=\"10\" y1=\"11\" y2=\"17\"/> <line x1=\"14\" x2=\"14\" y1=\"11\" y2=\"17\"/>",
    "fan": "<path d=\"M10.827 16.379a6.082 6.082 0 0 1-8.618-7.002l5.412 1.45a6.082 6.082 0 0 1 7.002-8.618l-1.45 5.412a6.082 6.082 0 0 1 8.618 7.002l-5.412-1.45a6.082 6.082 0 0 1-7.002 8.618l1.45-5.412Z\"/> <path d=\"M12 12v.01\"/>",
    "droplet": "<path d=\"M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z\"/>",
    "valve-disc": "<circle cx=\"12\" cy=\"12\" r=\"9\"/> <path d=\"M7 17 17 7\"/> <path d=\"M2 12h1M21 12h1\"/>",
    "filter": "<path d=\"M10 20a1 1 0 0 0 .553.895l2 1A1 1 0 0 0 14 21v-7a2 2 0 0 1 .517-1.341L21.74 4.67A1 1 0 0 0 21 3H3a1 1 0 0 0-.742 1.67l7.225 7.989A2 2 0 0 1 10 14z\"/>",
    "flask-conical": "<path d=\"M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2\"/> <path d=\"M8.5 2h7\"/> <path d=\"M7 16h10\"/>",
    "waves": "<path d=\"M2 6c.6.5 1.2 1 2.5 1C7 7 7 5 9.5 5c2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1\"/> <path d=\"M2 12c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1\"/> <path d=\"M2 18c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1\"/>",
    "network": "<rect x=\"16\" y=\"16\" width=\"6\" height=\"6\" rx=\"1\"/> <rect x=\"2\" y=\"16\" width=\"6\" height=\"6\" rx=\"1\"/> <rect x=\"9\" y=\"2\" width=\"6\" height=\"6\" rx=\"1\"/> <path d=\"M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3\"/> <path d=\"M12 12V8\"/>",
    "qr-code": "<rect width=\"5\" height=\"5\" x=\"3\" y=\"3\" rx=\"1\"/> <rect width=\"5\" height=\"5\" x=\"16\" y=\"3\" rx=\"1\"/> <rect width=\"5\" height=\"5\" x=\"3\" y=\"16\" rx=\"1\"/> <path d=\"M21 16h-3a2 2 0 0 0-2 2v3\"/> <path d=\"M21 21v.01\"/> <path d=\"M12 7v3a2 2 0 0 1-2 2H7\"/> <path d=\"M3 12h.01\"/> <path d=\"M12 3h.01\"/> <path d=\"M12 16v.01\"/> <path d=\"M16 12h1\"/> <path d=\"M21 12v.01\"/> <path d=\"M12 21v-1\"/>",
    "package": "<path d=\"M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z\"/> <path d=\"M12 22V12\"/> <path d=\"m3.3 7 7.703 4.734a2 2 0 0 0 2.004 0L20.7 7\"/> <path d=\"m7.5 4.27 9 5.15\"/>",
    "arrow-right": "<path d=\"M5 12h14\"/> <path d=\"m12 5 7 7-7 7\"/>",
    "building-2": "<path d=\"M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z\"/> <path d=\"M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2\"/> <path d=\"M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2\"/> <path d=\"M10 6h4\"/> <path d=\"M10 10h4\"/> <path d=\"M10 14h4\"/> <path d=\"M10 18h4\"/>",
    "calendar": "<path d=\"M8 2v4\"/> <path d=\"M16 2v4\"/> <rect width=\"18\" height=\"18\" x=\"3\" y=\"4\" rx=\"2\"/> <path d=\"M3 10h18\"/>",
    "chart-line": "<path d=\"M3 3v16a2 2 0 0 0 2 2h16\"/> <path d=\"m19 9-5 5-4-4-3 3\"/>",
    "check": "<path d=\"M20 6 9 17l-5-5\"/>",
    "chevron-left": "<path d=\"m15 18-6-6 6-6\"/>",
    "chevron-right": "<path d=\"m9 18 6-6-6-6\"/>",
    "circle-alert": "<circle cx=\"12\" cy=\"12\" r=\"10\"/> <line x1=\"12\" x2=\"12\" y1=\"8\" y2=\"12\"/> <line x1=\"12\" x2=\"12.01\" y1=\"16\" y2=\"16\"/>",
    "circle-check": "<circle cx=\"12\" cy=\"12\" r=\"10\"/> <path d=\"m9 12 2 2 4-4\"/>",
    "circle-user": "<circle cx=\"12\" cy=\"12\" r=\"10\"/> <circle cx=\"12\" cy=\"10\" r=\"3\"/> <path d=\"M7 20.662V19a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v1.662\"/>",
    "clock": "<circle cx=\"12\" cy=\"12\" r=\"10\"/> <polyline points=\"12 6 12 12 16 14\"/>",
    "command": "<path d=\"M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3\"/>",
    "copy": "<rect width=\"14\" height=\"14\" x=\"8\" y=\"8\" rx=\"2\" ry=\"2\"/> <path d=\"M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2\"/>",
    "cpu": "<rect width=\"16\" height=\"16\" x=\"4\" y=\"4\" rx=\"2\"/> <rect width=\"6\" height=\"6\" x=\"9\" y=\"9\" rx=\"1\"/> <path d=\"M15 2v2\"/> <path d=\"M15 20v2\"/> <path d=\"M2 15h2\"/> <path d=\"M2 9h2\"/> <path d=\"M20 15h2\"/> <path d=\"M20 9h2\"/> <path d=\"M9 2v2\"/> <path d=\"M9 20v2\"/>",
    "download": "<path d=\"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4\"/> <polyline points=\"7 10 12 15 17 10\"/> <line x1=\"12\" x2=\"12\" y1=\"15\" y2=\"3\"/>",
    "eye": "<path d=\"M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0\"/> <circle cx=\"12\" cy=\"12\" r=\"3\"/>",
    "eye-off": "<path d=\"M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49\"/> <path d=\"M14.084 14.158a3 3 0 0 1-4.242-4.242\"/> <path d=\"M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143\"/> <path d=\"m2 2 20 20\"/>",
    "factory": "<path d=\"M2 20a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8l-7 5V8l-7 5V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z\"/> <path d=\"M17 18h1\"/> <path d=\"M12 18h1\"/> <path d=\"M7 18h1\"/>",
    "hash": "<line x1=\"4\" x2=\"20\" y1=\"9\" y2=\"9\"/> <line x1=\"4\" x2=\"20\" y1=\"15\" y2=\"15\"/> <line x1=\"10\" x2=\"8\" y1=\"3\" y2=\"21\"/> <line x1=\"16\" x2=\"14\" y1=\"3\" y2=\"21\"/>",
    "house": "<path d=\"M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8\"/> <path d=\"M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z\"/>",
    "indian-rupee": "<path d=\"M6 3h12\"/> <path d=\"M6 8h12\"/> <path d=\"m6 13 8.5 8\"/> <path d=\"M6 13h3\"/> <path d=\"M9 13c6.667 0 6.667-10 0-10\"/>",
    "key-round": "<path d=\"M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z\"/> <circle cx=\"16.5\" cy=\"7.5\" r=\".5\" fill=\"currentColor\"/>",
    "layout-dashboard": "<rect width=\"7\" height=\"9\" x=\"3\" y=\"3\" rx=\"1\"/> <rect width=\"7\" height=\"5\" x=\"14\" y=\"3\" rx=\"1\"/> <rect width=\"7\" height=\"9\" x=\"14\" y=\"12\" rx=\"1\"/> <rect width=\"7\" height=\"5\" x=\"3\" y=\"16\" rx=\"1\"/>",
    "layout-grid": "<rect width=\"7\" height=\"7\" x=\"3\" y=\"3\" rx=\"1\"/> <rect width=\"7\" height=\"7\" x=\"14\" y=\"3\" rx=\"1\"/> <rect width=\"7\" height=\"7\" x=\"14\" y=\"14\" rx=\"1\"/> <rect width=\"7\" height=\"7\" x=\"3\" y=\"14\" rx=\"1\"/>",
    "leaf": "<path d=\"M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z\"/> <path d=\"M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12\"/>",
    "list-checks": "<path d=\"m3 17 2 2 4-4\"/> <path d=\"m3 7 2 2 4-4\"/> <path d=\"M13 6h8\"/> <path d=\"M13 12h8\"/> <path d=\"M13 18h8\"/>",
    "lock": "<rect width=\"18\" height=\"11\" x=\"3\" y=\"11\" rx=\"2\" ry=\"2\"/> <path d=\"M7 11V7a5 5 0 0 1 10 0v4\"/>",
    "log-out": "<path d=\"M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4\"/> <polyline points=\"16 17 21 12 16 7\"/> <line x1=\"21\" x2=\"9\" y1=\"12\" y2=\"12\"/>",
    "megaphone": "<path d=\"m3 11 18-5v12L3 14v-3z\"/> <path d=\"M11.6 16.8a3 3 0 1 1-5.8-1.6\"/>",
    "microchip": "<path d=\"M18 12h2\"/> <path d=\"M18 16h2\"/> <path d=\"M18 20h2\"/> <path d=\"M18 4h2\"/> <path d=\"M18 8h2\"/> <path d=\"M4 12h2\"/> <path d=\"M4 16h2\"/> <path d=\"M4 20h2\"/> <path d=\"M4 4h2\"/> <path d=\"M4 8h2\"/> <path d=\"M8 2a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2h-1.5c-.276 0-.494.227-.562.495a2 2 0 0 1-3.876 0C9.994 2.227 9.776 2 9.5 2z\"/>",
    "minus": "<path d=\"M5 12h14\"/>",
    "monitor": "<rect width=\"20\" height=\"14\" x=\"2\" y=\"3\" rx=\"2\"/> <line x1=\"8\" x2=\"16\" y1=\"21\" y2=\"21\"/> <line x1=\"12\" x2=\"12\" y1=\"17\" y2=\"21\"/>",
    "moon": "<path d=\"M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z\"/>",
    "panel-left": "<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\"/> <path d=\"M9 3v18\"/>",
    "plus": "<path d=\"M5 12h14\"/> <path d=\"M12 5v14\"/>",
    "power": "<path d=\"M12 2v10\"/> <path d=\"M18.4 6.6a9 9 0 1 1-12.77.04\"/>",
    "printer": "<path d=\"M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2\"/> <path d=\"M6 9V3a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v6\"/> <rect x=\"6\" y=\"14\" width=\"12\" height=\"8\" rx=\"1\"/>",
    "refresh-cw": "<path d=\"M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8\"/> <path d=\"M21 3v5h-5\"/> <path d=\"M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16\"/> <path d=\"M8 16H3v5\"/>",
    "rocket": "<path d=\"M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z\"/> <path d=\"m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z\"/> <path d=\"M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0\"/> <path d=\"M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5\"/>",
    "scan-line": "<path d=\"M3 7V5a2 2 0 0 1 2-2h2\"/> <path d=\"M17 3h2a2 2 0 0 1 2 2v2\"/> <path d=\"M21 17v2a2 2 0 0 1-2 2h-2\"/> <path d=\"M7 21H5a2 2 0 0 1-2-2v-2\"/> <path d=\"M7 12h10\"/>",
    "scroll-text": "<path d=\"M15 12h-5\"/> <path d=\"M15 8h-5\"/> <path d=\"M19 17V5a2 2 0 0 0-2-2H4\"/> <path d=\"M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3\"/>",
    "search": "<circle cx=\"11\" cy=\"11\" r=\"8\"/> <path d=\"m21 21-4.3-4.3\"/>",
    "server": "<rect width=\"20\" height=\"8\" x=\"2\" y=\"2\" rx=\"2\" ry=\"2\"/> <rect width=\"20\" height=\"8\" x=\"2\" y=\"14\" rx=\"2\" ry=\"2\"/> <line x1=\"6\" x2=\"6.01\" y1=\"6\" y2=\"6\"/> <line x1=\"6\" x2=\"6.01\" y1=\"18\" y2=\"18\"/>",
    "sparkles": "<path d=\"M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z\"/> <path d=\"M20 3v4\"/> <path d=\"M22 5h-4\"/> <path d=\"M4 17v2\"/> <path d=\"M5 18H3\"/>",
    "sun": "<circle cx=\"12\" cy=\"12\" r=\"4\"/> <path d=\"M12 2v2\"/> <path d=\"M12 20v2\"/> <path d=\"m4.93 4.93 1.41 1.41\"/> <path d=\"m17.66 17.66 1.41 1.41\"/> <path d=\"M2 12h2\"/> <path d=\"M20 12h2\"/> <path d=\"m6.34 17.66-1.41 1.41\"/> <path d=\"m19.07 4.93-1.41 1.41\"/>",
    "triangle-alert": "<path d=\"m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3\"/> <path d=\"M12 9v4\"/> <path d=\"M12 17h.01\"/>",
    "upload": "<path d=\"M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4\"/> <polyline points=\"17 8 12 3 7 8\"/> <line x1=\"12\" x2=\"12\" y1=\"3\" y2=\"15\"/>",
    "user-cog": "<circle cx=\"18\" cy=\"15\" r=\"3\"/> <circle cx=\"9\" cy=\"7\" r=\"4\"/> <path d=\"M10 15H6a4 4 0 0 0-4 4v2\"/> <path d=\"m21.7 16.4-.9-.3\"/> <path d=\"m15.2 13.9-.9-.3\"/> <path d=\"m16.6 18.7.3-.9\"/> <path d=\"m19.1 12.2.3-.9\"/> <path d=\"m19.6 18.7-.4-1\"/> <path d=\"m16.8 12.3-.4-1\"/> <path d=\"m14.3 16.6 1-.4\"/> <path d=\"m20.7 13.8 1-.4\"/>",
    "user-plus": "<path d=\"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2\"/> <circle cx=\"9\" cy=\"7\" r=\"4\"/> <line x1=\"19\" x2=\"19\" y1=\"8\" y2=\"14\"/> <line x1=\"22\" x2=\"16\" y1=\"11\" y2=\"11\"/>",
    "users": "<path d=\"M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2\"/> <circle cx=\"9\" cy=\"7\" r=\"4\"/> <path d=\"M22 21v-2a4 4 0 0 0-3-3.87\"/> <path d=\"M16 3.13a4 4 0 0 1 0 7.75\"/>",
    "wand-sparkles": "<path d=\"m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72\"/> <path d=\"m14 7 3 3\"/> <path d=\"M5 6v4\"/> <path d=\"M19 14v4\"/> <path d=\"M10 2v2\"/> <path d=\"M7 8H3\"/> <path d=\"M21 16h-4\"/> <path d=\"M11 3H9\"/>",
    "x": "<path d=\"M18 6 6 18\"/> <path d=\"m6 6 12 12\"/>"
  };
  function icon(name, cls) {
    return '<svg class="fbx-i' + (cls ? " " + cls : "") + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
      (ICONS[name] || "") + "</svg>";
  }

  // -------------------------------------------------------------- modules
  // Every menu of the sidebar (same pages, same order within each group).
  var MODULES = [
    { id: "index", label: "Dashboard", icon: "layout-dashboard", group: "Overview",
      desc: "Live overview of farmers, controllers and alerts", tone: "green" },
    { id: "analytics", label: "Analytics", icon: "chart-line", group: "Overview",
      desc: "Device analytics, live status and control", tone: "teal" },
    { id: "farmer-onboarding", label: "Farmer Onboarding", icon: "user-plus", group: "Farmers",
      desc: "Register new farmers, farms and devices", tone: "lime" },
    { id: "farmer-database", label: "Farmer Database", icon: "users", group: "Farmers",
      desc: "Search, view and edit farmer records", tone: "green" },
    { id: "controller-database", label: "MCU / Controller", icon: "cpu", group: "Devices",
      desc: "Controller inventory, uploads and assignment", tone: "sky" },
    { id: "ota", label: "Firmware OTA", icon: "rocket", group: "Devices",
      desc: "Signed firmware uploads and rollouts", tone: "violet" },
    { id: "production", label: "Production", icon: "factory", group: "Devices",
      desc: "Daily MCU and node entry, labels, SIM and node stock", tone: "lime" },
    { id: "event-log", label: "Event Log", icon: "scroll-text", group: "Devices",
      desc: "Device events, faults and history", tone: "amber" },
    { id: "distributor-database", label: "Distributor Database", icon: "building-2", group: "Business",
      desc: "Distributors, onboarding and details", tone: "teal" },
    { id: "broadcast", label: "Message Broadcast", icon: "megaphone", group: "Business",
      desc: "Send announcements to farmers", tone: "rose" },
    { id: "pricing", label: "Module Pricing", icon: "indian-rupee", group: "Business",
      desc: "Prices for modules and add-ons", tone: "amber" },
    { id: "vps-status", label: "VPS & TBMQ", icon: "server", group: "System",
      desc: "Server, bridge and MQTT broker health", tone: "sky" },
    { id: "user-roles", label: "User Roles", icon: "user-cog", group: "System",
      desc: "Production and onboarding team accounts", tone: "violet" }
  ];
  if (STAFF) MODULES = MODULES.filter(function (m) { return m.id === "production"; });
  if (TEAM) MODULES = MODULES.filter(function (m) { return m.id === "farmer-onboarding" || m.id === "farmer-database"; });
  var BY_ID = {};
  MODULES.forEach(function (m) { m.href = "/admin/" + m.id + ".html"; BY_ID[m.id] = m; });

  // Pages reached from a module: which module they belong to. "from" lists
  // the modules that also link here - when the admin came from one of those,
  // the breadcrumb leads back there instead.
  var SUBPAGES = {
    "farmer-view": { parent: "farmer-database", from: ["farmer-onboarding", "index", "analytics"] },
    "farmer-edit": { parent: "farmer-database", from: [] },
    "add-farm": { parent: "farmer-database", from: ["controller-database", "farmer-onboarding", "index"] },
    "device-view": { parent: "analytics", from: ["farmer-database", "controller-database", "event-log", "index", "ota"] },
    "controller-view": { parent: "controller-database", from: ["farmer-database", "analytics", "index"] },
    "distributor-view": { parent: "distributor-database", from: [] },
    "distributor-edit": { parent: "distributor-database", from: [] },
    "distributor-onboarding": { parent: "distributor-database", from: [] },
    "phone-auth": { parent: null, from: [] }
  };

  function pageId(path) {
    var m = /\/admin\/?([^\/?#]*?)(?:\.html)?$/.exec(path || "");
    if (!m) return null;
    return m[1] || "index";
  }
  var here = pageId(location.pathname);
  var isHome = here === "home";

  // The page's own heading, without its emoji ("📋 Farmer Database").
  function pageLabel() {
    var h = document.querySelector(".fb-topbar h1");
    var t = h ? h.textContent : document.title.split("|")[0];
    t = t.replace(/^[^\p{L}\p{N}]+/u, "").trim();
    return t || "Page";
  }

  function parentOf(id) {
    var sub = SUBPAGES[id];
    if (!sub) return null;
    var from = null;
    try {
      var ref = document.referrer ? new URL(document.referrer) : null;
      if (ref && ref.origin === location.origin) from = pageId(ref.pathname);
    } catch (e) { /* no referrer */ }
    if (from && BY_ID[from] && (from === sub.parent || sub.from.indexOf(from) >= 0)) {
      ssave(KEY_FROM + id, from);
    } else if (from && SUBPAGES[from]) {
      // from another sub-page (farmer-view -> farmer-edit): same trail as it
      var prev = sload(KEY_FROM + from) || SUBPAGES[from].parent;
      if (prev && (prev === sub.parent || sub.from.indexOf(prev) >= 0)) ssave(KEY_FROM + id, prev);
    }
    var saved = sload(KEY_FROM + id);
    if (saved && BY_ID[saved] && (saved === sub.parent || sub.from.indexOf(saved) >= 0)) return BY_ID[saved];
    return sub.parent ? BY_ID[sub.parent] : null;
  }

  function currentModule() {
    if (BY_ID[here]) return BY_ID[here];
    return parentOf(here);
  }

  function recordRecent() {
    if (!BY_ID[here]) return;
    var list = [];
    try { list = JSON.parse(load(KEY_RECENT) || "[]"); } catch (e) { list = []; }
    if (!Array.isArray(list)) list = [];
    list = [here].concat(list.filter(function (x) { return x !== here && BY_ID[x]; })).slice(0, 6);
    save(KEY_RECENT, JSON.stringify(list));
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // ------------------------------------------------------------- firebase
  // The same /js/firebase-init.js the page itself imports - one Firebase app.
  var authApi = null;
  function firebase() {
    if (!authApi) {
      authApi = Promise.all([import("/js/firebase-init.js"), import(FIREBASE_AUTH)])
        .then(function (r) { return { auth: r[0].auth, mod: r[1] }; });
    }
    return authApi;
  }

  function signOutNow(btn) {
    if (btn) btn.disabled = true;
    if (STAFF) {
      // End the session on our server too, then forget it here.
      var done = function () {
        try { localStorage.removeItem("fb.prodSession"); } catch (e) { /* private mode */ }
        window.location.replace("/login.html");
      };
      import("/js/config.js").then(function (c) {
        return fetch(c.BRIDGE_BASE_URL + "/production/logout", { method: "POST", headers: { Authorization: "Bearer " + STAFF.token } });
      }).then(done, done);
      return;
    }
    firebase().then(function (f) { return f.mod.signOut(f.auth); })
      .then(function () {
        try { localStorage.removeItem("fb.team"); } catch (e) { /* private mode */ }
        window.location.replace("/login.html");
      })
      .catch(function (err) {
        if (btn) btn.disabled = false;
        console.error("Sign out failed:", err);
        alert("Sign out failed: " + (err && err.message ? err.message : err));
      });
  }

  // ---------------------------------------------------------- theme, view
  function transition(update, origin) {
    var animate = document.startViewTransition && !(reduceMotion && reduceMotion.matches);
    if (!animate) { update(); return; }
    if (origin) {
      var r = origin.getBoundingClientRect();
      var x = r.left + r.width / 2, y = r.top + r.height / 2;
      var far = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
      root.style.setProperty("--fbx-x", x + "px");
      root.style.setProperty("--fbx-y", y + "px");
      root.style.setProperty("--fbx-r", far + "px");
      root.classList.add("fbx-reveal");
    }
    var vt = document.startViewTransition(update);
    quiet(vt);
    vt.finished.then(done, done);
    function done() { root.classList.remove("fbx-reveal"); }
  }

  // A transition that gets skipped (another one starts, the page navigates
  // away mid-way) rejects its promises - expected, not an error.
  function quiet(vt) {
    if (!vt) return;
    [vt.ready, vt.finished, vt.updateCallbackDone].forEach(function (p) { if (p) p.catch(function () {}); });
  }
  // the same for the page-to-page fade (@view-transition in admin-shell.css)
  window.addEventListener("pagereveal", function (e) { quiet(e.viewTransition); });
  window.addEventListener("pageswap", function (e) {
    if (!e.viewTransition) return;
    quiet(e.viewTransition);
    // A page sending the admin straight on (no id -> back to its list) is
    // left without a fade - Chrome aborts that one with an error.
    if (performance.now() < 1500) e.viewTransition.skipTransition();
  });

  function setTheme(theme, origin) {
    transition(function () {
      root.setAttribute("data-theme", theme);
      save(KEY_THEME, theme);
      syncControls();
    }, origin);
  }

  function setView(view) {
    transition(function () {
      root.setAttribute("data-view", view);
      save(KEY_VIEW, view);
      document.body.classList.remove("fb-nav-open");
      syncControls();
    });
  }

  function toggleTheme(origin) {
    setTheme(root.getAttribute("data-theme") === "dark" ? "light" : "dark", origin);
  }

  // Another tab changed a preference, or this page came back from the
  // back/forward cache after another page changed one.
  window.addEventListener("storage", function (e) {
    if (e.key === KEY_THEME || e.key === KEY_VIEW || e.key === null) { applyPrefs(); syncControls(); }
  });
  window.addEventListener("pageshow", function () { applyPrefs(); syncControls(); });
  if (darkQuery && darkQuery.addEventListener) {
    darkQuery.addEventListener("change", function () {
      if (!load(KEY_THEME)) { applyPrefs(); syncControls(); }
    });
  }

  // ---------------------------------------------------------------- header
  var header, launcher, profileMenu, palette;

  function crumbsHtml() {
    if (STAFF) return '<li><span aria-current="page">' + icon("factory") + "<span>Production</span></span></li>";
    var trail = [{ label: "Home", href: HOME, icon: "house" }];
    if (!isHome) {
      var mod = BY_ID[here];
      if (mod) {
        trail.push({ label: mod.label });
      } else {
        var parent = parentOf(here);
        if (parent) trail.push({ label: parent.label, href: parent.href });
        trail.push({ label: pageLabel() });
      }
    }
    return trail.map(function (c, i) {
      var last = i === trail.length - 1;
      var inner = (c.icon ? icon(c.icon) : "") + "<span>" + esc(c.label) + "</span>";
      var item = c.href && !last
        ? '<a href="' + c.href + '">' + inner + "</a>"
        : '<span aria-current="page">' + inner + "</span>";
      return "<li>" + (i ? icon("chevron-right", "fbx-sep") : "") + item + "</li>";
    }).join("");
  }

  function launcherHtml() {
    var cur = currentModule();
    var groups = [];
    MODULES.forEach(function (m) { if (groups.indexOf(m.group) < 0) groups.push(m.group); });
    return '<div class="fbx-pop-head"><span>All modules</span><a href="' + HOME + '">' + icon("house") + "Home</a></div>" +
      groups.map(function (g) {
        return '<div class="fbx-pop-group"><div class="fbx-pop-label">' + g + '</div><div class="fbx-pop-grid">' +
          MODULES.filter(function (m) { return m.group === g; }).map(function (m) {
            return '<a class="fbx-tile' + (cur === m ? " is-current" : "") + '" data-tone="' + m.tone + '" href="' + m.href + '">' +
              '<span class="fbx-tile-ic">' + icon(m.icon) + "</span><span>" + esc(m.label) + "</span></a>";
          }).join("") + "</div></div>";
      }).join("");
  }

  function buildHeader() {
    var mac = /Mac|iPhone|iPad/.test(navigator.platform || "");
    header = document.createElement("header");
    header.className = "fbx-header";
    header.innerHTML =
      '<div class="fbx-left">' +
        '<a class="fbx-brand" href="' + HOME + '" title="Farm Buddie - Home">' +
          '<span class="fbx-logo"><img src="/assets/logo_icon.png" alt="" width="28" height="28"></span>' +
          '<span class="fbx-brand-txt"><b>Farm Buddie</b><small>Admin Console</small></span>' +
        "</a>" +
        '<nav class="fbx-crumbs" aria-label="Breadcrumb"><ol>' + crumbsHtml() + "</ol></nav>" +
      "</div>" +
      '<div class="fbx-right">' +
        '<button type="button" class="fbx-search" data-act="palette" aria-label="Search modules">' +
          icon("search") + "<span>Search modules…</span><kbd>" + (mac ? "⌘" : "Ctrl") + " K</kbd></button>" +
        '<a class="fbx-ibtn" href="' + HOME + '" title="Home" aria-label="Home"' + (isHome ? ' aria-current="page"' : "") + ">" + icon("house") + "</a>" +
        '<div class="fbx-pop-wrap">' +
          '<button type="button" class="fbx-ibtn" data-act="launcher" title="All modules" aria-label="All modules" aria-haspopup="true" aria-expanded="false">' + icon("layout-grid") + "</button>" +
          '<div class="fbx-pop fbx-launcher" role="menu" hidden>' + launcherHtml() + "</div>" +
        "</div>" +
        '<button type="button" class="fbx-ibtn fbx-theme" data-act="theme" title="Toggle theme" aria-label="Toggle light / dark theme">' +
          icon("sun", "fbx-sun") + icon("moon", "fbx-moon") + "</button>" +
        '<div class="fbx-seg" role="group" aria-label="Layout">' +
          '<button type="button" data-set-view="modern" title="Modern view - icon cards, no sidebar">' + icon("layout-grid") + "<span>Modern</span></button>" +
          '<button type="button" data-set-view="classic" title="Classic view - the sidebar menu">' + icon("panel-left") + "<span>Classic</span></button>" +
        "</div>" +
        '<div class="fbx-pop-wrap">' +
          '<button type="button" class="fbx-profile" data-act="profile" aria-haspopup="true" aria-expanded="false" aria-label="Admin profile">' +
            '<span class="fbx-avatar">A</span><span class="fbx-who"><b>Admin</b><small class="fbx-email">Signed in</small></span>' +
          "</button>" +
          '<div class="fbx-pop fbx-profile-menu" role="menu" hidden>' +
            '<div class="fbx-pm-user"><span class="fbx-avatar fbx-avatar-lg">A</span><div><b>Administrator</b><small class="fbx-email">Signed in</small></div></div>' +
            '<div class="fbx-pm-row"><span>' + icon("sun") + 'Theme</span><button type="button" class="fbx-switch" data-act="theme" role="switch" aria-label="Dark theme"><i></i></button></div>' +
            '<div class="fbx-pm-row"><span>' + icon("panel-left") + 'Layout</span><div class="fbx-seg fbx-seg-sm" role="group" aria-label="Layout">' +
              '<button type="button" data-set-view="modern">Modern</button><button type="button" data-set-view="classic">Classic</button></div></div>' +
            '<button type="button" class="fbx-pm-item fbx-danger" data-act="signout">' + icon("log-out") + "Sign out</button>" +
          "</div>" +
        "</div>" +
        '<button type="button" class="fbx-ibtn fbx-signout" data-act="signout" title="Sign out" aria-label="Sign out">' + icon("log-out") + "</button>" +
      "</div>";

    var main = document.querySelector(".fb-main");
    if (main) main.insertBefore(header, main.firstChild);
    else document.body.insertBefore(header, document.body.firstChild);
    root.classList.add("fbx-has-header");

    launcher = header.querySelector(".fbx-launcher");
    profileMenu = header.querySelector(".fbx-profile-menu");
    header.addEventListener("click", onHeaderClick);
    fitHeader();
    window.addEventListener("resize", fitHeader);
    syncControls();
  }

  // The header spans the full width of the content area, whatever padding
  // each page gives .fb-main.
  function fitHeader() {
    if (!header || !header.parentElement || !header.parentElement.classList.contains("fb-main")) return;
    var cs = getComputedStyle(header.parentElement);
    header.style.marginTop = "-" + cs.paddingTop;
    header.style.marginLeft = "-" + cs.paddingLeft;
    header.style.marginRight = "-" + cs.paddingRight;
  }

  function onHeaderClick(e) {
    var v = e.target.closest("[data-set-view]");
    if (v) { setView(v.getAttribute("data-set-view")); return; }
    var b = e.target.closest("[data-act]");
    if (!b) return;
    var act = b.getAttribute("data-act");
    if (act === "theme") toggleTheme(b);
    else if (act === "palette") openPalette();
    else if (act === "launcher") togglePop(launcher, b);
    else if (act === "profile") togglePop(profileMenu, b);
    else if (act === "signout") signOutNow(b);
  }

  var openPop = null;
  function togglePop(pop, btn) {
    var show = pop.hidden;
    closePops();
    if (show) {
      pop.hidden = false;
      btn.setAttribute("aria-expanded", "true");
      openPop = { pop: pop, btn: btn };
      var first = pop.querySelector("a, button");
      if (first && e_isKeyboard) first.focus();
    }
  }
  function closePops() {
    if (!openPop) return;
    openPop.pop.hidden = true;
    openPop.btn.setAttribute("aria-expanded", "false");
    openPop = null;
  }
  var e_isKeyboard = false;
  document.addEventListener("keydown", function () { e_isKeyboard = true; }, true);
  document.addEventListener("pointerdown", function (e) {
    e_isKeyboard = false;
    if (openPop && !openPop.pop.contains(e.target) && !openPop.btn.contains(e.target)) closePops();
  }, true);

  function syncControls() {
    if (!header) return;
    var dark = root.getAttribute("data-theme") === "dark";
    var view = root.getAttribute("data-view");
    header.querySelectorAll(".fbx-switch").forEach(function (s) { s.setAttribute("aria-checked", dark ? "true" : "false"); });
    header.querySelectorAll("[data-set-view]").forEach(function (b) {
      b.setAttribute("aria-pressed", b.getAttribute("data-set-view") === view ? "true" : "false");
    });
    var t = header.querySelector(".fbx-theme");
    if (t) t.title = dark ? "Switch to light theme" : "Switch to dark theme";
    var meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "theme-color";
      document.head.appendChild(meta);
    }
    meta.content = dark ? "#0f1714" : "#f3f7f5";
  }

  function showUser(user) {
    if (!header || !user) return;
    var email = user.email || user.phoneNumber || "Admin";
    var letter = (email.charAt(0) || "A").toUpperCase();
    header.querySelectorAll(".fbx-email").forEach(function (el) { el.textContent = email; });
    header.querySelectorAll(".fbx-avatar").forEach(function (el) { el.textContent = letter; });
    var who = header.querySelector(".fbx-who b");
    if (who) who.textContent = user.displayName || email.split("@")[0];
    header.querySelector(".fbx-profile").title = email;
    if (user.staff) {
      var team = user.teamName || "Production team";
      var role = header.querySelector(".fbx-pm-user b");
      if (role) role.textContent = user.displayName || team;
      header.querySelectorAll(".fbx-email").forEach(function (el) { el.textContent = "@" + email + " · " + team; });
    }
  }

  // ----------------------------------------------------- classic sidebar
  function addSidebarHome() {
    var menu = document.querySelector(".fb-sidebar .fb-menu");
    if (!menu || menu.querySelector(".fbx-home-link")) return;
    var a = document.createElement("a");
    a.href = HOME;
    a.className = "fbx-home-link" + (isHome ? " active" : "");
    a.textContent = "🏠 Home";
    menu.insertBefore(a, menu.firstChild);
    if (isHome) {
      menu.querySelectorAll("a.active").forEach(function (x) { if (x !== a) x.classList.remove("active"); });
    }
    if (!menu.querySelector('a[href="/admin/production.html"]')) {
      var p = document.createElement("a");
      p.href = "/admin/production.html";
      p.textContent = "🏭 Production";
      if (here === "production") {
        menu.querySelectorAll("a.active").forEach(function (x) { x.classList.remove("active"); });
        p.className = "active";
      }
      var after = menu.querySelector('a[href="/admin/controller-database.html"]');
      menu.insertBefore(p, after ? after.nextSibling : null);
    }
    if (!menu.querySelector('a[href="/admin/user-roles.html"]')) {
      var ur = document.createElement("a");
      ur.href = "/admin/user-roles.html";
      ur.textContent = "👥 User Roles";
      if (here === "user-roles") {
        menu.querySelectorAll("a.active").forEach(function (x) { x.classList.remove("active"); });
        ur.className = "active";
      }
      var logout = menu.querySelector(".logout, #logoutBtn");
      menu.insertBefore(ur, logout || null);
    }
  }

  // ------------------------------------------------------- command palette
  function paletteItems() {
    var dark = root.getAttribute("data-theme") === "dark";
    var classic = root.getAttribute("data-view") === "classic";
    var items = STAFF ? [] : [{ label: "Home", hint: "All modules", icon: "house", href: HOME }];
    MODULES.forEach(function (m) { items.push({ label: m.label, hint: m.desc, icon: m.icon, href: m.href, tone: m.tone }); });
    items.push({ label: dark ? "Switch to light theme" : "Switch to dark theme", hint: "Theme", icon: dark ? "sun" : "moon", run: function () { toggleTheme(); } });
    if (!STAFF && !TEAM) items.push({ label: classic ? "Switch to Modern view" : "Switch to Classic view", hint: "Layout", icon: classic ? "layout-grid" : "panel-left",
      run: function () { setView(classic ? "modern" : "classic"); } });
    items.push({ label: "Sign out", hint: "End this session", icon: "log-out", run: function () { signOutNow(); } });
    return items;
  }

  function openPalette() {
    closePops();
    if (palette) { palette.remove(); palette = null; }
    var items = paletteItems(), shown = items, sel = 0;
    palette = document.createElement("div");
    palette.className = "fbx-palette";
    palette.innerHTML =
      '<div class="fbx-pal-box" role="dialog" aria-modal="true" aria-label="Search modules">' +
        '<div class="fbx-pal-in">' + icon("search") + '<input type="text" placeholder="Go to a module or run an action…" aria-label="Search" autocomplete="off" spellcheck="false"><kbd>Esc</kbd></div>' +
        '<ul class="fbx-pal-list" role="listbox"></ul>' +
        '<div class="fbx-pal-foot"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>Esc</kbd> close</span></div>' +
      "</div>";
    document.body.appendChild(palette);
    var input = palette.querySelector("input"), list = palette.querySelector(".fbx-pal-list");
    var lastFocus = document.activeElement;

    function render() {
      list.innerHTML = shown.length ? shown.map(function (it, i) {
        return '<li role="option" data-i="' + i + '" aria-selected="' + (i === sel) + '"' + (it.tone ? ' data-tone="' + it.tone + '"' : "") + ">" +
          '<span class="fbx-pal-ic">' + icon(it.icon) + "</span><span class=\"fbx-pal-t\"><b>" + esc(it.label) + "</b><small>" + esc(it.hint || "") + "</small></span>" +
          icon("arrow-right", "fbx-pal-go") + "</li>";
      }).join("") : '<li class="fbx-pal-empty">No module matches</li>';
      var cur = list.querySelector('[aria-selected="true"]');
      if (cur) cur.scrollIntoView({ block: "nearest" });
    }
    function filter() {
      var q = input.value.trim().toLowerCase();
      shown = !q ? items : items.filter(function (it) {
        return (it.label + " " + (it.hint || "")).toLowerCase().indexOf(q) >= 0;
      });
      sel = 0;
      render();
    }
    function close() {
      if (!palette) return;
      palette.remove();
      palette = null;
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    }
    function run(it) {
      if (!it) return;
      close();
      if (it.href) location.href = it.href; else it.run();
    }
    input.addEventListener("input", filter);
    input.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { sel = Math.min(shown.length - 1, sel + 1); render(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { sel = Math.max(0, sel - 1); render(); e.preventDefault(); }
      else if (e.key === "Enter") { run(shown[sel]); e.preventDefault(); }
      else if (e.key === "Escape") { close(); e.preventDefault(); }
      else if (e.key === "Tab") e.preventDefault();
    });
    list.addEventListener("mousemove", function (e) {
      var li = e.target.closest("[data-i]");
      if (li && +li.getAttribute("data-i") !== sel) { sel = +li.getAttribute("data-i"); render(); }
    });
    list.addEventListener("click", function (e) {
      var li = e.target.closest("[data-i]");
      if (li) run(shown[+li.getAttribute("data-i")]);
    });
    palette.addEventListener("mousedown", function (e) { if (e.target === palette) close(); });
    render();
    input.focus();
  }

  document.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "k" || e.key === "K")) {
      e.preventDefault();
      if (palette) { palette.remove(); palette = null; } else openPalette();
    } else if (e.key === "Escape" && openPop) {
      var btn = openPop.btn;
      closePops();
      btn.focus();
    }
  });

  // ------------------------------------------------------------------ init
  function init() {
    if (header || LEAVING) return;
    buildHeader();
    addSidebarHome();
    recordRecent();
    // Who's signed in - after the page's own scripts have started.
    var later = window.requestIdleCallback || function (f) { setTimeout(f, 300); };
    if (STAFF) {
      showUser({ email: STAFF.username, displayName: STAFF.name, staff: true });
      return;
    }
    if (TEAM) {
      showUser({ email: TEAM.username, displayName: TEAM.name, staff: true, teamName: "Onboarding team" });
      return;
    }
    later(function () {
      firebase().then(function (f) {
        f.mod.onAuthStateChanged(f.auth, showUser);
      }).catch(function (err) { console.warn("Admin header: could not load sign-in state", err); });
    });
  }

  // For the Home page's own script.
  window.FBShell = { modules: MODULES, icon: icon, esc: esc, openPalette: openPalette, KEY_RECENT: KEY_RECENT, staff: STAFF, team: TEAM };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
