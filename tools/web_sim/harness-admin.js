// The one in-memory database of a simulation run, in the shape the server
// modules import from firebaseAdmin.js / firebase-admin/firestore - see
// harness.js, which points productionFirebase.js at this file.
import { createMemDb, FieldValue, FieldPath, Timestamp } from "./memdb.js";

export const mem = createMemDb();
export const db = mem.admin;
export { FieldValue, FieldPath, Timestamp };

// firebase-admin/auth, the parts productionFirebase.js uses. Custom tokens
// are readable ("custom.<base64 JSON>"); the fake browser Auth trades one
// for a signed-in user at /__auth/custom.
export const auth = {
  async createCustomToken(uid, claims = {}) {
    return "custom." + Buffer.from(JSON.stringify({ uid, claims })).toString("base64");
  },
  async updateUser() {},
  async revokeRefreshTokens() {},
  async deleteUser() {}
};

// firebase-admin/messaging: pushes are recorded, every token "delivered".
export const pushes = [];
export const messaging = {
  async sendEachForMulticast(msg) {
    pushes.push(msg);
    return { successCount: msg.tokens.length, failureCount: 0, responses: msg.tokens.map(() => ({ success: true })) };
  },
  async send(msg) { pushes.push(msg); return "sim-message-id"; }
};
