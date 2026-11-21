FROM oven/bun:1-alpine
WORKDIR /app

# The CLI imports only from src/ and has zero runtime dependencies, so there
# is no install step and the image stays tiny.
COPY package.json ./
COPY src ./src

# Create and own the data dir BEFORE declaring it a volume: changes made to a
# path after VOLUME are discarded, which would leave it root-owned and unwritable.
RUN mkdir -p /data && chown bun:bun /data
USER bun

# The SQLite file lives in the volume, so data survives container restarts.
ENV PORT=3000 \
    TALLYMARK_DB=/data/tallymark.db
VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["bun", "src/cli.ts"]
