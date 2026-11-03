// Fake Firebase app (web simulation - see ../run.js).
export function initializeApp(config) { return { name: "[DEFAULT]", options: config }; }
export function getApp() { return { name: "[DEFAULT]" }; }
