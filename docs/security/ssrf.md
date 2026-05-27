# SSRF defense

> How **rideshare** prevents server-side request forgery, especially via `did:web` resolution. Audience: reviewers checking the egress fetch boundary.

The server makes outbound HTTP requests in only two cases:

1. **`did:web` resolution** for verifying Verifiable Credentials issued by peer deployments.
2. **Tile fetches** when the operator has not configured a self-hosted tile source.

Both go through `lib/safeFetch.js`. This document describes that wrapper's policies. Direct `fetch(...)` calls in route handlers are forbidden by code review.

---

## The threat

A user-controlled URL passed to `fetch()` lets an attacker:

- Reach internal services (`http://192.168.0.1/admin`, `http://localhost:9200/_cat/indices`).
- Reach cloud metadata services (`http://169.254.169.254/latest/meta-data/iam/security-credentials/`).
- Probe ports on the host or its network neighbours.
- Pivot to internal HTTP-based services that trust the network.
- Cause the server to download a multi-gigabyte response and exhaust memory.
- Time DNS resolution to map the internal network.

For our app, the user-controlled URL comes most plausibly from a `did:web` identifier (`did:web:internal-service.local` resolves to `https://internal-service.local/.well-known/did.json`).

---

## `lib/safeFetch.js` — the policies

Every outbound request is built and validated as follows:

### 1. Scheme allowlist

Only `https:` is permitted. `http:` is refused; `file:`, `gopher:`, `data:` etc. never reach the wrapper.

### 2. Hostname → IP resolution, then IP allowlist

Resolve the hostname via `dns.lookup` with `family: 0` (both v4 and v6). The resolved IP must be in **public address space**.

Refused IP ranges:

- `0.0.0.0/8`, `::/128` (this-network)
- `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16` (RFC1918)
- `127.0.0.0/8`, `::1/128` (loopback)
- `169.254.0.0/16`, `fe80::/10` (link-local — also catches AWS/GCE/Azure metadata)
- `100.64.0.0/10` (CGNAT)
- `224.0.0.0/4`, `ff00::/8` (multicast)
- `fc00::/7` (IPv6 unique-local)
- Any DNS-rebinding-prone address resolved to a local range mid-request.

The lookup happens **before** the connection. Then we connect to that specific IP, with the SNI / Host header set to the original hostname. This prevents DNS rebinding (the second resolution that the TLS stack would do is bypassed).

### 3. Redirect refusal

`fetch(..., { redirect: 'error' })`. Any 3xx response causes the request to fail. A redirect-based bypass (server returns `Location: http://169.254.169.254/...`) cannot get us back into private space.

### 4. Body size cap

`16 * 1024` bytes by default for `did:web` responses. Configurable per call. The wrapper consumes the response stream, counting bytes; on overflow it aborts the fetch and throws.

### 5. Timeout

`AbortController` fires after 5 seconds by default. No request can hang the verifier indefinitely.

### 6. Per-host concurrency cap

A small in-memory map limits concurrent requests to the same host (default 2). A burst of `did:web:victim.example.com` resolutions cannot DoS that host through us.

### 7. Header hygiene

Outbound requests carry only `Accept`, `User-Agent`, and `Accept-Language`. No cookies, no auth headers, no custom headers from the user. The `User-Agent` identifies us so peer operators can rate-limit us if they want (`rideshare/0.3 (+https://example.com/rideshare)`).

### 8. Response content-type check

`did:web` responses must have `Content-Type: application/json` (or `application/did+json`). Tile responses must be `image/*`. Anything else fails the call.

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

Special-case for the resolution path:

- The path is computed deterministically from the DID; user input cannot inject `..` or `?` or `#`.
- Path segment after `did:web:` is hex-encoded if it contains anything other than `[a-z0-9.-:]`.

---

## Tile fetch flow

Configurable. Default is `disabled` (the deployment requires the operator to either provide `TILE_PROXY_URL` or accept that tile fetches go straight to a third party at request time).

If enabled, the same `safeFetch` policies apply. The tile URL template is locked to one of the supported provider patterns; the user cannot inject an arbitrary URL.

We strongly recommend self-hosting via MBTiles. `lib/tiles.js` includes an MBTiles reader that bypasses egress entirely.

---

## What's still possible

- A peer deployment we trust (`TRUST_PEERS`) that becomes malicious can return arbitrary 16KB JSON and we'll process it. Mitigation: JSON parser is the standard library; resulting object is type-checked before use; any field we don't expect is ignored.
- A peer's hostname could resolve to a public IP that they then point at a vulnerable third-party host. The third party would receive our request, but: we send no auth headers and no cookies, so the request is equivalent to any unauthenticated GET from the internet. Low blast-radius.
- A peer's TLS cert is forged by a rogue CA. Out of scope per [`THREAT_MODEL.md`](../../THREAT_MODEL.md) residual risks.

---

## What's deliberately not done

- We do not implement DNSSEC validation. The OS resolver is trusted.
- We do not pin the peer's TLS cert. `did:web` is meant to be operator-rotatable; pinning would defeat that. Trust is anchored in the published `did.json` content, not in TLS material beyond standard CA chain validation.
- We do not maintain a cache of peer DID documents beyond a 5-minute TTL. Fresh resolution per verification keeps revocation latency tight; the rate-limit and concurrency cap prevent it from being a DoS amplifier.

---

## Where to look

- `lib/safeFetch.js` — the wrapper.
- `lib/did.js` — `resolveDidWeb` call site.
- `lib/tiles.js` — tile fetch path, including MBTiles fast path.
- `tests/safeFetch.test.js` — adversarial vectors (rebinding, redirect chain, oversized body, IPv4-mapped-IPv6 address aliases, etc.).

---

## See also

- [`THREAT_MODEL.md`](../../THREAT_MODEL.md) — `CC-5: SSRF via did:web`.
- [`credential-forgery.md`](credential-forgery.md) — what we do *after* a `did:web` document has been safely fetched.
- [`TRUST.md`](../../TRUST.md) — trust model for peer deployments.
