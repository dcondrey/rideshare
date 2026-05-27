// @ts-check
/**
 * Unit tests for lib/html.js — HTML escape helper, the `html` template tag
 * (auto-escapes interpolations), the `raw` opt-out helper, and the layout
 * shell.
 *
 * Reviewers care that every interpolation in `html`...`...`...` is escaped
 * by default, that `raw` is the only escape hatch, and that the layout
 * produces well-formed HTML with the expected meta + CSP-friendly markup.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { setupTestEnv } from "../helpers/env.js";
setupTestEnv();

import { escapeHtml, html, raw, layout } from "../../lib/html.js";

describe("escapeHtml", () => {
  it("escapes the 5 sensitive HTML characters", () => {
    assert.equal(escapeHtml("&"), "&amp;");
    assert.equal(escapeHtml("<"), "&lt;");
    assert.equal(escapeHtml(">"), "&gt;");
    assert.equal(escapeHtml('"'), "&quot;");
    assert.equal(escapeHtml("'"), "&#39;");
  });

  it("escapes a string containing a script-tag injection attempt", () => {
    const out = escapeHtml(`<script>alert("xss")</script>`);
    assert.equal(
      out,
      "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;",
    );
  });

  it("is a no-op for inputs without sensitive characters", () => {
    assert.equal(escapeHtml("hello world"), "hello world");
    assert.equal(escapeHtml(""), "");
  });
});

describe("html`` template tag", () => {
  it("escapes interpolated strings by default", () => {
    const userInput = `<img src=x onerror="alert(1)">`;
    const out = String(html`<p>${userInput}</p>`);
    assert.equal(
      out,
      `<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt;</p>`,
    );
  });

  it("escapes numbers, booleans, and null safely (no '[object …]')", () => {
    const out = String(html`<p>${1}</p><p>${true}</p><p>${null}</p>`);
    assert.equal(out, `<p>1</p><p>true</p><p></p>`);
  });

  it("passes RawHtml values through verbatim (the only escape hatch)", () => {
    const safe = raw(`<strong>bold</strong>`);
    const out = String(html`<p>${safe}</p>`);
    assert.equal(out, `<p><strong>bold</strong></p>`);
  });

  it("composes nested html`` fragments without double-escaping", () => {
    const inner = html`<em>${"<x>"}</em>`;
    const out = String(html`<p>${inner}</p>`);
    assert.equal(out, `<p><em>&lt;x&gt;</em></p>`);
  });
});

describe("raw()", () => {
  it("returns a value that html`` will not escape", () => {
    const out = String(html`${raw("<b>x</b>")}`);
    assert.equal(out, "<b>x</b>");
  });

  it("regression: passes a plain string through verbatim (no double-wrap)", () => {
    // Earlier bug: raw("...") was being string-coerced to "[object Object]"
    // when used outside an html`` tag. Pin the contract.
    assert.equal(String(raw("hello")), "hello");
    assert.equal(String(raw("<b>hi</b>")), "<b>hi</b>");
  });
});

describe("layout()", () => {
  it("produces a complete HTML5 document", () => {
    const out = layout({
      title: "Test Page",
      body: html`<h1>Hello</h1>`,
    });
    const s = String(out);
    assert.match(s, /^<!doctype html>/i);
    assert.match(s, /<html[^>]*>/i);
    assert.match(s, /<\/html>\s*$/i);
    assert.match(s, /<meta charset="utf-8"[^>]*>/i);
    assert.match(s, /<meta name="viewport"/i);
    assert.match(s, /<title>Test Page<\/title>/);
    assert.match(s, /<h1>Hello<\/h1>/);
  });

  it("escapes the title to prevent injection through the page title", () => {
    const out = String(
      layout({ title: `</title><script>alert(1)</script>`, body: html`` }),
    );
    assert.doesNotMatch(out, /<script>alert\(1\)<\/script>/);
    assert.match(out, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  });

  it("does not introduce inline event-handler attributes (CSP-friendly)", () => {
    const out = String(layout({ title: "x", body: html`<p>hi</p>` }));
    assert.doesNotMatch(out, /\son[a-z]+=/i);
  });
});
