// @ts-check
/**
 * The audit log is the evidence trail behind every credential this deployment
 * issues. docs/security/audit-tampering.md promises the application connection
 * cannot rewrite it; these are that promise.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { setupTestEnv } from "../helpers/env.js";

setupTestEnv({ DATABASE_PATH: ":memory:" });

const { audit, db } = await import("../../lib/db.js");

test("an audit row cannot be updated through the application connection", () => {
  audit({ action: "ride.create", detail: "ride 1" });
  const row = /** @type {{ id: number } | undefined} */ (
    db.prepare("SELECT id FROM audit_log ORDER BY id DESC LIMIT 1").get()
  );
  assert.ok(row, "insert landed");
  assert.throws(
    () => db.prepare("UPDATE audit_log SET action = 'nothing.happened' WHERE id = ?").run(row.id),
    /append-only/,
  );
  assert.equal(
    db.prepare("SELECT action FROM audit_log WHERE id = ?").get(row.id)?.action,
    "ride.create",
  );
});

test("an audit row cannot be deleted through the application connection", () => {
  const before = db.prepare("SELECT COUNT(*) AS n FROM audit_log").get()?.n;
  assert.throws(() => db.prepare("DELETE FROM audit_log").run(), /append-only/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_log").get()?.n, before);
});

test("an audit row cannot be re-attributed to a different user", () => {
  const row = /** @type {{ id: number } | undefined} */ (
    db.prepare("SELECT id FROM audit_log ORDER BY id DESC LIMIT 1").get()
  );
  assert.ok(row);
  assert.throws(
    () => db.prepare("UPDATE audit_log SET actor_id = 42 WHERE id = ?").run(row.id),
    /append-only/,
  );
});

test("the ON DELETE SET NULL cascade is still allowed to null actor_id", () => {
  const row = /** @type {{ id: number } | undefined} */ (
    db.prepare("SELECT id FROM audit_log ORDER BY id DESC LIMIT 1").get()
  );
  assert.ok(row);
  db.prepare("UPDATE audit_log SET actor_id = NULL WHERE id = ?").run(row.id);
  assert.equal(
    db.prepare("SELECT actor_id FROM audit_log WHERE id = ?").get(row.id)?.actor_id,
    null,
  );
});
