/**
 * Ground storyboard selectors in the LIVE, hydrated DOM right before filming.
 *
 * The web service plans the storyboard against static HTML (cheerio, no JS), so
 * on client-rendered SPAs the selectors Grok gets are often guesses. By the time
 * we're here, the worker already has a real browser sitting on the live page —
 * so we read the REAL rendered elements, then for each step:
 *   1. verify the existing selector resolves fast (no 8s film-timeout waits)
 *   2. repair it by matching the step's text to a real on-page element
 *   3. drop it only if nothing plausible exists (better than filming a dead wait)
 *
 * Landing / "pause on hero" style steps are never dropped — they fall back to a
 * safe body pause so the tour still has an opening beat.
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
    blob.includes("view the")
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
  return /^open\b/i.test(step.description || "");
}

/** Camera/permission steps are granted via context flags, not clicked. */
function isNativePermissionStep(step) {
  const blob = `${step.description} ${step.targetHint}`.toLowerCase();
  return (
    blob.includes("allow") &&
    (blob.includes("camera") || blob.includes("permission") || blob.includes("prompt"))
  );
}

/** Pull real interactive/heading elements from the hydrated page. */
async function enumerateElements(page) {
  return page.evaluate(() => {
    const clean = (v) =>
      v ? String(v).replace(/\s+/g, " ").trim().slice(0, 120) : "";
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
}

/** Build a Playwright-usable selector string for a real element. */
function selectorFor(el) {
  if (el.testId) return `[data-testid="${el.testId}"]`;
  if (el.id && /^[A-Za-z][\w:-]*$/.test(el.id)) return `#${el.id}`;
  if (el.name) {
    return `${el.tag}:has-text("${el.name.slice(0, 60).replace(/"/g, '\\"')}")`;
  }
  if (el.href && el.href.startsWith("/") && el.href.length < 80) {
    return `a[href="${el.href}"]`;
  }
  return el.tag;
}

const STOP_WORDS = new Set([
  "the", "a", "an", "to", "on", "in", "of", "for", "and", "or", "your", "you",
  "click", "tap", "press", "open", "view", "see", "watch", "go", "button",
  "link", "this", "that", "it", "with", "get", "then", "into", "at", "page",
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
  const stepTokens = new Set([
    ...tokens(step.description),
    ...tokens(step.targetHint),
  ]);
  if (stepTokens.size === 0) return 0;
  const elTokens = tokens(el.name);
  if (elTokens.length === 0) return 0;
  let hits = 0;
  for (const t of elTokens) if (stepTokens.has(t)) hits += 1;
  // Normalize by the element's token count so short exact labels win.
  return hits / Math.max(elTokens.length, 1);
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
 * @param {import('playwright').Page} page
 * @param {Array<{id?:string, description:string, targetHint:string}>} steps
 * @returns {Promise<{ steps: Array, report: Array }>}
 */
export async function resolveSteps(page, steps) {
  let elements = [];
  try {
    elements = await enumerateElements(page);
  } catch (err) {
    console.warn(
      `[resolve] could not enumerate DOM (${err instanceof Error ? err.message : err}); filming raw steps`,
    );
    return {
      steps,
      report: steps.map((s) => ({
        description: s.description,
        resolution: "unchecked",
      })),
    };
  }

  console.log(`[resolve] enumerated ${elements.length} live elements`);

  const kept = [];
  const report = [];
  // Selectors already claimed by an earlier kept step — prevents two steps
  // from filming the exact same control.
  const claimed = new Set();

  for (const step of steps) {
    // Leave navigation / permission steps for record.js to handle as-is.
    if (isNavigationStep(step) || isNativePermissionStep(step)) {
      kept.push(step);
      report.push({ description: step.description, resolution: "passthrough" });
      continue;
    }

    // 1. Does the existing selector already resolve (and isn't already taken)?
    if (
      step.targetHint &&
      !claimed.has(step.targetHint) &&
      (await probe(page, step.targetHint))
    ) {
      claimed.add(step.targetHint);
      kept.push(step);
      report.push({ description: step.description, resolution: "verified" });
      continue;
    }

    // 2. Repair: best-matching real element that actually probes true.
    //    Keep disabled controls as candidates (a disabled "Generate" button
    //    gets enabled once an earlier fill step types into its input), but
    //    prefer enabled matches when scores tie. Skip anything already claimed.
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
    for (const candidate of ranked.slice(0, 6)) {
      const sel = selectorFor(candidate.el);
      if (claimed.has(sel)) continue;
      if (await probe(page, sel)) {
        repaired = { sel, name: candidate.el.name };
        break;
      }
    }
    if (repaired) claimed.add(repaired.sel);

    if (repaired) {
      kept.push({ ...step, targetHint: repaired.sel });
      report.push({
        description: step.description,
        resolution: "repaired",
        from: step.targetHint,
        to: repaired.sel,
      });
      continue;
    }

    // 3. Nothing matched. Keep pause-style steps with a safe fallback; drop rest.
    if (isPauseStep(step)) {
      kept.push({ ...step, targetHint: "body" });
      report.push({ description: step.description, resolution: "fallback-pause" });
    } else {
      report.push({
        description: step.description,
        resolution: "dropped",
        from: step.targetHint,
      });
    }
  }

  // Safety net: never hand back an empty tour — keep the first step as a pause.
  if (kept.length === 0 && steps.length > 0) {
    kept.push({ ...steps[0], targetHint: "body" });
    report.push({ description: steps[0].description, resolution: "fallback-first" });
  }

  const summary = report.reduce((acc, r) => {
    acc[r.resolution] = (acc[r.resolution] || 0) + 1;
    return acc;
  }, {});
  console.log(`[resolve] ${kept.length}/${steps.length} steps kept —`, summary);

  return { steps: kept, report };
}
