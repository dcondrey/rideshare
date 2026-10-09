#!/usr/bin/env node

// @ts-check
// SPDX-License-Identifier: MIT
//
// seed-demo.js
// ------------
// Populate the currently configured database with a small synthetic dataset
// (attendees, ride offers/requests, claims) so an organizer can dry-run the
// whole flow — map, browse, claim, admin insights — before the real event
// starts, without importing a real allowlist first.
//
// Run via: node scripts/seed-demo.js --yes
//
// Refuses to run (exit 1, no DB writes) unless:
//   - the --yes flag is passed, and
//   - `users` and `allowlist_hashes` each have REFUSE_THRESHOLD or fewer rows
//     (this is a dry-run seeder for an empty/near-empty deployment, not a way
//     to inject fake rows into a DB that already has real attendees).

import { config } from "../lib/config.js";
import { db } from "../lib/db.js";
import { seedDemoData } from "../lib/demo.js";

const REFUSE_THRESHOLD = 5;

/** @param {string} table */
function countRows(table) {
  const row = /** @type {{ c: number }} */ (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get());
  return row.c;
}

function main() {
  if (!process.argv.slice(2).includes("--yes")) {
    console.error(
      "\n[seed-demo] This inserts fake attendees, rides, and claims into the\n" +
        `            database at DATABASE_PATH (currently: ${config.databasePath}).\n` +
        "            Re-run with --yes to confirm:\n\n" +
        "              node scripts/seed-demo.js --yes\n",
    );
    process.exit(1);
  }

  const userCount = countRows("users");
  const allowlistCount = countRows("allowlist_hashes");
  if (userCount > REFUSE_THRESHOLD || allowlistCount > REFUSE_THRESHOLD) {
    console.error(
      `\n[seed-demo] Refusing to seed: users=${userCount}, allowlist_hashes=${allowlistCount}, ` +
        `threshold=${REFUSE_THRESHOLD}.\n` +
        "            This looks like a deployment with real attendees already. seed-demo.js\n" +
        "            is only for an empty/near-empty dry-run database.\n",
    );
    process.exit(1);
  }

  const r = seedDemoData({ attendees: 18, rides: 13, claims: 6 });
  console.log(
    `[seed-demo] Seeded ${r.attendees} attendees, ${r.rides} rides, ${r.claims} claims.\n` +
      "            This is synthetic demo data — visible in /admin/audit as action=demo.seed.\n" +
      "            Clear it before the real event by deleting the database file and\n" +
      "            restarting, or by manually removing these rows.",
  );
}

main();
