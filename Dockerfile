# Single-stage Dockerfile.
#
# Why single-stage: there's nothing to build. The app is plain JavaScript
# with no dependencies. We just copy the source and run it.
#
# Image size: ~70MB on top of node:22-alpine.

FROM node:22-alpine

WORKDIR /app

# Copy source. .dockerignore excludes data/, *.csv, .env, etc.
COPY . .

# Persistent volume mount target. Set DATABASE_PATH=/data/app.db at runtime.
VOLUME ["/data"]

ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/data/app.db

EXPOSE 3000

# Drop privileges
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:3000/about >/dev/null 2>&1 || exit 1

CMD ["node", "--no-warnings=ExperimentalWarning", "server.js"]
