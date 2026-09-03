// @ts-check

import { hashEmailForAllowlist, normalizeEmail } from "./crypto.js";
import { audit, db, tx } from "./db.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isAllowed(email) {
	const hash = hashEmailForAllowlist(email);
	const row = db
		.prepare("SELECT 1 FROM allowlist_hashes WHERE email_hash = ?")
		.get(hash);
	return !!row;
}

export function allowlistCount() {
	const row = /** @type {{ c: number }} */ (
		db.prepare("SELECT COUNT(*) AS c FROM allowlist_hashes").get()
	);
	return row.c;
}

function splitCsvLine(line) {
	const cols = [];
	let cur = "";
	let inQuote = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (inQuote) {
			if (ch === '"') {
				if (line[i + 1] === '"') {
					cur += '"';
					i++;
				} else inQuote = false;
			} else {
				cur += ch;
			}
		} else {
			if (ch === '"') {
				inQuote = true;
			} else if (ch === ",") {
				cols.push(cur);
				cur = "";
			} else {
				cur += ch;
			}
		}
	}
	cols.push(cur);
	return cols;
}

export function parseAllowlistCsv(csvText) {
	// Strip BOM if present
	if (csvText.charCodeAt(0) === 0xfeff) csvText = csvText.slice(1);

	const lines = csvText.split(/\r?\n/).filter((l) => l.trim() !== "");
	if (lines.length === 0)
		return { emails: [], skippedInvalid: 0, totalRows: 0 };

	const firstCols = splitCsvLine(lines[0]);

	// Determine email column index and whether to skip the first line as a header.
	let emailColIdx = 0;
	let startLine = 0;

	// Look for an explicit 'email' or 'email address' header column.
	// The matched cell must NOT itself be a valid email address, so that a
	// single-column file whose first line happens to be a real address is never
	// mistaken for a header row.
	const HEADER_RE = /^email( ?address)?$/i;

	const headerIdx = firstCols.findIndex((c) => {
		const trimmed = c.trim();
		return HEADER_RE.test(trimmed) && !EMAIL_RE.test(trimmed);
	});

	if (headerIdx >= 0) {
		// Explicit header found — use that column and skip the header row.
		emailColIdx = headerIdx;
		startLine = 1;
	} else if (firstCols.length === 1) {
		// Single-column file with no recognized header — treat every line
		// (including the first) as a data row.
		emailColIdx = 0;
		startLine = 0;
	} else {
		// Multi-column file with no recognized header.
		// Heuristic: find the first column whose first-row value looks like
		// an email address.
		const guess = firstCols.findIndex((c) => EMAIL_RE.test(c.trim()));
		emailColIdx = guess >= 0 ? guess : 0;
		startLine = 0;
	}

	const emails = [];
	let skipped = 0;
	let totalRows = 0;
	const seen = new Set();
	for (let i = startLine; i < lines.length; i++) {
		totalRows++;
		const cols = splitCsvLine(lines[i]);
		const raw = (cols[emailColIdx] ?? "").trim();
		if (!raw) {
			skipped++;
			continue;
		}
		if (!EMAIL_RE.test(raw)) {
			skipped++;
			continue;
		}
		const norm = normalizeEmail(raw);
		if (seen.has(norm)) continue;
		seen.add(norm);
		emails.push(norm);
	}
	return { emails, skipped, skippedInvalid: skipped, totalRows };
}

export function replaceAllowlist(normalizedEmails, actor) {
	const result = tx(() => {
		db.exec("DELETE FROM allowlist_hashes");
		const now = Date.now();
		const ins = db.prepare(
			"INSERT OR IGNORE INTO allowlist_hashes (email_hash, added_at) VALUES (?, ?)",
		);
		let added = 0;
		for (const email of normalizedEmails) {
			const hash = hashEmailForAllowlist(email);
			const r = ins.run(hash, now);
			if (r.changes > 0) added++;
		}
		return { added, total: normalizedEmails.length };
	});
	audit({
		actorId: actor?.actorId ?? null,
		actorEmail: actor?.actorEmail ?? null,
		action: "allowlist.replace",
		detail: `imported ${result.added} entries`,
		ip: actor?.ip ?? null,
	});
	return result;
}

export function appendAllowlist(normalizedEmails, actor) {
	const result = tx(() => {
		const now = Date.now();
		const ins = db.prepare(
			"INSERT OR IGNORE INTO allowlist_hashes (email_hash, added_at) VALUES (?, ?)",
		);
		let added = 0;
		for (const email of normalizedEmails) {
			const r = ins.run(hashEmailForAllowlist(email), now);
			if (r.changes > 0) added++;
		}
		return { added, total: normalizedEmails.length };
	});
	audit({
		actorId: actor?.actorId ?? null,
		actorEmail: actor?.actorEmail ?? null,
		action: "allowlist.append",
		detail: `added ${result.added} new entries`,
		ip: actor?.ip ?? null,
	});
	return result;
}

export function wipeAllowlist(actor) {
	const count = allowlistCount();
	db.exec("DELETE FROM allowlist_hashes");
	audit({
		actorId: actor?.actorId ?? null,
		actorEmail: actor?.actorEmail ?? null,
		action: "allowlist.wipe",
		detail: `wiped ${count} entries`,
		ip: actor?.ip ?? null,
	});
	return { removed: count };
}
