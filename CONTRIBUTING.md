# Contributing

> How to contribute to **rideshare**. Audience: developers proposing patches, reviewers, and forks adopting upstream changes.

The project is small, opinionated, and security-sensitive. Most of the rules below exist to keep it that way.

---

## Code of conduct

This project follows the [Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/) v2.1. Be kind, attack ideas not people, accept that maintainers may say "no" to patches that broaden the dependency surface or weaken the security posture.

Report code-of-conduct issues to the maintainer email listed in [`SECURITY.md`](SECURITY.md). Code-of-conduct reports are not security disclosures and do not enter the disclosure SLA, but they are taken seriously.

---

## Development setup

```bash
# Clone
git clone https://example.com/rideshare
cd rideshare

# Verify Node version
node --version   # must be >= 22.5

# No `npm install`. There are zero runtime dependencies.
# Dev tools (biome, typescript) are run via `npx`, which fetches them on demand.

# Bootstrap secrets
cp .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))" > secrets/server.secret
node -e "
  const k = require('node:crypto').generateKeyPairSync('ed25519');
  process.stdout.write(k.privateKey.export({type:'pkcs8', format:'pem'}));
" > secrets/deployment.key
chmod 600 secrets/*

# Run
npm start    # which is `node server.js`
```

The dev server listens on `http://localhost:3000` by default. The first sign-in attempt prints the magic link to stdout if `MAIL_PROVIDER=stdout` (the default in `.env.example`), so you don't need an actual SMTP setup to develop.

---

## Quality gates

A change is mergeable when **all four** are green.

### 1. Tests

```bash
node --test
```

Uses the built-in `node:test` runner. New behaviour requires new tests. Bug fixes require a regression test that fails before the fix and passes after.

### 2. Lint

```bash
npx biome check .
```

Biome is configured in `biome.json` at the repo root. Don't fight the formatter; if you disagree with a rule, propose changing it in a separate PR.

### 3. Type check

```bash
npx tsc --noEmit
```

The project is JavaScript with JSDoc types. `tsc` validates the JSDoc against `tsconfig.json` (`checkJs: true`). New code MUST type-check.

### 4. Manual smoke

For UI-touching changes, exercise the path in a real browser. The maintainers will ask. Screenshots in the PR description help.

---

## Commit format

[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/). Use one of:

- `feat:` — new user-visible behaviour.
- `fix:` — bug fix; reference the issue number.
- `docs:` — documentation only.
- `security:` — security-relevant fix or hardening. Triggers an entry under `Security` in [`CHANGELOG.md`](CHANGELOG.md).
- `chore:` — internal cleanup with no behavioural change.
- `refactor:` — internal restructure with no behavioural change.
- `test:` — test-only changes.
- `perf:` — performance improvement.

Use `!` for breaking changes, e.g. `feat!: replace magic-link token format`.

Subject ≤ 72 chars, imperative mood. The body explains *why* — the diff already shows *what*.

### Signed commits

All commits to `main` must be signed (`git commit -S`). Configure once:

```bash
git config commit.gpgsign true
git config user.signingkey <your-key-id>
```

CI rejects unsigned commits on protected branches. If you don't have a key, see [GitHub's signing docs](https://docs.github.com/en/authentication/managing-commit-signature-verification) or use `gh auth setup-git` for SSH-based signing.

---

## PR template requirements

Every PR description includes:

- **What:** one-sentence summary.
- **Why:** the problem this solves; link to issue if there is one.
- **Risk:** what could go wrong; what the blast radius is if it does.
- **Test plan:** the commands you ran; for UI changes, the manual steps.
- **Security impact:** "none" is a valid answer; if non-trivial, walk through which threat model entry is affected (link to [`THREAT_MODEL.md`](THREAT_MODEL.md)).
- **Docs touched:** which docs you updated; "n/a" if none.

PRs that touch security-sensitive code (`lib/auth.js`, `lib/trust.js`, `lib/router.js`, anything under `lib/keys.js` or `lib/audit.js`) require **two** maintainer approvals.

---

## Strict rule: no new npm runtime dependencies

The project ships zero runtime npm dependencies on purpose. The threat model treats this as a load-bearing property: the supply-chain attack surface is the Node runtime, full stop.

To add a runtime dependency you MUST:

1. Open an RFC issue titled `RFC: add <package>`.
2. Include: what the package does, what it replaces, lines-of-code saved, transitive dependency tree, last 12 months of advisories, alternative implementations considered, why we can't write it ourselves in <300 lines.
3. Wait **at least 7 days** for public review.
4. Get approval from at least two maintainers.

Dev dependencies (biome, typescript) are tolerated but reviewed under the same lens (lighter bar — they don't ship to production).

For comparison: `node:`-prefixed standard library is fine, in fact preferred (`import { readFile } from 'node:fs/promises'`).

---

## Code style summary

- **ESM only.** `package.json` has `"type": "module"`. No `require`, no CommonJS.
- **`node:` prefix on stdlib imports.** `import { ... } from 'node:crypto'`, not `'crypto'`. Makes intent obvious and prevents shadowing by a future npm package of the same name.
- **JSDoc types.** Every exported function has `@param` and `@returns`. Internal functions have types when helpful. We compile-check via `tsc --noEmit`.
- **No `console.log` in source.** Use the central logger in `lib/log.js`. Tests are allowed `console.log` for debugging but should remove it before merging.
- **No top-level await in library code.** Top-level `await` is fine in `server.js` and bin scripts, but `lib/` modules export functions and `class` instances; no side effects at import time.
- **No default exports.** Named exports only; eases grep and refactors.
- **Errors are objects, not strings.** Throw `new Error(...)` or a subclass; never `throw 'string'`.
- **Async functions return Promises, period.** No `.then(...)`/callback mixing within a single function.
- **Two-space indentation, single quotes, no semicolons** — biome enforces.
- **Filenames are kebab-case for routes** (`routes/well-known.js`), camelCase for libraries (`lib/rateLimit.js` would be valid but we currently use kebab everywhere; pick one and stick with the surrounding files).

---

## Where to add new code (cookbook)

The repo is small enough to navigate by `find`, but here's the short version.

### New crypto primitive

→ `lib/<name>.js`, exported as named functions.

Requirements:

- Cite the W3C spec or RFC in the file's leading JSDoc block (e.g. `// RFC 8032 §5.1, Ed25519 verify`).
- Include test vectors from the spec in `tests/<name>.test.js`.
- Constant-time everywhere user-supplied bytes are compared (`crypto.timingSafeEqual`).
- Never roll your own primitive. Compose from `node:crypto` and the WebCrypto subset Node ships.

### New endpoint

→ `routes/<area>.js`. Register via the `get()` / `post()` helpers exported from `lib/router.js`.

Requirements:

- Validate every input. Use the helpers in `lib/validate.js`; do not write ad-hoc regex.
- All user-rendered output goes through the `html\`\`` template from `lib/html.js`. Use `raw()` only for content you produced yourself or content that has been demonstrably sanitised.
- New write endpoints append to the audit log via `audit({ event_type, actor_id, payload })` from `lib/audit.js`.
- Add a test in `tests/routes/<area>.test.js` covering: happy path, unauthenticated, unauthorised, invalid input.
- Update [`docs/code-reading-guide.md`](docs/code-reading-guide.md) "where lives X" map if the endpoint introduces a new concern.

### New DB column

→ `lib/db.js`. Two places:

1. The `CREATE TABLE` block at the bottom of the bootstrap function — add the new column there for fresh DBs.
2. The migration block — an idempotent `ALTER TABLE` guarded by a `PRAGMA table_info(...)` check, so existing DBs upgrade in place on next start.

For non-additive schema changes, write a `bin/migrations/<NNNN>-<name>.sql` and document it in [`RUNBOOK.md`](RUNBOOK.md#migrations).

### New utility

→ `lib/<name>.js` if used by ≥2 callers. With JSDoc.

If it's used in exactly one place, **inline it.** Premature factoring out is worse than a slightly-long function.

### New static asset

→ `public/`. Served straight by `routes/static.js` (or whatever the static handler is named in your branch). Watch the cache headers — long-cached assets need a fingerprint in the filename.

### New documentation page

→ `docs/<area>/<topic>.md`. Cross-link from the index in the relevant top-level doc (`SECURITY.md`, `THREAT_MODEL.md`, etc.). Keep doc files focused; link, don't duplicate.

---

## What gets rejected

Common reasons a PR doesn't merge:

- New runtime npm dependency without an RFC.
- New `console.log` in source.
- Adds an inline `<script>` or `<style>` to a template (breaks CSP).
- Adds a route that mutates state without an audit entry.
- Adds a query built with string concatenation (use parameterised `prepare()`).
- Removes a test without explaining why.
- Touches `lib/auth.js`, `lib/keys.js`, or `lib/trust.js` without a security-impact section in the PR description.
- "Refactors for readability" with no behaviour change and no test additions — these tend to introduce subtle bugs in code paths that lacked test coverage. Talk to a maintainer first.

---

## See also

- [`SECURITY.md`](SECURITY.md) — disclosure policy.
- [`THREAT_MODEL.md`](THREAT_MODEL.md) — what the security review will check against.
- [`docs/code-reading-guide.md`](docs/code-reading-guide.md) — five-minute tour for new contributors.
- [`BUILD.md`](BUILD.md) — how the artifact is produced and verified.
- [`CHANGELOG.md`](CHANGELOG.md) — the running log of changes.
