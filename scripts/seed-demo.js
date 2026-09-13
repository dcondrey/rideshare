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
import { hashEmailForAllowlist } from "../lib/crypto.js";
import { audit, db, tx } from "../lib/db.js";

const REFUSE_THRESHOLD = 5;

const ATTENDEE_COUNT = 18;
const RIDE_COUNT = 13;
const CLAIM_COUNT = 6;

const FIRST_NAMES = [
  "Avery",
  "Bianca",
  "Carlos",
  "Dana",
  "Elan",
  "Farida",
  "Gus",
  "Harriet",
  "Ivo",
  "Jules",
  "Kiran",
  "Lena",
  "Marco",
  "Nadia",
  "Omar",
  "Priya",
  "Quinn",
  "Rosa",
  "Sami",
  "Tova",
];
const LAST_NAMES = [
  "Okafor",
  "Nguyen",
  "Fischer",
  "Patel",
  "Rossi",
  "Svensson",
  "Haddad",
  "Kowalski",
  "Diallo",
  "Martinez",
  "Novak",
  "Lindgren",
];
const CONTACT_METHODS = [
  "Signal: +1-555-0100",
  "@handle on X",
  "Telegram: @conference_rider",
  null,
];

function runArgs() {
  return new Set(process.argv.slice(2));
}

function randomInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function pick(list) {
  return list[randomInt(0, list.length - 1)];
}

function fakeEmail(first, last, index) {
  const domains = ["example.com", "example.org", "example.net"];
  return `${first.toLowerCase()}.${last.toLowerCase()}${index}@${pick(domains)}`;
}

function dateRange() {
  const start = new Date(`${config.event.dates.start}T00:00:00Z`);
  const end = new Date(`${config.event.dates.end}T00:00:00Z`);
  const days = Math.max(1, Math.round((end - start) / 86_400_000) + 1);
  return { start, days };
}

function randomDepartDate({ start, days }) {
  const offset = randomInt(0, days - 1);
  const d = new Date(start.getTime() + offset * 86_400_000);
  return d.toISOString().slice(0, 10);
}

function randomDepartTime() {
  const hour = randomInt(5, 22);
  const minute = pick([0, 15, 30, 45]);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function countRows(table) {
  const row = /** @type {{ c: number }} */ (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get());
  return row.c;
}

function seedAttendees() {
  const now = Date.now();
  const users = [];
  for (let i = 0; i < ATTENDEE_COUNT; i++) {
    const first = pick(FIRST_NAMES);
    const last = pick(LAST_NAMES);
    const email = fakeEmail(first, last, i);
    const displayName = `${first} ${last}`;
    const contactMethod = pick(CONTACT_METHODS);

    db.prepare(`INSERT INTO allowlist_hashes (email_hash, added_at) VALUES (?, ?)`).run(
      hashEmailForAllowlist(email),
      now,
    );

    const r = db
      .prepare(
        `INSERT INTO users (email, display_name, contact_method, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(email, displayName, contactMethod, now, now);

    users.push({ id: Number(r.lastInsertRowid), email, displayName });
  }
  return users;
}

function seedRides(users) {
  const airports = config.event.airports || [];
  if (airports.length === 0) {
    throw new Error("event.config.yaml has no airports configured — add at least one");
  }
  const range = dateRange();
  const rideIds = [];
  const now = Date.now();

  for (let i = 0; i < RIDE_COUNT; i++) {
    const poster = pick(users);
    const kind = Math.random() < 0.6 ? "offer" : "request";
    const direction = Math.random() < 0.5 ? "to_venue" : "from_venue";
    const airport = pick(airports);
    const seats = kind === "offer" ? randomInt(1, 4) : randomInt(1, 2);
    const flexMinutes = pick([0, 15, 30, 60]);
    const notes =
      kind === "offer"
        ? pick([
            "Happy to swing by a hotel on the way.",
            "Have a car seat if anyone's traveling with a kid.",
            "Can leave a bit earlier or later, just ask.",
            null,
          ])
        : pick(["Landing a bit late, flight status TBD.", "Traveling with one checked bag.", null]);

    const r = db
      .prepare(
        `INSERT INTO rides (user_id, kind, direction, airport, other_place,
                            depart_date, depart_time, flex_minutes, seats, notes,
                            status, pickup_lat, pickup_lng, meetup_id,
                            created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, 'open', ?, ?, NULL, ?, ?)`,
      )
      .run(
        poster.id,
        kind,
        direction,
        airport.code,
        randomDepartDate(range),
        randomDepartTime(),
        flexMinutes,
        seats,
        notes,
        airport.lat,
        airport.lng,
        now,
        now,
      );
    rideIds.push({ id: Number(r.lastInsertRowid), posterId: poster.id });
  }
  return rideIds;
}

function seedClaims(users, rides) {
  const now = Date.now();
  let created = 0;
  const statuses = ["pending", "pending", "accepted"];
  const shuffledRides = [...rides].sort(() => Math.random() - 0.5);

  for (const ride of shuffledRides) {
    if (created >= CLAIM_COUNT) break;
    const claimer = pick(users.filter((u) => u.id !== ride.posterId));
    if (!claimer) continue;

    const status = pick(statuses);
    const decidedAt = status === "accepted" ? now : null;
    try {
      db.prepare(
        `INSERT INTO claims (ride_id, claimer_id, seats, message, status, created_at, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        ride.id,
        claimer.id,
        randomInt(1, 2),
        pick(["Happy to split gas.", "Can meet wherever's easiest.", null]),
        status,
        now,
        decidedAt,
      );
      created++;
    } catch {
      // UNIQUE(ride_id, claimer_id) collision from a prior ride's claimer pick — skip.
    }
  }
  return created;
}

function main() {
  const args = runArgs();
  if (!args.has("--yes")) {
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

  const { users, rides, claimCount } = tx(() => {
    const seededUsers = seedAttendees();
    const seededRides = seedRides(seededUsers);
    const seededClaimCount = seedClaims(seededUsers, seededRides);
    return { users: seededUsers, rides: seededRides, claimCount: seededClaimCount };
  });

  audit({
    actorId: null,
    actorEmail: null,
    action: "demo.seed",
    detail: `seeded ${users.length} attendees, ${rides.length} rides, ${claimCount} claims (synthetic demo data, not real signups)`,
  });

  console.log(
    `[seed-demo] Seeded ${users.length} attendees, ${rides.length} rides, ${claimCount} claims.\n` +
      "            This is synthetic demo data — visible in /admin/audit as action=demo.seed.\n" +
      "            Clear it before the real event by deleting the database file and\n" +
      "            restarting, or by manually removing these rows.",
  );
}

main();
