# Build & reproducibility

There is no build step. Node runs `server.js`, `lib/` and `routes/` directly: no bundler, no transpiler, no runtime dependencies (`scripts/check-zero-runtime-deps.mjs` enforces it in CI).

## Checking a checkout

```bash
git clone https://github.com/dcondrey/rideshare
cd rideshare
git status          # clean means unmodified
```

There are no release tags yet. To pin a deployment, record the commit SHA.

Never tracked: `node_modules/`, `data/`, `.env`, deployment keys. The DID document at `/.well-known/did.json` is generated at runtime from the deployment key.

### Hashing the source

```bash
git ls-files -z | sort -z | xargs -0 sha256sum | sha256sum
```

Any tracked change, docs included, changes this hash. To compare behaviour only:

```bash
git diff --diff-filter=ACMRT <sha> -- server.js lib/ routes/ public/
```

## Container image

`Dockerfile` (repo root) is single-stage:

- Base `node:22-alpine`, pinned by digest. Tags move, digests don't; treat bumps as security-relevant.
- Source copied to `/app` (`.dockerignore` excludes `data/`, `.env`, CSVs).
- Runs as the unprivileged `app` user. No `npm install`.
- Data volume at `/data`: `DATABASE_PATH=/data/app.db`, `DEPLOYMENT_KEY_PATH=/data/secrets/deployment.key`.
- `HEALTHCHECK` polls `GET /health`.

Update the base digest:

```bash
docker pull node:22-alpine
docker inspect --format='{{index .RepoDigests 0}}' node:22-alpine
```

Build:

```bash
docker build --platform linux/amd64 --tag rideshare:$(git rev-parse --short HEAD) .
```

`docker-compose.yml`, `fly.toml`, `railway.json`, `render.yaml` and `render.demo.yaml` all build from this Dockerfile.

## Checking a running deployment

`GET /health` returns `{"status":"ok","checks":{"db":true,"signingKey":true}}`, or 503 when a check fails. It does not report a build hash, so you can't verify someone else's deployment from outside. Ask the operator for the commit SHA and the base image digest.

## Not done yet

- Signed release tags and images (`cosign`).
- SLSA provenance from CI.
- A build hash or commit SHA in `/health` or a signed `/.well-known/deployment-manifest.json`.
- Reproducible image builds (`SOURCE_DATE_EPOCH`).
- An SBOM.

## See also

- [`SECURITY.md`](SECURITY.md): disclosure policy.
- [`RUNBOOK.md`](RUNBOOK.md): deploying and updating.
- [`CHANGELOG.md`](CHANGELOG.md): what changed when.
