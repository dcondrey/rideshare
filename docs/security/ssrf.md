# SSRF defense

SSRF defense in **rideshare**, mainly for `did:web` resolution.

Outbound requests the server makes:

| Request | User-influenced | Path |
|---|---|---|
| `did:web` resolution (verifying peer credentials) | yes | `lib/safe-fetch.js` |
| Resend API (`lib/email.js`) | no: fixed host, operator API key | direct; the wrapper strips auth headers by design |
| Map tiles | n/a | none: the browser fetches them (`public/map.js` builds the URL from `event.config.yaml`) |

New fetches with request-derived URLs must use `lib/safe-fetch.js`.

---

## The threat

A user-controlled URL passed to `fetch()` can:

- Reach and pivot through internal services (`http://192.168.0.1/admin`, `http://localhost:9200/_cat/indices`) or cloud metadata (`http://169.254.169.254/latest/meta-data/iam/security-credentials/`).
- Port-scan, map the network via DNS timing, or exhaust memory with a huge response.

Likely vector: `did:web:internal-service.local` resolves to `https://internal-service.local/.well-known/did.json`.

---

## `lib/safe-fetch.js`: the policies

### 1. Scheme allowlist

`https:` only. `http:` is refused; `file:`, `gopher:`, `data:` never reach the wrapper.

### 2. Hostname → IP resolution, then IP allowlist

`dns.lookup` with `family: 0` (v4 and v6). The IP must be public. Refused:

- `0.0.0.0/8`, `::/128` (this-network)
- `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` (RFC1918)
- `127.0.0.0/8`, `::1/128` (loopback)
- `169.254.0.0/16`, `fe80::/10` (link-local, including AWS/GCE/Azure metadata)
- `100.64.0.0/10` (CGNAT)
- `224.0.0.0/4`, `ff00::/8` (multicast)
- `fc00::/7` (IPv6 unique-local)
- Any DNS-rebinding-prone address resolved to a local range mid-request.

We resolve **before** connecting, then connect to that IP with SNI/Host set to the hostname. No second resolution, no rebinding.

### 3. Redirect refusal

Any 3xx fails the request, so `Location: http://169.254.169.254/...` goes nowhere.

### 4. Body size cap

Default `16 * 1024` bytes, per call; `did:web` passes 64KB. Overflow while streaming destroys the socket and throws; an oversized `Content-Length` is refused up front.

### 5. Timeout

`AbortController` at 5 seconds by default.

### 6. Per-host concurrency cap

In-memory, default 2 concurrent requests per host, so a burst of `did:web:victim.example.com` can't DoS that host through us.

### 7. Header hygiene

Only `Accept`, `User-Agent` (identifies us) and `Accept-Language`. No parameter exists for cookies, auth or custom headers.

### 8. Response content-type check

`did:web` requires `Content-Type: application/json` or `application/did+json`. The check is per-call; callers that pass none accept any type.

---

## `did:web` resolution flow

```
did:web:event.example.com:peers:cool-event
   │
   ▼
URL = https://event.example.com/peers/cool-event/did.json
   │
   ▼ safeFetch (above)
   │
   ▼
DID document JSON
   │
   ▼ extract verificationMethod[0].publicKeyMultibase
   │
   ▼
Ed25519 public key, used to verify the credential JWS
```

- The path is derived deterministically from the DID; no `..`, `?` or `#` injection.
- The segment after `did:web:` is hex-encoded if it contains anything outside `[a-z0-9.-:]`.

---

## Tile fetches are the browser's, not ours

`routes/map.js` renders the template from `event.config.yaml`; the browser fetches tiles. The provider sees attendee IPs (privacy, not SSRF); self-host a tile server to avoid that. No server-side tile fetch or proxy exists.

---

## What's still possible

- A malicious trusted peer (`TRUST_PEERS`) can return any JSON up to the cap; it's parsed by the standard library, type-checked, extra fields ignored.
- A peer hostname can point at a public third-party host, which gets a plain unauthenticated GET. DIDComm replies (`lib/didcomm.js`) are the one POST through this policy: encrypted body, at most one per inbound authcrypt message, rate-limited per sender (THREAT_MODEL.md CC-15).
- A rogue CA forging a peer's cert. Out of scope per [`THREAT_MODEL.md`](../../THREAT_MODEL.md) residual risks.

---

## What's deliberately not done

- No DNSSEC validation; the OS resolver is trusted.
- No TLS pinning (`did:web` is operator-rotatable); trust rests on `did.json` plus standard CA validation.
- No caching of peer DID documents. Fresh resolution keeps revocation latency low; the concurrency cap prevents amplification.

---

## Where to look

- `lib/safe-fetch.js`: the wrapper.
- `lib/did.js`: `did:web` call site in `resolveDid`.
- `tests/unit/safe-fetch.test.js`: address vectors (IPv4-mapped IPv6, NAT64, CGNAT, metadata, range boundaries) and URL-level refusals.

---

## The one documented exception

`ALLOW_INSECURE_DID_WEB=true` lets `did:web` use plain HTTP for `localhost` and `127.0.0.1`, bypassing the wrapper, for the demo and tests.

- Defaults to false; never inferred from `NODE_ENV`.
- Warns at boot if on while `APP_URL` is https.
- When on, anyone can make the server fetch loopback ports. Laptops only.

---

## See also

- [`THREAT_MODEL.md`](../../THREAT_MODEL.md): `CC-5: SSRF via did:web`.
- [`credential-forgery.md`](credential-forgery.md): what happens after a `did:web` document is fetched.
- [`TRUST.md`](../../TRUST.md): trust model for peer deployments.
