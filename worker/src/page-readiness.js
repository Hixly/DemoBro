const BUSY_SELECTOR = [
  '[aria-busy="true"]',
  '[role="progressbar"]',
  '[data-loading="true"]',
  '.loading:not([hidden])',
  '.spinner:not([hidden])',
  '.skeleton:not([hidden])',
].join(",");

const NETWORK_NOISE =
  /analytics|telemetry|segment\.io|google-analytics|googletagmanager|hotjar|posthog|sentry|intercom|beacon/i;

export function isMeaningfulResponseMeta({
  url,
  method,
  resourceType,
  status,
  origin,
}) {
  if (!["fetch", "xhr", "document"].includes(String(resourceType || ""))) {
    return false;
  }
  if (
    !Number.isFinite(Number(status)) ||
    Number(status) < 200 ||
    Number(status) >= 400
  ) {
    return false;
  }
  if (NETWORK_NOISE.test(String(url || ""))) return false;
  try {
    const parsed = new URL(String(url || ""));
    if (origin && parsed.origin !== origin) return false;
  } catch {
    return false;
  }
  return /^(GET|POST|PUT|PATCH|DELETE)$/i.test(String(method || ""));
}

export function waitForMeaningfulResponse(page, timeoutMs = 8_000) {
  const origin = (() => {
    try {
      return new URL(page.url()).origin;
    } catch {
      return "";
    }
  })();
  return page
    .waitForResponse(
      (response) =>
        isMeaningfulResponseMeta({
          url: response.url(),
          method: response.request().method(),
          resourceType: response.request().resourceType(),
          status: response.status(),
          origin,
        }),
      { timeout: timeoutMs },
    )
    .catch(() => null);
}

async function waitForDomQuiet(page, quietMs, maxWaitMs) {
  return page
    .evaluate(
      ({ quiet, ceiling }) =>
        new Promise((resolve) => {
          let settled = false;
          let quietTimer;
          let ceilingTimer;
          const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(quietTimer);
            clearTimeout(ceilingTimer);
            observer.disconnect();
            resolve(true);
          };
          const schedule = () => {
            clearTimeout(quietTimer);
            quietTimer = setTimeout(finish, quiet);
          };
          const observer = new MutationObserver(schedule);
          observer.observe(document.documentElement, {
            attributes: true,
            childList: true,
            characterData: true,
            subtree: true,
          });
          ceilingTimer = setTimeout(finish, ceiling);
          schedule();
        }),
      { quiet: quietMs, ceiling: maxWaitMs },
    )
    .catch(() => false);
}

/**
 * Wait for evidence that the current page state is presentation-ready.
 * Everything is bounded: analytics, streaming UIs, and persistent spinners can
 * never hold a DemoBro job hostage.
 */
export async function waitForPageReadiness(
  page,
  { networkSignal = null, maxWaitMs = 7_000, quietMs = 450 } = {},
) {
  const startedAt = Date.now();
  const boundedWait = Math.max(1_000, Number(maxWaitMs) || 7_000);

  const earlySignals = [
    page.waitForLoadState("networkidle", { timeout: Math.min(4_000, boundedWait) }).catch(() => null),
    page.waitForTimeout(Math.min(1_600, boundedWait)),
  ];
  if (networkSignal) earlySignals.push(Promise.resolve(networkSignal).catch(() => null));
  await Promise.race(earlySignals);

  await page
    .evaluate(async () => {
      await document.fonts?.ready?.catch?.(() => {});
      const visibleImages = [...document.images]
        .filter((img) => {
          const rect = img.getBoundingClientRect();
          return rect.width > 1 && rect.height > 1 && !img.complete;
        })
        .slice(0, 24);
      await Promise.all(
        visibleImages.map(
          (img) =>
            new Promise((resolve) => {
              const done = () => resolve(true);
              img.addEventListener("load", done, { once: true });
              img.addEventListener("error", done, { once: true });
              setTimeout(done, 1_800);
            }),
        ),
      );
    })
    .catch(() => {});

  await page
    .waitForFunction(
      (selector) => {
        const visible = (el) => {
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          return (
            rect.width > 1 &&
            rect.height > 1 &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            Number(style.opacity || 1) > 0.05
          );
        };
        return ![...document.querySelectorAll(selector)].some(visible);
      },
      BUSY_SELECTOR,
      { timeout: Math.min(2_500, boundedWait) },
    )
    .catch(() => {});

  const remaining = Math.max(500, boundedWait - (Date.now() - startedAt));
  await waitForDomQuiet(page, quietMs, Math.min(3_000, remaining));
  await page.waitForTimeout(180).catch(() => {});

  return { waitedMs: Date.now() - startedAt };
}
