/**
 * General entry-blocker dismissal: cookie/consent, intro overlays, chooser
 * modals. Runs after hydrate, before enumerate/plan. No per-site selectors.
 */

const SETTLE_MS = 450;
const CLICK_TIMEOUT_MS = 1200;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Safe, affirmative / dismiss labels — never destructive actions. */
const CONSENT_RE =
  /^(accept(\s+all)?|agree|i agree|got it|allow(\s+all)?|accept cookies|ok(ay)?|continue|reject(\s+all)?|decline|necessary only|only necessary|save (and|&) continue|confirm)$/i;

const DISMISS_RE =
  /^(close|dismiss|skip|no thanks|maybe later|not now|later|continue without|dismiss all)$/i;

/**
 * Chooser modals only (e.g. "Stay on JSON Crack" vs upsell).
 * Must NOT match bare footer "open source" / sponsor links — those leave the site.
 */
const CHOOSER_STAY_RE =
  /stay on\b|^stay$|stay here|continue (here|free|with free)|continue with (the )?open.?source|use (the )?(free|web|browser|open.?source)( (version|edition|app))?|start free|try free|no thanks|maybe later|keep using|remain here/i;

const DIALOG_SCOPE =
  '[role="dialog"], [role="alertdialog"], [aria-modal="true"], .modal, [class*="modal"]';

async function tryClickLocator(locator, label, clicked) {
  try {
    const el = locator.first();
    if ((await el.count()) < 1) return false;
    const visible = await el.isVisible().catch(() => false);
    if (!visible) return false;
    const enabled = await el.isEnabled().catch(() => true);
    if (!enabled) return false;
    await el.click({ timeout: CLICK_TIMEOUT_MS });
    clicked.push(label);
    return true;
  } catch {
    return false;
  }
}

/**
 * Click a same-origin (or hash/#) chooser control inside a dialog.
 * Rejects off-site links that used to match loose "open source" patterns.
 */
async function tryClickChooserInDialogs(page, role, clicked) {
  const dialogs = page.locator(DIALOG_SCOPE);
  const n = await dialogs.count().catch(() => 0);
  if (n < 1) return false;

  const origin = (() => {
    try {
      return new URL(page.url()).origin;
    } catch {
      return "";
    }
  })();

  for (let i = 0; i < Math.min(n, 4); i += 1) {
    const dialog = dialogs.nth(i);
    const visible = await dialog.isVisible().catch(() => false);
    if (!visible) continue;

    const candidates = dialog.getByRole(role, { name: CHOOSER_STAY_RE });
    const count = await candidates.count().catch(() => 0);
    for (let j = 0; j < Math.min(count, 6); j += 1) {
      const el = candidates.nth(j);
      const elVisible = await el.isVisible().catch(() => false);
      if (!elVisible) continue;

      if (role === "link") {
        const href = await el.getAttribute("href").catch(() => null);
        if (href) {
          try {
            const abs = new URL(href, page.url());
            if (abs.origin !== origin && abs.protocol !== "javascript:") {
              continue; // never follow off-site chooser links
            }
          } catch {
            continue;
          }
        }
      }

      try {
        await el.click({ timeout: CLICK_TIMEOUT_MS });
        clicked.push(`chooser:${role}`);
        return true;
      } catch {
        /* try next */
      }
    }
  }
  return false;
}

/**
 * One pass over common blocker patterns. Returns true if something was clicked.
 * @param {import('playwright').Page} page
 * @param {string[]} clicked
 */
async function dismissRound(page, clicked) {
  let did = false;

  // 1) Cookie / consent buttons (roles first).
  if (
    await tryClickLocator(
      page.getByRole("button", { name: CONSENT_RE }),
      "consent:button",
      clicked,
    )
  ) {
    did = true;
  }
  if (
    !did &&
    (await tryClickLocator(
      page.getByRole("link", { name: CONSENT_RE }),
      "consent:link",
      clicked,
    ))
  ) {
    did = true;
  }

  // 2) Explicit close / skip / no-thanks.
  if (
    await tryClickLocator(
      page.getByRole("button", { name: DISMISS_RE }),
      "dismiss:button",
      clicked,
    )
  ) {
    did = true;
  }

  // 3) Aria-labelled close controls on overlays.
  if (
    await tryClickLocator(
      page.locator(
        '[aria-label="Close"], [aria-label="close"], [aria-label="Dismiss"], [aria-label="dismiss"]',
      ),
      "dismiss:aria",
      clicked,
    )
  ) {
    did = true;
  }

  // 4) Chooser modals ONLY inside dialogs — never page-wide "open source" links.
  if (await tryClickChooserInDialogs(page, "button", clicked)) {
    did = true;
  }
  if (!did && (await tryClickChooserInDialogs(page, "link", clicked))) {
    did = true;
  }

  // 5) Dialog-scoped primary that looks like continue/accept (not delete).
  if (!did) {
    const dialogBtn = page
      .locator(`${DIALOG_SCOPE} button`)
      .filter({ hasText: CONSENT_RE });
    if (await tryClickLocator(dialogBtn, "dialog:consent", clicked)) {
      did = true;
    }
  }

  // 6) Soft Escape only if no safer button matched this round.
  if (!did) {
    const dialogVisible = await page
      .locator('[role="dialog"], [role="alertdialog"], [aria-modal="true"]')
      .first()
      .isVisible()
      .catch(() => false);
    if (dialogVisible) {
      await page.keyboard.press("Escape").catch(() => {});
      clicked.push("escape");
      did = true;
    }
  }

  return did;
}

/**
 * Dismiss entry blockers after hydrate. Safe no-op when none exist.
 * @param {import('playwright').Page} page
 * @returns {Promise<string[]>} labels of actions taken
 */
export async function dismissEntryBlockers(page) {
  const clicked = [];
  const startUrl = page.url();
  let startOrigin = "";
  try {
    startOrigin = new URL(startUrl).origin;
  } catch {
    /* ignore */
  }

  for (let round = 0; round < 3; round += 1) {
    const did = await dismissRound(page, clicked);
    if (!did) break;
    await sleep(SETTLE_MS);
    await page
      .waitForLoadState("domcontentloaded", { timeout: 3_000 })
      .catch(() => {});

    // If a dismiss click navigated off-origin, bounce back.
    try {
      const now = new URL(page.url());
      if (startOrigin && now.origin !== startOrigin) {
        console.warn(
          `[dismiss] off-origin after ${clicked[clicked.length - 1]} → ${now.href}; restoring ${startUrl}`,
        );
        await page.goto(startUrl, {
          waitUntil: "domcontentloaded",
          timeout: 15_000,
        });
        clicked.push("restore-origin");
        break;
      }
    } catch {
      /* ignore */
    }
  }
  if (clicked.length) {
    console.log(`[dismiss] cleared blockers: ${clicked.join(" → ")}`);
  } else {
    console.log(`[dismiss] no blockers found`);
  }
  return clicked;
}
