---
name: Security report (DO NOT USE THIS FORM)
about: Security disclosures must be sent privately — see instructions below
title: "[security] DO NOT FILE PUBLICLY"
labels: [security, do-not-use]
assignees: []
---

# STOP — do not file a public issue for security reports.

Security vulnerabilities, suspected vulnerabilities, and any report involving an exploitable
weakness must be disclosed **privately** so they can be fixed before the details become public.

## How to disclose

Read [`SECURITY.md`](../../SECURITY.md) in the root of this repository for the full policy
(supported versions, coordinated disclosure timeline, PGP key, scope).

Then choose **one** of the following private channels — listed in order of preference:

1. **GitHub Private Vulnerability Reporting** — preferred.
   Open the repository's **Security** tab and click **Report a vulnerability**. This creates a
   private advisory only the maintainers can see.

2. **Email** the maintainers at the address listed in `SECURITY.md`. Encrypt with the PGP key
   published there if the report contains exploit details.

## What to include

- A clear description of the issue and its impact.
- Reproduction steps (or a proof-of-concept).
- The version / commit SHA you tested against.
- Your name / handle for credit (optional).

## What NOT to do

- Do not open a public issue, discussion, or PR that describes the vulnerability.
- Do not test against production infrastructure that is not yours.
- Do not exfiltrate, modify, or delete data that is not yours.

---

If you opened this template by accident, please **close it immediately** and follow the
instructions above. Thank you for helping keep the project and its users safe.
