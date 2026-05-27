// @ts-check
/**
 * Unit tests for did:web identifier construction and resolution to URL.
 *
 * Spec: https://w3c-ccg.github.io/did-method-web/
 *
 *   did:web:<host>[%3A<port>][:<path-segments...>]
 *
 * Resolution rule (no path):  https://<host>[:<port>]/.well-known/did.json
 * Resolution rule (path):     https://<host>[:<port>]/<segments-joined-with-/>/did.json
 *
 * Per spec the host (and port if present) must be percent-encoded; ':' in
 * the port is encoded as '%3A'.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { setupTestEnv } from "../helpers/env.js";
setupTestEnv();

import { didWebFor, didWebToUrl } from "../../lib/did.js";

describe("didWebFor — DID construction from app URL", () => {
  it("https origin without port → did:web:<host>", () => {
    assert.equal(
      didWebFor("https://rideshare.example.com"),
      "did:web:rideshare.example.com",
    );
  });

  it("http origin without port → did:web:<host> (port-less form)", () => {
    assert.equal(
      didWebFor("http://example.com"),
      "did:web:example.com",
    );
  });

  it("origin with non-default port encodes ':' as %3A", () => {
    assert.equal(
      didWebFor("http://localhost:9999"),
      "did:web:localhost%3A9999",
    );
    assert.equal(
      didWebFor("https://example.com:8443"),
      "did:web:example.com%3A8443",
    );
  });

  it("default ports (80 for http, 443 for https) are omitted", () => {
    assert.equal(
      didWebFor("http://example.com:80"),
      "did:web:example.com",
    );
    assert.equal(
      didWebFor("https://example.com:443"),
      "did:web:example.com",
    );
  });

  it("path on the URL is intentionally ignored (deployment-root only)", () => {
    // App lives at the origin root; any trailing path is irrelevant for did:web
    assert.equal(
      didWebFor("https://example.com/some/sub/path"),
      "did:web:example.com",
    );
  });
});

describe("didWebToUrl — DID → DID document URL", () => {
  it("port-less host resolves to the .well-known location", () => {
    assert.equal(
      didWebToUrl("did:web:rideshare.example.com"),
      "https://rideshare.example.com/.well-known/did.json",
    );
  });

  it("host with %3A-encoded port decodes to host:port and uses .well-known", () => {
    assert.equal(
      didWebToUrl("did:web:localhost%3A9999"),
      "https://localhost:9999/.well-known/did.json",
    );
  });

  it("path segments after the host are joined with '/' and use /<path>/did.json", () => {
    assert.equal(
      didWebToUrl("did:web:example.com:user:alice"),
      "https://example.com/user/alice/did.json",
    );
  });

  it("rejects non-did:web inputs", () => {
    assert.throws(() => didWebToUrl("did:key:z6Mk..."), /did:web/);
    assert.throws(() => didWebToUrl("https://example.com"), /did:web/);
  });
});

describe("didWebFor ↔ didWebToUrl — round-trip consistency", () => {
  /** @type {Array<[string, string]>} */
  const cases = [
    ["https://rideshare.example.com", "https://rideshare.example.com/.well-known/did.json"],
    ["http://localhost:9999", "https://localhost:9999/.well-known/did.json"],
    ["https://example.com:8443", "https://example.com:8443/.well-known/did.json"],
  ];
  for (const [appUrl, expectedDocUrl] of cases) {
    it(`${appUrl} → didWebFor → didWebToUrl → ${expectedDocUrl}`, () => {
      const did = didWebFor(appUrl);
      assert.equal(didWebToUrl(did), expectedDocUrl);
    });
  }
});
