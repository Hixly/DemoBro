# Match the ffmpeg used in local dev. Jammy only packages 4.4, which predates
# the -fps_mode flag the render pipeline relies on and differs in filter
# behaviour, so renders that work locally would fail here.
FROM mwader/static-ffmpeg:8.1.2 AS ffmpeg

# Official Playwright image — Chromium + system deps included.
FROM mcr.microsoft.com/playwright:v1.51.0-jammy

USER root
COPY --from=ffmpeg /ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg /ffprobe /usr/local/bin/ffprobe

WORKDIR /app

# Browsers already present in the base image; skip download in container builds.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src
COPY assets ./assets

# The base image drops to `pwuser`, but /app is root-owned, so the worker needs
# an explicitly writable scratch dir for raw captures and renders.
ENV DEMOBRO_OUTPUT_DIR=/app/output
RUN mkdir -p /app/output && chown -R pwuser:pwuser /app/output

USER pwuser

CMD ["npm", "start"]
