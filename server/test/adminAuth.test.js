import { test } from "node:test";
import assert from "node:assert/strict";

// Each test file runs in its own process, so the env set here is what
// config.js reads when adminAuth.js is first imported.
process.env.ADMIN_EMAILS = "Admin@FarmBuddie.com, ops@farmbuddie.com";
const { isAdmin, requireAdmin } = await import("../src/adminAuth.js");
const { validateSequences } = await import("../src/bridge/valveSequences.js");

test("only the listed email accounts are admins", () => {
  assert.equal(isAdmin({ email: "admin@farmbuddie.com" }), true);     // case doesn't matter
  assert.equal(isAdmin({ email: "OPS@farmbuddie.com" }), true);
  assert.equal(isAdmin({ email: "stranger@gmail.com" }), false);
  assert.equal(isAdmin({ phone_number: "+919000000001" }), false);   // a farmer's phone login
  assert.equal(isAdmin(undefined), false);
});

test("requireAdmin answers 403 for anyone else", () => {
  let status = null;
  let passed = false;
  const res = { status(s) { status = s; return { json() {} }; } };
  requireAdmin({ decodedToken: { email: "stranger@gmail.com" } }, res, () => { passed = true; });
  assert.equal(status, 403);
  assert.equal(passed, false);
  requireAdmin({ decodedToken: { email: "admin@farmbuddie.com" } }, res, () => { passed = true; });
  assert.equal(passed, true);
});

test("a valve sequence may use valves up to 64 (the hub's limit)", () => {
  const seq = (valve) => [{ name: "A", steps: [{ valve, duration_sec: 60 }] }];
  assert.equal(validateSequences(seq(64))[0].steps[0].valve, 64);
  assert.throws(() => validateSequences(seq(65)));
});
