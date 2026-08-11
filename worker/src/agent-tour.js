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
import {
  assessTourQuality,
  MIN_SUCCESSFUL_BEATS,
  TARGET_BODY_DURATION_MS,
} from "./tour-quality.js";
import {
  GROK_MAX_ATTEMPTS,
  GROK_TIMEOUT_MS,
  closeBrowserSafely,
  findNewestWebm,
  killOrphanBrowsers,
  probeLiveUrl,
  toUserFacingError,
  withRetry,
  withTimeout,
} from "./job-utils.js";

const VIEWPORT = { width: 1920, height: 1080 };
const SETTLE_MS = 1800;
const STEP_TIMEOUT_MS = 8000;
const SESSION_TIMEOUT_MS = 3 * 60 * 1000;
const MAX_BEATS = 5;
const DOCS_BRIEF_MAX_BEATS = 3;
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

/** Interactive surface on a docs/marketing site (playground, examples, try-it). */
function pickPlayground(elements, claimed = new Set(), baseUrl = "") {
  const scored = (elements || [])
    .filter((el) => el.visible && !claimed.has(selectorFor(el)))
    .map((el) => {
      const name = String(el.name || "").toLowerCase();
      const href = String(el.href || "").toLowerCase();
      const path = hrefPath(el.href, baseUrl).toLowerCase();
      const blob = `${name} ${href} ${path}`;
      const hint = selectorFor(el);
      let score = 0;
      if (
        /\/(examples?|playground|sandbox|try|demo|tutorial|repl)(\/|$)/.test(
          path,
        )
      ) {
        score += 8;
      }
  if (
    /^(examples?|playground|tutorial|demos?|try it|sandbox)$/.test(
      name.trim(),
    )
  ) {
    score += 8;
  }
  if (
    /\b(examples?|playground|sandbox|try it|try online|live demo|online editor|runnable|tutorial)\b/.test(
      name,
    )
  ) {
    score += 6;
  }
  if (/\b(demo|tutorial|playground|examples?)\b/.test(blob)) score += 2;
  // Prefer live playground/examples over long tutorial curricula.
  if (/\/(playground|examples?|sandbox|repl)(\/|$)/.test(path)) score += 3;
  if (/\/(docs?|reference|api|essays|guide)(\/|$)/.test(path)) score -= 5;
  if (el.tag === "a" || el.tag === "button") score += 1;
  return { hint, name, score };
    })
    .filter((c) => c.score >= 6)
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best) return null;
  return {
    description: /example/i.test(best.name)
      ? "See live examples"
      : /play|sandbox|try|tutorial/i.test(best.name)
        ? "Open the playground"
        : best.name.slice(0, 36) || "Try it live",
    targetHint: best.hint,
    caption: "Try it live",
  };
}

/** Docs TOC / sidebar clicks that produce walls of text — never focal beats. */
function isDocsSidebarBeat(beat) {
  const hint = String(beat?.targetHint || "");
  const desc = String(beat?.description || "").toLowerCase();
  const blob = `${desc} ${hint.toLowerCase()}`;
  if (/example|playground|sandbox|try it|demo|hero|land|home/i.test(blob)) {
    return false;
  }
  if (/\/(docs?|reference|api|essays|guide)\b/i.test(hint)) return true;
  if (
    /\b(sidebar|table of contents|\btoc\b|reference|attributes?|triggers?|essays?)\b/i.test(
      desc,
    )
  ) {
    return true;
  }
  // Short prose nav labels ("AJAX", "triggers") that leave into docs.
  if (
    /a:has-text\("[^"]{1,28}"\)/i.test(hint) &&
    /\b(section|docs?|reference|ajax|css|hyperscript|attributes?)\b/i.test(desc)
  ) {
    return true;
  }
  return false;
}

/**
 * Classify site → camera | docs | product.
 * Uses hydrated DOM + URL + repo copy — no per-site allowlists.
 */
function hrefPath(href, baseUrl) {
  try {
    return new URL(href, baseUrl || "https://example.com").pathname;
  } catch {
    return String(href || "");
  }
}

function classifySiteType({ title, description, elements, currentUrl }) {
  if (isCameraHeavyProduct({ title, description, elements, currentUrl })) {
    return {
      type: "camera",
      reason: "camera/hardware signals",
      playground: null,
    };
  }

  const els = elements || [];
  const meta = `${title || ""} ${description || ""} ${currentUrl || ""}`.toLowerCase();
  let docsScore = 0;
  let productScore = 0;

  if (/\/(docs?|reference|api|guide|manual|essays)\b/i.test(currentUrl || "")) {
    docsScore += 3;
  }
  if (
    /\b(documentation|docs|reference|library|framework|hypermedia|sdk|javascript library)\b/i.test(
      meta,
    )
  ) {
    docsScore += 2;
  }
  if (/\b(high.?power tools for html|html over the wire)\b/i.test(meta)) {
    docsScore += 2;
  }

  const hrefs = els.filter((el) => el.visible && el.href);
  const docsLinks = hrefs.filter((el) => {
    const path = hrefPath(el.href, currentUrl);
    // Same-origin docs/reference only — ignore MDN / external doc links.
    try {
      const abs = new URL(el.href, currentUrl || "https://example.com");
      const cur = new URL(currentUrl || abs.href);
      if (abs.origin !== cur.origin) return false;
    } catch {
      /* keep */
    }
    return /\/(docs?|reference|api|essays|guide|attributes?)(\/|$)/i.test(path);
  }).length;
  if (docsLinks >= 2) docsScore += 2;
  if (docsLinks >= 3) docsScore += 2;
  if (docsLinks >= 8) docsScore += 2;

  const shortNav = hrefs.filter((el) => {
    const words = String(el.name || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const path = hrefPath(el.href, currentUrl);
    return words.length > 0 && words.length <= 2 && path.startsWith("/");
  }).length;
  if (shortNav >= 10) docsScore += 2;
  if (shortNav >= 20) docsScore += 1;

  const headings = els.filter(
    (el) => el.visible && /^h[1-6]$/.test(el.tag),
  ).length;
  if (headings >= 8) docsScore += 1;

  // Code-block / pre-heavy pages are usually docs (signal via many code-y links).
  const codey = hrefs.filter((el) =>
    /\b(hx-|x-data|@click|npm i|cdn\.|install)\b/i.test(
      `${el.name || ""} ${el.href || ""}`,
    ),
  ).length;
  if (codey >= 2) docsScore += 1;

  const appControls = els.filter((el) => {
    if (!el.visible) return false;
    // Ignore search/newsletter chrome — not a product loop.
    if (el.tag === "textarea") return true;
    if (el.tag === "input" || el.tag === "select") {
      const name = String(el.name || "").toLowerCase();
      if (/search|email|newsletter|subscribe|password|login/.test(name)) {
        return false;
      }
      return true;
    }
    return /\b(generat|send|submit|draw|upload|sample|share|export|run|compose|freeze)\b/i.test(
      el.name || "",
    );
  }).length;
  if (appControls >= 3) productScore += 4;
  if (/\/(app|editor|dashboard|studio)\b/i.test(currentUrl || "")) {
    productScore += 3;
  }
  // Strong product-entry CTAs beat soft docs signals on SaaS landings.
  const productEntryLinks = hrefs.filter((el) => {
    const path = hrefPath(el.href, currentUrl);
    const name = String(el.name || "").toLowerCase();
    return (
      /\/(app|editor|dashboard|studio|workspace)(\/|$)/i.test(path) ||
      /\b(open (json )?editor|launch app|start detecting|try (it )?free|get started)\b/i.test(
        name,
      )
    );
  }).length;
  if (productEntryLinks >= 1) productScore += 4;
  if (productEntryLinks >= 2) productScore += 2;
  if (
    /\b(saas|dashboard|editor|workspace)\b/i.test(meta) &&
    appControls >= 1
  ) {
    productScore += 2;
  }

  const playground = pickPlayground(els, new Set(), currentUrl);
  // Already on an examples/playground PATH → treat as product surface.
  // Use pathname only so hosts like example.com don't false-match.
  const pathOnly = (() => {
    try {
      return new URL(currentUrl || "https://example.com").pathname;
    } catch {
      return "";
    }
  })();
  if (
    /\/(examples?|playground|sandbox|tutorial|repl)(\/|$)/i.test(pathOnly)
  ) {
    return {
      type: "product",
      reason: "already on interactive/examples surface",
      playground,
    };
  }

  // Docs only when clearly ahead of product signals (avoid SaaS false positives).
  if (docsScore >= 5 && docsScore > productScore) {
    return {
      type: "docs",
      reason: `docsScore=${docsScore} productScore=${productScore}`,
      playground,
    };
  }
  return {
    type: "product",
    reason: `docsScore=${docsScore} productScore=${productScore}`,
    playground,
  };
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

/**
 * Deterministic product-loop fallback. It relies only on semantic DOM signals,
 * never hostnames, product copy, or per-site selectors.
 */
export function buildDeterministicProductBeats(
  elements,
  { title = "the product", claimedHints = [] } = {},
) {
  const claimed = new Set(claimedHints);
  const visible = (elements || []).filter((el) => el.visible);
  const beats = [];
  const h1 = visible.find((el) => el.tag === "h1" && el.name);
  if (h1 && !claimed.has(selectorFor(h1))) {
    beats.push({
      description: "Land on hero",
      targetHint: selectorFor(h1),
      caption: productMeetCaption(title),
    });
  }

  const editable = visible
    .filter((el) => {
      const hint = selectorFor(el);
      const blob = `${el.name || ""} ${el.placeholder || ""} ${el.inputType || ""}`.toLowerCase();
      return (
        !claimed.has(hint) &&
        (el.editable || el.tag === "textarea" || el.tag === "input") &&
        !/password|login|sign.?in|newsletter|subscribe|search|enter your email/.test(blob)
      );
    })
    .map((el) => {
      const blob = `${el.name || ""} ${el.placeholder || ""}`.toLowerCase();
      let score = el.tag === "textarea" ? 8 : el.contentEditable ? 7 : 4;
      if (/prompt|message|describe|instruction|content|question|email|goal|idea/.test(blob)) score += 5;
      return { el, score };
    })
    .sort((a, b) => b.score - a.score)[0]?.el;

  if (editable) {
    beats.push({
      description: "Type a realistic product request",
      targetHint: selectorFor(editable),
      caption: "Describe what you need",
    });
  }

  const action = visible
    .filter((el) => {
      const hint = selectorFor(el);
      const name = String(el.name || "").toLowerCase();
      return (
        !claimed.has(hint) &&
        ["button", "a", "summary"].includes(el.tag) &&
        /generat|create|run|analy[sz]e|submit|send|compose|build|convert|preview|process|draft|improve|check/.test(name) &&
        !/notify|subscribe|login|sign.?in|history|settings/.test(name)
      );
    })
    .map((el) => {
      const name = String(el.name || "").toLowerCase();
      let score = 5;
      if (/generat/.test(name)) score = 18;
      else if (/create|run|submit|build|convert|process|draft/.test(name)) score = 12;
      else if (/send|compose|analy[sz]e|improve|check|preview/.test(name)) score = 8;
      if (el.tag === "button") score += 2;
      if (el.disabled && !editable) score -= 8;
      return { el, score };
    })
    .sort((a, b) => b.score - a.score)[0]?.el;

  if (action) {
    beats.push({
      description: `Click ${normalizeLabel(action.name) || "primary action"}`,
      targetHint: selectorFor(action),
      caption: "See the result",
    });
  }
  return beats;
}

function mergeUniqueBeats(primary, fallback, limit = 4) {
  const out = [];
  const seen = new Set();
  for (const beat of [...(primary || []), ...(fallback || [])]) {
    const key = String(beat.targetHint || "").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(beat);
    if (out.length >= limit) break;
  }
  return out;
}

function pickResultSurface(elements, claimedHints = [], plannedHints = [], beforeHints = []) {
  const blocked = new Set([...claimedHints, ...plannedHints]);
  const before = new Set(beforeHints);
  const candidate = (elements || [])
    .filter((el) => {
      const hint = selectorFor(el);
      return el.visible && !blocked.has(hint) && !before.has(hint);
    })
    .map((el) => {
      const name = String(el.name || "").toLowerCase();
      let score = 0;
      if (/generated|result|output|preview|response|subject line|email body/.test(name)) score += 12;
      if (/copy|download|export|share|save/.test(name)) score += 9;
      if (/^h[2-3]$/.test(el.tag)) score += 3;
      if (["button", "a"].includes(el.tag)) score += 1;
      return { el, score };
    })
    .filter((item) => item.score >= 8)
    .sort((a, b) => b.score - a.score)[0]?.el;
  if (!candidate) return null;
  return {
    description: "Pause on generated result",
    targetHint: selectorFor(candidate),
    caption: "Review the result",
  };
}

function isResultProducingBeat(beat) {
  const blob = `${beat?.description || ""} ${beat?.targetHint || ""}`;
  return /\b(generate|submit|send|create|draft|run|analy[sz]e|convert|render)\b/i.test(blob);
}

function orderProductBeats(beats) {
  return (beats || [])
    .map((beat, index) => {
      const blob = `${beat.description || ""} ${beat.targetHint || ""}`;
      let phase = 2;
      if (/\b(land|hero|overview|meet)\b/i.test(blob)) phase = 0;
      else if (/\b(type|enter|fill|prompt|describe|tell)\b/i.test(blob)) phase = 1;
      else if (isResultProducingBeat(beat)) phase = 3;
      return { beat, index, phase };
    })
    .sort((a, b) => a.phase - b.phase || a.index - b.index)
    .map(({ beat }) => {
      if (isResultProducingBeat(beat) && /^see (the )?result$/i.test(beat.caption || "")) {
        return { ...beat, caption: "Generate the result" };
      }
      return beat;
    });
}

async function waitForNewResultSurface(page, beforeHints, claimedHints, plannedHints) {
  const deadline = Date.now() + 18_000;
  while (Date.now() < deadline) {
    await sleep(750);
    const elements = await enumerateElements(page);
    const result = pickResultSurface(elements, claimedHints, plannedHints, beforeHints);
    if (result) return result;
  }
  return null;
}

async function captureStateFingerprint(page) {
  const state = await page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 1 && r.height > 1 && s.display !== "none" && s.visibility !== "hidden";
    };
    const controls = [...document.querySelectorAll("input, textarea, select, button, [role='button']")]
      .filter(visible)
      .slice(0, 60)
      .map((el) => `${el.tagName}:${el.getAttribute("aria-label") || el.textContent || ""}:${"value" in el ? el.value : ""}:${el.disabled ? "disabled" : "enabled"}`);
    return `${location.href}|${document.body.innerText.slice(0, 5000)}|${controls.join("|")}`;
  });
  let hash = 2166136261;
  for (let i = 0; i < state.length; i += 1) {
    hash ^= state.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

async function planPage(args) {
  const apiKey = requireApiKey();
  const model = modelName();
  const siteType = args.siteType || "product";
  const hasPlayground = Boolean(args.hasPlayground);
  const beatCap =
    siteType === "docs" && !hasPlayground ? DOCS_BRIEF_MAX_BEATS : MAX_BEATS;
  const remaining = Math.max(0, beatCap - args.beatsSoFar);
  const maxBeatsHere =
    siteType === "docs" && !hasPlayground
      ? Math.min(2, remaining)
      : Math.min(3, remaining);
  const cameraMode = siteType === "camera";
  const docsMode = siteType === "docs";

  let modeRules;
  let modeLabel;
  if (cameraMode) {
    modeLabel = "CAMERA_EXPLAINER";
    modeRules = `
CAMERA PRODUCT MODE (required):
- This product needs a live device camera/webcam. Do NOT open it.
- NEVER plan beats or nextNavigation into /app, /camera, detect tools, Start Detecting, Open App, Get Started, Upload, flashlight, or sample controls.
- Stay on the marketing site. Film: (1) one land/hero pause, then (2) How it works / Features / Three steps explainer headings or in-page anchors.
- Prefer scrolling the explainer over leaving the page. nextNavigation should be null unless it is an in-page #how-it-works style anchor.
- Set done=true after the explainer arc — never enter the live camera tool.
`;
  } else if (docsMode && hasPlayground) {
    modeLabel = "DOCS_PLAYGROUND";
    modeRules = `
DOCS / REFERENCE SITE — PLAYGROUND STRATEGY (required):
- This is documentation/reference, not a product app. Do NOT tour docs sidebars, TOC links, essays, or long prose sections.
- There IS an interactive surface (Examples / Playground / Try it / Sandbox / Demo). Get there ASAP.
- On page 0: ONE land/hero pause only, then put the playground/examples link in nextNavigation. No docs TOC beats.
- On the playground/examples page: film interactive demos (runnable examples, try buttons, live widgets) — not more docs nav.
- NEVER make nav sidebars, tables of contents, or paragraph text the focal beat.
- Keep the tour tight. Prefer story over coverage.
`;
  } else if (docsMode) {
    modeLabel = "DOCS_BRIEF";
    modeRules = `
DOCS / REFERENCE SITE — BRIEF "WHAT IT IS" STRATEGY (required):
- This is documentation/reference with NO clear playground. Do NOT scroll docs or click TOC/sidebar.
- Film a SHORT crisp arc only: (1) land/hero pause with a value caption, (2) at most 1–2 concept highlights that stay on THIS page (feature pills or hero subheads as PAUSE/visit — do not navigate into /docs).
- nextNavigation MUST be null. Set done=true. Do not pad to fill a longer budget — a clean ~12–15s beats walls of text.
- NEVER make nav sidebars, tables of contents, essays, or long paragraphs the focal beat.
`;
  } else {
    modeLabel = "PRODUCT_DEMO";
    modeRules = `
- This is a PRODUCT DEMO, not a marketing brochure. Show the product working.
- Prefer interactive controls: buttons, links with action labels (Start / Try / Open / Upload / Generate / Sample / Share), inputs, app chrome.
- AVOID beats that only click static headings or section titles ("highlight headline", "show three steps"). At most ONE land/hero pause on page 0.
- On page 0, if a primary product-entry CTA exists (Start, Try free, Open app, Get started, Launch, Upload), either film it as a beat OR put it in nextNavigation — do not burn the budget on marketing copy.
- On app/tool pages, film the PRIMARY product loop first (sample / generate / upload / share / result). Do NOT jump to settings/about/account until that loop is shown — prefer done=true after the product loop.
- Skip low-value chrome (theme toggle) unless nothing else is available.
`;
  }

  const prompt = `You are DemoBro's tour agent. Plan the NEXT beats for the CURRENT page only.

Project: ${args.title}
Description: ${args.description}
Live origin: ${args.origin}
Current URL: ${args.currentUrl}
Page index: ${args.pageIndex} (phase: ${narrativePhase(args.pageIndex)})
Beats filmed so far: ${args.beatsSoFar}/${beatCap}
Pages visited: ${args.visitedPaths.join(" -> ") || "(none yet)"}
Controls already used (do not reuse): ${args.claimedHints.slice(0, 20).join(", ") || "(none)"}
Site type: ${siteType.toUpperCase()}
Mode: ${modeLabel}

GROUND TRUTH — visible controls on THIS page after hydration:
${args.elementLines || "(nothing useful)"}

Rules:
${modeRules}
- Propose 1-${maxBeatsHere} beats for THIS page only (0 only if the page is empty/useless).
- Each beat: ONE action (visit/pause/click/type) using a real hint= from the list.
- description: INTERNAL action note for the robot (e.g. "Pause on hero", "Select rectangle tool") — not shown to viewers.
- caption: VIEWER-facing benefit line for the on-screen lower-third. 2–6 words, punchy, no trailing punctuation. Describe the VALUE of this screen/feature (why the viewer should care), NEVER the robot action. No "click/visit/scroll/land/select". No selectors or raw element labels. Examples: "Meet DemoBro", "Turn JSON into a map", "Sketch ideas in seconds", "See how it works".
- On page 0 with an h1, include ONE land/hero pause beat first.
- CRITICAL: page beats should STAY on this page. Put the SINGLE best same-site deeper link in nextNavigation only (do not also list it as a beat), unless the mode forbids leaving.
- nextNavigation.targetHint MUST be a real hint= from the list (prefer a[href^="/"] or a primary CTA button/link). Never use a bare URL path without a matching control.
- Prefer internal paths (href starting with /) over external for nextNavigation.
- Set done=true when the tour should end (enough story, no good next page, or remaining budget < 2).
- If this page yields nothing useful, beats=[] and done=true.
- Never invent controls not in the list.
- Return JSON only.`;

  const data = await withRetry(
    async () => {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        GROK_TIMEOUT_MS,
      );
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
      } catch (err) {
        const name = err && typeof err === "object" ? err.name : "";
        if (name === "AbortError") {
          throw new Error("Planning timed out");
        }
        throw err;
      } finally {
        clearTimeout(timeout);
      }

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(
          `Grok page-plan error ${res.status}: ${detail.slice(0, 200)}`,
        );
      }
      const json = await res.json();
      const content = json.choices?.[0]?.message?.content;
      if (!content) throw new Error("Empty page-plan response");
      return json;
    },
    {
      attempts: GROK_MAX_ATTEMPTS,
      delayMs: 900,
      label: "planPage",
    },
  );
  const content = data.choices?.[0]?.message?.content;
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
    .filter((b) => !isBrochureBeat(b, { allowExplainer: cameraMode || docsMode }))
    .filter((b) => !(docsMode && isDocsSidebarBeat(b)))
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
  if (docsMode && nextNavigation && isDocsSidebarBeat(nextNavigation)) {
    nextNavigation = null;
  }
  if (docsMode && !hasPlayground) {
    nextNavigation = null;
  }

  return {
    beats,
    nextNavigation,
    done:
      Boolean(parsed.done) ||
      beats.length === 0 ||
      (docsMode && !hasPlayground),
    reason: String(parsed.reason || ""),
  };
}

async function safeGoto(page, url) {
  const before = await assertSafePublicUrl(url);
  if (!before.ok) throw new Error(toUserFacingError(new Error(before.error)));
  try {
    await page.goto(before.url.toString(), {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
  } catch (err) {
    throw new Error(toUserFacingError(err));
  }
  const after = await assertSafePublicUrl(page.url());
  if (!after.ok) {
    throw new Error(toUserFacingError(new Error(after.error)));
  }
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

  const probed = await probeLiveUrl(liveUrl);
  if (!probed.ok) throw new Error(probed.error);
  const safe = await assertSafePublicUrl(liveUrl);
  if (!safe.ok) throw new Error(toUserFacingError(new Error(safe.error)));
  const origin = safe.url.origin;

  let title = options.title || "Demo";
  let description = options.description || "";
  if (options.repoUrl) {
    try {
      const repo = await ingestRepoLight(options.repoUrl);
      title = options.title || repo.title;
      description = options.description || repo.description;
    } catch (err) {
      // Never fail the job on GitHub — title/description from the form are enough.
      console.warn(
        `[agent] repo ingest soft-fail: ${err instanceof Error ? err.message : err}`,
      );
    }
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

  // A previous job that hung on close can leave a zombie that blocks launch.
  await killOrphanBrowsers();
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      "--disable-dev-shm-usage",
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
    const stateFingerprint =
      report.status === "succeeded"
        ? await captureStateFingerprint(page).catch(() => null)
        : null;
    reports.push({
      ...report,
      startMs,
      endMs,
      stateFingerprint,
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

  /** Minimal safe cut when the page has nothing to tour — still produce a video. */
  const filmMinimalLanding = async (elements) => {
    const h1 = (elements || []).find(
      (el) => el.visible && el.tag === "h1" && el.name,
    );
    const target = h1
      ? {
          description: "Land on hero",
          targetHint: selectorFor(h1),
          caption: productMeetCaption(title),
        }
      : {
          description: "Land on page",
          targetHint: "body",
          caption: productMeetCaption(title),
        };
    console.log(`[agent] minimal safe cut → ${target.targetHint}`);
    await filmOne(target);
    await sleep(1200);
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

      // Empty / uncooperative page → film a short land beat and finish.
      if (pageIndex === 0 && useful.length === 0) {
        console.warn(
          `[agent] no usable controls — filming minimal landing cut`,
        );
        await filmMinimalLanding(elements);
        done = true;
        break;
      }

      const site = classifySiteType({
        title,
        description,
        elements,
        currentUrl,
      });
      const cameraMode = site.type === "camera";
      const docsMode = site.type === "docs";
      const playground =
        site.playground || pickPlayground(elements, claimed, currentUrl);
      const beatBudget =
        docsMode && !playground ? DOCS_BRIEF_MAX_BEATS : MAX_BEATS;
      if (pageIndex === 0) {
        console.log(
          `[agent] site type=${site.type} (${site.reason})` +
            (playground
              ? ` playground="${playground.targetHint}"`
              : " playground=none") +
            ` strategy=${
              cameraMode
                ? "camera_explainer"
                : docsMode && playground
                  ? "docs_playground"
                  : docsMode
                    ? "docs_brief"
                    : "product_app"
            }`,
        );
      }

      if (succeeded() >= beatBudget) {
        console.log(`[agent] beat budget ${beatBudget} reached — ending`);
        done = true;
        break;
      }

      let plan;
      try {
        plan = await planPage({
          title,
          description,
          origin,
          currentUrl,
          pageIndex,
          beatsSoFar: succeeded(),
          visitedPaths,
          claimedHints: [...claimed],
          elementLines: elementsForPrompt(elements),
          siteType: site.type,
          hasPlayground: Boolean(playground),
        });
      } catch (err) {
        console.warn(
          `[agent] planPage failed: ${err instanceof Error ? err.message : err}`,
        );
        if (!cameraMode && !docsMode) {
          const fallback = buildDeterministicProductBeats(elements, {
            title,
            claimedHints: [...claimed],
          });
          if (fallback.length >= MIN_SUCCESSFUL_BEATS - succeeded()) {
            plan = {
              beats: fallback,
              nextNavigation: null,
              done: true,
              reason: "deterministic DOM fallback",
            };
            console.log(
              `[agent] using deterministic product fallback (${fallback.length} beats)`,
            );
          }
        }
        if (!plan) {
          if (succeeded() === 0 && pageIndex === 0) {
            await filmMinimalLanding(elements);
          }
          done = true;
          break;
        }
      }

      if (!cameraMode && !docsMode && succeeded() < MIN_SUCCESSFUL_BEATS) {
        const fallback = buildDeterministicProductBeats(elements, {
          title,
          claimedHints: [...claimed],
        });
        const before = plan.beats.length;
        plan.beats = mergeUniqueBeats(plan.beats, fallback, 4);
        if (plan.beats.length > before) {
          plan.done = false;
          console.log(
            `[agent] deepened product plan ${before} → ${plan.beats.length} beats`,
          );
        }
      }

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
      } else if (docsMode) {
        plan.beats = (plan.beats || []).filter((b) => !isDocsSidebarBeat(b));
        if (plan.nextNavigation && isDocsSidebarBeat(plan.nextNavigation)) {
          plan.nextNavigation = null;
        }
        if (pageIndex === 0 && playground) {
          const land = plan.beats.find((b) =>
            /\b(land|hero|pause|overview)\b/i.test(b.description),
          );
          if (land && !land.caption) {
            land.caption = productMeetCaption(title);
          }
          // Land only, then go to the interactive surface — skip docs prose.
          plan.beats = land ? [land] : plan.beats.slice(0, 1);
          plan.nextNavigation = playground;
          plan.done = false;
          console.log(
            `[agent] docs→playground → ${playground.targetHint} ("${playground.caption}")`,
          );
        } else if (pageIndex === 0) {
          // Brief what-it-is: hero + up to 2 on-page concept pauses, then stop.
          const h1 = elements.find(
            (el) => el.visible && el.tag === "h1" && el.name,
          );
          let land = plan.beats.find((b) =>
            /\b(land|hero|pause|overview)\b/i.test(b.description),
          );
          if (!land && h1) {
            land = {
              description: "Land on hero",
              targetHint: selectorFor(h1),
              caption: productMeetCaption(title),
            };
          }
          if (land && !land.caption) {
            land.caption = productMeetCaption(title);
          }
          const concepts = plan.beats
            .filter(
              (b) =>
                b !== land &&
                !isDocsSidebarBeat(b) &&
                !/href=.*\/(docs?|reference|api|essays)/i.test(
                  b.targetHint || "",
                ),
            )
            .slice(0, 2);
          plan.beats = land ? [land, ...concepts] : concepts;
          plan.nextNavigation = null;
          plan.done = true;
          console.log(
            `[agent] docs brief — ${plan.beats.length} beats, no docs scroll`,
          );
        } else {
          // Accidentally on a docs page — stop rather than scroll prose.
          plan.beats = plan.beats
            .filter((b) => !isDocsSidebarBeat(b))
            .slice(0, 1);
          plan.nextNavigation = null;
          plan.done = true;
          console.log(`[agent] docs page — ending without prose tour`);
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

        // Product sites: prefer examples/playground over docs when both exist.
        if (!docsMode) {
          const demoNav = pickPlayground(elements, claimed);
          const nextBlob = `${plan.nextNavigation?.description || ""} ${plan.nextNavigation?.targetHint || ""}`.toLowerCase();
          if (
            demoNav &&
            (!plan.nextNavigation || /docs?|reference|api/.test(nextBlob))
          ) {
            plan.nextNavigation = demoNav;
            plan.done = false;
            console.log(
              `[agent] prefer demo/examples → ${demoNav.targetHint}`,
            );
          }
        }
      }

      // Don't tour settings/about before showing the product loop (non-camera/docs).
      if (!cameraMode && !docsMode && plan.nextNavigation) {
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

      // On examples/playground surfaces, stay on the interactive story —
      // never click into docs TOC / attribute reference pages.
      if (
        !docsMode &&
        /\/(examples?|playground|sandbox|tutorial|repl)\b/i.test(currentUrl)
      ) {
        const docsPathRe =
          /\/(docs?|reference|api|essays|attributes?)(\/|$)/i;
        const leavesInteractive = (b) => {
          if (!b) return false;
          const hint = String(b.targetHint || "");
          if (docsPathRe.test(hint) || isDocsSidebarBeat(b)) return true;
          // Resolve hint → live href (selectors often omit the path).
          const textM = hint.match(/has-text\("([^"]+)"\)/i);
          const label = textM ? textM[1].toLowerCase() : "";
          const match = elements.find((el) => {
            if (!el.visible || !el.href) return false;
            if (selectorFor(el) === hint) return true;
            if (
              label &&
              String(el.name || "")
                .toLowerCase()
                .trim() === label
            ) {
              return true;
            }
            return false;
          });
          return Boolean(
            match?.href &&
              docsPathRe.test(hrefPath(match.href, currentUrl)),
          );
        };
        const before = plan.beats.length;
        plan.beats = (plan.beats || []).filter((b) => !leavesInteractive(b));
        if (plan.beats.length < before) {
          console.log(
            `[agent] dropped ${before - plan.beats.length} docs-bound beat(s) on interactive surface`,
          );
        }
        if (plan.nextNavigation && leavesInteractive(plan.nextNavigation)) {
          console.log(
            `[agent] dropping docs nextNavigation from interactive surface`,
          );
          plan.nextNavigation = null;
          plan.done = true;
        }
        // Prefer ending on the interactive surface rather than padding.
        if (!plan.nextNavigation) plan.done = true;
      }

      if (!cameraMode && !docsMode) {
        plan.beats = orderProductBeats(plan.beats);
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
        siteType: site.type,
        strategy:
          cameraMode
            ? "camera_explainer"
            : docsMode && playground
              ? "docs_playground"
              : docsMode
                ? "docs_brief"
                : "product_app",
        playground: playground?.targetHint || null,
        beats: plan.beats,
        next: plan.nextNavigation,
        done: plan.done,
      });

      let leftPageEarly = false;
      for (const beat of plan.beats) {
        if (succeeded() >= beatBudget || timedOut) break;
        const beforeElements = await enumerateElements(page);
        const beforeHints = beforeElements.map(selectorFor);
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

        const latest = reports[reports.length - 1];
        if (
          latest?.status === "succeeded" &&
          latest.stepKind === "click" &&
          isResultProducingBeat(beat)
        ) {
          await hydrateSettle(page);
          const resultBeat = await waitForNewResultSurface(
            page,
            beforeHints,
            [...claimed],
            plan.beats.map((item) => item.targetHint),
          );
          if (resultBeat) {
            console.log(`[agent] revealed result surface → ${resultBeat.targetHint}`);
            await filmOne({
              id: `p${pageIndex}-result-${reports.length}`,
              ...resultBeat,
            });
          }
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

      if (plan.done || !plan.nextNavigation || succeeded() >= beatBudget) {
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

      if (succeeded() < beatBudget) {
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

    // Same-attempt recovery: if the model stopped early, discover the remaining
    // product loop directly from the current DOM before ending the recording.
    let quality = assessTourQuality({ steps: reports });
    if (!quality.ok && sameOrigin(page.url(), origin)) {
      await hydrateSettle(page);
      const recoveryElements = await enumerateElements(page);
      const recovery = buildDeterministicProductBeats(recoveryElements, {
        title,
        claimedHints: [...claimed],
      });
      console.log(
        `[agent] quality recovery: ${quality.reasons.join("; ")} (${recovery.length} candidates)`,
      );
      for (const beat of recovery) {
        if (timedOut || Date.now() - t0 >= SESSION_TIMEOUT_MS - 8_000) break;
        quality = assessTourQuality({ steps: reports });
        if (quality.successfulBeats >= MIN_SUCCESSFUL_BEATS && quality.interactions > 0) break;
        await filmOne({
          id: `recovery-${reports.length}`,
          description: beat.description,
          targetHint: beat.targetHint,
          caption: beat.caption || "",
        });
        await sleep(350);
      }
    }

    quality = assessTourQuality({ steps: reports });
    if (
      quality.successfulBeats >= MIN_SUCCESSFUL_BEATS &&
      quality.interactions > 0 &&
      quality.distinctStates >= 2 &&
      quality.bodyDurationMs < TARGET_BODY_DURATION_MS
    ) {
      const holdMs = Math.min(
        6_000,
        TARGET_BODY_DURATION_MS - quality.bodyDurationMs + 250,
      );
      console.log(`[agent] holding final state ${holdMs}ms for render headroom`);
      await sleep(holdMs);
      const last = [...reports].reverse().find((r) => r.status === "succeeded");
      if (last) last.endMs += holdMs;
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
  await closeBrowserSafely(browser, context, 15_000);

  if (video) {
    try {
      const tempPath = await withTimeout(
        video.path(),
        10_000,
        "video.path timed out",
      );
      const finalPath = path.join(videoDir, "recording.webm");
      await rename(tempPath, finalPath).catch(() => {
        videoPath = tempPath;
      });
      if (!videoPath) videoPath = finalPath;
    } catch (err) {
      console.warn(
        `[agent] video finalize soft-fail: ${
          err instanceof Error ? err.message : err
        }`,
      );
      videoPath = (await findNewestWebm(videoDir)) || videoPath;
    }
  }
  if (!videoPath) {
    videoPath = await findNewestWebm(videoDir);
  }
  if (!videoPath) {
    throw new Error("Recording finished but no video file was written.");
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
