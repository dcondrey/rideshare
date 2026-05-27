# Build & reproducibility

> How the **rideshare** artifact is produced and how to verify a deployment matches the source. Audience: anyone auditing a running deployment, or building a container image for one.

The headline:

> **There is no build step. The repo IS the deployment artifact.**

This is intentional. No bundler, no transpiler, no lockfile resolution. The Node runtime executes `server.js` and `lib/*.js` directly. What you see in git is what runs in production.

---

## Verifying a fresh checkout

```bash
git clone https://example.com/rideshare
cd rideshare
git verify-tag v0.3.0           # confirms the tag is signed
git checkout v0.3.0
git diff --stat HEAD            # should be empty
```

If `git status` shows nothing and `git diff` shows nothing, you have an authentic, unmodified checkout.

### Files that should exist

A clean checkout at `v0.3.0` contains the following top-level entries:

```
.
├── .env.example
├── .gitignore
├── BUILD.md
├── CHANGELOG.md
├── CONTRIBUTING.md
├── LICENSE
├── README.md
├── RUNBOOK.md
├── SECURITY.md
├── TRUST.md
├── THREAT_MODEL.md
├── biome.json
├── deploy/
│   └── rideshare.service
├── docs/
│   ├── code-reading-guide.md
│   ├── intentional-non-features.md
│   └── security/
│       ├── audit-tampering.md
│       ├── credential-forgery.md
│       ├── csrf.md
│       ├── ssrf.md
│       ├── timing-attacks.md
│       └── xss.md
├── event.config.yaml
├── lib/
│   └── *.js
├── package.json
├── public/
│   ├── .well-known/
│   │   └── security.txt
│   ├── css/
│   └── js/
├── routes/
│   └── *.js
├── server.js
├── tests/
│   └── *.test.js
└── tsconfig.json
```

Files that should **never** exist in a clean checkout: `node_modules/`, `events.db`, `secrets/`, `.env`, anything under `public/.well-known/did.json` (generated at deploy time).

### Hashing the source tree

```bash
git ls-files | sort | xargs sha256sum | sha256sum
```

This is the build hash. The reference deployment exposes the same value at `GET /health` (`{"status":"ok","build":"<hex>"}`). Pin it for your event:

```bash
curl -fsSL https://$EVENT_HOST/health | jq -r .build
# compare to the local computation above
```

Mismatch means the deployment is running modified source. That may be legitimate (your fork, your patches) but you should know about it.

---

## Container image (Docker)

A Dockerfile is provided in `deploy/Dockerfile`. It produces a single-process image that runs `node server.js`.

### Pinning the base image

```Dockerfile
FROM node:22.5.1-alpine3.20@sha256:<digest>
```

The digest pin is what makes the image reproducible — image tags are mutable, digests are not. Update the digest by running:

```bash
docker pull node:22.5.1-alpine3.20
docker inspect --format='{{index .RepoDigests 0}}' node:22.5.1-alpine3.20
```

…and committing the new digest. Treat each base-image bump as a security-relevant change (see [`CONTRIBUTING.md`](CONTRIBUTING.md)).

### Building

```bash
docker build \
  --platform linux/amd64 \
  --provenance=false \
  --tag rideshare:v0.3.0 \
  --file deploy/Dockerfile .
```

`--platform linux/amd64` ensures cross-platform builds produce identical output regardless of the host architecture. `--provenance=false` keeps the image layer set deterministic; we publish provenance separately (see [Future](#future)).

### Verifying the image digest

After build:

```bash
docker inspect --format='{{.Id}}' rideshare:v0.3.0
```

The expected SHA-256 for the released image is published in the GitHub release notes for the matching tag (and signed — see Future).

To verify a *running* image matches what you built:

```bash
docker inspect --format='{{.Image}}' rideshare-running
# compare to the build SHA above
```

### What's inside the image

- `node:22.5.1-alpine3.20` base.
- The repo's source files copied to `/app`.
- A non-root user (`uid=10001`, `gid=10001`).
- `WORKDIR /app`, `USER 10001`, `ENTRYPOINT ["node", "server.js"]`.
- No `npm install`. No `apk add` beyond what the base image already has.

---

## Verifying a deployment

For a deployment you don't own (e.g. you're an attendee auditing a venue's instance):

1. Note the `Server` header on responses — should be either absent or `rideshare`.
2. `curl https://$EVENT_HOST/health` and capture the `build` hash.
3. Locally check out the matching tag.
4. Recompute the hash via the formula above.
5. Compare.

For deeper audit, request that the operator publish:

- The git tag deployed.
- The base image digest.
- The file mode and ownership of `secrets/` and `events.db`.
- The output of `node --version` from inside the running container.

The reference deployment publishes these in a public "deployment manifest" page at `/.well-known/deployment-manifest.json` (planned — tracked in [Future](#future)).

---

## Updating

Every change to `server.js`, `lib/`, `routes/`, or `public/` changes the build hash by definition. Documentation changes do too — that's fine; reproducibility is reproducibility, not behavioural equivalence. If you want to verify *behavioural* equivalence ignoring docs, use `git diff --diff-filter=ACMRT -- 'server.js' 'lib/' 'routes/' 'public/'` instead.

---

## Future

Tracked work toward stronger supply-chain assurance:

- **SLSA provenance**, level 3 target. Build attestations for both the source tarball and the container image, signed by a CI key, stored in a transparency log.
- **`cosign` signing of release tags and container images.** Operators verify with `cosign verify`.
- **`/.well-known/deployment-manifest.json`** endpoint listing the deployed git SHA, base image digest, Node version, and a fresh signature over the build hash. Lets attendees do the verification described above without operator cooperation beyond running the codebase.
- **Deterministic Docker builds** (BuildKit `--reproducible`, `SOURCE_DATE_EPOCH=$(git log -1 --format=%ct)`). Currently the image is layer-deterministic given the same inputs but the manifest timestamps are not pinned.
- **Software bill of materials (SBOM)** in CycloneDX form, generated from the source tree (which is short — base image + Node stdlib + our code).

---

## See also

- [`SECURITY.md`](SECURITY.md) — disclosure policy.
- [`RUNBOOK.md`](RUNBOOK.md#updating-the-deployment) — how operators update.
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — signed-commit policy.
- [`CHANGELOG.md`](CHANGELOG.md) — what changed when.
