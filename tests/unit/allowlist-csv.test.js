// @ts-check
/**
 * Unit tests for parseAllowlistCsv (lib/allowlist.js).
 *
 * Real allowlists arrive as a CSV upload from a conference's registration
 * vendor. The parser must be resilient to:
 *   - single-column files (just emails)
 *   - multi-column files with an `email` column header
 *   - multi-column files without a header row
 *   - quoted fields, escaped quotes ("")
 *   - BOM
 *   - CRLF / LF / mixed line endings
 *   - blank lines
 *   - duplicate emails (deduped after normalization)
 *   - invalid emails (skipped + counted, never crashes the import)
 *
 * Returned shape (under test):
 *   { emails: string[], skipped: number, total: number }
 *   where emails is a deduped, normalized list (Gmail dot/+tag rules applied
 *   per lib/crypto.js).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { setupTestEnv } from "../helpers/env.js";

setupTestEnv();

import { parseAllowlistCsv } from "../../lib/allowlist.js";

describe("parseAllowlistCsv — basic shapes", () => {
	it("parses a single-column file (one email per line, no header)", () => {
		const out = parseAllowlistCsv(
			["alice@example.com", "bob@example.com", "carol@example.com"].join("\n"),
		);
		assert.deepEqual(out.emails.sort(), [
			"alice@example.com",
			"bob@example.com",
			"carol@example.com",
		]);
		assert.equal(out.skipped, 0);
	});

	it("parses a multi-column file with an `email` header", () => {
		const csv = [
			"first_name,last_name,email,role",
			"Alice,Anderson,alice@example.com,attendee",
			"Bob,Bauer,bob@example.com,speaker",
		].join("\n");
		const out = parseAllowlistCsv(csv);
		assert.deepEqual(out.emails.sort(), [
			"alice@example.com",
			"bob@example.com",
		]);
		assert.equal(out.skipped, 0);
	});

	it("parses a multi-column file without a header (autodetects email column)", () => {
		const csv = [
			"Alice,Anderson,alice@example.com",
			"Bob,Bauer,bob@example.com",
		].join("\n");
		const out = parseAllowlistCsv(csv);
		assert.deepEqual(out.emails.sort(), [
			"alice@example.com",
			"bob@example.com",
		]);
	});
});

describe("parseAllowlistCsv — quoted fields and escapes", () => {
	it("handles quoted fields containing commas", () => {
		const csv = [
			`name,email`,
			`"Anderson, Alice",alice@example.com`,
			`"Bauer, Bob",bob@example.com`,
		].join("\n");
		const out = parseAllowlistCsv(csv);
		assert.deepEqual(out.emails.sort(), [
			"alice@example.com",
			"bob@example.com",
		]);
	});

	it('handles quoted fields with escaped quotes ("")', () => {
		const csv = [`name,email`, `"She said ""hi""",alice@example.com`].join(
			"\n",
		);
		const out = parseAllowlistCsv(csv);
		assert.deepEqual(out.emails, ["alice@example.com"]);
	});
});

describe("parseAllowlistCsv — file-level concerns", () => {
	it("strips a leading UTF-8 BOM", () => {
		const csv = "﻿email\nalice@example.com";
		const out = parseAllowlistCsv(csv);
		assert.deepEqual(out.emails, ["alice@example.com"]);
	});

	it("handles CRLF line endings", () => {
		const csv = "email\r\nalice@example.com\r\nbob@example.com\r\n";
		const out = parseAllowlistCsv(csv);
		assert.deepEqual(out.emails.sort(), [
			"alice@example.com",
			"bob@example.com",
		]);
	});

	it("handles mixed CRLF / LF line endings", () => {
		const csv =
			"email\nalice@example.com\r\nbob@example.com\ncarol@example.com\r\n";
		const out = parseAllowlistCsv(csv);
		assert.deepEqual(out.emails.sort(), [
			"alice@example.com",
			"bob@example.com",
			"carol@example.com",
		]);
	});

	it("ignores blank lines anywhere in the file", () => {
		const csv = "\nemail\n\nalice@example.com\n\n\nbob@example.com\n\n";
		const out = parseAllowlistCsv(csv);
		assert.deepEqual(out.emails.sort(), [
			"alice@example.com",
			"bob@example.com",
		]);
	});
});

describe("parseAllowlistCsv — dedup + invalid handling", () => {
	it("dedupes after normalization (gmail dots/+tags)", () => {
		// alice+conf@gmail.com, a.l.i.c.e@gmail.com, ALICE@gmail.com all → alice@gmail.com
		const csv = [
			"email",
			"alice+conf@gmail.com",
			"a.l.i.c.e@gmail.com",
			"ALICE@gmail.com",
			"alice@gmail.com",
			"bob@example.com",
		].join("\n");
		const out = parseAllowlistCsv(csv);
		assert.deepEqual(
			out.emails.sort(),
			["alice@gmail.com", "bob@example.com"].sort(),
		);
	});

	it("skips invalid email rows and reports the count via `skipped`", () => {
		const csv = [
			"email",
			"alice@example.com",
			"not-an-email",
			"",
			"bob@example.com",
			"@example.com",
			"carol@example.com",
		].join("\n");
		const out = parseAllowlistCsv(csv);
		assert.deepEqual(out.emails.sort(), [
			"alice@example.com",
			"bob@example.com",
			"carol@example.com",
		]);
		assert.ok(
			out.skipped >= 2,
			`expected at least 2 skipped, got ${out.skipped}`,
		);
	});
});

describe("parseAllowlistCsv — stress", () => {
	it("imports 1000 unique emails without crashing", () => {
		const rows = ["email"];
		for (let i = 0; i < 1000; i++) rows.push(`user${i}@example.com`);
		const csv = rows.join("\n");
		const out = parseAllowlistCsv(csv);
		assert.equal(out.emails.length, 1000);
		assert.equal(out.skipped, 0);
	});
});
