// @ts-check
/**
 * The QR encoder against matrices from an independent encoder (python-qrcode),
 * with the same text, version and mask. One wrong table entry or misplaced
 * format bit produces a code phones refuse to scan, and only a module-by-module
 * comparison shows it.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { encodeQr, qrSvg } from "../../lib/qr.js";

/** @type {{ cases: { text: string, version: number, mask: number, rows: string[] }[] }} */
const vectors = JSON.parse(readFileSync(new URL("../vectors/qr.json", import.meta.url), "utf8"));

describe("QR encoder", () => {
  for (const v of vectors.cases) {
    it(`matches the reference matrix: ${v.text.length} bytes, version ${v.version}, mask ${v.mask}`, () => {
      const q = encodeQr(v.text, { mask: v.mask });
      assert.equal(q.version, v.version);
      assert.deepEqual(
        q.modules.map((r) => r.join("")),
        v.rows,
      );
    });
  }

  it("refuses a payload larger than version 20 holds", () => {
    assert.doesNotThrow(() => encodeQr("a".repeat(666)));
    assert.throws(() => encodeQr("a".repeat(667)), /exceeds version 20/);
  });

  it("renders SVG with no style attribute and an escaped label", () => {
    const svg = qrSvg("https://example.test/", { label: 'Offer "<x>"' });
    assert.match(svg, /^<svg [^>]*role="img"/);
    assert.doesNotMatch(svg, /style=/);
    assert.doesNotMatch(svg, /<x>/);
  });
});
