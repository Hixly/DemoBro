/**
 * Ground storyboard selectors in the LIVE, hydrated DOM.
 *
 * Resolution is JUST-IN-TIME: call resolveStep() immediately before filming
 * each step, after prior clicks/types have settled, so controls that only
 * appear mid-tour (e.g. Analyze after Generate) can still be found.
 *
 * For each step we:
 *   1. re-enumerate the current DOM
 *   2. verify the existing selector resolves fast
 *   3. repair via token match against live elements (enabled preferred, deduped)
 *   4. skip only as a last resort if nothing resolves in the current state
 *
 * Landing / "pause on hero" style steps fall back to a safe body pause.
 */

const PROBE_TIMEOUT_MS = 1_200;

/** Steps that should survive even with no matching control (they just pause). */
function isPauseStep(step) {
  const blob = `${step.description}`.toLowerCase();
  return (
    blob.includes("land") ||
    blob.includes("hero") ||
    blob.includes("pause") ||
    blob.includes("watch") ||
    blob.includes("scroll") ||
    blob.includes("overview") ||
    blob.includes("view the") ||
    blob.includes("visit")
  );
}

/** Navigation steps are handled by record.js directly — leave them alone. */
function isNavigationStep(step) {
  const hint = (step.targetHint || "").trim();
  try {
    const u = new URL(hint);
    if (u.protocol === "http:" || u.protocol === "https:") return true;
  } catch {
    /* not a url */
  }
  return /^open\b/i.test(step.description || "") || /^visit\b/i.test(step.description || "");
}

/** Camera/permission steps are granted via context flags, not clicked. */
function isNativePermissionStep(step) {
  const blob = `${step.description} ${step.targetHint}`.toLowerCase();
  return (
    blob.includes("allow") &&
    (blob.includes("camera") || blob.includes("permission") || blob.includes("prompt"))
  );
}

/**
 * Normalize visible labels for selectors + captions.
 * Collapses whitespace, strips arrows, unglues camelCase / "Currently infoo".
 */
export function normalizeLabel(raw) {
  let s = String(raw ?? "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "";
  s = s.replace(/([a-z])([A-Z])/g, "$1 $2");
  s = s.replace(/\s*[→⟶»›]+\s*/g, " ");
  s = s.replace(/[●•·▪▸]+/g, " ");
  s = s.replace(/^(Currently\s+in)([a-z])/i, "$1 $2");
  s = s.replace(/\s+/g, " ").trim();
  // Card dumps ("Hackyard Live A hackathon platform…") → short name.
  if (s.length > 36) {
    const words = s.split(/\s+/).slice(0, 4).join(" ");
    s = words.length >= 2 ? words : s.slice(0, 33).trim();
  }
  if (s.length > 48) s = `${s.slice(0, 45).trim()}…`;
  return s;
}

/** Pull real interactive/heading elements from the hydrated page. */
export async function enumerateElements(page) {
  const raw = await page.evaluate(() => {
    const clean = (v) =>
      v ? String(v).replace(/\s+/g, " ").trim().slice(0, 160) : "";
    const accessibleName = (el) =>
      clean(
        el.getAttribute("aria-label") ||
          el.getAttribute("title") ||
          el.getAttribute("alt") ||
          el.getAttribute("placeholder") ||
          el.textContent,
      );

    const isVisible = (el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return false;
      const style = window.getComputedStyle(el);
      return style.visibility !== "hidden" && style.display !== "none";
    };

    const out = [];
    const seen = new Set();
    const push = (el, role) => {
      if (out.length >= 120) return;
      const name = accessibleName(el);
      const testId = el.getAttribute("data-testid") || "";
      const id = el.id || "";
      const href = el.getAttribute("href") || "";
      const key = `${el.tagName}|${name}|${testId}|${id}|${href}`;
      if (seen.has(key)) return;
      seen.add(key);
      const disabled =
        el.disabled === true ||
        el.getAttribute("aria-disabled") === "true" ||
        el.getAttribute("disabled") !== null;
      out.push({
        tag: el.tagName.toLowerCase(),
        role: role || el.getAttribute("role") || "",
        name,
        testId,
        id,
        href,
        visible: isVisible(el),
        disabled,
      });
    };

    document
      .querySelectorAll(
        "a[href], button, [role='button'], input, select, textarea, summary",
      )
      .forEach((el) => {
        const type = (el.getAttribute("type") || "").toLowerCase();
        if (el.tagName === "INPUT" && (type === "hidden" || type === "file")) return;
        push(el);
      });
    document
      .querySelectorAll("h1, h2, h3, [role='heading']")
      .forEach((el) => push(el, "heading"));

    return out;
  });

  return raw.map((el) => ({
    ...el,
    name: normalizeLabel(el.name),
  }));
}

/** Build a Playwright-usable selector string for a real element. */
export function selectorFor(el) {
  if (el.testId) return `[data-testid="${el.testId}"]`;
  if (el.id && /^[A-Za-z][\w:-]*$/.test(el.id)) return `#${el.id}`;
  // Prefer stable href over long / garbled visible text.
  if (el.href && el.href.startsWith("/") && el.href.length < 80) {
    return `a[href="${el.href}"]`;
  }
  const name = normalizeLabel(el.name);
  if (name) {
    const short = name.slice(0, 40).replace(/"/g, '\\"');
    return `${el.tag}:has-text("${short}")`;
  }
  return el.tag;
}

const STOP_WORDS = new Set([
  "the", "a", "an", "to", "on", "in", "of", "for", "and", "or", "your", "you",
  "click", "tap", "press", "open", "view", "see", "watch", "go", "button",
  "link", "this", "that", "it", "with", "get", "then", "into", "at", "page",
  "type", "enter", "fill", "write", "new",
]);

function tokens(str) {
  return String(str || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

/** Token overlap between a step and a real element's name/text. */
function scoreMatch(step, el) {
  const desc = `${step.description} ${step.targetHint}`.toLowerCase();
  const stepTokens = new Set([
    ...tokens(step.description),
    ...tokens(step.targetHint),
  ]);
  if (stepTokens.size === 0) return 0;
  const elName = String(el.name || "").toLowerCase();
  const elTokens = tokens(el.name);
  if (elTokens.length === 0) return 0;

  // Hard preference: Copy steps must match Copy*; don't steal Generate Email.
  if (/\bcopy\b/.test(desc) && !/\bcopy\b/.test(elName)) return 0;
  if (/\bgenerat/.test(desc) && !/\bgenerat/.test(elName)) return 0;

  let hits = 0;
  for (const t of elTokens) if (stepTokens.has(t)) hits += 1;
  // Normalize by the element's token count so short exact labels win.
  let score = hits / Math.max(elTokens.length, 1);
  if (/\bcopy\b/.test(desc) && /\bcopy\b/.test(elName)) score += 0.35;
  if (/\bgenerat/.test(desc) && /\bgenerat/.test(elName)) score += 0.25;
  return Math.min(1, score);
}

async function probe(page, selector) {
  try {
    await page
      .locator(selector)
      .first()
      .waitFor({ state: "visible", timeout: PROBE_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve ONE step against the DOM as it exists right now (after prior
 * navigation/clicks/typing). Re-enumerates every call so mid-tour UI can appear.
 *
 * @param {import('playwright').Page} page
 * @param {{id?:string, description:string, targetHint:string}} step
 * @param {{ claimed?: Set<string> }} [opts] — selectors already used by earlier steps
 * @returns {Promise<{
 *   step: {id?:string, description:string, targetHint:string} | null,
 *   skip: boolean,
 *   report: { description: string, resolution: string, from?: string, to?: string }
 * }>}
 */
export async function resolveStep(page, step, opts = {}) {
  const claimed = opts.claimed ?? new Set();

  if (isNavigationStep(step) || isNativePermissionStep(step)) {
    return {
      step,
      skip: false,
      report: { description: step.description, resolution: "passthrough" },
    };
  }

  // 1. Existing selector already visible and not claimed?
  if (
    step.targetHint &&
    !claimed.has(step.targetHint) &&
    (await probe(page, step.targetHint))
  ) {
    claimed.add(step.targetHint);
    return {
      step,
      skip: false,
      report: { description: step.description, resolution: "verified" },
    };
  }

  // 2. Re-enumerate current DOM and repair.
  let elements = [];
  try {
    elements = await enumerateElements(page);
  } catch (err) {
    console.warn(
      `[resolve] enumerate failed (${err instanceof Error ? err.message : err}); filming raw selector`,
    );
    return {
      step,
      skip: false,
      report: { description: step.description, resolution: "unchecked" },
    };
  }

  console.log(
    `[resolve] step "${step.description.slice(0, 48)}" — ${elements.length} live elements`,
  );

  // Keep disabled controls as candidates (Generate enables after fill), but
  // prefer enabled matches when scores tie. Skip anything already claimed.
  const ranked = elements
    .filter((el) => el.visible && el.name)
    .map((el) => ({ el, score: scoreMatch(step, el) }))
    .filter((c) => c.score >= 0.34)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.el.disabled ? 1 : 0) - (b.el.disabled ? 1 : 0),
    );

  let repaired = null;
  for (const candidate of ranked.slice(0, 8)) {
    const sel = selectorFor(candidate.el);
    if (claimed.has(sel)) continue;
    if (await probe(page, sel)) {
      repaired = { sel, name: candidate.el.name };
      break;
    }
  }

  if (repaired) {
    claimed.add(repaired.sel);
    return {
      step: { ...step, targetHint: repaired.sel },
      skip: false,
      report: {
        description: step.description,
        resolution: "repaired",
        from: step.targetHint,
        to: repaired.sel,
      },
    };
  }

  // 3. Last resorts — pause fallback, else skip (do NOT drop earlier in the tour).
  if (isPauseStep(step)) {
    return {
      step: { ...step, targetHint: "body" },
      skip: false,
      report: { description: step.description, resolution: "fallback-pause" },
    };
  }

  return {
    step: null,
    skip: true,
    report: {
      description: step.description,
      resolution: "skipped",
      from: step.targetHint,
    },
  };
}

/**
 * Batch helper (tests / diagnostics). Does NOT drop unresolved mid-tour steps
 * up front — each step is resolved against the same snapshot only. Prefer
 * resolveStep() at film time in record.js.
 *
 * @param {import('playwright').Page} page
 * @param {Array<{id?:string, description:string, targetHint:string}>} steps
 */
export async function resolveSteps(page, steps) {
  const claimed = new Set();
  const kept = [];
  const report = [];

  for (const step of steps) {
    const result = await resolveStep(page, step, { claimed });
    report.push(result.report);
    if (!result.skip && result.step) kept.push(result.step);
  }

  if (kept.length === 0 && steps.length > 0) {
    kept.push({ ...steps[0], targetHint: "body" });
    report.push({ description: steps[0].description, resolution: "fallback-first" });
  }

  const summary = report.reduce((acc, r) => {
    acc[r.resolution] = (acc[r.resolution] || 0) + 1;
    return acc;
  }, {});
  console.log(`[resolve] batch ${kept.length}/${steps.length} —`, summary);

  return { steps: kept, report };
}
