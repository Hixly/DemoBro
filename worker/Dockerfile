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

USER pwuser

CMD ["npm", "start"]
