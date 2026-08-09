# Official Playwright image — Chromium + system deps included.
FROM mcr.microsoft.com/playwright:v1.51.0-jammy

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

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
