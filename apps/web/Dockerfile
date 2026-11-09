# The dashboard as a container: Next.js standalone build, run on the Playwright image because the
# invoice PDFs are made by headless Chromium. Build from the repo root:
#   docker build -f apps/web/Dockerfile .
# (docker-compose.prod.yml does this.) No secrets go in: the image has no env file, and the
# server's settings arrive at run time.

FROM node:22-bookworm-slim AS build
WORKDIR /repo
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
RUN npm ci
COPY apps/web apps/web
RUN npm run build --workspace web

# Keep this tag equal to the playwright-core version in package-lock.json: the image carries the
# Chromium build that exact version expects, and it is published for amd64 and arm64.
FROM mcr.microsoft.com/playwright:v1.64.1-noble AS run
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build --chown=pwuser:pwuser /repo/apps/web/.next/standalone ./
COPY --from=build --chown=pwuser:pwuser /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=pwuser:pwuser /repo/apps/web/public ./apps/web/public
# Playwright reads its own browsers.json at run time, which file tracing doesn't see: take the
# whole package.
COPY --from=build --chown=pwuser:pwuser /repo/node_modules/playwright-core ./node_modules/playwright-core
# The invoice fonts are read from disk at run time (lib/document-fonts.ts), so file tracing
# doesn't see them.
COPY --from=build --chown=pwuser:pwuser /repo/node_modules/@fontsource ./node_modules/@fontsource
# Saved PDFs and the invoice archive live on a volume mounted here.
RUN mkdir -p /data && chown pwuser:pwuser /data
USER pwuser
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
