# The GUI is pre-built (web/dist) so the image builds quickly on a Pi.
# Rebuild it with:  cd web && npm ci && npm run build
FROM node:22-alpine

WORKDIR /app
COPY server/package.json server/
COPY server/src server/src
COPY web/dist web/dist
# the dashboard card, which the app copies into Home Assistant on start
COPY dashboard/home-control-card.js dashboard/

ENV NODE_ENV=production \
    WEB_DIR=/app/web/dist \
    DATA_DIR=/data \
    PORT=8099

CMD ["node", "server/src/index.js"]
