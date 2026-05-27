---
name: Feature request
about: Propose a new capability or enhancement
title: "[feature] "
labels: [enhancement, needs-triage]
assignees: []
---

## Problem

<!--
What user-facing problem are you trying to solve?
Skip implementation details here; focus on the *need*.
A good problem statement starts with "As a ..., I want ..., so that ...".
-->

## Proposed solution

<!-- Sketch the user-visible API / UX. Code samples welcome. -->

## Alternatives considered

<!-- What other approaches did you weigh, and why is the proposal better? -->

## Constraints to honor

- [ ] Must remain **zero runtime dependencies** (the `zero-runtime-deps` CI job will block any new runtime dep)
- [ ] Must pass all existing tests, lint, typecheck
- [ ] Must not weaken CSP / security headers / threat model
- [ ] Must work on Node 22 and Node 24 (the test matrix)

## Additional context

<!-- Links, prior art, related issues. -->

## Willingness to contribute

- [ ] I am willing to open a PR for this
- [ ] I would like guidance from a maintainer first
- [ ] I am only filing the request; someone else can implement
