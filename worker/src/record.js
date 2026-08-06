import { mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { assertSafePublicUrl } from "./ssrf.js";

const VIEWPORT = { width: 1920, height: 1080 };
const SESSION_TIMEOUT_MS = 3 * 60 * 1000;
const STEP_TIMEOUT_MS = 8_000;
const SETTLE_MS = 1_200;

/**
 * @typedef {{ id?: string, description: string, targetHint: string }} StoryboardStep
 * @typedef {{ index: number, description: string, targetHint: string, status: 'succeeded' | 'skipped', reason?: string, startMs?: number, endMs?: number }} StepReport
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function looksLikeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isNativePermissionStep(step) {
  const blob = `${step.description} ${step.targetHint}`.toLowerCase();
  return (
    blob.includes("allow") &&
    (blob.includes("camera") || blob.includes("permission") || blob.includes("prompt"))
  );
}

/**
 * @param {import('playwright').Page} page
 * @param {string} hint
 */
function locatorForHint(page, hint) {
  const trimmed = hint.trim();
  if (!trimmed) return page.locator("body");

  // Playwright text engine: button:has-text("Freeze")
  if (
    /:has-text\(/.test(trimmed) ||
    trimmed.startsWith("text=") ||
    trimmed.startsWith("role=") ||
    /\[aria-label=/.test(trimmed)
  ) {
    return page.locator(trimmed).first();
  }

  // Accessible name shorthand — "Get Started"
  if (/^[^.#\[\]=]+$/.test(trimmed) && /\s/.test(trimmed)) {
    return page
      .getByRole("button", { name: trimmed })
      .or(page.getByRole("link", { name: trimmed }))
      .or(page.getByText(trimmed, { exact: false }))
      .first();
  }

  return page.locator(trimmed).first();
}

/**
 * @param {import('playwright').Page} page
 * @param {import('playwright').Locator} locator
 */
async function moveMouseVisibly(page, locator) {
  const box = await locator.boundingBox();
  if (!box) return;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y, { steps: 28 });
}

/**
 * @param {import('playwright').Page} page
 * @param {string} url
 */
async function safeGoto(page, url) {
  const before = await assertSafePublicUrl(url);
  if (!before.ok) {
    throw new Error(before.error);
  }

  const response = await page.goto(before.url.toString(), {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });

  const finalUrl = page.url();
  const after = await assertSafePublicUrl(finalUrl);
  if (!after.ok) {
    throw new Error(`Blocked after redirect: ${after.error}`);
  }

  return response;
}

/**
 * @param {import('playwright').Page} page
 * @param {StoryboardStep} step
 * @param {number} index
 * @returns {Promise<StepReport>}
 */
async function executeStep(page, step, index) {
  const base = {
    index: index + 1,
    description: step.description,
    targetHint: step.targetHint,
  };

  if (isNativePermissionStep(step)) {
    return {
      ...base,
      status: "skipped",
      reason:
        "Camera permission is granted via context + fake media flags, not a clickable Allow button",
    };
  }

  try {
    if (looksLikeUrl(step.targetHint) || /^open\b/i.test(step.description)) {
      const url = looksLikeUrl(step.targetHint)
        ? step.targetHint
        : page.url();
      await safeGoto(page, looksLikeUrl(step.targetHint) ? step.targetHint : url);
      await sleep(SETTLE_MS + 800);
      return { ...base, status: "succeeded" };
    }

    const locator = locatorForHint(page, step.targetHint);
    await locator.waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    await moveMouseVisibly(page, locator);

    const desc = step.description.toLowerCase();
    const tag = await locator.evaluate((el) => el.tagName.toLowerCase()).catch(() => "");

    if (
      desc.includes("watch") ||
      desc.includes("point") ||
      desc.includes("pause") ||
      desc.includes("land") ||
      tag === "video"
    ) {
      await locator.hover({ timeout: STEP_TIMEOUT_MS }).catch(() => {});
      await sleep(SETTLE_MS + 1500);
      return { ...base, status: "succeeded" };
    }

    await locator.click({ timeout: STEP_TIMEOUT_MS });
    await sleep(SETTLE_MS);
    return { ...base, status: "succeeded" };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(`[record] step ${index + 1} skipped: ${reason}`);
    return {
      ...base,
      status: "skipped",
      reason: reason.slice(0, 240),
    };
  }
}

/**
 * @param {{ liveUrl: string, steps: StoryboardStep[], outputDir: string, jobId?: string }} options
 */
export async function recordStoryboard(options) {
  const { liveUrl, steps, outputDir } = options;
  const jobId = options.jobId ?? `job-${Date.now()}`;
  const videoDir = path.join(outputDir, "raw", jobId);
  await mkdir(videoDir, { recursive: true });

  const safe = await assertSafePublicUrl(liveUrl);
  if (!safe.ok) {
    throw new Error(safe.error);
  }

  const origin = safe.url.origin;
  /** @type {StepReport[]} */
  const reports = [];
  let videoPath = null;

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });

  const context = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: {
      dir: videoDir,
      size: VIEWPORT,
    },
    permissions: ["camera", "microphone"],
  });

  await context.grantPermissions(["camera", "microphone"], { origin });

  const page = await context.newPage();
  page.setDefaultTimeout(STEP_TIMEOUT_MS);
  const t0 = Date.now();

  let timedOut = false;
  let finished = false;

  const session = (async () => {
    await safeGoto(page, safe.url.toString());
    await sleep(SETTLE_MS);

    for (let i = 0; i < steps.length; i += 1) {
      if (timedOut) break;
      const startMs = Date.now() - t0;
      const report = await executeStep(page, steps[i], i);
      const endMs = Date.now() - t0;
      reports.push({ ...report, startMs, endMs });
      console.log(
        `[record] step ${report.index}: ${report.status}` +
          (report.reason ? ` (${report.reason})` : ""),
      );
    }

    await sleep(SETTLE_MS);
    finished = true;
  })();

  const timeout = sleep(SESSION_TIMEOUT_MS).then(() => {
    if (!finished) {
      timedOut = true;
      throw new Error("Recording session hit the 3-minute hard timeout");
    }
  });

  try {
    await Promise.race([session, timeout]);
  } catch (err) {
    if (!timedOut) throw err;
    console.warn("[record] hard timeout — saving whatever was captured");
  }

  const video = page.video();
  await context.close();
  await browser.close();

  if (video) {
    const tempPath = await video.path();
    const finalPath = path.join(videoDir, "recording.webm");
    await rename(tempPath, finalPath).catch(async () => {
      // If rename across devices fails, leave playwright filename
      videoPath = tempPath;
    });
    if (!videoPath) videoPath = finalPath;
  }

  return {
    jobId,
    liveUrl: safe.url.toString(),
    finalUrl: safe.url.toString(),
    timedOut,
    steps: reports,
    timeline: { steps: reports },
    succeeded: reports.filter((r) => r.status === "succeeded").length,
    skipped: reports.filter((r) => r.status === "skipped").length,
    videoPath,
    videoDir,
  };
}
