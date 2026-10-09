# Intentional non-features

What rideshare deliberately doesn't build, and why. These are decisions, not TODOs. Reopening one needs an RFC issue and a real change in the threat model or operating context.

## No native mobile app

Two more codebases, app-store review, a distribution signing key, and push notifications via a third party that sees user activity. The responsive web page works on any phone with nothing to install, can go on the home screen, and updates on next load. No service worker or offline cache; location is requested only when you tap "Share my location".

## No real-time chat

A different product with its own threat model (group keys, persistence, moderation) and legal exposure (CSAM scanning, lawful intercept). A confirmed ride shows contact info; people talk on Signal, Matrix or the event's chat.

## No cost-splitting payments

PCI scope (even with Stripe), possible KYC/AML and tax reporting, chargebacks, and a new class of fraud. Way out of proportion to the value. People settle up with Venmo or cash; the app can show who owes whom but never moves money.

## No driver verification beyond cross-event trust

Credentials already say "this person attended event X under DID Y". License checks, insurance proof or background checks would make us a regulated entity, mean storing government IDs, and imply a "verified safe driver" promise we can't keep.

## No background checks

Results are jurisdiction-specific, a clean check guarantees nothing, an unclean one may reflect injustice, and storing them invites discrimination claims. If your event needs them, run them outside the app and issue an "approved by the organising committee" credential.

## No insurance products

Regulated: licensing, reporting, sometimes capital reserves. We facilitate peer coordination at an event, closer to a community Slack channel than to Uber. Run any insurance as a separate program.

## No user-uploaded media

Uploads mean EXIF stripping, malware scanning, moderation, storage costs, retention and erasure handling. The only upload is the admin-only deployment logo, as sanitised SVG (see [`docs/security/xss.md`](security/xss.md)).

## No analytics or telemetry

No third-party JavaScript, no per-user behaviour tracking. Aggregate counters from the audit log (rides created today, magic links sent today) are at `/admin/insights`. Keeps CSP at a simple `default-src 'self'`.

## No federated identity (OAuth, OIDC, SSO)

A third-party IdP would learn which event you attended, could lock you out, and adds OAuth misimplementation risk. Magic links depend only on SMTP, and `did:key` plus Verifiable Credentials give cross-event continuity. Signing in with a held credential may come later (federation among deployments, not with an IdP).

## No "remember me forever" sessions

Cookie is `Session` (browser-bounded) by default; "remember me" extends to 30 days max. Long sessions amplify cookie theft, and events last 3-7 days.

## No SMS or phone-call verification

SIM swapping, easy telco interception in some places, per-message cost, and phone numbers are PII. Email's threat model is well understood. A hardware-backed `did:key` (WebAuthn-derived) as a second factor is planned for v0.5, not shipped.

## No driver background photo / ID verification

Same reasons as no background checks and no uploaded media.

## No location history or background tracking

Live location is opt-in on the map and visible only to your matched ride partners. The server keeps just your latest point, in memory, for two minutes; no trail is stored. Web pages can't track in the background, and we wouldn't if they could. Once you've met, use Signal, Find My or Google Maps.

## No automatic ride matching

A matcher is a recommendation system (preference modelling, fairness, gaming) and would need every attendee's location and times. Browsing the open rides list works at event scale (typically <500 active rides at peak).

## See also

- [`SECURITY.md`](../SECURITY.md): disclosure and policy.
- [`THREAT_MODEL.md`](../THREAT_MODEL.md): what we do defend against.
- [`CONTRIBUTING.md`](../CONTRIBUTING.md): the RFC process for reversing any of these.
