import { mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { assertSafePublicUrl } from "./ssrf.js";
import { resolveStep } from "./resolve-selectors.js";
import { dismissEntryBlockers } from "./dismiss-blockers.js";

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
 *   contentBounds?: TargetBox | null,
 *   stepKind?: StepKind,
 * }} StepReport
 */

/** @returns {StepKind} */
function classifyStepKind(step, tag, desc) {
  // Absolute URL → navigate. "Open/Visit …" with a selector is a click.
  if (looksLikeUrl(step.targetHint)) {
    return "nav";
  }
  const wantsType = /\b(type|enter|fill|write|paste|search)\b/.test(desc);
  if (tag === "input" || tag === "textarea" || (wantsType && tag !== "button")) {
    return "type";
  }
  // "Pause & tap to sample" / "Tap to view…" are button actions, not soft pauses.
  const actionable =
    /\b(tap|click|sample|toggle|press|select|upload|share|copy|save|detect|generat|open|freeze)\b/.test(
      desc,
    );
  if (actionable && (tag === "button" || tag === "a" || tag === "summary")) {
    return "click";
  }
  const headingTag = /^h[1-6]$/.test(tag);
  if (
    desc.includes("watch") ||
    desc.includes("point") ||
    desc.includes("pause") ||
    desc.includes("land") ||
    desc.includes("highlight") ||
    desc.includes("headline") ||
    desc.includes("overview") ||
    headingTag ||
    tag === "video"
  ) {
    return "pause";
  }
  return "click";
}

/**
 * Visible content bounding box — the meaningful rendered column/cluster,
 * ignoring empty viewport margins. Used by render to keep framing balanced.
 * @param {import('playwright').Page} page
 * @returns {Promise<TargetBox | null>}
 */
export async function measureContentBounds(page) {
  try {
    const bounds = await page.evaluate(({ vw, vh }) => {
      const skipTag = new Set([
        "SCRIPT",
        "STYLE",
        "NOSCRIPT",
        "META",
        "LINK",
        "HEAD",
        "BR",
        "SVG",
        "PATH",
      ]);

      /** @type {{ x: number, y: number, w: number, h: number, area: number }[]} */
      const boxes = [];

      const consider = (el) => {
        if (!el || skipTag.has(el.tagName)) return;
        const style = window.getComputedStyle(el);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          Number(style.opacity) === 0
        ) {
          return;
        }
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) return;
        if (r.bottom < 0 || r.right < 0 || r.top > vh || r.left > vw) return;
        // Full-viewport / near-full shells don't define the content column.
        if (r.width >= vw * 0.88 && r.height >= vh * 0.55) return;
        if (r.width >= vw * 0.9 && r.height < 10) return;
        if (r.height >= vh * 0.9 && r.width < 10) return;
        // Wide empty wrappers inflate bounds on left-aligned terminal pages.
        if (r.width >= vw * 0.82 && r.height >= vh * 0.35) return;

        const left = Math.max(0, r.left);
        const top = Math.max(0, r.top);
        const right = Math.min(vw, r.right);
        const bottom = Math.min(vh, r.bottom);
        const w = right - left;
        const h = bottom - top;
        if (w < 4 || h < 4) return;
        boxes.push({ x: left, y: top, w, h, area: w * h });
      };

      const roots = document.querySelectorAll(
        'main, article, [role="main"], form, section, header, h1, h2, h3, h4, p, li, pre, code, input, textarea, button, a, img, video, canvas, label, [class*="terminal"], [class*="hero"], [class*="content"]',
      );
      for (const el of roots) consider(el);

      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
      );
      let node = walker.nextNode();
      let textSamples = 0;
      while (node && textSamples < 120) {
        const t = (node.textContent || "").trim();
        if (t.length >= 2) {
          consider(node.parentElement);
          textSamples += 1;
        }
        node = walker.nextNode();
      }

      if (boxes.length < 2) return null;

      // Prefer the dense content column: drop the widest outliers, then union.
      boxes.sort((a, b) => a.area - b.area);
      const keep = boxes.slice(0, Math.max(2, Math.ceil(boxes.length * 0.85)));
      // Further prefer boxes whose centers cluster (mode column).
      const centers = keep.map((b) => b.x + b.w / 2).sort((a, b) => a - b);
      const mid = centers[Math.floor(centers.length / 2)];
      const clustered = keep.filter((b) => {
        const cx = b.x + b.w / 2;
        return Math.abs(cx - mid) < vw * 0.28;
      });
      const use = clustered.length >= 2 ? clustered : keep;

      let minX = vw;
      let minY = vh;
      let maxX = 0;
      let maxY = 0;
      for (const b of use) {
        minX = Math.min(minX, b.x);
        minY = Math.min(minY, b.y);
        maxX = Math.max(maxX, b.x + b.w);
        maxY = Math.max(maxY, b.y + b.h);
      }
      const w = maxX - minX;
      const h = maxY - minY;
      if (w < vw * 0.1 || h < vh * 0.08) return null;

      const padX = Math.min(56, Math.max(24, w * 0.05));
      const padY = Math.min(40, Math.max(16, h * 0.04));
      const x = Math.max(0, minX - padX);
      const y = Math.max(0, minY - padY);
      return {
        x,
        y,
        w: Math.min(vw - x, w + padX * 2),
        h: Math.min(vh - y, h + padY * 2),
      };
    }, { vw: VIEWPORT.width, vh: VIEWPORT.height });

    if (
      !bounds ||
      !Number.isFinite(bounds.w) ||
      !Number.isFinite(bounds.h) ||
      bounds.w < 8 ||
      bounds.h < 8
    ) {
      return null;
    }
    return bounds;
  } catch {
    return null;
  }
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
async function locatorForHint(page, hint) {
  const trimmed = hint.trim();
  if (!trimmed) return page.locator("body");

  // Bare textarea/input → largest visible field (not a tiny search box).
  if (trimmed === "textarea" || trimmed === "input") {
    return largestEditable(page, trimmed);
  }

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

/** Prefer the largest visible editable for bare textarea/input hints. */
async function largestEditable(page, tag) {
  try {
    const idx = await page.locator(tag).evaluateAll((nodes) => {
      let bestIdx = 0;
      let bestArea = 0;
      nodes.forEach((n, i) => {
        const r = n.getBoundingClientRect();
        const style = window.getComputedStyle(n);
        if (style.visibility === "hidden" || style.display === "none") return;
        const area = r.width * r.height;
        if (area > bestArea) {
          bestArea = area;
          bestIdx = i;
        }
      });
      return bestIdx;
    });
    return page.locator(tag).nth(idx || 0);
  } catch {
    return page.locator(tag).first();
  }
}

/** Drag a simple shape on the largest visible canvas, if any. */
async function drawSampleOnCanvas(page) {
  try {
    const canvases = page.locator("canvas");
    const n = await canvases.count();
    if (!n) return;
    let best = null;
    for (let i = 0; i < n; i += 1) {
      const box = await canvases.nth(i).boundingBox().catch(() => null);
      if (!box || box.width < 200 || box.height < 200) continue;
      const area = box.width * box.height;
      if (!best || area > best.area) best = { box, area };
    }
    if (!best) return;
    const { box } = best;
    const x0 = box.x + box.width * 0.35;
    const y0 = box.y + box.height * 0.35;
    const x1 = box.x + box.width * 0.62;
    const y1 = box.y + box.height * 0.58;
    await page.mouse.move(x0, y0, { steps: 12 });
    await page.mouse.down();
    await page.mouse.move(x1, y1, { steps: 24 });
    await page.mouse.up();
    await sleep(400);
    console.log("[record] canvas sample stroke");
  } catch (err) {
    console.warn(
      `[record] canvas stroke skipped: ${err instanceof Error ? err.message : err}`,
    );
  }
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
    contentBounds: null,
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

  const finishOk = async (report) => {
    const contentBounds = await measureContentBounds(page);
    return { ...report, contentBounds };
  };

  try {
    // Only goto when the hint itself is a URL. Descriptions like "Open the app"
    // with a[href="/app"] must fall through to click — otherwise we no-op on
    // the current page and the agent never reaches the product.
    if (looksLikeUrl(step.targetHint)) {
      await safeGoto(page, step.targetHint);
      await sleep(SETTLE_MS + 1_000);
      return finishOk({ ...base, stepKind: "nav", status: "succeeded" });
    }

    const locator = await locatorForHint(page, step.targetHint);
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
      return finishOk({
        ...base,
        ...meta,
        stepKind,
        status: "succeeded",
      });
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
      return finishOk({
        ...base,
        ...meta,
        stepKind,
        status: "succeeded",
      });
    }

    // Prefer force when a sheet/modal may intercept (common after "view details").
    try {
      await locator.click({ timeout: STEP_TIMEOUT_MS });
    } catch {
      await locator.click({ timeout: STEP_TIMEOUT_MS, force: true });
    }

    // Canvas apps: selecting a shape/draw tool does nothing visible unless we
    // actually stroke on the canvas (Excalidraw, tldraw, etc.).
    const toolBlob = `${desc} ${step.targetHint || ""}`;
    if (
      /\b(rectangle|ellipse|diamond|arrow|line|freedraw|draw|pencil|brush|shape)\b/i.test(
        toolBlob,
      )
    ) {
      await drawSampleOnCanvas(page);
    }

    // Generate/submit often reveals result UI — wait for it before the next beat.
    const looksSubmit = /generat|submit|send|create|draft/i.test(desc);
    const opensSheet = /detail|sample|share|history|save/i.test(desc);
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
    } else if (opensSheet) {
      await sleep(SETTLE_MS + 1_400);
    } else {
      await sleep(SETTLE_MS + 900);
    }
    return finishOk({
      ...base,
      ...meta,
      stepKind,
      status: "succeeded",
    });
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
    await dismissEntryBlockers(page);
    await sleep(300);

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
