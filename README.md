<div align="center">

# Event Rideshare

**A self-hosted, zero-dependency ride-sharing platform for conference and event attendees.**

Deploy in one command. Run it for the event. Shut it down after.

[![Node 22.5+](https://img.shields.io/badge/node-%E2%89%A522.5-brightgreen)](#requirements)
[![Zero Dependencies](https://img.shields.io/badge/npm%20deps-0-blue)](#why-zero-dependencies)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](./LICENSE)
[![CI](https://github.com/dcondrey/rideshare/actions/workflows/ci.yml/badge.svg)](https://github.com/dcondrey/rideshare/actions/workflows/ci.yml)

</div>

---

## Why does this exist?

Every conference has the same problem: hundreds of attendees flying into the same airports, heading to the same venue, on the same dates, and nobody coordinates. People pay for solo rideshares, miss connections, and waste money.

Event Rideshare gives organizers a private, self-hosted coordination tool they can spin up in minutes, brand for their event, and tear down when it's over. No accounts to create, no app to install, no vendor lock-in, no data left behind.

## How it works

```
  Attendee signs in           Posts or browses rides         Claims a ride
  with magic link     →     (offering or requesting)    →    and gets matched
       |                           |                              |
  Email on allowlist?        Airport, date, time,         Poster accepts/declines.
  Rate-limited, no           seats, meetup pin,           Both sides see contact
  enumeration possible.      notes, flexibility.          info only after match.
```

1. **Sign in** with a registered email (passwordless magic link).
2. **Post** a ride you're offering or requesting: airport, date, time, seats, notes, and optional pickup location.
3. **Browse and claim** rides from other attendees. When a poster accepts, both sides exchange contact details.
4. **View the map** with the venue, meetup spots, and all active rides pinned at their pickup locations.
5. **Organizers** get a privacy-safe insights dashboard: engagement, match rates, unmet demand by airport/date, and CSV export.

## Features

| Category | Details |
|---|---|
| **Zero dependencies** | No `npm install`. Just Node >=22.5 and a single process. No build step. |
| **Self-contained** | One Node process + one SQLite file. Nothing else to provision. |
| **Privacy-first** | Emails stored as one-way HMAC hashes. No trackers. No third-party JS. Aggregate-only analytics with k-anonymity. |
| **Interactive map** | Custom slippy-map renderer (12KB vanilla JS). Pan, zoom, pinch, markers with popups. Five tile styles built in. |
| **Portable trust** | W3C Verifiable Credentials: confirmed rides mint VCs that travel with users across events. Each deployment is a `did:web` issuer; each user is a `did:key` holder. See [TRUST.md](./TRUST.md). |
| **One-click deploy** | Docker, Railway, Render, Fly.io, or any VPS. |
| **Event-agnostic** | Name, dates, venue, airports, brand color, logo, meetup pins, all configurable in one YAML file or live via the admin UI. |
| **Admin dashboard** | Allowlist management, event config editor, insights with CSV export, audit log, meetup/logo management. |
| **Dark mode** | Automatic, based on system preference. |

---

## Quick start

```bash
git clone https://github.com/dcondrey/rideshare.git
cd rideshare
cp .env.example .env
```

Generate secrets and edit `.env`:

```bash
# Paste each output into .env:
openssl rand -hex 32    # → SESSION_SECRET
openssl rand -hex 32    # → ALLOWLIST_SALT

# Then set:
#   ADMIN_EMAILS=you@example.com
#   RESEND_API_KEY=re_xxx  (or SMTP_* vars)
#   EMAIL_FROM="Rideshare <noreply@yourdomain.com>"
```

Start the server:

```bash
npm start
# → http://localhost:3000
```

For development with auto-reload:

```bash
npm run dev
```

### First-run checklist

1. Open `http://localhost:3000` and sign in with your admin email.
2. Go to `/admin/allowlist` and upload your attendee CSV.
3. Customize your event at `/admin/config` (or edit `event.config.yaml`).
4. Share the URL with attendees.

### Requirements

- **Node.js 22.5+** (for the built-in `node:sqlite` module; stable in Node 24+)
- An email provider: [Resend](https://resend.com) (free tier, recommended) or any SMTP server

---

## Deploy

### Docker

```bash
cp .env.example .env    # edit with your values
docker compose up -d
```

SQLite lives in a named volume (`rideshare-data`). Back it up with:

```bash
docker run --rm -v rideshare-data:/data -v $PWD:/out alpine \
  tar czf /out/backup.tgz /data
```

### Railway

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/YOUR-TEMPLATE-ID)

1. Add a **Volume** mounted at `/data`.
2. Set environment variables in the Railway UI:

| Variable | Value |
|---|---|
| `APP_URL` | `https://your-app.up.railway.app` |
| `SESSION_SECRET` | 32-byte hex (use Railway's "generate") |
| `ALLOWLIST_SALT` | 32-byte hex |
| `ADMIN_EMAILS` | `you@example.com` |
| `RESEND_API_KEY` | `re_xxx` |
| `EMAIL_FROM` | `"Rideshare <noreply@yourdomain.com>"` |
| `TRUST_PROXY` | `true` |

### Render

Push to GitHub, then in Render: **New > Blueprint** and point at this repo. The included `render.yaml` provisions the service, a 1GB disk for SQLite, and prompts for secrets.

### Fly.io

```bash
fly launch --copy-config --name your-app
fly volumes create data --size 1 --region iad
fly secrets set \
  SESSION_SECRET=$(openssl rand -hex 32) \
  ALLOWLIST_SALT=$(openssl rand -hex 32) \
  ADMIN_EMAILS=you@example.com \
  RESEND_API_KEY=re_xxx \
  EMAIL_FROM='"Rideshare <noreply@yourdomain.com>"' \
  APP_URL=https://your-app.fly.dev \
  TRUST_PROXY=true
fly deploy
```

---

## Configuration

All event configuration lives in **`event.config.yaml`** at the project root. Edit it once before deploy, or change most fields live via `/admin/config` without restarting. JSON is also accepted (`event.config.json`).

<details>
<summary><strong>Full example configuration</strong></summary>

```yaml
name: IIW XL
longName: Internet Identity Workshop
tagline: Find a ride. Offer a seat. Get there together.

dates:
  start: 2026-04-21
  end: 2026-04-23

venue:
  name: Computer History Museum
  address: 1401 N Shoreline Blvd, Mountain View, CA
  lat: 37.4143
  lng: -122.0773

airports:
  - code: SFO
    name: San Francisco Intl
    lat: 37.6213
    lng: -122.3790
  - code: SJC
    name: San Jose Mineta Intl
    lat: 37.3639
    lng: -121.9289

meetups:
  - name: Hotel Avante
    address: 860 E El Camino Real, Mountain View
    lat: 37.3989
    lng: -122.0822

map:
  style: voyager
  defaultZoom: 11
  customTileUrl: ""
  customAttribution: ""

brand:
  primaryColor: "#2563eb"
  logoPath: null

registrationUrl: https://internetidentityworkshop.com
supportEmail: support@example.com
```

</details>

### Logo

Upload via the admin UI at `/admin/config` (stored in DB, max 200KB; SVG/PNG/WebP/JPEG, served from `/logo`), or drop a file in `public/` and set `brand.logoPath` in config. Upload takes priority.

### Map styles

| Style | Look | API Key |
|---|---|---|
| **`voyager`** (default) | Flat retro warm palette | No |
| `positron` | Bright minimal grayscale | No |
| `dark-matter` | Dark retro (matches dark mode) | No |
| `toner-lite` | Black and white | Stadia (may need key) |
| `osm` | Classic OpenStreetMap | No |
| `custom` | Your own tile URL | Depends on provider |

For Mapbox, MapTiler, or other paid providers, choose `custom` and set `map.customTileUrl` and `map.customAttribution`.

Riders can pin their pickup location by selecting a meetup spot, entering coordinates, or letting it default to the airport.

---

## Importing attendees

1. Sign in as admin and visit `/admin/allowlist`.
2. Upload or paste a CSV. Accepts a single column of emails, or any multi-column file with an `email` header.
3. Choose **Replace** (swap entire list) or **Append** (add to existing).

The CSV is never written to disk. Each email is normalized (lowercase, trimmed, Gmail dot/plus-tag stripped) and stored as `HMAC-SHA256(email, ALLOWLIST_SALT)`. Raw emails are never persisted.

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `APP_URL` | Yes | | Public URL the app is served from |
| `SESSION_SECRET` | Yes | | 32-byte hex; signs sessions and magic links |
| `ALLOWLIST_SALT` | Yes | | 32-byte hex; HMAC key for attendee emails |
| `ADMIN_EMAILS` | Yes | | Comma-separated admin email addresses |
| `EMAIL_FROM` | Yes | | RFC 5322 sender, e.g. `"Rideshare <noreply@x.com>"` |
| `RESEND_API_KEY` | One of | | [Resend](https://resend.com) API key (recommended) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE` | One of | | Bring-your-own SMTP |
| `PORT` | | `3000` | HTTP port |
| `DATABASE_PATH` | | `./data/app.db` | SQLite file path |
| `TRUST_PROXY` | | `false` | Set `true` behind a reverse proxy |
| `MAGIC_LINK_RATE_LIMIT` | | `5` | Max sign-in emails per address per hour |
| `SESSION_LIFETIME_DAYS` | | `14` | Session cookie lifetime |

---

## Operations

### Backups

```bash
sqlite3 ./data/app.db ".backup ./data/app.db.bak"
```

Also back up WAL files (`app.db-wal`, `app.db-shm`) if the server is running.

### Wiping after the event

Use **Allowlist > Wipe attendee data** in the admin UI. To remove everything (rides, claims, audit log), delete the SQLite file or the entire deployment.

### Updating

Pull the latest source, restart the process. Schema migrations are forward-compatible (`CREATE TABLE IF NOT EXISTS`, additive `ALTER`), so no manual migration step is needed.

---

## Why zero dependencies?

This is a deliberate architectural choice, not a stunt.

- **No supply chain risk.** No `node_modules`, no transitive dependencies, no advisory fatigue. The attack surface is this code and Node.js itself.
- **No build step.** Clone and run. No webpack, no transpiler, no bundler.
- **No version rot.** Nothing to update, audit, or pin. The app runs the same today as it will in five years on any Node >=22.5.
- **Instant deploy.** Docker image builds in seconds. CI runs in seconds. Cold starts are instant.
- **Auditability.** Every line of code is in this repo. Reviewers can read it all in an afternoon.

The tradeoffs are real (hand-rolled SMTP client, custom YAML parser, custom map renderer) but intentional. Each is <300 lines, tested, and does exactly what this app needs.

---

## Portable trust

Event Rideshare implements a decentralized trust system using W3C standards:

- Each deployment has a **`did:web`** identity (anchored at `/.well-known/did.json`).
- Each user generates a **`did:key`** (Ed25519) in their browser. The private key stays in IndexedDB.
- Confirmed rides mint **W3C Verifiable Credentials** (compact JWT, EdDSA-signed).
- Users carry credentials to other deployments, where signatures are verified against the original issuer's DID document.
- A public verifier playground at `/trust/verify` lets anyone inspect any credential.

No central registry. No proprietary format. No lock-in. See [TRUST.md](./TRUST.md) for the full protocol specification.

---

## Project layout

```
.
├── server.js                 # HTTP server, graceful shutdown
├── event.config.yaml         # Event-specific defaults
├── lib/
│   ├── config.js             # Env + YAML/JSON config loader
│   ├── db.js                 # SQLite schema, migrations, queries
│   ├── auth.js               # Magic-link auth + sessions
│   ├── rides.js              # Ride + claim business logic
│   ├── allowlist.js          # CSV parsing, hashed allowlist
│   ├── trust.js              # DID/VC issuance + verification
│   ├── vc.js                 # JWT signing/verification, JWS
│   ├── did.js                # DID generation + resolution
│   ├── crypto.js             # Ed25519, HMAC-SHA256, base58
│   ├── email.js              # Resend HTTP + SMTP client
│   ├── router.js             # HTTP router + middleware
│   ├── html.js               # Auto-escaping HTML templates
│   ├── validate.js           # Input validation
│   ├── rate-limit.js         # In-memory token bucket
│   ├── insights.js           # Privacy-safe aggregate metrics
│   ├── yaml.js               # Minimal YAML parser
│   ├── assets.js             # Logo upload/sanitization
│   ├── meetups.js            # Meetup CRUD
│   ├── map-styles.js         # Tile-style catalogue
│   └── event-config.js       # File defaults + DB overrides
├── routes/
│   ├── auth.js               # Sign-in, magic link, sign-out
│   ├── rides.js              # Browse, create, claim, manage
│   ├── admin.js              # Dashboard, allowlist, config, audit
│   ├── map.js                # Interactive map
│   ├── trust.js              # DID binding, VC issuance, verifier
│   ├── well-known.js         # /.well-known/did.json
│   └── static.js             # CSS, JS, fonts, favicon
├── public/
│   ├── styles.css            # Responsive UI + dark mode
│   ├── app.js                # Progressive enhancement
│   ├── map.js                # Custom slippy-map renderer
│   ├── trust.js              # Client-side DID/VC management
│   ├── favicon.svg
│   └── robots.txt
├── tests/                    # 18 test files, unit + integration
├── docs/
│   ├── code-reading-guide.md
│   ├── intentional-non-features.md
│   └── security/             # XSS, CSRF, SSRF, timing deep-dives
├── Dockerfile                # Single-stage, ~70MB, non-root
├── docker-compose.yml
├── railway.json
├── render.yaml
├── fly.toml
├── biome.json                # Lint + format rules
├── .github/workflows/ci.yml  # Tests, lint, type-check, security
├── SECURITY.md               # Threat model + mitigations
├── TRUST.md                  # Portable trust protocol spec
├── RUNBOOK.md                # Operations + troubleshooting
├── CONTRIBUTING.md            # How to contribute
└── CHANGELOG.md
```

---

## Security

Security is a core design constraint, not an afterthought. See [SECURITY.md](./SECURITY.md) and [THREAT_MODEL.md](./THREAT_MODEL.md) for the complete STRIDE analysis.

**Key protections:**

- **No plaintext emails.** Attendee emails are stored as one-way HMAC-SHA256 hashes. A stolen database reveals nothing.
- **No enumeration.** Magic-link endpoints return identical responses for on-list and off-list emails. Rate-limited per-email and per-IP.
- **No third-party code.** Zero client-side JS libraries. No external fonts, trackers, or analytics. CSP enforced to `default-src 'self'`.
- **Constant-time comparisons** for all secret-derived values.
- **Parameterized queries** everywhere. Zero SQL injection surface.
- **Opaque sessions.** Random tokens stored server-side, revocable instantly.
- **Audit log.** Every admin action and sensitive operation is logged with timestamp, actor, and IP.
- **HSTS + SameSite cookies + CSP.** Defense in depth against XSS, CSRF, and downgrade attacks.

Found a vulnerability? See the disclosure process in [SECURITY.md](./SECURITY.md).

---

## Limitations

- **Single instance.** SQLite + in-memory rate limiter prevent multi-replica deployments. For event scale (a few thousand users), one small instance is more than sufficient.
- **No real-time updates.** Server-rendered pages. No websockets.
- **SMTP subset.** The hand-rolled SMTP client supports PLAIN/LOGIN AUTH and STARTTLS (works with Postmark, SES, Mailgun, Gmail). For XOAUTH2-only providers, use Resend.
- **`node:sqlite` warning.** Technically experimental in Node 22 (warning suppressed). Fully stable in Node 24+.

For a full list of intentional non-features (no payments, no OAuth, no real-time chat, no native app) and the reasoning behind each, see [docs/intentional-non-features.md](./docs/intentional-non-features.md).

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for code style, RFC process, and how to submit patches.

## License

MIT. See [LICENSE](./LICENSE).