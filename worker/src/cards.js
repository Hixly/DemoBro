import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const W = 1920;
const H = 1080;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INTER_FONT = path.resolve(__dirname, "../assets/fonts/Inter-Regular.ttf");

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

/**
 * Full-frame transparent lower-third caption: one dark pill, white Inter type.
 * Bar is pinned to a fixed Y so every beat lands in the same spot.
 */
function captionCardHtml({ text, fontUrl, position = "bottom" }) {
  const anchor = position === "top" ? "top: 80px;" : "bottom: 80px;";
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    @font-face {
      font-family: "Inter";
      src: url("${fontUrl}") format("truetype");
      font-weight: 400 600;
      font-style: normal;
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0; width: ${W}px; height: ${H}px; overflow: hidden;
      background: transparent;
      font-family: "Inter", system-ui, sans-serif;
    }
    .stage {
      position: relative;
      width: 100%; height: 100%;
      background: transparent;
    }
    .caption {
      position: absolute;
      left: 50%;
      ${anchor}
      transform: translateX(-50%);
      max-width: 1600px;
      padding: 18px 44px;
      border-radius: 999px;
      background: rgba(10, 10, 12, 0.78);
      color: #ffffff;
      font-size: 38px;
      font-weight: 500;
      letter-spacing: -0.01em;
      line-height: 1.2;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      box-shadow: 0 10px 28px rgba(0, 0, 0, 0.38);
    }
  </style>
</head>
<body>
  <div class="stage">
    <div class="caption">${escapeHtml(text)}</div>
  </div>
</body>
</html>`;
}

function outroCardHtml({ title, liveUrl, repoUrl, logoUrl }) {
  const project = String(title || "this project").trim().slice(0, 64);
  const live = String(liveUrl || "").replace(/^https?:\/\//, "");
  const repo = String(repoUrl || "").replace(/^https?:\/\//, "");
  const primary = live || repo;
  const secondary = live && repo && live !== repo ? repo : "";
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
      padding: 72px 110px; gap: 18px;
    }
    .eyebrow {
      margin: 0 0 2px;
      color: #141414;
      font-size: 25px; font-weight: 600;
      letter-spacing: 0.08em; text-transform: uppercase;
    }
    .project {
      margin: 0;
      max-width: 1500px;
      font-size: 82px; font-weight: 700; line-height: 1.05;
      color: #141414;
      letter-spacing: -0.02em; text-align: center;
    }
    .primary {
      margin: 8px 0 0;
      max-width: 1500px;
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: 36px; font-weight: 500; color: #168DD6;
      text-align: center;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .repo {
      margin: 0;
      max-width: 1350px;
      font-family: "IBM Plex Mono", ui-monospace, monospace;
      font-size: 21px; font-weight: 500; color: #5A5A5A;
      text-align: center;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .rule {
      width: 180px; height: 3px; margin: 16px 0 4px;
      border-radius: 999px; background: #141414;
    }
    .made {
      display: flex; align-items: center; gap: 16px;
    }
    .logo {
      width: 84px; height: 84px; object-fit: contain;
      /* Near-white JPG bg keyed out in JS before paint */
    }
    .credit {
      display: flex; flex-direction: column; align-items: flex-start;
      gap: 1px;
    }
    .built {
      margin: 0; color: #5A5A5A;
      font-size: 19px; font-weight: 500;
    }
    .wordmark {
      margin: 0; font-size: 34px; font-weight: 700; line-height: 1;
      letter-spacing: -0.02em;
    }
    .wordmark .ink { color: #141414; }
    .wordmark .accent { color: #2BACFC; }
  </style>
</head>
<body>
  <div class="stage">
    <p class="eyebrow">Keep exploring</p>
    <h1 class="project">Try ${escapeHtml(project)}</h1>
    <p class="primary">${escapeHtml(primary)}</p>
    ${secondary ? `<p class="repo">Source: ${escapeHtml(secondary)}</p>` : ""}
    <div class="rule"></div>
    <div class="made">
      <img class="logo" src="${logoUrl}" alt="" width="84" height="84" />
      <div class="credit">
        <p class="built">Made with</p>
        <p class="wordmark"><span class="ink">Demo</span><span class="accent">Bro</span></p>
      </div>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Render a branded card PNG via Playwright.
 * Title/outro use Fredoka + inlined logo; caption uses bundled Inter on a
 * transparent full-frame canvas (lower-third pill already positioned).
 */
export async function renderCardPng(outPath, kind, data, logoPath) {
  await mkdir(path.dirname(outPath), { recursive: true });

  let html;
  if (kind === "caption") {
    const fontBytes = await readFile(INTER_FONT);
    const fontUrl = `data:font/ttf;base64,${fontBytes.toString("base64")}`;
    html = captionCardHtml({
      text: String(data?.text ?? "").trim(),
      fontUrl,
      position: data?.position === "top" ? "top" : "bottom",
    });
  } else {
    const bytes = await readFile(logoPath);
    const logoUrl = `data:image/jpeg;base64,${bytes.toString("base64")}`;
    html =
      kind === "title"
        ? titleCardHtml({ ...data, logoUrl })
        : outroCardHtml({ ...data, logoUrl });
  }

  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage({
      viewport: { width: W, height: H },
      deviceScaleFactor: 1,
    });
    await page.setContent(html, {
      waitUntil: kind === "caption" ? "load" : "networkidle",
    });
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
    await page.waitForTimeout(kind === "caption" ? 120 : 300);
    await page.screenshot({
      path: outPath,
      type: "png",
      omitBackground: kind === "caption",
    });
  } finally {
    await browser.close();
  }
}

export { W, H };
