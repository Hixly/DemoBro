/**
 * Shared hardening helpers: timeouts, live-URL probe, user-facing errors.
 */

import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertSafePublicUrl } from "./ssrf.js";

/** Hard ceiling for an entire job (record + render + upload). */
export const JOB_TIMEOUT_MS = Number(
  process.env.DEMOBRO_JOB_TIMEOUT_MS || 8 * 60 * 1000,
);
/** Live URL HTTP probe. */
export const PROBE_TIMEOUT_MS = 12_000;
/** Grok / planning call. */
export const GROK_TIMEOUT_MS = 40_000;
export const GROK_MAX_ATTEMPTS = 3;
/** ffmpeg / render subprocess. */
export const RENDER_TIMEOUT_MS = Number(
  process.env.DEMOBRO_RENDER_TIMEOUT_MS || 4 * 60 * 1000,
);

/**
 * Resolve a scratch dir the worker can actually write to. Container images that
 * drop root can leave the bundled path read-only, which would otherwise fail
 * every single job, so fall back to tmp instead of dying.
 * @param {string} preferred
 * @returns {Promise<string>}
 */
export async function resolveWritableDir(preferred) {
  const candidates = [
    process.env.DEMOBRO_OUTPUT_DIR?.trim(),
    preferred,
    path.join(os.tmpdir(), "demobro-output"),
  ].filter(Boolean);

  for (const dir of candidates) {
    try {
      await mkdir(dir, { recursive: true });
      await access(dir, constants.W_OK);
      return dir;
    } catch (err) {
      console.warn(
        `[worker] output dir ${dir} unusable: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  }
  throw new Error(
    `No writable output directory (tried: ${candidates.join(", ")}).`,
  );
}

/**
 * Reject after `ms` with a clear Error. Clears timer when `promise` settles.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} message
 * @returns {Promise<T>}
 */
export function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Retry an async fn with linear backoff. Only retries retryable failures.
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{ attempts?: number, delayMs?: number, label?: string, isRetryable?: (err: unknown) => boolean }} [opts]
 * @returns {Promise<T>}
 */
export async function withRetry(fn, opts = {}) {
  const attempts = opts.attempts ?? 3;
  const delayMs = opts.delayMs ?? 800;
  const label = opts.label || "operation";
  const isRetryable =
    opts.isRetryable ||
    ((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      return /timeout|timed out|abort|ECONNRESET|ETIMEDOUT|503|502|429|fetch failed/i.test(
        msg,
      );
    });

  let lastErr;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retryable = isRetryable(err);
      console.warn(
        `[retry] ${label} attempt ${i}/${attempts} failed: ${
          err instanceof Error ? err.message : err
        }${retryable && i < attempts ? " — retrying" : ""}`,
      );
      if (!retryable || i >= attempts) break;
      await new Promise((r) => setTimeout(r, delayMs * i));
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(String(lastErr || `${label} failed`));
}

/** Map low-level failures into short, stranger-safe messages. */
export function toUserFacingError(err) {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const msg = raw.replace(/\s+/g, " ").trim();

  if (/couldn.?t reach that url/i.test(msg)) return "Couldn't reach that URL.";
  if (/couldn.?t resolve that hostname/i.test(msg)) {
    return "Couldn't reach that URL.";
  }
  if (/only http|https:\/\/ urls are allowed|doesn.?t look like a valid url/i.test(msg)) {
    return "That doesn’t look like a public website URL.";
  }
  if (/private address|isn.?t publicly reachable|localhost/i.test(msg)) {
    return "That host isn’t publicly reachable.";
  }
  if (
    /ERR_NAME_NOT_RESOLVED|ENOTFOUND|getaddrinfo|ERR_CONNECTION_REFUSED|ECONNREFUSED|ERR_ADDRESS_UNREACHABLE|ERR_CONNECTION_RESET|ERR_NETWORK_CHANGED/i.test(
      msg,
    )
  ) {
    return "Couldn't reach that URL.";
  }
  if (
    /ERR_CONNECTION_TIMED_OUT|ETIMEDOUT|Navigation timeout|Timeout \d+ms exceeded|took too long to respond|Probe timed out/i.test(
      msg,
    )
  ) {
    return "That site took too long to respond.";
  }
  if (/ERR_SSL|ERR_CERT|SSL|certificate/i.test(msg)) {
    return "Couldn't open that site securely.";
  }
  if (/ERR_HTTP_RESPONSE_CODE_FAILURE|net::ERR_ABORTED/i.test(msg)) {
    return "Couldn't load that page.";
  }
  if (/Recording session hit the .* timeout|job timed out|overall job timeout/i.test(msg)) {
    return "This demo took too long and was stopped. Try a simpler page.";
  }
  if (/Grok|x\.ai|page-plan|planning|Empty page-plan/i.test(msg)) {
    return "Planning timed out. Please try again in a moment.";
  }
  if (/XAI_API_KEY/i.test(msg)) {
    return "Demo service isn’t configured right now. Please try again later.";
  }
  if (/ffmpeg|ffprobe/i.test(msg)) {
    return "Video rendering failed. Please try again.";
  }
  if (/browser|playwright|Target closed|Protocol error/i.test(msg)) {
    return "Browsing that site failed. Please try again.";
  }
  if (/empty storyboard/i.test(msg)) {
    return "Nothing to film for that job.";
  }
  // Keep short; never dump stacks / HTML.
  const clipped = msg.slice(0, 180);
  if (clipped.length < 8) return "Something went wrong filming that demo.";
  return clipped;
}

/**
 * Fail-fast: DNS/SSRF + short HTTP probe before Playwright.
 * @param {string} raw
 * @param {{ timeoutMs?: number }} [opts]
 */
export async function probeLiveUrl(raw, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const safe = await assertSafePublicUrl(raw);
  if (!safe.ok) {
    return {
      ok: false,
      error: toUserFacingError(new Error(safe.error)),
    };
  }

  const url = safe.url.toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const tryFetch = async (method) =>
    fetch(url, {
      method,
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "DemoBroProbe/1.0 (+https://demobro.video)",
        Accept: "text/html,application/xhtml+xml,*/*",
      },
    });

  try {
    let res;
    try {
      res = await tryFetch("HEAD");
      // Some hosts reject HEAD — fall through to GET.
      if (res.status === 405 || res.status === 501) {
        res = await tryFetch("GET");
      }
    } catch {
      res = await tryFetch("GET");
    }

    // Redirect target must also be public.
    if (res.url && res.url !== url) {
      const after = await assertSafePublicUrl(res.url);
      if (!after.ok) {
        return {
          ok: false,
          error: toUserFacingError(new Error(after.error)),
        };
      }
    }

    // Hard misses — don't bother filming.
    if (res.status === 404 || res.status === 410) {
      return { ok: false, error: "Couldn't reach that URL." };
    }
    if (res.status >= 500) {
      return {
        ok: false,
        error: "That site isn’t responding right now. Try again later.",
      };
    }

    return { ok: true, url: safe.url, status: res.status };
  } catch (err) {
    const name = err && typeof err === "object" ? err.name : "";
    if (name === "AbortError") {
      return { ok: false, error: "That site took too long to respond." };
    }
    return { ok: false, error: "Couldn't reach that URL." };
  } finally {
    clearTimeout(timer);
  }
}
