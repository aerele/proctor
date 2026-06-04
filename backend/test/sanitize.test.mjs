import assert from "node:assert/strict";
import test from "node:test";

test("username-safe path convention", () => {
  const value = " Student Name/@Hack ";
  const normalized = value.trim().toLowerCase().replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
  assert.equal(normalized, "student_name__hack");
});
