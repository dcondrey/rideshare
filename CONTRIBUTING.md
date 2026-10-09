# Contributing

Small, opinionated, security-sensitive project. Most rules here exist to keep it that way.

## Code of conduct

[Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/) v2.1. Maintainers may say no to patches that add dependencies or weaken security.

Report conduct issues to the maintainer email in [`SECURITY.md`](SECURITY.md). These aren't security disclosures and don't enter the disclosure SLA.

## Development setup

```bash
git clone https://example.com/rideshare
cd rideshare
node --version   # must be >= 22.5

# No `npm install`: zero runtime dependencies. Dev tools (biome, typescript) run via `npx`.

cp .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))" > secrets/server.secret
node -e "
  const k = require('node:crypto').generateKeyPairSync('ed25519');
  process.stdout.write(k.privateKey.export({type:'pkcs8', format:'pem'}));
" > secrets/deployment.key
chmod 600 secrets/*

npm start    # node server.js
```

Listens on `http://localhost:3000`. With `MAIL_PROVIDER=stdout` (the `.env.example` default) the magic link prints to stdout, so no SMTP needed.

## Quality gates

All four must pass.

| Gate | Command | Notes |
|---|---|---|
| Tests | `node --test` | Built-in `node:test`. New behaviour needs tests; bug fixes need a regression test that fails before the fix. |
| Lint | `npx biome check .` | Config in `biome.json`. Disagree with a rule? Separate PR. |
| Types | `npx tsc --noEmit` | JSDoc types checked via `tsconfig.json` (`checkJs: true`). New code must type-check. |
| Manual smoke | real browser | For UI changes. Screenshots in the PR help. |

## Commit format

[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

| Type | Use |
|---|---|
| `feat:` | New user-visible behaviour |
| `fix:` | Bug fix; reference the issue |
| `docs:` | Docs only |
| `security:` | Security fix or hardening; gets a `Security` entry in [`CHANGELOG.md`](CHANGELOG.md) |
| `chore:` | Internal cleanup, no behaviour change |
| `refactor:` | Restructure, no behaviour change |
| `test:` | Tests only |
| `perf:` | Performance |

Breaking changes use `!`, e.g. `feat!: replace magic-link token format`. Subject ≤ 72 chars, imperative. The body says why; the diff shows what.

### Signed commits

Commits to `main` must be signed (`git commit -S`):

```bash
git config commit.gpgsign true
git config user.signingkey <your-key-id>
```

CI rejects unsigned commits on protected branches. No key? See [GitHub's signing docs](https://docs.github.com/en/authentication/managing-commit-signature-verification) or use `gh auth setup-git` for SSH signing.

## PR template requirements

Every PR description has:

- What: one sentence.
- Why: the problem, with issue link if any.
- Risk: what could break and how widely.
- Test plan: commands run; manual steps for UI.
- Security impact: "none" is fine; otherwise name the affected entry in [`THREAT_MODEL.md`](THREAT_MODEL.md).
- Docs touched: or "n/a".

PRs touching `lib/auth.js`, `lib/trust.js`, `lib/router.js`, `lib/keys.js` or `lib/db.js` need two maintainer approvals.

## Strict rule: no new npm runtime dependencies

Zero runtime npm dependencies is a load-bearing property of the threat model: the supply-chain surface is the Node runtime.

To add one:

1. Open an issue titled `RFC: add <package>`.
2. Cover: what it does, what it replaces, lines saved, transitive tree, last 12 months of advisories, alternatives, and why we can't write it in <300 lines.
3. Wait at least 7 days for review.
4. Get two maintainer approvals.

Dev dependencies (biome, typescript) get the same scrutiny with a lower bar, since they don't ship. `node:` stdlib imports are preferred (`import { readFile } from 'node:fs/promises'`).

## Code style summary

- ESM only (`"type": "module"`). No `require`.
- `node:` prefix on stdlib imports, so a future npm package can't shadow them.
- JSDoc `@param`/`@returns` on every export; checked by `tsc --noEmit`.
- No `console.log` in source; use `lib/log.js`. Remove debug logs from tests before merge.
- No top-level await or import-time side effects in `lib/`. Fine in `server.js` and bin scripts.
- Named exports only.
- Throw `Error` objects, never strings.
- Async functions don't mix `.then`/callbacks.
- Two-space indent, double quotes, semicolons (Biome enforces).
- Filenames: kebab-case everywhere today (`routes/well-known.js`). Match the surrounding files.

## Where to add new code (cookbook)

### New crypto primitive

`lib/<name>.js`, named exports.

- Cite the spec in the leading JSDoc (e.g. `// RFC 8032 §5.1, Ed25519 verify`).
- Spec test vectors in `tests/<name>.test.js`.
- `crypto.timingSafeEqual` wherever user-supplied bytes are compared.
- Compose from `node:crypto` and Node's WebCrypto. Never roll your own primitive.

### New endpoint

`routes/<area>.js`, registered with `get()` / `post()` from `lib/router.js`.

- Validate input with `lib/validate.js`, not ad-hoc regex.
- Render through the `html\`\`` template in `lib/html.js`. `raw()` only for content you produced or have provably sanitised.
- Write endpoints call `audit({ actorId, actorEmail, action, detail, ip })` from `lib/db.js`.
- Test in `tests/e2e/<area>.test.js`: happy path, unauthenticated, unauthorised, invalid input.
- Update the "where lives X" table in [`docs/code-reading-guide.md`](docs/code-reading-guide.md) if it adds a new concern.

### New DB column

In `lib/db.js`:

1. Add it to the `CREATE TABLE` block at the bottom of the bootstrap function (fresh DBs).
2. Add an idempotent `ALTER TABLE` guarded by `PRAGMA table_info(...)` to the migration block (existing DBs).

Non-additive changes have no tooling; follow the manual steps in [`RUNBOOK.md`](RUNBOOK.md#migrations).

### New utility

`lib/<name>.js` with JSDoc, only if it has ≥2 callers. One caller: inline it.

### New static asset

`public/`, served by `routes/static.js`. Long-cached assets need a fingerprinted filename.

### New documentation page

`docs/<area>/<topic>.md`, linked from the relevant top-level doc (`SECURITY.md`, `THREAT_MODEL.md`, etc.). Link, don't duplicate.

## What gets rejected

- New runtime npm dependency without an RFC.
- `console.log` in source.
- Inline `<script>` or `<style>` in a template (breaks CSP).
- A state-mutating route with no audit entry.
- SQL built by string concatenation (use parameterised `prepare()`).
- Removing a test without saying why.
- Changes to `lib/auth.js`, `lib/keys.js` or `lib/trust.js` without a security-impact section.
- "Readability" refactors with no behaviour change and no new tests. They tend to break untested paths. Talk to a maintainer first.

## See also

- [`SECURITY.md`](SECURITY.md): disclosure policy.
- [`THREAT_MODEL.md`](THREAT_MODEL.md): what security review checks against.
- [`docs/code-reading-guide.md`](docs/code-reading-guide.md): short tour for new contributors.
- [`BUILD.md`](BUILD.md): how the artifact is produced and verified.
- [`CHANGELOG.md`](CHANGELOG.md): change log.
