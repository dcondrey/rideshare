// @ts-check
// Sets the required env vars as an import side effect. Must be listed before
// any module that pulls in lib/config.js, which exits on a missing APP_URL.
import "../helpers/setup.js";

import assert from "node:assert/strict";
import { test } from "node:test";

// parseAllowlistCsv is pure CSV parsing — no DB writes occur during parsing.
// Dynamic import ensures env vars (set via the test command) are in place
// before the allowlist module (and its db.js dependency) initialises.
const { parseAllowlistCsv } = await import("../../lib/allowlist.js");

test("parses a single-column file (one email per line, no header)", () => {
	const csv = [
		"alice@example.com",
		"bob@example.com",
		"charlie@example.com",
	].join("\n");

	const { emails, skippedInvalid, totalRows } = parseAllowlistCsv(csv);

	assert.equal(totalRows, 3, "all three lines are data rows");
	assert.equal(skippedInvalid, 0, "no rows skipped");
	assert.equal(emails.length, 3, "three distinct emails parsed");
	assert.ok(emails.includes("alice@example.com"));
	assert.ok(emails.includes("bob@example.com"));
	assert.ok(emails.includes("charlie@example.com"));
});

test("parses a multi-column file with an `email` header", () => {
	const csv = [
		"Name,email,Phone",
		"Alice,alice@example.com,555-1234",
		"Bob,bob@example.com,555-5678",
	].join("\n");

	const { emails, skippedInvalid, totalRows } = parseAllowlistCsv(csv);

	assert.equal(totalRows, 2, "header row excluded; two data rows");
	assert.equal(skippedInvalid, 0, "no rows skipped");
	assert.equal(emails.length, 2, "two emails parsed from email column");
	assert.ok(emails.includes("alice@example.com"));
	assert.ok(emails.includes("bob@example.com"));
});
