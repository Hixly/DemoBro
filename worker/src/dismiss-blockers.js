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

// Prefer stay/free/open-source paths — never the upsell/"Open To Diagram" fork.
const CHOOSER_STAY_RE =
  /stay on\b|^stay$|stay here|open source|continue (here|free|with free)|use (the )?(free|web|browser)|start free|try free|no thanks|maybe later/i;

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

  // 4) Chooser modals — prefer free/open-source/stay-on-product paths.
  if (
    await tryClickLocator(
      page.getByRole("button", { name: CHOOSER_STAY_RE }),
      "chooser:button",
      clicked,
    )
  ) {
    did = true;
  }
  if (
    !did &&
    (await tryClickLocator(
      page.getByRole("link", { name: CHOOSER_STAY_RE }),
      "chooser:link",
      clicked,
    ))
  ) {
    did = true;
  }

  // 5) Dialog-scoped primary that looks like continue/accept (not delete).
  if (!did) {
    const dialogBtn = page
      .locator('[role="dialog"] button, [role="alertdialog"] button')
      .filter({ hasText: CONSENT_RE });
    if (await tryClickLocator(dialogBtn, "dialog:consent", clicked)) {
      did = true;
    }
  }

  // 6) Soft Escape only if no safer button matched this round.
  if (!did) {
    const dialogVisible = await page
      .locator('[role="dialog"], [role="alertdialog"]')
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
  for (let round = 0; round < 3; round += 1) {
    const did = await dismissRound(page, clicked);
    if (!did) break;
    await sleep(SETTLE_MS);
    await page
      .waitForLoadState("domcontentloaded", { timeout: 3_000 })
      .catch(() => {});
  }
  if (clicked.length) {
    console.log(`[dismiss] cleared blockers: ${clicked.join(" → ")}`);
  } else {
    console.log(`[dismiss] no blockers found`);
  }
  return clicked;
}
