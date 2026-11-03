// Fake Firebase Storage (uploads are off in config.js - DOCUMENT_UPLOADS).
export function getStorage() { return {}; }
export function ref(_s, path) { return { fullPath: path }; }
export async function uploadBytes(r) { window.__fbStats && (window.__fbStats.uploads = (window.__fbStats.uploads || 0) + 1); return { ref: r }; }
export async function getDownloadURL(r) { return "https://storage.test/" + encodeURIComponent(r.fullPath); }
