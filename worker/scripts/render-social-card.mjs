import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "../..");
const source = path.join(root, "scripts", "social-card.html");
const output = path.join(
  root,
  "public",
  "brand",
  "demobro-social-card.png",
);

await mkdir(path.dirname(output), { recursive: true });

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 1,
  });
  await page.goto(pathToFileURL(source).href, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: output, type: "png" });
  console.log(`Wrote ${output} (1200x630)`);
} finally {
  await browser.close();
}
