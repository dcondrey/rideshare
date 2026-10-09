// @ts-check
/**
 * OpenID for Verifiable Presentations 1.0 (Final): this deployment as a
 * verifier asking a wallet for a ride credential, cross-device.
 *
 *   verifier page ──QR: openid4vp://?client_id=decentralized_identifier:<did>&request_uri=…
 *   wallet ──GET request_uri──▶ request object (JWT, typ oauth-authz-req+jwt,
 *                                ES256, kid <did>#key-2, DCQL query)
 *   wallet ──POST response_uri (direct_post: vp_token, state)──▶ verified here
 *
 * The client identifier uses the `decentralized_identifier` prefix, so the
 * request object must be signed with a key in the DID document; wallets check
 * it by resolving did:web. HAIP's `x509_hash` prefix and encrypted
 * `direct_post.jwt` responses are not implemented (see TRUST.md).
 */

import { randomBytes } from "node:crypto";

import { config } from "./config.js";
import { db } from "./db.js";
import { resolveAssertionKey } from "./did.js";
import { errorMessage } from "./errors.js";
import { decodeJws, signJws, verifyJws } from "./jose.js";
import { loadEs256Key } from "./keys.js";
import { safeFetch } from "./safe-fetch.js";
import { getDeploymentKey, rideVct } from "./trust.js";
import { verifySdJwtVc } from "./verifier.js";

const REQUEST_TTL_MS = 10 * 60 * 1000;
const DCQL_ID = "ride_credential";
/** What this verifier asks for: enough to show a shared ride, nothing more. */
const REQUESTED_CLAIMS = [["event", "name"], ["role"]];

db.exec(`
  CREATE TABLE IF NOT EXISTS oid4vp_requests (
    id          TEXT    PRIMARY KEY,      -- random, in the request_uri
    state       TEXT    NOT NULL UNIQUE,
    nonce       TEXT    NOT NULL,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    status_token TEXT,                    -- separate capability for reading the result
    status      TEXT    NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','failed')),
    result_json TEXT,
    answered_at INTEGER
  );
`);

// The status token came after the table's first release; add it in place.
if (
  !(
    /** @type {{ name: string }[]} */ (db.prepare("PRAGMA table_info(oid4vp_requests)").all()).some(
      (c) => c.name === "status_token",
    )
  )
) {
  db.exec("ALTER TABLE oid4vp_requests ADD COLUMN status_token TEXT");
}

/** This verifier's Client Identifier, prefix included (OpenID4VP §5.9). */
export function clientId() {
  return `decentralized_identifier:${getDeploymentKey().did}`;
}

/**
 * Create a presentation request. The id travels in the QR code's request_uri,
 * so it must not unlock the result: reading the status needs a second random
 * token that only the verifier's page holds.
 */
export function createPresentationRequest() {
  const now = Date.now();
  db.prepare("DELETE FROM oid4vp_requests WHERE expires_at < ?").run(now - 24 * 60 * 60 * 1000);
  const id = randomBytes(16).toString("base64url");
  const statusToken = randomBytes(24).toString("base64url");
  db.prepare(
    "INSERT INTO oid4vp_requests (id, state, nonce, status_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    id,
    randomBytes(16).toString("base64url"),
    randomBytes(18).toString("base64url"),
    statusToken,
    now,
    now + REQUEST_TTL_MS,
  );
  const requestUri = `${config.appUrl}/oid4vp/request/${id}`;
  return {
    id,
    statusToken,
    requestUri,
    walletUrl: `openid4vp://?client_id=${encodeURIComponent(clientId())}&request_uri=${encodeURIComponent(requestUri)}`,
    expiresAt: now + REQUEST_TTL_MS,
  };
}

/** The DCQL query (OpenID4VP §6) for this verifier's ride credential. */
export function dcqlQuery() {
  return {
    credentials: [
      {
        id: DCQL_ID,
        format: "dc+sd-jwt",
        meta: { vct_values: [rideVct()] },
        claims: REQUESTED_CLAIMS.map((path) => ({ path })),
      },
    ],
  };
}

/**
 * The signed request object a wallet fetches from request_uri.
 * @param {string} id
 */
export function requestObject(id) {
  const row =
    /** @type {{ state: string, nonce: string, expires_at: number, status: string } | undefined} */ (
      db
        .prepare("SELECT state, nonce, expires_at, status FROM oid4vp_requests WHERE id = ?")
        .get(id)
    );
  if (row?.status !== "pending" || row.expires_at < Date.now()) return null;
  const key = loadEs256Key();
  const did = getDeploymentKey().did;
  const now = Math.floor(Date.now() / 1000);
  return signJws(
    { typ: "oauth-authz-req+jwt", kid: `${did}#${key.keyFragment}` },
    {
      iss: clientId(),
      aud: "https://self-issued.me/v2",
      client_id: clientId(),
      response_type: "vp_token",
      response_mode: "direct_post",
      response_uri: `${config.appUrl}/oid4vp/response`,
      nonce: row.nonce,
      state: row.state,
      dcql_query: dcqlQuery(),
      client_metadata: {
        vp_formats_supported: {
          "dc+sd-jwt": {
            "sd-jwt_alg_values": ["ES256"],
            "kb-jwt_alg_values": ["ES256", "Ed25519"],
          },
        },
      },
      iat: now,
      exp: Math.floor(row.expires_at / 1000),
    },
    key.privateKey,
  );
}

/**
 * Handle a direct_post Authorization Response (OpenID4VP §8).
 * @param {Record<string, string>} form
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function handleResponse(form) {
  const row =
    /** @type {{ id: string, nonce: string, expires_at: number, status: string } | undefined} */ (
      db
        .prepare("SELECT id, nonce, expires_at, status FROM oid4vp_requests WHERE state = ?")
        .get(form.state || "")
    );
  if (row?.status !== "pending" || row.expires_at < Date.now()) {
    return { ok: false, error: "invalid_request" };
  }
  // A response that fails leaves the request pending, with the reason noted:
  // `state` is readable by anyone who fetches the request object, so letting
  // junk settle it as failed would let a bystander void a real verification.
  /** @param {string[]} errors */
  const note = (errors) => {
    db.prepare(
      "UPDATE oid4vp_requests SET result_json = ? WHERE id = ? AND status = 'pending'",
    ).run(JSON.stringify({ errors }), row.id);
  };
  if (form.error) {
    note([`a wallet answered ${form.error}`]);
    return { ok: true };
  }
  let presentation;
  try {
    const token = JSON.parse(form.vp_token || "");
    const list = token?.[DCQL_ID];
    if (!Array.isArray(list) || list.length !== 1 || typeof list[0] !== "string") {
      throw new Error(`vp_token must map ${DCQL_ID} to an array of one presentation`);
    }
    presentation = list[0];
  } catch (err) {
    note([errorMessage(err)]);
    return { ok: false, error: "invalid_request" };
  }
  const v = await verifySdJwtVc(presentation, {
    aud: clientId(),
    expectedNonce: row.nonce,
    requireKeyBinding: true,
  });
  const errors = [...v.errors];
  if (
    v.ok &&
    v.result &&
    !dcqlQuery().credentials[0].meta.vct_values.includes(String(v.result.claims.vct))
  ) {
    errors.push(`vct ${String(v.result.claims.vct)} is not one this verifier accepts`);
  }
  if (!v.ok || errors.length > 0 || !v.result) {
    note(errors);
    return { ok: false, error: "invalid_request" };
  }
  const settled = db
    .prepare(
      "UPDATE oid4vp_requests SET status = 'verified', result_json = ?, answered_at = ? WHERE id = ? AND status = 'pending'",
    )
    .run(
      JSON.stringify({ checks: v.checks, errors: [], claims: v.result.claims }),
      Date.now(),
      row.id,
    );
  return settled.changes === 1 ? { ok: true } : { ok: false, error: "invalid_request" };
}

/** @param {string} statusToken */
export function requestStatus(statusToken) {
  const row =
    /** @type {{ status: string, result_json: string | null, expires_at: number } | undefined} */ (
      db
        .prepare(
          "SELECT status, result_json, expires_at FROM oid4vp_requests WHERE status_token = ?",
        )
        .get(statusToken)
    );
  if (!row) return null;
  return {
    status: row.status === "pending" && row.expires_at < Date.now() ? "expired" : row.status,
    ...(row.result_json ? JSON.parse(row.result_json) : {}),
  };
}

/**
 * Holder side (the in-app wallet on /trust): fetch and verify a request named
 * by an openid4vp:// URL, and return what it asks for. The signature is
 * checked against the key its `kid` names in the verifier's DID document.
 * @param {string} walletUrl
 */
export async function inspectRequest(walletUrl) {
  const u = new URL(walletUrl);
  const cid = u.searchParams.get("client_id") || "";
  const requestUri = u.searchParams.get("request_uri") || "";
  if (!cid.startsWith("decentralized_identifier:did:web:")) {
    throw new Error("only decentralized_identifier did:web verifiers are supported by this holder");
  }
  if (!requestUri) throw new Error("the request has no request_uri");
  const local = requestUri.startsWith(`${config.appUrl}/oid4vp/request/`);
  const jwt = local
    ? requestObject(requestUri.slice(`${config.appUrl}/oid4vp/request/`.length))
    : (
        await safeFetch(requestUri, {
          accept: "application/oauth-authz-req+jwt",
          contentType: /^application\/(oauth-authz-req\+)?jwt\b/i,
          maxBytes: 16 * 1024,
        })
      ).body.trim();
  if (!jwt) throw new Error("the request has expired or was already answered");
  const d = decodeJws(jwt);
  if (d.header.typ !== "oauth-authz-req+jwt")
    throw new Error("request object typ must be oauth-authz-req+jwt");
  const did = cid.slice("decentralized_identifier:".length);
  const kid = String(d.header.kid || "");
  if (kid.split("#")[0] !== did)
    throw new Error("request object kid is not a key of the client_id DID");
  const key =
    did === getDeploymentKey().did ? loadEs256Key().publicKey : await resolveAssertionKey(kid);
  verifyJws(jwt, key, ["ES256", "Ed25519", "EdDSA"]);
  const p = d.payload;
  if (p.client_id !== cid) throw new Error("request object client_id does not match the URL");
  if (p.response_type !== "vp_token" || p.response_mode !== "direct_post") {
    throw new Error("only response_type vp_token with response_mode direct_post is supported");
  }
  if (typeof p.exp === "number" && p.exp < Math.floor(Date.now() / 1000))
    throw new Error("request expired");
  const query =
    /** @type {{ credentials?: { id: string, format: string, meta?: { vct_values?: string[] }, claims?: { path: (string | number | null)[] }[] }[] }} */ (
      p.dcql_query
    );
  const first = query?.credentials?.[0];
  if (first?.format !== "dc+sd-jwt")
    throw new Error("the request does not ask for a dc+sd-jwt credential");
  return {
    clientId: cid,
    verifier: did,
    responseUri: String(p.response_uri),
    nonce: String(p.nonce),
    state: String(p.state),
    credentialQueryId: first.id,
    vctValues: first.meta?.vct_values || [],
    claims: (first.claims || []).map((c) => c.path.map(String)),
  };
}
