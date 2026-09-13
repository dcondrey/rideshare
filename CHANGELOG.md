# Changelog

All notable changes to this project are generated from the commit history.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) +
[Conventional Commits](https://www.conventionalcommits.org/).
## [Unreleased]

### Added
- Validate the event config at load and untrack the live one
- Key ride confirmations and issued credentials by claim
- Add key custody, SSRF-safe fetch, event schema, banner, seo and health modules
- Initial release of event rideshare platform

### Documentation
- Document key custody, the new controls and the operator procedures
- Update changelog [skip ci]
- Update changelog [skip ci]
- Restore CI and OpenSSF badges
- Fix README header rendering and badge accuracy
- Update changelog [skip ci]
- Update changelog [skip ci]
- Update changelog [skip ci]
- Update changelog [skip ci]
- Expand the pull request template with type, security, and threat-model sections
- Update changelog [skip ci]
- Standardize repository presentation (#12)
- Update changelog [skip ci]
- Update changelog [skip ci]
- Update changelog [skip ci]
- Update changelog [skip ci]
- Update changelog [skip ci]
- Update changelog [skip ci]
- Update changelog [skip ci]
- Update changelog [skip ci]
- Update changelog [skip ci]
- Restructure README with collapsible sections
- Replace static CI badge with live GitHub Actions badge

### Fixed
- Key map tiles per world copy and anchor pinch zoom on the midpoint
- Report allowlist file progress without blocking or a modal
- Bound request/body/email latency and retry transient DB/email failures
- Run tsc through npx -p so the typecheck step executes
- Remove the last bare any casts, all six CI gates green
- Bring the Biome gate back to green
- Typecheck clean under checkJs
- Make the typecheck gate real and start clearing it
- Clear the license-header, banned-pattern and CSP gates
- Give the CI boot smoke job the env vars lib/config.js requires
- Run CI tests via node --test discovery and repair the dead html tests
- Stop .gitignore from excluding source files named allowlist*
- Rewrite rate-limit tests against the real rateLimit() API (#9)
- Null-prototype object for parsed cookies; drop unused safeEqual import (#8)
- Harden setPath() against prototype pollution (#7)
- Escape/validate untrusted map config before DOM insertion (#6)
- Prevent log injection and tainted-format-string in error logging (#5)

### Security
- Close the auth, logging, upload and outbound-request gaps

### Style
- Apply the repo's Biome formatting and safe lint fixes

