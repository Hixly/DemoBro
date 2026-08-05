# Official Playwright image — Chromium + system deps included.
FROM mcr.microsoft.com/playwright:v1.51.0-jammy

USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
COPY src ./src

USER pwuser

CMD ["npm", "start"]
