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
import { dismissEntryBlockers } from "./dismiss-blockers.js";

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
        required: ["description", "targetHint", "caption"],
        properties: {
          description: { type: "string" },
          targetHint: { type: "string" },
          caption: { type: "string" },
        },
      },
    },
    nextNavigation: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["description", "targetHint", "caption"],
          properties: {
            description: { type: "string" },
            targetHint: { type: "string" },
            caption: { type: "string" },
          },
        },
        { type: "null" },
      ],
    },
    done: { type: "boolean" },
    reason: { type: "string" },
  },
};

/** Sanitize model caption into short viewer-facing copy. */
function sanitizeViewerCaption(raw, fallback = "") {
  let s = String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?…,:;]+$/g, "");
  // Never show selectors or stage directions.
  if (!s || /[#.\[\]=]|:has-text|aria-label|href=/i.test(s)) {
    s = String(fallback || "").trim();
  }
  s = s
    .replace(/^(click|tap|press|visit|open|scroll|land on|go to|select)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "";
  const words = s.split(/\s+/).slice(0, 6);
  s = words.join(" ");
  if (s.length > 42) s = `${s.slice(0, 39).trim()}…`;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function productMeetCaption(title) {
  const name = String(title || "the product")
    .split(/[|\-–—]/)[0]
    .trim()
    .slice(0, 22);
  return sanitizeViewerCaption(`Meet ${name || "the product"}`);
}

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

/** Models sometimes paste the whole prompt line; pull a real selector out. */
function cleanTargetHint(raw) {
  let s = String(raw || "").trim();
  if (!s) return "";
  const hintEq = s.match(/\bhint=((?:[^\s|].*))$/i);
  if (hintEq) s = hintEq[1].trim();
  // Prompt debris: `a | name="Open To Diagram"` → a:has-text("Open To Diagram")
  const pipeName = s.match(
    /^([a-z][a-z0-9_-]*)\s*\|\s*name="([^"]+)"/i,
  );
  if (pipeName) {
    const tag = pipeName[1].toLowerCase();
    const name = pipeName[2].replace(/"/g, '\\"').slice(0, 48);
    if (tag === "textarea" || tag === "input") return tag;
    return `${tag}:has-text("${name}")`;
  }
  // Strip trailing prose after a solid CSS/Playwright selector.
  const solid = s.match(
    /^((?:[a-z0-9_-]+)?(?:\[(?:[^\]]+)\]|:has-text\("[^"]*"\)|#[\w:-]+)+)/i,
  );
  if (solid) s = solid[1];
  // Drop prompt debris like `h1 | name="…"`.
  if (s.includes("|")) {
    const parts = s.split("|").map((p) => p.trim());
    const sel = parts.find(
      (p) =>
        /:has-text\(|\[aria-label=|\[href=|^[a-z]+\[|^#|^\//i.test(p) ||
        /^https?:\/\//i.test(p),
    );
    if (sel) s = sel.replace(/^hint=/, "");
  }
  return s.trim();
}

/** Heading-only "highlight this copy" beats waste the demo — drop them. */
function isBrochureBeat(beat, { allowExplainer = false } = {}) {
  const hint = String(beat.targetHint || "").trim();
  const desc = String(beat.description || "").toLowerCase();
  const blob = `${desc} ${hint.toLowerCase()}`;
  if (
    allowExplainer &&
    /\b(how it works|how-it-works|three steps|features|see it work|point|detect|know)\b/.test(
      blob,
    )
  ) {
    return false;
  }
  const headingHint = /^h[1-6](:|$)/i.test(hint);
  const brochureDesc =
    /\b(highlight|headline|heading|tagline|section|show three|see the|read the)\b/.test(
      desc,
    );
  if (headingHint && !/\b(land|hero|pause|overview)\b/.test(desc)) return true;
  if (brochureDesc && headingHint) return true;
  return false;
}

/**
 * Products that need a live camera / webcam make poor automated demos.
 * Detect from copy + controls, then stay on marketing "How it works".
 */
function isCameraHeavyProduct({ title, description, elements, currentUrl }) {
  const meta = `${title || ""} ${description || ""} ${currentUrl || ""}`.toLowerCase();
  const elBlob = (elements || [])
    .map((el) => `${el.name || ""} ${el.href || ""} ${el.ariaLabel || ""}`)
    .join(" ")
    .toLowerCase();
  const text = `${meta} ${elBlob}`;
  if (
    /\b(camera|webcam|getusermedia|flashlight|crosshair|color vision|detecting colors|tap to sample|open your camera|aim the crosshair|live camera)\b/.test(
      text,
    )
  ) {
    return true;
  }
  return (elements || []).some((el) => {
    const name = String(el.name || "").toLowerCase();
    const href = String(el.href || "").toLowerCase();
    return (
      /\b(toggle flashlight|pause\s*&\s*tap to sample|start detecting|allow camera|use camera)\b/.test(
        name,
      ) || /\/(camera|detect)\b/.test(href)
    );
  });
}

/** Nav/CTA that would open a live camera / detect tool. */
function isCameraEntryTarget(target) {
  if (!target) return false;
  const blob = `${target.description || ""} ${target.targetHint || ""}`.toLowerCase();
  return (
    /\/(app|camera|detect)\b/.test(blob) ||
    /mode=upload/.test(blob) ||
    /\b(start detecting|open(\s+the)?\s+app|get started|use camera|launch camera|upload an image|detect colors)\b/.test(
      blob,
    )
  );
}

/** Best on-page explainer target for camera-heavy products. */
function pickHowItWorks(elements, claimed) {
  const scored = (elements || [])
    .filter((el) => el.visible && !claimed.has(selectorFor(el)))
    .map((el) => {
      const name = String(el.name || "").toLowerCase();
      const href = String(el.href || "").toLowerCase();
      const hint = selectorFor(el);
      let score = 0;
      if (/how[\s-]?it[\s-]?works/.test(`${name} ${href}`)) score += 10;
      if (/see it work|three steps|features|how it works/.test(name)) score += 8;
      if (/^#/.test(href) && /how|feature|step|work/.test(href)) score += 7;
      if (/^h[23]$/.test(el.tag) && /how|step|feature|work/.test(name)) {
        score += 5;
      }
      if (el.tag === "a" || el.tag === "button") score += 1;
      if (isCameraEntryTarget({ description: name, targetHint: hint })) {
        score -= 12;
      }
      return { hint, name, score };
    })
    .filter((c) => c.score >= 5)
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best) return null;
  return {
    description: /how/.test(best.name)
      ? "See how it works"
      : best.name.slice(0, 36) || "See how it works",
    targetHint: best.hint,
    caption: "See how it works",
  };
}

/**
 * Prefer a real product-entry control when the model leaves nextNavigation null
 * or points at another marketing section.
 */
function pickProductEntry(elements, claimed) {
  const scored = elements
    .filter((el) => el.visible && !claimed.has(selectorFor(el)))
    .map((el) => {
      const name = String(el.name || "").toLowerCase();
      const href = String(el.href || "").toLowerCase();
      const hint = selectorFor(el);
      let score = 0;
      // Prefer labeled primary CTAs over tiny nav "Open App" chrome.
      if (
        /\b(start detecting|get started|try (it )?free|start free|launch app)\b/.test(
          name,
        )
      ) {
        score += 8;
      }
      if (/\/(app|demo|dashboard|studio|editor|camera|detect)\b/.test(href)) {
        score += 5;
      }
      if (
        /\b(start|try|open app|launch|get started|detect|upload|begin|enter)\b/.test(
          name,
        )
      ) {
        score += 4;
      }
      // Bare nav labels are weaker than hero CTAs.
      if (/^(open app|app|home|menu)$/i.test(name)) score -= 2;
      if (el.tag === "a" || el.tag === "button") score += 1;
      if (el.disabled) score -= 3;
      return { el, hint, name, score };
    })
    .filter((c) => c.score >= 4)
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best) return null;
  let label = best.name.replace(/\s+/g, " ").trim().slice(0, 40) || "Open product";
  if (/start detecting/i.test(label)) label = "Start detecting colors";
  else if (label.length > 28) label = "Open the app";
  return {
    description: label,
    targetHint: best.hint,
    caption: sanitizeViewerCaption(label, "Explore the product"),
  };
}

async function planPage(args) {
  const apiKey = requireApiKey();
  const model = modelName();
  const remaining = Math.max(0, MAX_BEATS - args.beatsSoFar);
  const maxBeatsHere = Math.min(3, remaining);
  const cameraMode = Boolean(args.cameraMode);

  const cameraRules = cameraMode
    ? `
CAMERA PRODUCT MODE (required):
- This product needs a live device camera/webcam. Do NOT open it.
- NEVER plan beats or nextNavigation into /app, /camera, detect tools, Start Detecting, Open App, Get Started, Upload, flashlight, or sample controls.
- Stay on the marketing site. Film: (1) one land/hero pause, then (2) How it works / Features / Three steps explainer headings or in-page anchors.
- Prefer scrolling the explainer over leaving the page. nextNavigation should be null unless it is an in-page #how-it-works style anchor.
- Set done=true after the explainer arc — never enter the live camera tool.
`
    : `
- This is a PRODUCT DEMO, not a marketing brochure. Show the product working.
- Prefer interactive controls: buttons, links with action labels (Start / Try / Open / Upload / Generate / Sample / Share), inputs, app chrome.
- AVOID beats that only click static headings or section titles ("highlight headline", "show three steps"). At most ONE land/hero pause on page 0.
- On page 0, if a primary product-entry CTA exists (Start, Try free, Open app, Get started, Launch, Upload), either film it as a beat OR put it in nextNavigation — do not burn the budget on marketing copy.
- On app/tool pages, film the PRIMARY product loop first (sample / generate / upload / share / result). Do NOT jump to settings/about/account until that loop is shown — prefer done=true after the product loop.
- Skip low-value chrome (theme toggle) unless nothing else is available.
`;

  const prompt = `You are DemoBro's tour agent. Plan the NEXT beats for the CURRENT page only.

Project: ${args.title}
Description: ${args.description}
Live origin: ${args.origin}
Current URL: ${args.currentUrl}
Page index: ${args.pageIndex} (phase: ${narrativePhase(args.pageIndex)})
Beats filmed so far: ${args.beatsSoFar}/${MAX_BEATS}
Pages visited: ${args.visitedPaths.join(" -> ") || "(none yet)"}
Controls already used (do not reuse): ${args.claimedHints.slice(0, 20).join(", ") || "(none)"}
Mode: ${cameraMode ? "CAMERA_EXPLAINER" : "PRODUCT_DEMO"}

GROUND TRUTH — visible controls on THIS page after hydration:
${args.elementLines || "(nothing useful)"}

Rules:
${cameraRules}
- Propose 1-${maxBeatsHere} beats for THIS page only (0 only if the page is empty/useless).
- Each beat: ONE action (visit/pause/click/type) using a real hint= from the list.
- description: INTERNAL action note for the robot (e.g. "Pause on hero", "Select rectangle tool") — not shown to viewers.
- caption: VIEWER-facing benefit line for the on-screen lower-third. 2–6 words, punchy, no trailing punctuation. Describe the VALUE of this screen/feature (why the viewer should care), NEVER the robot action. No "click/visit/scroll/land/select". No selectors or raw element labels. Examples: "Meet DemoBro", "Turn JSON into a map", "Sketch ideas in seconds", "See how it works".
- On page 0 with an h1, include ONE land/hero pause beat first.
- Prefer examples / playground / demo / try-it pages over dense docs TOC or sidebar links.
- CRITICAL: page beats should STAY on this page. Put the SINGLE best same-site deeper link in nextNavigation only (do not also list it as a beat), unless camera mode forbids it.
- nextNavigation.targetHint MUST be a real hint= from the list (prefer a[href^="/"] or a primary CTA button/link). Never use a bare URL path without a matching control.
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
              "You plan short product-demo beats from a live hydrated element list. Each beat needs an internal description, a real targetHint, and a viewer-facing caption about product value (not robot actions). Never invent controls. Respond with structured JSON only.",
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
  let beats = (Array.isArray(parsed.beats) ? parsed.beats : [])
    .map((b) => {
      const description =
        normalizeLabel(b.description) || String(b.description || "").trim();
      const targetHint = cleanTargetHint(b.targetHint);
      const caption = sanitizeViewerCaption(
        b.caption,
        description.replace(/^(click|tap|visit|open|land on|select)\s+/i, ""),
      );
      return { description, targetHint, caption };
    })
    .filter((b) => b.description && b.targetHint)
    .filter((b) => !isBrochureBeat(b, { allowExplainer: cameraMode }))
    .slice(0, maxBeatsHere);

  if (cameraMode) {
    beats = beats.filter((b) => !isCameraEntryTarget(b));
  }

  let nextNavigation = parsed.nextNavigation ?? null;
  if (nextNavigation) {
    const description =
      normalizeLabel(nextNavigation.description) ||
      String(nextNavigation.description || "Go deeper").trim();
    nextNavigation = {
      description,
      targetHint: cleanTargetHint(nextNavigation.targetHint),
      caption: sanitizeViewerCaption(nextNavigation.caption, description),
    };
    if (!nextNavigation.targetHint) nextNavigation = null;
  }
  if (cameraMode && nextNavigation && isCameraEntryTarget(nextNavigation)) {
    nextNavigation = null;
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
          caption: step.caption || "",
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
      filmStep = { ...resolved.step, caption: step.caption };
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
    reports.push({
      ...report,
      startMs,
      endMs,
      caption: step.caption || report.caption || "",
    });
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
      // Clear cookie/consent/intro/chooser overlays before planning.
      await dismissEntryBlockers(page);
      await sleep(300);
      const elements = await enumerateElements(page);
      const useful = elements.filter((el) => el.visible && el.name);
      console.log(
        `[agent] page ${pageIndex} ${key} — ${useful.length} named controls`,
      );

      const succeeded = () =>
        reports.filter((r) => r.status === "succeeded").length;

      const cameraMode = isCameraHeavyProduct({
        title,
        description,
        elements,
        currentUrl,
      });
      if (cameraMode && pageIndex === 0) {
        console.log(
          `[agent] camera product detected — explainer mode (skip live camera/app)`,
        );
      }

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
        cameraMode,
      });

      if (cameraMode) {
        // Never inject /app entry. Steer toward How it works instead.
        plan.beats = (plan.beats || []).filter((b) => !isCameraEntryTarget(b));
        if (plan.nextNavigation && isCameraEntryTarget(plan.nextNavigation)) {
          plan.nextNavigation = null;
        }
        const explainer = pickHowItWorks(elements, claimed);
        const needsExplainer =
          pageIndex === 0 &&
          explainer &&
          !plan.beats.some((b) =>
            /how it works|three steps|features|see it work/i.test(
              `${b.description} ${b.targetHint}`,
            ),
          );
        if (needsExplainer) {
          // Keep one hero land beat if present, then explainer.
          const land = plan.beats.find((b) =>
            /\b(land|hero|pause|overview)\b/i.test(b.description),
          );
          if (land && !land.caption) {
            land.caption = productMeetCaption(title);
          }
          plan.beats = land ? [land, explainer] : [explainer];
          plan.nextNavigation = null;
          plan.done = true;
          console.log(
            `[agent] camera explainer → ${explainer.targetHint} ("${explainer.caption}")`,
          );
        } else {
          plan.nextNavigation = null;
          plan.done = true;
        }
      } else if (pageIndex === 0 && !plan.done) {
        // Prefer a strong primary CTA over bare /app nav chrome on landings.
        const entry = pickProductEntry(elements, claimed);
        const weakNav =
          !plan.nextNavigation ||
          isBrochureBeat(plan.nextNavigation) ||
          /^h[1-6](:|$)/i.test(plan.nextNavigation.targetHint || "") ||
          (/href="\/app"/i.test(plan.nextNavigation?.targetHint || "") &&
            /open(\s+the)?\s+app/i.test(
              plan.nextNavigation?.description || "",
            ));
        if (entry && weakNav) {
          plan.nextNavigation = entry;
          plan.done = false;
          console.log(
            `[agent] product entry → ${entry.targetHint} ("${entry.description}")`,
          );
        }
      }

      // Ensure page-0 opens with a land/hero beat when an h1 exists.
      if (pageIndex === 0 && !cameraMode) {
        const h1 = elements.find(
          (el) => el.visible && el.tag === "h1" && el.name,
        );
        const hasLand = plan.beats.some((b) =>
          /\b(land|hero|pause|overview)\b/i.test(b.description),
        );
        if (h1 && !hasLand) {
          const land = {
            description: "Land on hero",
            targetHint: selectorFor(h1),
            caption: productMeetCaption(title),
          };
          plan.beats = [land, ...plan.beats].slice(0, 3);
          console.log(`[agent] injected land beat → ${land.targetHint}`);
        }

        // Prefer examples/playground over docs when both exist.
        const demoLink = elements
          .filter((el) => el.visible && el.href && !claimed.has(selectorFor(el)))
          .map((el) => {
            const blob = `${el.name || ""} ${el.href || ""}`.toLowerCase();
            let score = 0;
            if (/example|playground|demo|try|sandbox/.test(blob)) score += 6;
            if (/docs?|reference|api|essays/.test(blob)) score -= 3;
            return { el, score, hint: selectorFor(el) };
          })
          .filter((c) => c.score >= 6)
          .sort((a, b) => b.score - a.score)[0];
        const nextBlob = `${plan.nextNavigation?.description || ""} ${plan.nextNavigation?.targetHint || ""}`.toLowerCase();
        if (
          demoLink &&
          (!plan.nextNavigation || /docs?|reference|api/.test(nextBlob))
        ) {
          plan.nextNavigation = {
            description: "See examples",
            targetHint: demoLink.hint,
            caption: "Try it live",
          };
          plan.done = false;
          console.log(`[agent] prefer demo/examples → ${demoLink.hint}`);
        }
      }

      // Don't tour settings/about before showing the product loop (non-camera).
      if (!cameraMode && plan.nextNavigation) {
        const navBlob = `${plan.nextNavigation.description} ${plan.nextNavigation.targetHint}`.toLowerCase();
        const goesMeta = /\b(settings|about|account|pricing|blog|docs)\b/.test(
          navBlob,
        );
        const hasProductLoop = elements.some((el) =>
          /\b(sample|detect|generat|upload|share|copy|analyze|freeze|pause)\b/i.test(
            el.name || "",
          ),
        );
        if (goesMeta && hasProductLoop && pageIndex >= 1) {
          console.log(
            `[agent] dropping meta nextNavigation "${plan.nextNavigation.description}" — finish product loop`,
          );
          plan.nextNavigation = null;
          plan.done = true;
        }
      }

      console.log(
        `[agent] plan page ${pageIndex}: ${plan.beats.length} beats` +
          (plan.nextNavigation
            ? ` next="${plan.nextNavigation.description}"`
            : " next=null") +
          (plan.done ? " done" : "") +
          (plan.reason ? ` (${plan.reason})` : ""),
      );
      for (const b of plan.beats) {
        console.log(
          `[agent]   • ${b.description} → ${b.targetHint}` +
            (b.caption ? ` | caption="${b.caption}"` : ""),
        );
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
          caption: beat.caption || "",
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
        const navHint = String(nav.targetHint || "");
        // Must be a real navigation target — not a toolbar button with :has-text.
        const looksLikeLink =
          /href=|^https?:\/\//i.test(navHint) ||
          navHint.startsWith("#") ||
          /^a[\[.:]/i.test(navHint);
        if (!looksLikeLink) {
          console.log(
            `[agent] nextNavigation is not a link ("${nav.description}") — finishing tour`,
          );
          done = true;
          break;
        }
        const beforeFull = page.url();
        const beforeNav = pathKey(beforeFull);
        const ok = await filmOne({
          id: `p${pageIndex}-nav`,
          description: nav.description,
          targetHint: nav.targetHint,
          caption: nav.caption || "",
        });
        await hydrateSettle(page);
        const afterFull = page.url();
        const afterNav = pathKey(afterFull);
        if (!ok) {
          console.warn(`[agent] navigation beat failed — ending tour`);
          done = true;
          break;
        }
        if (afterFull === beforeFull) {
          console.warn(
            `[agent] navigation did not change URL (${beforeNav}) — finishing filmed beats`,
          );
          done = true;
          break;
        }
        // In-page hash/query change: counted as success, stay on this page index.
        if (afterNav === beforeNav) {
          console.log(
            `[agent] in-page navigation ${beforeFull} → ${afterFull}`,
          );
          continue;
        }
      } else {
        done = true;
        break;
      }

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
