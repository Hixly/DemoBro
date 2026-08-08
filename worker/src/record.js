import { mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { assertSafePublicUrl } from "./ssrf.js";
import { resolveStep } from "./resolve-selectors.js";

const VIEWPORT = { width: 1920, height: 1080 };
const SESSION_TIMEOUT_MS = 3 * 60 * 1000;
const STEP_TIMEOUT_MS = 8_000;
// ~2.5–3s of hold per kept step so tours fill the 20–25s budget.
const SETTLE_MS = 1_800;
// Fallback text typed into a field when the step doesn't specify its own.
const DEFAULT_INPUT_TEXT =
  "Write a short, friendly welcome email to a new customer.";

/** Pull an explicit value out of a step description, if it names one. */
function extractTypedValue(description) {
  const quoted = description.match(/["'“”](.{2,}?)["'“”]/);
  if (quoted) return quoted[1].trim();
  const verb = description.match(
    /\b(?:type|enter|write|fill(?:\s+in)?|paste|search for)\s+(.{3,})/i,
  );
  if (!verb) return null;
  let value = verb[1]
    .replace(/\s+\binto\b.*$/i, "")
    .replace(/\s+\bin the\b.*$/i, "")
    .trim();
  // Caption-style descriptions ("Type your goal") aren't literal fill text.
  if (
    /^(your|a|the|my)\s+(goal|prompt|email|message|text|subject)\b/i.test(value) ||
    value.split(/\s+/).length <= 2
  ) {
    return null;
  }
  return value;
}

/**
 * @typedef {{ id?: string, description: string, targetHint: string }} StoryboardStep
 * @typedef {{ x: number, y: number, w: number, h: number }} TargetBox
 * @typedef {{ x: number, y: number }} ActionPoint
 * @typedef {'click' | 'type' | 'pause' | 'nav'} StepKind
 * @typedef {{
 *   index: number,
 *   description: string,
 *   targetHint: string,
 *   status: 'succeeded' | 'skipped',
 *   reason?: string,
 *   startMs?: number,
 *   endMs?: number,
 *   box?: TargetBox | null,
 *   actionPoint?: ActionPoint | null,
 *   stepKind?: StepKind,
 * }} StepReport
 */

/** @returns {StepKind} */
function classifyStepKind(step, tag, desc) {
  if (
    looksLikeUrl(step.targetHint) ||
    /^open\b/i.test(step.description) ||
    /^visit\b/i.test(step.description)
  ) {
    return "nav";
  }
  if (
    desc.includes("watch") ||
    desc.includes("point") ||
    desc.includes("pause") ||
    desc.includes("land") ||
    tag === "video"
  ) {
    return "pause";
  }
  const wantsType = /\b(type|enter|fill|write|paste|search)\b/.test(desc);
  if (tag === "input" || tag === "textarea" || (wantsType && tag !== "button")) {
    return "type";
  }
  return "click";
}

/**
 * @param {import('playwright').Locator} locator
 * @returns {Promise<{ box: TargetBox | null, actionPoint: ActionPoint | null }>}
 */
async function captureTargetMeta(locator) {
  const raw = await locator.boundingBox().catch(() => null);
  if (!raw || raw.width < 1 || raw.height < 1) {
    return { box: null, actionPoint: null };
  }
  // Soft-fail near-full-viewport boxes (wrong element / body) — null for polish.
  if (raw.width >= VIEWPORT.width * 0.9 && raw.height >= VIEWPORT.height * 0.9) {
    console.log(
      `[record] soft-fail full-frame box ${Math.round(raw.width)}x${Math.round(raw.height)}`,
    );
    return { box: null, actionPoint: null };
  }
  const box = {
    x: raw.x,
    y: raw.y,
    w: raw.width,
    h: raw.height,
  };
  return {
    box,
    actionPoint: { x: box.x + box.w / 2, y: box.y + box.h / 2 },
  };
}

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

  // Comma-separated fallbacks: pick the first listed selector (most specific).
  // Avoid Playwright OR across `:has-text()` matching giant containers.
  if (trimmed.includes(",") && !trimmed.includes("[")) {
    const first = trimmed.split(",")[0].trim();
    if (first) return page.locator(first).first();
  }

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
export async function executeStep(page, step, index) {
  const base = {
    index: index + 1,
    description: step.description,
    targetHint: step.targetHint,
    box: null,
    actionPoint: null,
    stepKind: /** @type {StepKind} */ ("pause"),
  };

  if (isNativePermissionStep(step)) {
    return {
      ...base,
      stepKind: "nav",
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
      await sleep(SETTLE_MS + 1_000);
      return { ...base, stepKind: "nav", status: "succeeded" };
    }

    const locator = locatorForHint(page, step.targetHint);
    await locator.waitFor({ state: "visible", timeout: STEP_TIMEOUT_MS });
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    await moveMouseVisibly(page, locator);

    const desc = step.description.toLowerCase();
    const tag = await locator.evaluate((el) => el.tagName.toLowerCase()).catch(() => "");
    const stepKind = classifyStepKind(step, tag, desc);
    const meta = await captureTargetMeta(locator);

    if (stepKind === "pause") {
      await locator.hover({ timeout: STEP_TIMEOUT_MS }).catch(() => {});
      await sleep(SETTLE_MS + 1_200);
      return {
        ...base,
        ...meta,
        stepKind,
        status: "succeeded",
      };
    }

    // Fill text fields so interactive flows unlock (e.g. typing a prompt
    // enables a Generate button that a click step films right after).
    if (stepKind === "type") {
      const value = extractTypedValue(step.description) || DEFAULT_INPUT_TEXT;
      await locator.click({ timeout: STEP_TIMEOUT_MS }).catch(() => {});
      try {
        await locator.fill(value, { timeout: STEP_TIMEOUT_MS });
      } catch {
        await locator.pressSequentially(value, { delay: 25 }).catch(() => {});
      }
      await sleep(SETTLE_MS + 1_000);
      return {
        ...base,
        ...meta,
        stepKind,
        status: "succeeded",
      };
    }

    await locator.click({ timeout: STEP_TIMEOUT_MS });
    // Generate/submit often reveals result UI — wait for it before the next beat.
    const looksSubmit = /generat|submit|send|create|draft/i.test(desc);
    if (looksSubmit) {
      await Promise.race([
        page
          .getByRole("button", { name: /copy/i })
          .first()
          .waitFor({ state: "visible", timeout: 8_000 })
          .catch(() => {}),
        sleep(SETTLE_MS + 2_400),
      ]);
      await sleep(800);
    } else {
      await sleep(SETTLE_MS + 900);
    }
    return {
      ...base,
      ...meta,
      stepKind,
      status: "succeeded",
    };
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
  /** @type {Array} */
  let resolution = [];
  // Selectors claimed by earlier filmed steps — shared across JIT resolves.
  const claimed = new Set();

  const session = (async () => {
    await safeGoto(page, safe.url.toString());
    await sleep(SETTLE_MS);
    await sleep(1_000); // SPA hydration beat before step 1

    // Keep EVERY planned step. Resolve each one just-in-time against the live
    // DOM after prior steps have run — so Analyze/post-Generate UI can appear.
    for (let i = 0; i < steps.length; i += 1) {
      if (timedOut) break;

      let filmStep = steps[i];
      try {
        const resolved = await resolveStep(page, steps[i], { claimed });
        resolution.push(resolved.report);
        console.log(
          `[resolve] ${resolved.report.resolution}` +
            (resolved.report.to ? ` → ${resolved.report.to}` : "") +
            ` — ${steps[i].description}`,
        );
        if (resolved.skip || !resolved.step) {
          const startMs = Date.now() - t0;
          reports.push({
            index: i + 1,
            description: steps[i].description,
            targetHint: steps[i].targetHint,
            status: "skipped",
            reason: "selector unresolved in current app state",
            startMs,
            endMs: Date.now() - t0,
            box: null,
            actionPoint: null,
            stepKind: "pause",
          });
          console.log(
            `[record] step ${i + 1}: skipped (selector unresolved in current app state)`,
          );
          continue;
        }
        filmStep = resolved.step;
      } catch (err) {
        console.warn(
          `[resolve] step ${i + 1} resolve failed, filming raw: ${err instanceof Error ? err.message : err}`,
        );
        resolution.push({
          description: steps[i].description,
          resolution: "unchecked",
        });
      }

      const startMs = Date.now() - t0;
      const report = await executeStep(page, filmStep, i);
      const endMs = Date.now() - t0;
      reports.push({ ...report, startMs, endMs });
      const boxLog = report.box
        ? ` box={x:${Math.round(report.box.x)},y:${Math.round(report.box.y)},w:${Math.round(report.box.w)},h:${Math.round(report.box.h)}}`
        : " box=null";
      console.log(
        `[record] step ${report.index}: ${report.status}` +
          ` kind=${report.stepKind ?? "?"}` +
          boxLog +
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
    resolution,
    timeline: { steps: reports },
    succeeded: reports.filter((r) => r.status === "succeeded").length,
    skipped: reports.filter((r) => r.status === "skipped").length,
    videoPath,
    videoDir,
  };
}
