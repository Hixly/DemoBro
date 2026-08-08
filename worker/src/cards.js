import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const W = 1920;
const H = 1080;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function titleCardHtml({ title, description, liveUrl, badges }) {
  const pills = (badges ?? [])
    .slice(0, 6)
    .map((b) => `<span class="pill">${escapeHtml(b)}</span>`)
    .join("");

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet" />
  <style>
    * { box-sizing: border-box; }
    html, body {
      margin: 0; width: ${W}px; height: ${H}px; overflow: hidden;
      background: #FAF9F6;
      font-family: "Fredoka", system-ui, sans-serif;
    }
    .stage {
      width: 100%; height: 100%;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      padding: 80px 120px; gap: 28px;
    }
    .title {
      margin: 0;
      font-size: 92px; font-weight: 700; line-height: 1.05;
      color: #141414; text-align: center; letter-spacing: -0.02em;
      max-width: 1500px;
    }
    .desc {
      margin: 0;
      font-size: 32px; font-weight: 500; line-height: 1.35;
      color: #3A3A3A; text-align: center; max-width: 1180px;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .url {
      margin: 4px 0 0;
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: 22px; font-weight: 500; color: #5A5A5A;
      text-align: center;
    }
    .pills {
      display: flex; flex-wrap: wrap; gap: 14px;
      justify-content: center; margin-top: 18px; max-width: 1200px;
    }
    .pill {
      display: inline-flex; align-items: center;
      border: 2px solid #141414;
      border-radius: 999px;
      background: #2BACFC;
      color: #141414;
      padding: 12px 26px;
      font-size: 26px; font-weight: 600;
      box-shadow: 3px 3px 0 #141414;
    }
  </style>
</head>
<body>
  <div class="stage">
    <h1 class="title">${escapeHtml(title)}</h1>
    <p class="desc">${escapeHtml(description)}</p>
    <p class="url">${escapeHtml(liveUrl)}</p>
    <div class="pills">${pills}</div>
  </div>
</body>
</html>`;
}

function outroCardHtml({ repoUrl, logoUrl }) {
  const repo = String(repoUrl || "").replace(/^https?:\/\//, "");
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet" />
  <style>
    * { box-sizing: border-box; }
    html, body {
      margin: 0; width: ${W}px; height: ${H}px; overflow: hidden;
      background: #FAF9F6;
      font-family: "Fredoka", system-ui, sans-serif;
    }
    .stage {
      width: 100%; height: 100%;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      padding: 80px; gap: 22px;
    }
    .logo {
      width: 300px; height: 300px; object-fit: contain;
      margin-bottom: 8px;
      /* Near-white JPG bg keyed out in JS before paint */
    }
    .wordmark {
      margin: 0;
      font-size: 64px; font-weight: 700; line-height: 1.1;
      letter-spacing: -0.02em; text-align: center;
    }
    .wordmark .ink { color: #141414; }
    .wordmark .accent { color: #2BACFC; }
    .built {
      margin: 0 0 4px;
      font-size: 28px; font-weight: 500; color: #5A5A5A;
      text-align: center;
    }
    .repo {
      margin: 18px 0 0;
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: 26px; font-weight: 500; color: #2BACFC;
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="stage">
    <img class="logo" src="${logoUrl}" alt="" width="280" height="280" />
    <p class="built">Built with</p>
    <p class="wordmark"><span class="ink">DemoBro</span><span class="accent">.video</span></p>
    <p class="repo">${escapeHtml(repo)}</p>
  </div>
</body>
</html>`;
}

/**
 * Render a branded card PNG via Playwright (exact logo + Fredoka).
 * Logo is inlined as a data URL so Chromium can load the real JPG bytes
 * without file:// restrictions under setContent.
 */
export async function renderCardPng(outPath, kind, data, logoPath) {
  await mkdir(path.dirname(outPath), { recursive: true });
  const bytes = await readFile(logoPath);
  const logoUrl = `data:image/jpeg;base64,${bytes.toString("base64")}`;
  const html =
    kind === "title"
      ? titleCardHtml({ ...data, logoUrl })
      : outroCardHtml({ ...data, logoUrl });

  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage({
      viewport: { width: W, height: H },
      deviceScaleFactor: 1,
    });
    await page.setContent(html, { waitUntil: "networkidle" });
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    if (kind === "outro") {
      await page.waitForFunction(() => {
        const img = document.querySelector("img.logo");
        return img && img.complete && img.naturalWidth > 0;
      });
      // Knock out near-white JPG background so it sits cleanly on #FAF9F6
      await page.evaluate(() => {
        const img = document.querySelector("img.logo");
        if (!(img instanceof HTMLImageElement)) return;
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(img, 0, 0);
        const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const d = image.data;
        for (let i = 0; i < d.length; i += 4) {
          const r = d[i];
          const g = d[i + 1];
          const b = d[i + 2];
          // Treat near-white / off-white as transparent
          if (r > 235 && g > 235 && b > 230 && Math.abs(r - g) < 18) {
            d[i + 3] = 0;
          }
        }
        ctx.putImageData(image, 0, 0);
        img.src = canvas.toDataURL("image/png");
      });
      await page.waitForFunction(() => {
        const img = document.querySelector("img.logo");
        return img && img.complete && img.naturalWidth > 0;
      });
    }
    await page.waitForTimeout(300);
    await page.screenshot({
      path: outPath,
      type: "png",
      omitBackground: false,
    });
  } finally {
    await browser.close();
  }
}

export { W, H };
