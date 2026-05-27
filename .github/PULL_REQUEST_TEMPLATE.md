<!--
Thanks for contributing! Please fill out every section below.
PRs that leave required sections blank will be sent back without review.
-->

## Description

<!-- What does this PR do, and *why*? Link the issue or RFC if there is one. -->

Fixes #

---

## Type of change

<!-- Tick exactly one. If your change spans more than one type, split the PR. -->

- [ ] Bugfix (non-breaking change which fixes an issue)
- [ ] Feature (non-breaking change which adds functionality)
- [ ] Refactor (no behavior change, internal cleanup)
- [ ] Docs (documentation only)
- [ ] Test (adds or improves tests; no production-code change)
- [ ] Security (vulnerability fix, hardening, threat-model change)

---

## Testing checklist

- [ ] Added or updated tests under `tests/unit`, `tests/fuzz`, or `tests/integration`
- [ ] Ran `node --test tests/unit tests/fuzz tests/integration` locally and it passed on Node 22 and Node 24
- [ ] Verified the change manually (steps below if non-trivial)
- [ ] CI is green (all jobs in `.github/workflows/ci.yml`)

<details>
<summary>Manual verification steps</summary>

<!-- e.g. `node server.mjs`, then `curl -i http://localhost:8080/health` -->

</details>

---

## Security checklist

- [ ] **No new runtime dependencies** added to `package.json#dependencies` (the `zero-runtime-deps` job enforces this)
- [ ] **No PII** is written to logs, traces, or error messages introduced by this change
- [ ] **No secrets, tokens, or API keys** are committed (env vars / a secrets manager only)
- [ ] **CSP / security headers** are unchanged or strictly hardened (never weakened)
- [ ] If this introduces a new HTTP route, input is validated and the route is rate-limited
- [ ] If this touches authentication, session handling, or crypto: a security reviewer is requested

---

## Screenshots / asciinema

<!-- Required for any UX-visible change. Drag-and-drop images, or paste an asciinema link. -->

---

## Threat model impact

<!--
Describe any new or changed assumptions in the threat model:
  - New trust boundaries crossed?
  - New data classes handled?
  - New external services contacted?
  - New attack surface exposed?
Write "No threat-model impact" if truly none, but think twice before doing so.
-->
