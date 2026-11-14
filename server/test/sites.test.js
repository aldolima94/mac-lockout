import { test } from "node:test";
import assert from "node:assert/strict";
import { BLOCKED_SITES, isDomain } from "../lib/sites.js";

test("every blocked site is a plain lowercase domain the Mac will accept", () => {
  for (const d of BLOCKED_SITES) assert.ok(isDomain(d), d);
  assert.equal(new Set(BLOCKED_SITES).size, BLOCKED_SITES.length, "no duplicates");
});

test("the domain check rejects what the Mac would drop", () => {
  for (const d of ["X.com", "x", "*.x.com", "x.com/path", "http://x.com", "-x.com", "x..com", "x.com ", ""]) assert.ok(!isDomain(d), d);
  for (const d of ["x.com", "ifood.com.br", "www.uber.com", "99app.com"]) assert.ok(isDomain(d), d);
});
