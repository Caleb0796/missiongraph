FROM node:22-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g pnpm@9 @openai/codex

WORKDIR /srv/missiongraph

COPY server ./server
COPY bridge ./bridge
RUN cd server && pnpm install --frozen-lockfile && pnpm build \
  && cd ../bridge && pnpm install --frozen-lockfile && pnpm build

COPY deploy/entry.sh ./entry.sh
RUN chmod +x entry.sh

# Render injects PORT; the server binds to it. /data is the persistent disk.
CMD ["./entry.sh"]
