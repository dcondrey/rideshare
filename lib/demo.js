// @ts-check
/**
 * Synthetic data and live-demo behaviour.
 *
 * Two callers:
 *   - scripts/seed-demo.js fills an empty database for an organizer's dry run.
 *   - DEMO_MODE=true (the public live demo) seeds at boot, replaces email
 *     sign-in with one-click demo accounts, and keeps "ghost" attendees active:
 *     they post rides, claim the visitor's rides, accept the visitor's claims
 *     and confirm shared rides, so a visitor can walk the whole flow, earning
 *     a real RideAttendanceCredential, without a second human.
 *
 * Ghosts are ordinary users with emails under GHOST_DOMAIN and a did:key bound
 * from a server-generated keypair. Every action they take goes through the same
 * lib/rides.js and lib/trust.js functions a person's request would, so the
 * demo exercises the real code paths, capacity checks and issuance included.
 *
 * Randomness comes from node:crypto even though it only shapes fake
 * activity: visitor ids and synthetic emails reach the allowlist hash, and
 * one source of randomness is simpler to reason about than two.
 */

import { randomInt as cryptoRandomInt, randomBytes } from "node:crypto";

import { createSession } from "./auth.js";
import { config, DEMO_ATTENDEE_EMAIL, DEMO_ORGANIZER_EMAIL } from "./config.js";
import { hashEmailForAllowlist } from "./crypto.js";
import { audit, db, tx } from "./db.js";
import { generateEd25519Keypair, pubKeyRawBytes, pubKeyToDidKey } from "./did.js";
import { getEventConfig, setOverrides } from "./event-config.js";
import { notifyRide } from "./live.js";
import { info, warn } from "./log.js";
import { rateLimit } from "./rate-limit.js";
import { createClaim, createRide, decideClaim, postRideUpdate, updateRideStatus } from "./rides.js";
import { confirmRide } from "./trust.js";

export const GHOST_DOMAIN = "ghost.demo.test";
export const VISITOR_DOMAIN = "visitors.demo.test";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Demo sign-ins allowed per client IP per hour, and visitor accounts in total. */
const SIGNIN_LIMIT_PER_IP = 30;
const MAX_VISITORS = 5000;
/** Ghost activity runs only while a visitor has acted within this window. */
const ACTIVE_WINDOW_MS = 45 * MINUTE;
/** Above this many open ghost rides the ticker retires old ones instead of posting. */
const MAX_OPEN_GHOST_RIDES = 34;

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
  "Uma",
  "Wren",
  "Yusuf",
  "Zoe",
  "Mateo",
  "Ines",
  "Kenji",
  "Amara",
  "Bram",
  "Leilani",
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
  "Tanaka",
  "Moreau",
  "Achebe",
  "Kaur",
];
const CONTACT_METHODS = [
  "Signal: @ghost-rider.01",
  "Matrix: @rider:example.org",
  "Telegram: @conference_rider",
  "Text the number on my badge",
  null,
];
const OFFER_NOTES = [
  "Happy to swing by a hotel on the way.",
  "Room for two carry-ons and a backpack.",
  "Leaving right after closing circle.",
  "Demoing a wallet at the interop plaza on day one, happy to talk shop on the drive.",
  "Bring a laptop: we can run the interop test suite on the way.",
  "EV, so one quick charging stop if traffic is bad.",
  "Can leave a bit earlier or later, just ask.",
  "Car seat available if anyone is traveling with a kid.",
  null,
];
const REQUEST_NOTES = [
  "Landing a bit late, flight status TBD.",
  "Traveling with one checked bag.",
  "Will split the fare or cover parking.",
  "First IDW, bringing a half-working verifier. Bugs welcome.",
  null,
];
const TAXI_NOTES = [
  "Booking an XL from arrivals, split four ways.",
  "Taxi rank outside terminal 2. About $18 each with four of us.",
  "Ordering a Lyft when we land, join and we split it.",
];
const TRANSIT_NOTES = [
  "Taking BART + Caltrain, meet at the platform.",
  "Catching the airport shuttle bus together, first time here so company welcome.",
  "Train to the venue, I know the transfer.",
];

const GHOST_BIOS = [
  "Building wallet interop tests. Ask me about DCQL.",
  "Demoing a did:web resolver that runs on a Raspberry Pi.",
  "Here for the OpenID4VP plaza. Bugs welcome.",
  "Working on selective disclosure for event tickets.",
  "First IDW! Looking to pair on DIDComm mediators.",
  "Verifier side. Will trade test vectors for coffee.",
  "Hacking on offline credential presentation over BLE.",
  "Running the SD-JWT interop table, come break my issuer.",
];
const GHOST_AFFILIATIONS = [
  "Open Wallet Foundation",
  "Independent",
  "Spruce Labs",
  "DIF working group",
  "University research lab",
  "City digital ID pilot",
  "Indie hacker",
  "Credential startup",
];

// Trip updates ghosts post for their ride partners: [status, minutes, note].
/** @type {[import("./rides.js").TripStatus, number | null, string][]} */
const STATUS_UPDATES = [
  ["late", 15, "Bags took forever, heading out now"],
  ["late", 25, "Flight held at the gate"],
  ["late", 40, "Stuck in the security line"],
  ["early", 10, "Tailwind! Landed early"],
  ["early", 20, "Got on an earlier flight"],
  ["missed", null, "Missed my connection in Denver, now landing 18:40"],
  ["missed", null, "Missed the 3:15 train, catching the next one"],
  ["on_time", null, "Boarding now, on schedule"],
  ["arrived", null, "At the curb, look for the blue jacket"],
  ["arrived", null, "Made it to the venue"],
];

const CLAIM_MESSAGES = [
  "Happy to split gas.",
  "Can meet wherever is easiest.",
  "My flight lands 20 minutes before that, should work.",
  "Would love a seat. I only have a backpack.",
  "Is there room for a guitar case?",
  null,
];

// ── Randomness helpers ───────────────────────────────────────────────────────

/** A uniform float in [0, 1) from the CSPRNG (47 bits; randomInt caps its range below 2^48). */
const rand = () => cryptoRandomInt(0, 2 ** 47) / 2 ** 47;

/** @param {number} min @param {number} max inclusive */
function randomInt(min, max) {
  return min + Math.floor(rand() * (max - min + 1));
}

/** @template T @param {readonly T[]} list @returns {T} */
function pick(list) {
  return list[randomInt(0, list.length - 1)];
}

/**
 * A delay that feels like a person reacting: log-uniform between min and max,
 * so short waits are common and long ones still happen.
 * @param {number} minMs @param {number} maxMs
 */
export function humanDelay(minMs, maxMs) {
  const lo = Math.log(minMs);
  const hi = Math.log(maxMs);
  return Math.round(Math.exp(lo + rand() * (hi - lo)));
}

/**
 * Gap before the next background ghost action. Mostly exponential around a
 * minute (a Poisson process reads as natural), with occasional bursts where
 * one action follows another within seconds.
 */
export function nextTickDelay() {
  if (rand() < 0.2) return randomInt(4_000, 15_000);
  const exp = -Math.log(1 - rand()) * 55_000;
  return Math.min(4 * MINUTE, Math.max(12_000, Math.round(exp)));
}

/** @param {number} ms */
function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** A departure time weighted toward the hours people actually fly. */
function departTime() {
  const hour = pick([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 16, 17, 17, 18, 19, 20, 21]);
  const minute = pick([0, 10, 15, 20, 30, 40, 45, 50]);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

// ── Identity helpers ─────────────────────────────────────────────────────────

/** @param {string} email */
function emailDomain(email) {
  return email.slice(email.lastIndexOf("@") + 1);
}

/** @param {number} userId @returns {string | null} */
function emailOf(userId) {
  const row = /** @type {{ email: string } | undefined} */ (
    db.prepare("SELECT email FROM users WHERE id = ?").get(userId)
  );
  return row ? row.email : null;
}

/** @param {number} userId */
export function isGhost(userId) {
  const email = emailOf(userId);
  return email != null && emailDomain(email) === GHOST_DOMAIN;
}

/** @param {number} userId */
export function isVisitor(userId) {
  const email = emailOf(userId);
  return email != null && emailDomain(email) === VISITOR_DOMAIN;
}

/** @returns {{ id: number, display_name: string }[]} */
function ghosts() {
  return /** @type {{ id: number, display_name: string }[]} */ (
    db.prepare("SELECT id, display_name FROM users WHERE email LIKE ?").all(`%@${GHOST_DOMAIN}`)
  );
}

/** Bind a server-generated did:key to a synthetic user so issuance can reach them. */
function bindGeneratedDid(userId) {
  const { publicKey } = generateEd25519Keypair();
  const did = pubKeyToDidKey(pubKeyRawBytes(publicKey));
  db.prepare(
    `INSERT INTO user_dids (user_id, did, bound_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO NOTHING`,
  ).run(userId, did, Date.now());
}

/**
 * @param {{ email: string, displayName: string, contactMethod: string | null, createdAt: number }} u
 */
function insertUser(u) {
  db.prepare(`INSERT INTO allowlist_hashes (email_hash, added_at) VALUES (?, ?)`).run(
    hashEmailForAllowlist(u.email),
    u.createdAt,
  );
  const r = db
    .prepare(
      `INSERT INTO users (email, display_name, contact_method, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(u.email, u.displayName, u.contactMethod, u.createdAt, u.createdAt);
  return Number(r.lastInsertRowid);
}

// ── Seeding ──────────────────────────────────────────────────────────────────

/**
 * @typedef {{ id: number, posterId: number, kind: string, seats: number, createdAt: number }} SeededRide
 */

/**
 * Event dates as "two weeks from today", so the live demo never shows a past
 * event. Written as config overrides, the same mechanism /admin/config uses.
 */
function shiftEventDatesToUpcoming() {
  const start = Date.now() + 14 * DAY;
  setOverrides([
    ["dates.start", isoDate(start)],
    ["dates.end", isoDate(start + 2 * DAY)],
  ]);
}

/** @returns {{ id: number, lat: number, lng: number }[]} */
function meetupPins() {
  return /** @type {{ id: number, lat: number, lng: number }[]} */ (
    db.prepare("SELECT id, lat, lng FROM meetups").all()
  );
}

/**
 * Post one ride as `posterId`, with plausible details for the current event.
 * @param {number} posterId
 * @param {{ createdAt?: number, kind?: "offer" | "request", direction?: "to_venue" | "from_venue" }} [opts]
 */
function postGhostRide(posterId, opts = {}) {
  const event = getEventConfig();
  const airport = pick(event.airports);
  const kind = opts.kind || (rand() < 0.6 ? "offer" : "request");
  // About one offer in four is a group without a car: a shared taxi or a
  // transit trip that anyone can join.
  /** @type {"car" | "taxi" | "transit"} */
  const mode = kind === "offer" && rand() < 0.25 ? pick(["taxi", "taxi", "transit"]) : "car";
  const direction = opts.direction || (rand() < 0.5 ? "to_venue" : "from_venue");
  const start = Date.parse(`${event.dates.start}T00:00:00Z`);
  const end = Date.parse(`${event.dates.end}T00:00:00Z`);
  const days = Math.max(1, Math.round((end - start) / DAY) + 1);
  // Arrivals cluster on day one, departures on the last day; both stay inside
  // the event so the browse page's date filter can reach every ride.
  const dayOffset = Math.min(
    days - 1,
    Math.max(
      0,
      direction === "to_venue" ? pick([0, 0, 0, 1]) : pick([days - 1, days - 1, days - 2]),
    ),
  );
  const pins = meetupPins();
  const meetup = direction === "from_venue" && pins.length && rand() < 0.4 ? pick(pins) : null;
  const id = createRide({
    userId: posterId,
    kind,
    direction,
    airport: airport.code,
    otherPlace: null,
    departDate: isoDate(start + dayOffset * DAY),
    departTime: departTime(),
    flexMinutes: pick([0, 15, 15, 30, 30, 60]),
    seats: mode !== "car" ? randomInt(2, 4) : kind === "offer" ? randomInt(1, 4) : randomInt(1, 2),
    notes:
      mode === "taxi"
        ? pick(TAXI_NOTES)
        : mode === "transit"
          ? pick(TRANSIT_NOTES)
          : kind === "offer"
            ? pick(OFFER_NOTES)
            : pick(REQUEST_NOTES),
    mode,
    // Some posts mention luggage or accessibility, so the filters have hits.
    features:
      rand() < 0.35
        ? [pick(["big_luggage", "big_luggage", "wheelchair", "quiet", "child_seat"])]
        : [],
    meetupId: meetup ? meetup.id : null,
    pickupLat: meetup ? meetup.lat : airport.lat,
    pickupLng: meetup ? meetup.lng : airport.lng,
  });
  if (opts.createdAt) {
    db.prepare("UPDATE rides SET created_at = ?, updated_at = ? WHERE id = ?").run(
      opts.createdAt,
      opts.createdAt,
      id,
    );
  }
  return id;
}

/**
 * Seed synthetic attendees, rides and claims.
 *
 * @param {{
 *   attendees?: number, rides?: number, claims?: number,
 *   live?: boolean,  // demo mode: upcoming dates, bound DIDs, issued credentials, spread-out history
 * }} [opts]
 */
export function seedDemoData(opts = {}) {
  const attendeeCount = opts.attendees ?? 18;
  const rideCount = opts.rides ?? 13;
  const claimCount = opts.claims ?? 6;
  const live = !!opts.live;
  const now = Date.now();
  // Live demo history is spread over the last three days so "posted 2h ago"
  // reads like a real board; a dry run keeps everything at "now".
  const past = () => (live ? now - humanDelay(10 * MINUTE, 3 * DAY) : now);

  if (live) shiftEventDatesToUpcoming();

  const seeded = tx(() => {
    /** @type {number[]} */
    const users = [];
    const usedNames = new Set();
    for (let i = 0; users.length < attendeeCount && i < attendeeCount * 10; i++) {
      const first = pick(FIRST_NAMES);
      const last = pick(LAST_NAMES);
      if (usedNames.has(`${first} ${last}`)) continue;
      usedNames.add(`${first} ${last}`);
      const id = insertUser({
        email: `${first}.${last}.${i}@${GHOST_DOMAIN}`.toLowerCase(),
        displayName: `${first} ${last}`,
        contactMethod: pick(CONTACT_METHODS),
        createdAt: past(),
      });
      db.prepare("UPDATE users SET bio = ?, affiliation = ?, listed = 1 WHERE id = ?").run(
        pick(GHOST_BIOS),
        pick(GHOST_AFFILIATIONS),
        id,
      );
      if (live) bindGeneratedDid(id);
      users.push(id);
    }

    /** @type {SeededRide[]} */
    const rides = [];
    for (let i = 0; i < rideCount; i++) {
      const posterId = pick(users);
      const createdAt = past();
      const id = postGhostRide(posterId, { createdAt });
      const row = /** @type {{ kind: string, seats: number }} */ (
        db.prepare("SELECT kind, seats FROM rides WHERE id = ?").get(id)
      );
      rides.push({ id, posterId, kind: row.kind, seats: row.seats, createdAt });
    }

    return { users, rides };
  });

  // Claims go through createClaim/decideClaim, which open their own
  // transactions (and SQLite has no nesting), so they run after the commit.
  /** @type {{ rideId: number, posterId: number, claimerId: number, decidedAt: number }[]} */
  const accepted = [];
  let claims = 0;
  const { users, rides } = seeded;
  for (const ride of [...rides].sort(() => rand() - 0.5)) {
    if (claims >= claimCount) break;
    const claimerId = pick(users.filter((u) => u !== ride.posterId));
    if (claimerId == null) continue;
    let claimId;
    try {
      claimId = createClaim({
        rideId: ride.id,
        claimerId,
        seats: 1,
        message: pick(CLAIM_MESSAGES),
      });
    } catch {
      continue; // ride closed or already claimed by this user
    }
    claims++;
    // A claim follows its ride; in a dry run everything is "now".
    const at = live ? Math.min(now, ride.createdAt + humanDelay(5 * MINUTE, 12 * HOUR)) : now;
    db.prepare("UPDATE claims SET created_at = ? WHERE id = ?").run(at, claimId);
    if (rand() < 0.5) {
      try {
        decideClaim(claimId, ride.posterId, "accepted");
        const decidedAt = Math.min(now, at + humanDelay(5 * MINUTE, 6 * HOUR));
        db.prepare("UPDATE claims SET decided_at = ? WHERE id = ?").run(decidedAt, claimId);
        accepted.push({ rideId: ride.id, posterId: ride.posterId, claimerId, decidedAt });
      } catch {
        // capacity reached; leave the claim pending
      }
    }
  }

  // Credentials between ghosts, so ride cards carry trust badges from the start.
  // Outside the seeding transaction: issuance signs and writes its own rows.
  let credentials = 0;
  if (live) {
    for (const pair of accepted.slice(0, Math.ceil(accepted.length * 0.7))) {
      confirmRide({ rideId: pair.rideId, userId: pair.posterId });
      const r = confirmRide({ rideId: pair.rideId, userId: pair.claimerId });
      credentials += r.issuedCredentialIds.length;
      // Backdate the record (not the signed JWT) so the activity feed reads as history.
      const at = Math.min(now, pair.decidedAt + humanDelay(2 * MINUTE, 12 * HOUR));
      for (const id of r.issuedCredentialIds) {
        db.prepare("UPDATE credentials_issued SET issued_at = ? WHERE id = ?").run(at, id);
      }
    }
  }

  audit({
    actorId: null,
    actorEmail: null,
    action: "demo.seed",
    detail: `seeded ${seeded.users.length} attendees, ${seeded.rides.length} rides, ${claims} claims, ${credentials} credentials (synthetic demo data, not real signups)`,
  });
  return {
    attendees: seeded.users.length,
    rides: seeded.rides.length,
    claims,
    credentials,
  };
}

/**
 * Seed the live demo once per database. Called at boot when DEMO_MODE is on.
 * Throws if the database holds anyone but demo accounts: demo sign-in is open
 * to the public, and every visitor would see those attendees' rides.
 */
export function ensureDemoSeeded() {
  const real = /** @type {{ c: number }} */ (
    db
      .prepare(
        `SELECT COUNT(*) AS c FROM users
          WHERE email NOT LIKE ? AND email NOT LIKE ? AND email != ?`,
      )
      .get(`%@${GHOST_DOMAIN}`, `%@${VISITOR_DOMAIN}`, DEMO_ORGANIZER_EMAIL)
  ).c;
  if (real > 0) {
    throw new Error(
      `DEMO_MODE refused: ${config.databasePath} has ${real} real attendee account(s). ` +
        "Point DATABASE_PATH at a separate demo database.",
    );
  }
  if (ghosts().length > 0) return;
  const r = seedDemoData({ attendees: 26, rides: 24, claims: 16, live: true });
  info(
    `[demo] seeded ${r.attendees} ghost attendees, ${r.rides} rides, ${r.claims} claims, ${r.credentials} credentials`,
  );
}

// ── Visitor sign-in ──────────────────────────────────────────────────────────

export class DemoSignInError extends Error {}

let lastVisitorActivity = 0;
function touch() {
  lastVisitorActivity = Date.now();
}

/**
 * Sign in to the live demo with one of the two published demo accounts.
 * The attendee account gives every visitor a fresh personal sandbox (a shared
 * login would put strangers in one another's rides); the organizer account is
 * shared and read-only (routes/admin.js refuses admin writes in demo mode).
 *
 * @param {string} email - DEMO_ATTENDEE_EMAIL or DEMO_ORGANIZER_EMAIL
 * @param {string} ip
 * @param {string} userAgent
 * @returns {{ sessionId: string, role: "attendee" | "organizer" }}
 */
export function signInDemo(email, ip, userAgent) {
  if (!config.demoMode) throw new DemoSignInError("Demo sign-in is not enabled.");
  const address = email.trim().toLowerCase();
  if (address !== DEMO_ATTENDEE_EMAIL && address !== DEMO_ORGANIZER_EMAIL) {
    throw new DemoSignInError(
      `This is the live demo: sign in as ${DEMO_ATTENDEE_EMAIL} or ${DEMO_ORGANIZER_EMAIL}.`,
    );
  }
  if (!rateLimit(`demo-signin:${ip}`, SIGNIN_LIMIT_PER_IP, HOUR).ok) {
    throw new DemoSignInError("Too many demo sign-ins from this address. Try again in a bit.");
  }
  touch();
  const now = Date.now();

  if (address === DEMO_ORGANIZER_EMAIL) {
    let row = /** @type {{ id: number } | undefined} */ (
      db.prepare("SELECT id FROM users WHERE email = ?").get(DEMO_ORGANIZER_EMAIL)
    );
    if (!row) {
      row = {
        id: insertUser({
          email: DEMO_ORGANIZER_EMAIL,
          displayName: "Demo Organizer",
          contactMethod: null,
          createdAt: now,
        }),
      };
    }
    audit({ actorId: row.id, actorEmail: DEMO_ORGANIZER_EMAIL, action: "demo.signin", ip });
    return { sessionId: createSession(row.id, userAgent), role: "organizer" };
  }

  const visitors = /** @type {{ c: number }} */ (
    db.prepare("SELECT COUNT(*) AS c FROM users WHERE email LIKE ?").get(`%@${VISITOR_DOMAIN}`)
  ).c;
  if (visitors >= MAX_VISITORS) {
    throw new DemoSignInError("The demo is full right now. It resets on its next restart.");
  }
  const tag = randomBytes(6).toString("hex");
  const userId = insertUser({
    email: `guest-${tag}@${VISITOR_DOMAIN}`,
    displayName: `Guest ${pick(FIRST_NAMES)}`,
    contactMethod: "Demo account (no real contact)",
    createdAt: now,
  });
  audit({ actorId: userId, actorEmail: null, action: "demo.signin", ip });
  try {
    setUpVisitor(userId);
  } catch (err) {
    warn("demo visitor setup failed", { component: "demo", err });
  }
  return { sessionId: createSession(userId, userAgent), role: "attendee" };
}

/**
 * Give a new visitor something already in motion: one ride of their own with a
 * ghost asking for a seat, and one accepted seat in a ghost's car that the
 * ghost has already confirmed, one tap away from a credential.
 * @param {number} userId
 */
function setUpVisitor(userId) {
  const event = getEventConfig();
  const crowd = ghosts();
  if (crowd.length === 0) return;

  const ownRide = createRide({
    userId,
    kind: "offer",
    direction: "from_venue",
    airport: event.airports[0].code,
    otherPlace: null,
    departDate: event.dates.end,
    departTime: "16:30",
    flexMinutes: 30,
    seats: 3,
    notes: "Heading to the airport after closing circle. Room for bags.",
    pickupLat: event.venue.lat,
    pickupLng: event.venue.lng,
  });
  const asker = pick(crowd);
  const askId = createClaim({
    rideId: ownRide,
    claimerId: asker.id,
    seats: 1,
    message: "Would love a seat, my flight is at 7:40pm.",
  });
  db.prepare("UPDATE claims SET created_at = ? WHERE id = ?").run(
    Date.now() - randomInt(1, 4) * MINUTE,
    askId,
  );

  // A seat in a ghost's car, already accepted and confirmed by the driver.
  const offer = /** @type {{ id: number, user_id: number } | undefined} */ (
    db
      .prepare(
        `SELECT r.id, r.user_id FROM rides r JOIN users u ON u.id = r.user_id
          WHERE r.status = 'open' AND r.kind = 'offer' AND r.direction = 'to_venue'
            AND u.email LIKE ?
            AND r.seats > COALESCE((SELECT SUM(seats) FROM claims c
                                     WHERE c.ride_id = r.id AND c.status = 'accepted'), 0)
          ORDER BY RANDOM() LIMIT 1`,
      )
      .get(`%@${GHOST_DOMAIN}`)
  );
  const driverRide = offer
    ? offer.id
    : postGhostRide(pick(crowd).id, { kind: "offer", direction: "to_venue" });
  const driverId = offer
    ? offer.user_id
    : /** @type {{ user_id: number }} */ (
        db.prepare("SELECT user_id FROM rides WHERE id = ?").get(driverRide)
      ).user_id;
  const seatId = createClaim({
    rideId: driverRide,
    claimerId: userId,
    seats: 1,
    message: "Landing mid-afternoon, a seat would be great.",
  });
  decideClaim(seatId, driverId, "accepted");
  confirmRide({ rideId: driverRide, userId: driverId });
}

// ── Ghost reactions to visitors ──────────────────────────────────────────────

/** @param {() => void} fn @param {number} ms */
function later(fn, ms) {
  setTimeout(() => {
    try {
      fn();
    } catch (err) {
      // Expected when the visitor withdrew, cancelled or filled the ride first.
      info(`[demo] skipped ghost reaction: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, ms).unref();
}

/**
 * A visitor claimed a seat. If a ghost posted the ride, the ghost accepts after
 * a human pause: usually under half a minute, occasionally longer.
 * @param {number} claimId
 */
export function onClaimCreated(claimId) {
  if (!config.demoMode) return;
  const row =
    /** @type {{ claimer_id: number, poster_id: number, ride_id: number, status: string } | undefined} */ (
      db
        .prepare(
          `SELECT c.claimer_id, c.ride_id, c.status, r.user_id AS poster_id FROM claims c
           JOIN rides r ON r.id = c.ride_id WHERE c.id = ?`,
        )
        .get(claimId)
    );
  if (!row || !isVisitor(row.claimer_id) || !isGhost(row.poster_id)) return;
  touch();
  // Groups accept on join; a driver accepts after a pause. Either way the
  // ghost then sends a trip update a little later, so the visitor sees one.
  const accepted = row.status === "accepted" ? 0 : humanDelay(4_000, 45_000);
  if (row.status === "pending")
    later(() => decideClaim(claimId, row.poster_id, "accepted"), accepted);
  later(() => ghostUpdate(row.ride_id, row.poster_id), accepted + humanDelay(20_000, 70_000));
}

/** A ghost on a ride posts a trip update and its partners hear about it. */
function ghostUpdate(rideId, ghostId) {
  const [status, minutes, note] = pick(STATUS_UPDATES);
  postRideUpdate({ rideId, userId: ghostId, status, minutes, note });
  const name = /** @type {{ display_name: string | null } | undefined} */ (
    db.prepare("SELECT display_name FROM users WHERE id = ?").get(ghostId)
  )?.display_name;
  const text = {
    on_time: "On time",
    early: "Running early",
    late: "Running late",
    missed: "Missed a connection",
    arrived: "Arrived",
  }[status];
  notifyRide(
    rideId,
    "ride-status",
    {
      rideId,
      userId: ghostId,
      name: name || "A ride partner",
      status,
      text: minutes ? `${text} (${minutes} min)` : text,
      note,
    },
    ghostId,
  );
}

/**
 * A visitor posted a ride. A ghost asks for a seat within a minute or so, and
 * sometimes a second one shows up a few minutes later.
 * @param {number} rideId
 */
export function onRideCreated(rideId) {
  if (!config.demoMode) return;
  const ride = /** @type {{ user_id: number } | undefined} */ (
    db.prepare("SELECT user_id FROM rides WHERE id = ?").get(rideId)
  );
  if (!ride || !isVisitor(ride.user_id)) return;
  touch();
  const claim = () => {
    const status = /** @type {{ status: string } | undefined} */ (
      db.prepare("SELECT status FROM rides WHERE id = ?").get(rideId)
    );
    if (status?.status !== "open") return;
    const already = new Set(
      /** @type {{ claimer_id: number }[]} */ (
        db.prepare("SELECT claimer_id FROM claims WHERE ride_id = ?").all(rideId)
      ).map((c) => c.claimer_id),
    );
    const candidates = ghosts().filter((g) => !already.has(g.id));
    if (candidates.length === 0) return;
    const ghost = pick(candidates);
    const claimId = createClaim({
      rideId,
      claimerId: ghost.id,
      seats: 1,
      message: pick(CLAIM_MESSAGES),
    });
    // Joining a visitor's group needs no approval, so the new member can say
    // how their trip is going straight away.
    const joined = /** @type {{ status: string } | undefined} */ (
      db.prepare("SELECT status FROM claims WHERE id = ?").get(claimId)
    );
    if (joined?.status === "accepted") {
      later(() => ghostUpdate(rideId, ghost.id), humanDelay(20_000, 70_000));
    }
  };
  later(claim, humanDelay(10_000, 75_000));
  if (rand() < 0.45) later(claim, humanDelay(2 * MINUTE, 6 * MINUTE));
}

/**
 * A visitor tapped "I made this ride". Ghost counterparts confirm too, at once,
 * so the response that reports the visitor's confirmation can already carry
 * the issued credential.
 * @param {number} rideId
 * @param {number} userId
 * @param {{ recorded: boolean, dualConfirmed: boolean, issuedCredentialIds: string[] }} result
 */
export function onRideConfirmed(rideId, userId, result) {
  if (!config.demoMode || !isVisitor(userId)) return result;
  touch();
  const ride = /** @type {{ user_id: number } | undefined} */ (
    db.prepare("SELECT user_id FROM rides WHERE id = ?").get(rideId)
  );
  if (!ride) return result;
  const counterparts =
    ride.user_id === userId
      ? /** @type {{ claimer_id: number }[]} */ (
          db
            .prepare("SELECT claimer_id FROM claims WHERE ride_id = ? AND status = 'accepted'")
            .all(rideId)
        ).map((c) => c.claimer_id)
      : [ride.user_id];
  const issued = [...result.issuedCredentialIds];
  let dualConfirmed = result.dualConfirmed;
  for (const ghostId of counterparts.filter(isGhost)) {
    const r = confirmRide({ rideId, userId: ghostId });
    issued.push(...r.issuedCredentialIds);
    dualConfirmed = dualConfirmed || r.dualConfirmed;
  }
  return { ...result, dualConfirmed, issuedCredentialIds: [...new Set(issued)] };
}

// ── Background ghost activity ────────────────────────────────────────────────

/**
 * First row of a query whose selected columns are all integers (ids, counts).
 * @param {string} sql @param {...(string|number)} args
 */
function oneRow(sql, ...args) {
  return /** @type {Record<string, number> | undefined} */ (db.prepare(sql).get(...args));
}

const ACTIONS = [
  { weight: 34, run: ghostPostsRide },
  { weight: 26, run: ghostClaimsRide },
  { weight: 22, run: ghostAcceptsClaim },
  { weight: 10, run: ghostsConfirmRide },
  { weight: 8, run: ghostRetiresRide },
  { weight: 12, run: ghostPostsStatus },
];

function ghostPostsStatus() {
  const row = oneRow(
    `SELECT c.ride_id, r.user_id AS poster_id, c.claimer_id FROM claims c
       JOIN rides r ON r.id = c.ride_id JOIN users u ON u.id = r.user_id
      WHERE c.status = 'accepted' AND r.status != 'cancelled' AND u.email LIKE ?
      ORDER BY RANDOM() LIMIT 1`,
    `%@${GHOST_DOMAIN}`,
  );
  if (row) ghostUpdate(row.ride_id, row.poster_id);
}

function ghostPostsRide() {
  const open = oneRow(
    `SELECT COUNT(*) AS c FROM rides r JOIN users u ON u.id = r.user_id
      WHERE r.status = 'open' AND u.email LIKE ?`,
    `%@${GHOST_DOMAIN}`,
  );
  if ((open?.c ?? 0) >= MAX_OPEN_GHOST_RIDES) return ghostRetiresRide();
  postGhostRide(pick(ghosts()).id);
}

function ghostClaimsRide() {
  // Prefer rides visitors posted that nobody has asked about yet.
  const target =
    oneRow(
      `SELECT r.id, r.user_id FROM rides r JOIN users u ON u.id = r.user_id
        WHERE r.status = 'open' AND u.email LIKE ?
          AND NOT EXISTS (SELECT 1 FROM claims c WHERE c.ride_id = r.id)
        ORDER BY RANDOM() LIMIT 1`,
      `%@${VISITOR_DOMAIN}`,
    ) ||
    oneRow(
      `SELECT r.id, r.user_id FROM rides r JOIN users u ON u.id = r.user_id
        WHERE r.status = 'open' AND u.email LIKE ? ORDER BY RANDOM() LIMIT 1`,
      `%@${GHOST_DOMAIN}`,
    );
  if (!target) return;
  const claimer = pick(ghosts().filter((g) => g.id !== target.user_id));
  createClaim({
    rideId: target.id,
    claimerId: claimer.id,
    seats: 1,
    message: pick(CLAIM_MESSAGES),
  });
}

function ghostAcceptsClaim() {
  const pending = oneRow(
    `SELECT c.id, r.user_id AS poster_id FROM claims c
       JOIN rides r ON r.id = c.ride_id JOIN users u ON u.id = r.user_id
      WHERE c.status = 'pending' AND u.email LIKE ?
      ORDER BY RANDOM() LIMIT 1`,
    `%@${GHOST_DOMAIN}`,
  );
  if (pending) decideClaim(pending.id, pending.poster_id, "accepted");
}

function ghostsConfirmRide() {
  const pair = oneRow(
    `SELECT c.ride_id, c.claimer_id, r.user_id AS poster_id FROM claims c
       JOIN rides r ON r.id = c.ride_id
       JOIN users p ON p.id = r.user_id JOIN users q ON q.id = c.claimer_id
      WHERE c.status = 'accepted' AND p.email LIKE ?1 AND q.email LIKE ?1
        AND NOT EXISTS (SELECT 1 FROM credentials_issued ci WHERE ci.claim_id = c.id)
      ORDER BY RANDOM() LIMIT 1`,
    `%@${GHOST_DOMAIN}`,
  );
  if (!pair) return;
  confirmRide({ rideId: pair.ride_id, userId: pair.poster_id });
  confirmRide({ rideId: pair.ride_id, userId: pair.claimer_id });
}

function ghostRetiresRide() {
  const old = oneRow(
    `SELECT r.id, r.user_id FROM rides r JOIN users u ON u.id = r.user_id
      WHERE r.status = 'open' AND u.email LIKE ?
        AND NOT EXISTS (SELECT 1 FROM claims c WHERE c.ride_id = r.id AND c.status = 'accepted')
      ORDER BY r.created_at ASC LIMIT 1`,
    `%@${GHOST_DOMAIN}`,
  );
  if (old) updateRideStatus(old.id, old.user_id, "cancelled");
}

function tick() {
  if (Date.now() - lastVisitorActivity <= ACTIVE_WINDOW_MS && ghosts().length > 1) {
    const total = ACTIONS.reduce((s, a) => s + a.weight, 0);
    let roll = rand() * total;
    let action = ACTIONS[0];
    for (const a of ACTIONS) {
      roll -= a.weight;
      if (roll < 0) {
        action = a;
        break;
      }
    }
    try {
      action.run();
    } catch (err) {
      info(`[demo] ghost action skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  setTimeout(tick, nextTickDelay()).unref();
}

/**
 * Start the background loop. Idle while no visitor has acted recently, so an
 * always-on demo does not grow its database with nobody watching.
 */
export function startGhostActivity() {
  if (!config.demoMode) return;
  setTimeout(tick, nextTickDelay()).unref();
}

// ── What the demo pages show ─────────────────────────────────────────────────

/**
 * @typedef {{ kind: "ride" | "claim" | "match" | "credential", at: number,
 *   who: string, rideKind: string, direction: string, airport: string, mine: boolean }} ActivityItem
 */

/**
 * The most recent things that happened on the board, newest first.
 * @param {number} viewerId
 * @param {number} [limit]
 * @returns {ActivityItem[]}
 */
export function recentActivity(viewerId, limit = 6) {
  const rows = /** @type {{ kind: ActivityItem["kind"], at: number, who: string | null,
    uid: number, ride_kind: string, direction: string, airport: string }[]} */ (
    db
      .prepare(
        `SELECT * FROM (
           SELECT 'ride' AS kind, r.created_at AS at, u.display_name AS who, u.id AS uid,
                  r.kind AS ride_kind, r.direction, r.airport
             FROM rides r JOIN users u ON u.id = r.user_id
           UNION ALL
           SELECT 'claim', c.created_at, u.display_name, u.id, r.kind, r.direction, r.airport
             FROM claims c JOIN users u ON u.id = c.claimer_id JOIN rides r ON r.id = c.ride_id
           UNION ALL
           SELECT 'match', c.decided_at, u.display_name, u.id, r.kind, r.direction, r.airport
             FROM claims c JOIN rides r ON r.id = c.ride_id JOIN users u ON u.id = r.user_id
            WHERE c.status = 'accepted' AND c.decided_at IS NOT NULL
           UNION ALL
           SELECT 'credential', ci.issued_at, u.display_name, u.id, r.kind, r.direction, r.airport
             FROM credentials_issued ci JOIN users u ON u.id = ci.subject_user_id
             JOIN rides r ON r.id = ci.ride_id
         ) WHERE at <= ? ORDER BY at DESC LIMIT ?`,
      )
      .all(Date.now(), limit)
  );
  return rows.map((r) => ({
    kind: r.kind,
    at: r.at,
    who: r.uid === viewerId ? "You" : r.who || "Someone",
    rideKind: r.ride_kind,
    direction: r.direction,
    airport: r.airport,
    mine: r.uid === viewerId,
  }));
}

/**
 * Where a visitor is in the guided tour.
 * @param {number} userId
 */
export function tourState(userId) {
  const did = db.prepare("SELECT 1 FROM user_dids WHERE user_id = ?").get(userId);
  const seat = /** @type {{ ride_id: number, driver: string } | undefined} */ (
    db
      .prepare(
        `SELECT r.id AS ride_id, u.display_name AS driver FROM claims c
           JOIN rides r ON r.id = c.ride_id JOIN users u ON u.id = r.user_id
          WHERE c.claimer_id = ? AND c.status = 'accepted'
          ORDER BY c.decided_at ASC LIMIT 1`,
      )
      .get(userId)
  );
  const confirmed = seat
    ? !!oneRow(
        "SELECT 1 FROM ride_confirmations WHERE ride_id = ? AND user_id = ?",
        seat.ride_id,
        userId,
      )
    : false;
  const credentials = oneRow(
    "SELECT COUNT(*) AS c FROM credentials_issued WHERE subject_user_id = ?",
    userId,
  );
  const ownRide = oneRow(
    `SELECT r.id, (SELECT COUNT(*) FROM claims c WHERE c.ride_id = r.id AND c.status = 'pending') AS pending
       FROM rides r WHERE r.user_id = ? AND r.status != 'cancelled' ORDER BY r.created_at ASC LIMIT 1`,
    userId,
  );
  return {
    didBound: !!did,
    seatRideId: seat ? Number(seat.ride_id) : null,
    driver: seat ? String(seat.driver) : null,
    confirmed,
    credentialCount: Number(credentials?.c ?? 0),
    ownRideId: ownRide ? Number(ownRide.id) : null,
    pendingOnOwnRide: Number(ownRide?.pending ?? 0),
  };
}
