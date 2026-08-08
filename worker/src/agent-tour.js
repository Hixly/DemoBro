/**
 * Navigation-aware plan-and-film agent loop.
 * Discovers the tour page-by-page instead of planning everything from landing HTML.
 */
import { mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { assertSafePublicUrl } from "./ssrf.js";
import {
  enumerateElements,
  selectorFor,
  resolveStep,
  normalizeLabel,
} from "./resolve-selectors.js";
import { executeStep } from "./record.js";
import { ingestRepoLight } from "./generate-storyboard.js";

const VIEWPORT = { width: 1920, height: 1080 };
const SETTLE_MS = 1800;
const STEP_TIMEOUT_MS = 8000;
const SESSION_TIMEOUT_MS = 3 * 60 * 1000;
const MAX_BEATS = 6;
const MAX_PAGES = 4;

const PAGE_PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["beats", "done"],
  properties: {
    beats: {
      type: "array",
      minItems: 0,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["description", "targetHint"],
        properties: {
          description: { type: "string" },
          targetHint: { type: "string" },
        },
      },
    },
    nextNavigation: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["description", "targetHint"],
          properties: {
            description: { type: "string" },
            targetHint: { type: "string" },
          },
        },
        { type: "null" },
      ],
    },
    done: { type: "boolean" },
    reason: { type: "string" },
  },
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function requireApiKey() {
  const key = process.env.XAI_API_KEY?.trim();
  if (!key) throw new Error("XAI_API_KEY is not set.");
  return key;
}

function modelName() {
  return process.env.XAI_MODEL?.trim() || "grok-4.20-0309-non-reasoning";
}

function pathKey(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.replace(/\/$/, "") || "/"}`;
  } catch {
    return url;
  }
}

function sameOrigin(a, b) {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function narrativePhase(pageIndex) {
  if (pageIndex === 0) return "hero / overview — establish the product";
  if (pageIndex === 1) return "key feature — show the main value";
  if (pageIndex === 2) return "deeper feature or content";
  return "closing beat — contact / CTA / wrap";
}

function elementsForPrompt(elements) {
  return elements
    .filter(
      (el) =>
        el.visible &&
        (el.name || el.href || el.tag === "textarea" || el.tag === "input"),
    )
    .slice(0, 50)
    .map((el) => {
      const bits = [
        el.tag,
        el.name ? `name="${el.name}"` : null,
        el.href ? `href="${el.href}"` : null,
        el.disabled ? "disabled" : null,
        `hint=${selectorFor(el)}`,
      ].filter(Boolean);
      return `- ${bits.join(" | ")}`;
    })
    .join("\n");
}

async function planPage(args) {
  const apiKey = requireApiKey();
  const model = modelName();
  const remaining = Math.max(0, MAX_BEATS - args.beatsSoFar);
  const maxBeatsHere = Math.min(3, remaining);

  const prompt = `You are DemoBro's tour agent. Plan the NEXT beats for the CURRENT page only.

Project: ${args.title}
Description: ${args.description}
Live origin: ${args.origin}
Current URL: ${args.currentUrl}
Page index: ${args.pageIndex} (phase: ${narrativePhase(args.pageIndex)})
Beats filmed so far: ${args.beatsSoFar}/${MAX_BEATS}
Pages visited: ${args.visitedPaths.join(" -> ") || "(none yet)"}
Controls already used (do not reuse): ${args.claimedHints.slice(0, 20).join(", ") || "(none)"}

GROUND TRUTH — visible controls on THIS page after hydration:
${args.elementLines || "(nothing useful)"}

Rules:
- Propose 1-${maxBeatsHere} beats for THIS page only (0 only if the page is empty/useless).
- Each beat: ONE action (visit/pause/click/type) using a real hint= from the list.
- description: clean caption, max ~6 words, no arrows or glued words.
- Prefer a coherent arc for the phase above — not random clicks.
- On page 0, start with a visit/land beat if beatsSoFar is 0 (targetHint can be the current URL or body / h1).
- CRITICAL: beats must STAY on this page. Prefer headings, body CTAs, cards, inputs — NOT top-nav links that leave the page.
- Put the SINGLE best same-site deeper link in nextNavigation only (do not also list it as a beat).
- Prefer internal paths (href starting with /) over external for nextNavigation.
- Set done=true when the tour should end (enough story, no good next page, or remaining budget < 2).
- If this page yields nothing useful, beats=[] and done=true.
- Never invent controls not in the list.
- Return JSON only.`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 40_000);
  let res;
  try {
    res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.25,
        messages: [
          {
            role: "system",
            content:
              "You plan short, coherent product-demo beats from a live hydrated element list. Never invent controls. Respond with structured JSON only.",
          },
          { role: "user", content: prompt },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "page_tour_plan",
            schema: PAGE_PLAN_SCHEMA,
            strict: true,
          },
        },
      }),
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Grok page-plan error ${res.status}: ${detail.slice(0, 200)}`,
    );
  }
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty page-plan response");
  const parsed = JSON.parse(content);
  const beats = (Array.isArray(parsed.beats) ? parsed.beats : [])
    .map((b) => ({
      description:
        normalizeLabel(b.description) || String(b.description || "").trim(),
      targetHint: String(b.targetHint || "").trim(),
    }))
    .filter((b) => b.description && b.targetHint)
    .slice(0, maxBeatsHere);

  let nextNavigation = parsed.nextNavigation ?? null;
  if (nextNavigation) {
    nextNavigation = {
      description:
        normalizeLabel(nextNavigation.description) ||
        String(nextNavigation.description || "Go deeper").trim(),
      targetHint: String(nextNavigation.targetHint || "").trim(),
    };
    if (!nextNavigation.targetHint) nextNavigation = null;
  }

  return {
    beats,
    nextNavigation,
    done: Boolean(parsed.done) || beats.length === 0,
    reason: String(parsed.reason || ""),
  };
}

async function safeGoto(page, url) {
  const before = await assertSafePublicUrl(url);
  if (!before.ok) throw new Error(before.error);
  await page.goto(before.url.toString(), {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  const after = await assertSafePublicUrl(page.url());
  if (!after.ok) throw new Error(`Blocked after redirect: ${after.error}`);
}

async function hydrateSettle(page) {
  await page
    .waitForLoadState("networkidle", { timeout: 10_000 })
    .catch(() => {});
  await sleep(SETTLE_MS);
}

/**
 * Film a tour by discovering pages as we go.
 */
export async function recordAgentTour(options) {
  const liveUrl = options.liveUrl;
  const jobId = options.jobId ?? `job-${Date.now()}`;
  const videoDir = path.join(options.outputDir, "raw", jobId);
  await mkdir(videoDir, { recursive: true });

  const safe = await assertSafePublicUrl(liveUrl);
  if (!safe.ok) throw new Error(safe.error);
  const origin = safe.url.origin;

  let title = options.title || "Demo";
  let description = options.description || "";
  if (options.repoUrl) {
    const repo = await ingestRepoLight(options.repoUrl);
    title = options.title || repo.title;
    description = options.description || repo.description;
  }

  const reports = [];
  const resolution = [];
  const pagePlans = [];
  const claimed = new Set();
  const visitedPaths = [];
  const navEdges = new Set();

  let videoPath = null;
  let timedOut = false;
  let finished = false;

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
    recordVideo: { dir: videoDir, size: VIEWPORT },
    permissions: ["camera", "microphone"],
  });
  await context.grantPermissions(["camera", "microphone"], { origin });
  const page = await context.newPage();
  page.setDefaultTimeout(STEP_TIMEOUT_MS);
  const t0 = Date.now();

  const filmOne = async (step) => {
    const i = reports.length;
    let filmStep = step;
    try {
      const resolved = await resolveStep(page, step, { claimed });
      resolution.push(resolved.report);
      console.log(
        `[resolve] ${resolved.report.resolution}` +
          (resolved.report.to ? ` → ${resolved.report.to}` : "") +
          ` — ${step.description}`,
      );
      if (resolved.skip || !resolved.step) {
        const startMs = Date.now() - t0;
        reports.push({
          index: i + 1,
          description: step.description,
          targetHint: step.targetHint,
          status: "skipped",
          reason: "selector unresolved in current app state",
          startMs,
          endMs: Date.now() - t0,
          box: null,
          actionPoint: null,
          stepKind: "pause",
        });
        console.log(`[record] step ${i + 1}: skipped (selector unresolved)`);
        return false;
      }
      filmStep = resolved.step;
    } catch (err) {
      console.warn(
        `[resolve] failed, filming raw: ${err instanceof Error ? err.message : err}`,
      );
      resolution.push({
        description: step.description,
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
      `[record] step ${report.index}: ${report.status} kind=${report.stepKind ?? "?"}${boxLog}` +
        (report.reason ? ` (${report.reason})` : ""),
    );
    return report.status === "succeeded";
  };

  const session = (async () => {
    await safeGoto(page, safe.url.toString());
    await hydrateSettle(page);
    await sleep(800);

    let pageIndex = 0;
    let done = false;

    while (
      !done &&
      !timedOut &&
      reports.filter((r) => r.status === "succeeded").length < MAX_BEATS &&
      pageIndex < MAX_PAGES &&
      Date.now() - t0 < SESSION_TIMEOUT_MS - 15_000
    ) {
      const currentUrl = page.url();
      if (!sameOrigin(currentUrl, origin)) {
        console.warn(`[agent] left origin — stopping`);
        break;
      }
      const key = pathKey(currentUrl);
      if (visitedPaths.includes(key) && pageIndex > 0) {
        console.warn(`[agent] revisited ${key} — stopping`);
        break;
      }
      if (!visitedPaths.includes(key)) visitedPaths.push(key);

      await hydrateSettle(page);
      const elements = await enumerateElements(page);
      const useful = elements.filter((el) => el.visible && el.name);
      console.log(
        `[agent] page ${pageIndex} ${key} — ${useful.length} named controls`,
      );

      const succeeded = () =>
        reports.filter((r) => r.status === "succeeded").length;

      const plan = await planPage({
        title,
        description,
        origin,
        currentUrl,
        pageIndex,
        beatsSoFar: succeeded(),
        visitedPaths,
        claimedHints: [...claimed],
        elementLines: elementsForPrompt(elements),
      });

      console.log(
        `[agent] plan page ${pageIndex}: ${plan.beats.length} beats` +
          (plan.nextNavigation
            ? ` next="${plan.nextNavigation.description}"`
            : " next=null") +
          (plan.done ? " done" : "") +
          (plan.reason ? ` (${plan.reason})` : ""),
      );
      for (const b of plan.beats) {
        console.log(`[agent]   • ${b.description} → ${b.targetHint}`);
      }
      pagePlans.push({
        page: pageIndex,
        url: currentUrl,
        beats: plan.beats,
        next: plan.nextNavigation,
        done: plan.done,
      });

      let leftPageEarly = false;
      for (const beat of plan.beats) {
        if (succeeded() >= MAX_BEATS || timedOut) break;
        const beforeUrl = pathKey(page.url());
        await filmOne({
          id: `p${pageIndex}-b${reports.length}`,
          description: beat.description,
          targetHint: beat.targetHint,
        });
        await sleep(400);
        const afterUrl = pathKey(page.url());
        if (afterUrl !== beforeUrl) {
          console.log(
            `[agent] beat navigated ${beforeUrl} → ${afterUrl} — replan on new page`,
          );
          leftPageEarly = true;
          break;
        }
      }

      if (leftPageEarly) {
        if (!sameOrigin(page.url(), origin)) {
          console.warn(`[agent] left origin — ending`);
          done = true;
          break;
        }
        pageIndex += 1;
        continue;
      }

      if (plan.done || !plan.nextNavigation || succeeded() >= MAX_BEATS) {
        done = true;
        break;
      }

      const nav = plan.nextNavigation;
      const edge = `${key}=>${nav.targetHint}`;
      if (navEdges.has(edge)) {
        console.warn(`[agent] bounce edge ${edge} — stopping`);
        done = true;
        break;
      }
      navEdges.add(edge);

      if (succeeded() < MAX_BEATS) {
        const ok = await filmOne({
          id: `p${pageIndex}-nav`,
          description: nav.description,
          targetHint: nav.targetHint,
        });
        if (!ok) {
          console.warn(`[agent] navigation beat failed — ending tour`);
          done = true;
          break;
        }
      } else {
        done = true;
        break;
      }

      await hydrateSettle(page);
      if (!sameOrigin(page.url(), origin)) {
        console.warn(`[agent] navigation left origin — ending`);
        done = true;
        break;
      }
      pageIndex += 1;
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
    console.warn("[agent] hard timeout — saving whatever was captured");
  }

  const video = page.video();
  await context.close();
  await browser.close();

  if (video) {
    const tempPath = await video.path();
    const finalPath = path.join(videoDir, "recording.webm");
    await rename(tempPath, finalPath).catch(async () => {
      videoPath = tempPath;
    });
    if (!videoPath) videoPath = finalPath;
  }

  const succeededCount = reports.filter((r) => r.status === "succeeded").length;
  const skippedCount = reports.filter((r) => r.status === "skipped").length;
  console.log(
    `[agent] done pages=${pagePlans.length} succeeded=${succeededCount} skipped=${skippedCount}`,
  );

  return {
    videoPath,
    videoDir,
    timeline: { steps: reports },
    steps: reports,
    resolution,
    pagePlans,
    title,
    description,
    succeeded: succeededCount,
    skipped: skippedCount,
    mode: "agent",
  };
}
