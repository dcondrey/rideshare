# Intentional non-features

> Things **rideshare** deliberately does not build, and the security or scope reasoning. Audience: anyone proposing "what if we added…" or evaluating whether the project meets their needs.

A non-feature is not a TODO. These are decisions, not gaps. Reopening any of them requires an RFC issue and a meaningful change in the threat model or operating context.

---

## No native mobile app

**Why not:** a Progressive Web App is sufficient for the use case. Adding a native app would add:

- App-store review surface (unrelated organisations approving our security model).
- Two more codebases (iOS, Android), each with its own attack surface.
- Push notifications, which require a third-party service that observes user activity.
- A signing-key management story for app distribution that is non-trivial.

**The PWA gives us:** add-to-home-screen, offline cache via service worker, geolocation, full UI control. Sufficient for an event.

---

## No real-time chat

**Why not:** out of scope. Chat is a different product with its own threat model (group key management, message persistence, moderation tooling).

Attendees coordinate via the channels they already have: Signal, Matrix, the event's official chat. We surface attendee contact info on a confirmed ride; the actual conversation happens elsewhere.

This also avoids the legal exposure of operating a chat service (CSAM scanning, lawful intercept requests, content moderation).

---

## No cost-splitting payments

**Why not:** payment processing brings:

- PCI scope, even when offloaded to Stripe (the integration code is in scope).
- KYC/AML obligations in some jurisdictions if we hold funds.
- Chargeback handling and customer service.
- A whole new class of financial-fraud attacks against the app.
- Tax reporting in some jurisdictions for facilitated payments.

The complexity is wildly disproportionate to the value. Drivers and riders settle externally (Venmo, cash, "I owe you a beer"). The app surfaces who-owes-whom if asked, but does not move money.

---

## No driver verification beyond cross-event trust

**Why not:** the cross-event Verifiable Credential model already provides "this person attended event X under DID Y." Going further (background checks, license verification, insurance proof) means:

- Becoming a regulated entity in many jurisdictions.
- Storing copies of government IDs (a high-value target).
- Making promises we cannot keep ("verified safe driver" — we can't promise that).

The cross-event credential model gives attendees something concrete to evaluate — the person showed up at IIW XX, they're a known quantity in the community — without us pretending to do background checks we can't verify.

---

## No background checks

**Why not:** see above. Also:

- Background checks are jurisdiction-specific and the result varies wildly in meaning.
- A clean check is not a guarantee; an unclean check may reflect injustice rather than risk.
- Storing the result creates discrimination exposure.

If your event needs background checks, run them outside the app, encode the result as "this attendee was approved by the organising committee," and grant them a credential of that type.

---

## No insurance products

**Why not:** insurance is a regulated product. Selling, brokering, or even loosely facilitating it brings licensing requirements, ongoing reporting, capital reserves (for some jurisdictions), and a class of commercial counterparty risk we have no business handling.

A commercial ride-sharing service has insurance because they are providing the ride as a service. We are facilitating peer coordination among attendees of an event the attendees chose to come to. The legal frame is closer to a community Slack channel than to Uber.

If your event wants to provide insurance to ride-sharers, run that as a separate program.

---

## No user-uploaded media

**Why not:**

- Image uploads bring an entire EXIF-stripping, malware-scanning, content-moderation pipeline.
- Video uploads bring an order of magnitude more.
- Storage means cost, retention policy, deletion guarantees, GDPR/erasure handling.
- Misuse cases (harassment imagery, NSFW) we do not want to be in the business of moderating.

The one exception is the deployment logo (admin-only, sanitised SVG, see [`docs/security/xss.md`](security/xss.md)). That's the only file an attacker-controlled-or-influenced party can upload, and it is heavily constrained.

---

## No analytics or telemetry

**Why not:** the audience is security-conscious; running third-party analytics (Google, Plausible, even self-hosted Matomo with default cookies) signals we don't take their privacy seriously.

What we do instead:

- Aggregate counters in the audit log (rides created today, magic links sent today). Visible at `/admin/insights`.
- No per-user behaviour tracking. We don't know that user 42 looked at three rides before claiming one.
- No third-party JavaScript on any page.

This is also a CSP simplification: `default-src 'self'` is easy to maintain when there is nothing external.

---

## No federated identity (OAuth, OIDC, SSO)

**Why not:** OIDC against a third-party provider (Google, GitHub, your-corporate-IDP) means:

- The provider learns which event you attended.
- The provider can lock you out by suspending your account.
- We become a target for OAuth-misimplementation attacks.

The magic-link flow is conceptually similar (we send a link to your email, you prove you control the inbox) but the dependency is just SMTP, not a stateful relationship with an identity provider. And the trust portability story (`did:key`, Verifiable Credentials) gives the cross-event identity continuity that SSO would otherwise provide.

A future feature might allow signing in via a held credential — that's federation against ourselves and other deployments, not against a third-party IDP.

---

## No "remember me forever" sessions

**Why not:** sessions are 30 days max, cookie is `Session` (browser-bounded) by default; "remember me" extends to 30 days but no further. After that, sign in again.

Long sessions amplify the impact of cookie theft. For an event lifetime (typically 3-7 days) the default is well-suited.

---

## No SMS or phone-call verification

**Why not:**

- SIM swapping is a real and accessible attack.
- Telco interception in some jurisdictions is trivial.
- Cost per message at scale.
- Globally, phone numbers are PII and storing them carries obligations.

Email is not perfect but the threat model is well-understood. Attendees who want a stronger second factor can bind a `did:key` with a hardware-backed key (WebAuthn-derived, not currently shipped but planned for v0.5).

---

## No driver background photo / ID verification

See "No background checks" and "No user-uploaded media." Same reasoning, doubled.

---

## No real-time location sharing during a ride

**Why not:**

- Live-location streaming requires WebSockets or long-poll: more attack surface.
- Storing or even briefly buffering live location creates a high-value target.
- Existing tools (Signal, Find My, Google Maps share-trip) do this well already.

We facilitate the meeting. After that, attendees use whatever they already use.

---

## No automatic ride matching

**Why not:** an algorithmic matcher is a recommendation system, with all the complexity that implies (preference modeling, fairness considerations, abuse via gaming the algorithm). Plus it would need to read every attendee's location and time to compute matches — a reach that's hard to justify for the marginal utility over "browse the open rides list."

The list-based UI scales to the size of an event (typically <500 active rides at peak).

---

## See also

- [`SECURITY.md`](../SECURITY.md) — disclosure and policy.
- [`THREAT_MODEL.md`](../THREAT_MODEL.md) — what we *do* defend against.
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — the RFC process for proposing reversal of any of these.
