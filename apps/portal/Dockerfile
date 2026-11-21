# Build from the repository root:  docker build -f apps/portal/Dockerfile -t venstudio-portal .
FROM node:24-bookworm-slim AS deps
WORKDIR /repo
COPY package.json package-lock.json* ./
COPY apps/portal/package.json apps/portal/
COPY packages/protocol/package.json packages/protocol/
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build -w apps/portal

FROM node:24-bookworm-slim AS run
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    WORKER_DIR=/app/worker \
    ARTIFACT_DIR=/data/artifacts
WORKDIR /app
COPY --from=build /repo/apps/portal/.next/standalone ./
COPY --from=build /repo/apps/portal/.next/static ./apps/portal/.next/static
COPY --from=build /repo/apps/portal/db ./apps/portal/db
COPY --from=build /repo/apps/portal/scripts ./apps/portal/scripts
COPY apps/worker/venstudio-worker.ts apps/worker/install.sh apps/worker/SETUP.md ./worker/
# The Remotion templates, served as /install/render-remotion.json (sources only; workers npm-install the rest).
COPY apps/render-remotion/package.json apps/render-remotion/tsconfig.json ./render-remotion/
COPY apps/render-remotion/src ./render-remotion/src
COPY apps/render-remotion/scripts ./render-remotion/scripts
RUN mkdir -p /data/artifacts && chown -R node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "-c", "node apps/portal/scripts/migrate.mjs && exec node apps/portal/server.js"]
