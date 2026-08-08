/**
 * Capture page structure from a REAL hydrated DOM (Playwright),
 * reusing enumerateElements / selectorFor from resolve-selectors.js.
 */
import { chromium } from "playwright";
import { assertSafePublicUrl } from "./ssrf.js";
import { enumerateElements, selectorFor } from "./resolve-selectors.js";

const VIEWPORT = { width: 1920, height: 1080 };
const NAV_TIMEOUT_MS = 45_000;
const SETTLE_MS = 2_500;

/**
 * @typedef {{
 *   tag: string,
 *   role?: string,
 *   name?: string,
 *   href?: string,
 *   selectorHint: string,
 *   visible?: boolean,
 *   disabled?: boolean,
 * }} PageElement
 *
 * @typedef {{
 *   finalUrl: string,
 *   title: string,
 *   elements: PageElement[],
 *   landmarks: string[],
 * }} PageStructure
 */

/**
 * Load liveUrl headlessly, wait for hydration, enumerate interactive controls.
 * @param {string} liveUrl
 * @returns {Promise<
 *   | { ok: true, structure: PageStructure }
 *   | { ok: false, error: string }
 * >}
 */
export async function captureHydratedPageStructure(liveUrl) {
  const safe = await assertSafePublicUrl(liveUrl);
  if (!safe.ok) return { ok: false, error: safe.error };

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--autoplay-policy=no-user-gesture-required"],
    });
    const context = await browser.newContext({ viewport: VIEWPORT });
    const page = await context.newPage();
    page.setDefaultTimeout(NAV_TIMEOUT_MS);

    const response = await page.goto(safe.url.toString(), {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT_MS,
    });
    if (response && response.status() >= 400) {
      return {
        ok: false,
        error: `Live URL returned ${response.status()} — couldn’t read the page.`,
      };
    }

    // Let SPA JS hydrate; networkidle is nice-to-have but flaky on analytics-heavy sites.
    await page.waitForLoadState("networkidle", { timeout: 12_000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, SETTLE_MS));

    const finalUrl = page.url();
    const title = (await page.title().catch(() => "")) || "";
    const raw = await enumerateElements(page);

    const elements = raw
      .filter((el) => el.visible && (el.name || el.tag === "textarea" || el.tag === "input"))
      .slice(0, 80)
      .map((el) => ({
        tag: el.tag,
        role: el.role || undefined,
        name: el.name || undefined,
        href: el.href || undefined,
        selectorHint: selectorFor(el),
        visible: el.visible,
        disabled: el.disabled,
      }));

    // Landmarks via a small evaluate (not in enumerate — keep enumerate untouched).
    const landmarks = await page.evaluate(() => {
      const clean = (v) =>
        v ? String(v).replace(/\s+/g, " ").trim().slice(0, 80) : "";
      return Array.from(
        document.querySelectorAll(
          "main, nav, header, footer, [role='main'], [role='navigation']",
        ),
      )
        .slice(0, 12)
        .map((el) =>
          [el.tagName.toLowerCase(), el.getAttribute("role"), clean(el.getAttribute("aria-label"))]
            .filter(Boolean)
            .join(" "),
        );
    });

    console.log(
      `[hydrate] ${finalUrl} — ${elements.length} visible controls (title="${title.slice(0, 60)}")`,
    );

    return {
      ok: true,
      structure: {
        finalUrl,
        title,
        elements,
        landmarks,
      },
    };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Couldn’t hydrate that live URL.";
    return { ok: false, error: message };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
