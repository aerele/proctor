// backend/test/evalWriteIsolation.test.mjs — the proctor-eval WRITE-ISOLATION
// guard in clients.mjs (getFirestore()).
//
// Contract: when EVAL_WRITE_ALLOWLIST is configured (proctor-eval only), the
// Firestore client returned by getFirestore() rejects every WRITE to a
// collection NOT in the allowlist — so a runaway/compromised eval deploy can
// only mutate its OWN collection(s). READS are always allowed. When UNSET
// (proctor-api), getFirestore() returns the RAW client and writes are
// unrestricted — behavior + overhead completely unchanged.
//
// We drive clients.mjs DIRECTLY (its DI seams configureClients +
// __setClientsForTest), with a tiny recording fake-Firestore, so the guard is
// pinned at the chokepoint independent of the eval routes.
import { test } from "node:test";
import assert from "node:assert/strict";

// Fresh ?buster import so the module-level allowlist/singletons are clean here.
const clients = await import("../src/lib/clients.mjs?evalWriteIsolation");
const { configureClients, __setClientsForTest, getFirestore } = clients;

// A minimal recording Firestore: every write appends to `writes`; reads return
// empty. collection(name).doc(id).{set,update,delete,create}, collection().add(),
// and a query read path are all represented.
function makeRecordingFirestore() {
  const writes = [];
  function makeColl(name) {
    return {
      add(value) { writes.push({ op: "add", coll: name, value }); return Promise.resolve({ id: "x" }); },
      where() { return makeColl(name); },
      orderBy() { return makeColl(name); },
      limit() { return makeColl(name); },
      async get() { return { docs: [] }; },
      doc(id) {
        return {
          id,
          async set(value) { writes.push({ op: "set", coll: name, id, value }); },
          async update(value) { writes.push({ op: "update", coll: name, id, value }); },
          async delete() { writes.push({ op: "delete", coll: name, id }); },
          async create(value) { writes.push({ op: "create", coll: name, id, value }); },
          async get() { return { exists: false, data: () => undefined }; },
          collection(sub) { return makeColl(sub); }
        };
      }
    };
  }
  return {
    _writes: writes,
    collection(name) { return makeColl(name); },
    batch() { return { set() {}, update() {}, delete() {}, async commit() {} }; },
    async runTransaction(fn) { return fn({ get: async () => ({ exists: false }), set() {}, update() {}, delete() {} }); }
  };
}

test("WRITE to an ALLOWLISTED collection succeeds (and actually reaches the store)", async () => {
  const fake = makeRecordingFirestore();
  configureClients({ evalWriteAllowlist: "proctor_evaluations" });
  __setClientsForTest({ firestore: fake });

  const fs = getFirestore();
  await fs.collection("proctor_evaluations").doc("contest::id").set({ score: 1 });
  await fs.collection("proctor_evaluations").doc("__job::c").set({ status: "running" }, { merge: true });

  assert.equal(fake._writes.length, 2, JSON.stringify(fake._writes));
  assert.equal(fake._writes[0].coll, "proctor_evaluations");
  assert.equal(fake._writes[0].op, "set");
});

test("WRITE to a NON-allowlisted collection throws the write-isolation error (and never reaches the store)", async () => {
  const fake = makeRecordingFirestore();
  configureClients({ evalWriteAllowlist: "proctor_evaluations" });
  __setClientsForTest({ firestore: fake });

  const fs = getFirestore();
  // .set on a foreign collection
  assert.throws(
    () => fs.collection("proctor_sessions").doc("s1").set({ status: "ended" }),
    /eval write-isolation: proctor_sessions not in EVAL_WRITE_ALLOWLIST/
  );
  // .update, .delete, .create on a foreign collection are all blocked too.
  assert.throws(() => fs.collection("proctor_contests").doc("c1").update({ x: 1 }), /eval write-isolation: proctor_contests/);
  assert.throws(() => fs.collection("proctor_alerts").doc("a1").delete(), /eval write-isolation: proctor_alerts/);
  assert.throws(() => fs.collection("proctor_roster").doc("r1").create({ x: 1 }), /eval write-isolation: proctor_roster/);
  // collection().add() on a foreign collection is blocked.
  assert.throws(() => fs.collection("proctor_admin_audit").add({ x: 1 }), /eval write-isolation: proctor_admin_audit/);

  // NOTHING reached the store.
  assert.equal(fake._writes.length, 0, JSON.stringify(fake._writes));
});

test("READS on a non-allowlisted collection are ALWAYS allowed", async () => {
  const fake = makeRecordingFirestore();
  configureClients({ evalWriteAllowlist: "proctor_evaluations" });
  __setClientsForTest({ firestore: fake });

  const fs = getFirestore();
  // A query read + a doc read on a foreign collection must not throw.
  await fs.collection("proctor_sessions").where("status", "==", "active").limit(10).get();
  const snap = await fs.collection("proctor_contests").doc("c1").get();
  assert.equal(snap.exists, false);
  assert.equal(fake._writes.length, 0);
});

test("batch() and runTransaction() are blocked under the allowlist (defense-in-depth; eval uses neither today)", () => {
  const fake = makeRecordingFirestore();
  configureClients({ evalWriteAllowlist: "proctor_evaluations" });
  __setClientsForTest({ firestore: fake });

  const fs = getFirestore();
  assert.throws(() => fs.batch(), /eval write-isolation: batch\(\) is not permitted/);
  assert.throws(() => fs.runTransaction(async () => {}), /eval write-isolation: runTransaction\(\) is not permitted/);
});

test("with the allowlist UNSET (proctor-api), writes to ANY collection are unrestricted and getFirestore() is the RAW client", async () => {
  const fake = makeRecordingFirestore();
  // Empty string clears the allowlist → no guard at all.
  configureClients({ evalWriteAllowlist: "" });
  __setClientsForTest({ firestore: fake });

  const fs = getFirestore();
  // Identity: the unguarded path returns the exact injected instance (no proxy).
  assert.equal(fs, fake, "getFirestore() must return the RAW client when no allowlist is set");

  await fs.collection("proctor_sessions").doc("s1").set({ status: "ended" });
  await fs.collection("proctor_contests").doc("c1").update({ x: 1 });
  fs.batch();
  assert.equal(fake._writes.length, 2, JSON.stringify(fake._writes));
});

test("a multi-name allowlist permits each listed collection and blocks the rest", async () => {
  const fake = makeRecordingFirestore();
  configureClients({ evalWriteAllowlist: " proctor_evaluations , proctor_eval_extra " });
  __setClientsForTest({ firestore: fake });

  const fs = getFirestore();
  await fs.collection("proctor_evaluations").doc("a").set({ x: 1 });
  await fs.collection("proctor_eval_extra").doc("b").set({ x: 1 });
  assert.equal(fake._writes.length, 2);
  assert.throws(() => fs.collection("proctor_sessions").doc("c").set({ x: 1 }), /not in EVAL_WRITE_ALLOWLIST/);
});

// Restore the unset state so any later import of this module in the same process
// is not left guarded (cross-file hygiene; ?buster already isolates, but belt-and-braces).
// Run at module scope — not as a test — since it asserts nothing.
configureClients({ evalWriteAllowlist: "" });
