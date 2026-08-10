import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderCardPng, W, H } from "./cards.js";
import { RENDER_TIMEOUT_MS } from "./job-utils.js";

/**
 * x264 allocates frame buffers per thread and defaults to ~1.5x the host's core
 * count, which the container sees in full while its memory ceiling is far
 * smaller — at 1080p that gets the encoder OOM-killed mid-render.
 */
const X264_THREADS = process.env.DEMOBRO_FFMPEG_THREADS || "1";

const TITLE_SECS = 2.8;
const OUTRO_SECS = 3.0;
const XFADE = 0.55;
/** Soft ceiling — never pad/slow to fill; only speed up if over. */
const MAX_SECS = 30;
const FADE_IN = 0.55;
const FADE_OUT = 0.4;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOGO_CANDIDATES = [
  path.resolve(__dirname, "../assets/demobro-logo.jpg"),
  path.resolve(__dirname, "../../public/brand/demobro-logo.jpg"),
];
const CLICK_RING_PNG = path.resolve(__dirname, "../assets/click-ring.png");
const CURSOR_PNG = path.resolve(__dirname, "../assets/cursor.png");
const SFX_CLICK = path.resolve(__dirname, "../assets/sfx/click.wav");
const SFX_WHOOSH = path.resolve(__dirname, "../assets/sfx/whoosh.wav");
/** Caption pill fade in/out (seconds). */
const CAPTION_FADE = 0.2;

/**
 * ffmpeg's filter graph and encoder both allocate full frame buffers per
 * thread, sized from the host's core count rather than the container's much
 * smaller memory ceiling. At 1080p that is enough to get killed mid-render, so
 * cap the pools globally.
 */
const FFMPEG_THREAD_LIMITS = [
  "-filter_threads",
  "1",
  "-filter_complex_threads",
  "1",
];

function run(cmd, args, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs ?? RENDER_TIMEOUT_MS);
  if (cmd === "ffmpeg" && !args.includes("-filter_threads")) {
    args = [...FFMPEG_THREAD_LIMITS, ...args];
  }
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...opts,
    });
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
      reject(new Error(`${cmd} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(stderr);
      // A null code means the kernel signalled us (SIGKILL is almost always OOM).
      else if (signal) reject(new Error(`${cmd} killed by ${signal}: ${stderr.slice(-400)}`));
      else reject(new Error(`${cmd} failed (${code}): ${stderr.slice(-800)}`));
    });
  });
}

function ffprobe(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffprobe", args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`ffprobe failed: ${stderr}`));
    });
  });
}

async function probeDuration(file) {
  const out = await ffprobe([
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  const n = Number(out);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Bad duration for ${file}`);
  return n;
}

/** Parse ffprobe avg_frame_rate like "25/1" → 25. */
async function probeFps(file) {
  const out = await ffprobe([
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=avg_frame_rate,r_frame_rate",
    "-of",
    "default=noprint_wrappers=1",
    file,
  ]);
  const avg = out.match(/avg_frame_rate=([0-9]+)\/([0-9]+)/);
  const r = out.match(/r_frame_rate=([0-9]+)\/([0-9]+)/);
  const pick = avg ?? r;
  if (!pick) return null;
  const den = Number(pick[2]);
  if (!den) return null;
  const fps = Number(pick[1]) / den;
  return Number.isFinite(fps) && fps > 0 ? fps : null;
}

/**
 * Build kept segments from step timeline (ms from recording start).
 * One window per succeeded step. Trim dead waits; keep natural length
 * — never pad short actions to fill time.
 * Carries capture meta (box / actionPoint / stepKind / description) for polish.
 */
export function planSegments(timeline, totalDurationSec) {
  const steps = (timeline?.steps ?? []).filter((s) => s.status === "succeeded");
  if (!steps.length) {
    const end = Math.min(totalDurationSec, 22);
    const start = Math.max(0, end - 18);
    return [
      {
        start,
        end,
        box: null,
        actionPoint: null,
        contentBounds: null,
        stepKind: "pause",
        description: "",
        caption: "",
      },
    ];
  }

  const segments = [];
  for (const step of steps) {
    // Keep a little lead-in / trail so each beat can breathe (~5s windows).
    let start = Math.max(0, ((step.startMs ?? 0) - 250) / 1000);
    let end = Math.min(totalDurationSec, ((step.endMs ?? 0) + 800) / 1000);
    const dur = end - start;
    if (dur < 0.35) continue;

    // Only trim very long waits — keep up to ~5s of a good window.
    if (dur > 6.5) {
      start = Math.max(start, end - 5);
    }

    const prev = segments[segments.length - 1];
    if (prev && start < prev.end) {
      start = prev.end;
      if (end - start < 0.5) continue;
    }
    const contentBounds = normalizeContentBounds(step.contentBounds ?? null);
    const cleaned = sanitizeTarget(
      step.box ?? null,
      step.actionPoint ?? null,
      contentBounds,
    );
    segments.push({
      start,
      end,
      box: cleaned.box,
      actionPoint: cleaned.actionPoint,
      contentBounds,
      stepKind: step.stepKind ?? "pause",
      description: step.description ?? "",
      caption: step.caption ?? "",
    });
  }

  // If individual steps lack contentBounds, estimate a page content column
  // from the union of all target boxes (helps older timelines).
  const estimated = estimateContentFromBoxes(
    segments.map((s) => s.box).filter(Boolean),
  );
  if (estimated) {
    for (const seg of segments) {
      if (!seg.contentBounds) seg.contentBounds = estimated;
    }
  }

  return segments.length
    ? segments
    : [
        {
          start: 0,
          end: Math.min(totalDurationSec, 20),
          box: null,
          actionPoint: null,
          contentBounds: null,
          stepKind: "pause",
          description: "",
          caption: "",
        },
      ];
}

const ZOOM_EASE_SEC = 0.28;
/**
 * Web pages run edge to edge, so a hard punch-in slices navs and side rails
 * mid-word and the shot stops reading as a real product page. Landing beats
 * therefore stay essentially full-frame and actions punch only enough to draw
 * the eye to the target.
 */
const ZOOM_MAX = 1.1;
const PAUSE_ZOOM_MAX = 1.05;
const ACTION_ZOOM_MAX = 1.1;
/**
 * Landing beats still need to breathe. The zoom eases from and back to 1.0, so
 * a small peak reads as a gentle settle and the beat opens and closes on the
 * uncropped page.
 */
const PAUSE_ZOOM_MIN = 1.03;
/** Breathing room kept around an action target, in source pixels. */
const ZOOM_PAD_PX = 180;
const SPOTLIGHT_PAD = 48;

function normalizeContentBounds(raw) {
  if (
    !raw ||
    !Number.isFinite(raw.x) ||
    !Number.isFinite(raw.y) ||
    !Number.isFinite(raw.w) ||
    !Number.isFinite(raw.h) ||
    raw.w < 32 ||
    raw.h < 32
  ) {
    return null;
  }
  const x = Math.max(0, Math.min(W - 8, raw.x));
  const y = Math.max(0, Math.min(H - 8, raw.y));
  const w = Math.max(32, Math.min(W - x, raw.w));
  const h = Math.max(32, Math.min(H - y, raw.h));
  return { x, y, w, h };
}

/** Union of target boxes → rough content column when DOM bounds are missing. */
function estimateContentFromBoxes(boxes) {
  if (!boxes?.length) return null;
  let minX = W;
  let minY = H;
  let maxX = 0;
  let maxY = 0;
  let n = 0;
  for (const b of boxes) {
    if (!b || b.w < 8 || b.h < 8) continue;
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
    n += 1;
  }
  if (n < 1) return null;
  return normalizeContentBounds({
    x: minX,
    y: minY,
    w: maxX - minX,
    h: maxY - minY,
  });
}

/** Null out near-full-frame boxes; expand tiny labels into a readable card window. */
function sanitizeTarget(box, actionPoint, contentBounds = null) {
  if (
    !box ||
    !Number.isFinite(box.w) ||
    !Number.isFinite(box.h) ||
    box.w < 1 ||
    box.h < 1
  ) {
    return { box: null, actionPoint: null };
  }
  if (box.w >= W * 0.9 && box.h >= H * 0.9) {
    console.log(
      `[render] soft-fail full-frame box ${Math.round(box.w)}x${Math.round(box.h)}`,
    );
    return { box: null, actionPoint: null };
  }

  let b = { ...box };
  const ap = actionPoint
    ? { ...actionPoint }
    : { x: b.x + b.w / 2, y: b.y + b.h / 2 };

  // Tiny labels / icon buttons → expand into a readable result-card window.
  // Prefer content-column center so we don't bias into empty gutters.
  if (b.w < 140 || b.h < 40) {
    const targetW = Math.min(W, Math.max(b.w, 720));
    const targetH = Math.min(H, Math.max(b.h, 380));
    const contentCx = contentBounds
      ? contentBounds.x + contentBounds.w / 2
      : W / 2;
    const contentCy = contentBounds
      ? contentBounds.y + contentBounds.h / 2
      : H / 2;
    // Keep the tiny control inside the expanded window, but pull toward content.
    const cx = ap.x * 0.55 + contentCx * 0.45;
    const cy = ap.y * 0.55 + contentCy * 0.45;
    b = {
      x: Math.max(0, Math.min(W - targetW, cx - targetW / 2)),
      y: Math.max(0, Math.min(H - targetH, cy - targetH / 2)),
      w: targetW,
      h: targetH,
    };
    console.log(
      `[render] expand tiny box → ${Math.round(b.w)}x${Math.round(b.h)} @ (${Math.round(b.x)},${Math.round(b.y)})`,
    );
  }

  return { box: b, actionPoint: ap };
}

/**
 * Wide bottom chrome (Generate CTAs, color name bars, sheets). Aggressive
 * zoom here crops the product and parks the camera on footers.
 */
function isWideBottomCta(box) {
  return (
    !!box &&
    box.w >= W * 0.32 &&
    box.h <= 160 &&
    box.y + box.h / 2 > H * 0.58
  );
}

/** Keep title-card blurb to ~2 lines; prefer word boundary (no mid-sentence cut). */
function clampTitleDescription(text, maxLen = 110) {
  const s = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length <= maxLen) return s;
  const cut = s.slice(0, maxLen);
  const sp = cut.lastIndexOf(" ");
  const base = (sp > 40 ? cut.slice(0, sp) : cut).replace(/[,:;–—-]\s*$/, "");
  return `${base}…`;
}

/**
 * Shorten storyboard prose into one short caption phrase (~8 words / 48 chars).
 */
export function shortenCaption(description) {
  let s = String(description ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.$/, "");
  if (!s) return "";

  // Product-action captions that otherwise read as stage directions.
  if (/\b(pause\s+and\s+tap|tap\s+to\s+sample|sample\s+(a\s+)?color)\b/i.test(s)) {
    return "Sample a color";
  }
  if (/\b(view\s+color\s+details|color\s+details)\b/i.test(s)) {
    return "View color details";
  }
  if (/^(pause\s+on\s+hero|land\s+on\s+hero|hero\s+pause)/i.test(s)) {
    return "Land on hero";
  }

  const visit = s.match(/^(visit|open|go to|navigate to)\s+(?:the\s+)?(.+)/i);
  if (visit) {
    const rest = visit[2].split(/\s+/).slice(0, 5).join(" ");
    s = `Visit ${rest}`;
  } else if (/^(type|enter|fill|write)\s+/i.test(s)) {
    const rest = s
      .replace(/^(type|enter|fill|write)\s+(a\s+|the\s+|your\s+)?/i, "")
      .replace(/\s+into the .+$/i, "")
      .replace(/\s+in the .+$/i, "")
      .split(/\s+/)
      .slice(0, 6)
      .join(" ");
    s = `Type ${rest}`;
  } else if (/^(click|tap|press|select)\s+/i.test(s)) {
    s = s
      .replace(/^(click|tap|press|select)\s+(to\s+)?/i, "")
      .split(/\s+/)
      .slice(0, 6)
      .join(" ");
  } else {
    s = s.split(/\s+/).slice(0, 8).join(" ");
  }

  if (s.length > 48) s = `${s.slice(0, 45).trim()}…`;
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}

/**
 * Choose zoom peak + crop center so the shot frames CONTENT, not empty margins.
 * - Narrow / left-aligned pages: zoom+pan so the content column fills a balanced frame.
 * - Punch-ins: keep the target comfortably in view, but bias toward content CoM
 *   and clamp so we never slam into a one-sided dead edge.
 */
function computeFramedZoom(box, contentBounds, stepKind = "pause") {
  const content =
    normalizeContentBounds(contentBounds) || { x: 0, y: 0, w: W, h: H };

  const isAction = stepKind === "click" || stepKind === "type";
  const kindCeiling = isAction ? ACTION_ZOOM_MAX : PAUSE_ZOOM_MAX;

  // safeZoom is a CEILING: only crop into margins we can prove are empty.
  // Using it as a floor (the old bug) let action beats punch to 1.2x even when
  // that sliced off the logo while keeping the right-side nav — looking like
  // the whole page had been shoved sideways.
  const slackX = Math.max(0, Math.min(content.x, W - (content.x + content.w)));
  const slackY = Math.max(0, Math.min(content.y, H - (content.y + content.h)));
  const safeZoom = Math.max(
    1,
    Math.min(W / Math.max(W - 2 * slackX, 1), H / Math.max(H - 2 * slackY, 1)),
  );
  const ceiling = Math.min(kindCeiling, safeZoom);

  let zoomPeak = isAction ? 1 : PAUSE_ZOOM_MIN;
  if (isAction && box && Number.isFinite(box.x) && box.w > 0 && box.h > 0) {
    // Gentle enough that the target reads; never enough to fill the frame.
    const need = Math.min(
      W / Math.max(box.w + ZOOM_PAD_PX * 2, 1),
      H / Math.max(box.h + ZOOM_PAD_PX * 2, 1),
    );
    if (Number.isFinite(need) && need > 1) {
      zoomPeak = Math.min(ceiling, Math.max(1, need));
    }
  }
  zoomPeak = Math.min(ceiling, Math.max(zoomPeak, isAction ? 1 : PAUSE_ZOOM_MIN));

  // Always anchor to the page centre. Side-pulling the crop is what made
  // balanced sites look off-centre once header chrome was in frame.
  const cx = W / 2;
  let cy = H / 2;
  if (isAction && box && box.w > 0 && box.h > 0) {
    // Vertical only — keep the action in view without shifting sideways.
    cy = box.y + box.h / 2;
  }

  const placed = placeZoomCenter({ cx, cy, zoom: zoomPeak, box });
  return {
    zoomPeak: placed.zoom,
    cx: placed.cx,
    cy: placed.cy,
    content,
  };
}

/**
 * Clamp crop center so:
 * 1) crop stays inside the frame
 * 2) target (if any) stays inside the crop with padding
 * 3) when content fits in the crop, we center on content (no one-sided dead margin)
 */
function placeZoomCenter({ cx, cy, zoom, box }) {
  const z = Math.max(1, Math.min(ZOOM_MAX, zoom));
  const winW = W / z;
  const winH = H / z;

  const clampToFrame = (x, y) => ({
    x: Math.max(winW / 2, Math.min(W - winW / 2, x)),
    y: Math.max(winH / 2, Math.min(H - winH / 2, y)),
  });

  // Guarantee the target stays inside the crop with breathing room, nudging the
  // centre the minimum amount needed rather than recentring on the target.
  if (box && box.w > 0 && box.h > 0) {
    const pad = 64;
    if (box.w + pad * 2 <= winW) {
      const lo = box.x + box.w + pad - winW / 2;
      const hi = box.x - pad + winW / 2;
      if (lo <= hi) cx = Math.max(lo, Math.min(hi, cx));
    } else {
      cx = box.x + box.w / 2;
    }
    if (box.h + pad * 2 <= winH) {
      const lo = box.y + box.h + pad - winH / 2;
      const hi = box.y - pad + winH / 2;
      if (lo <= hi) cy = Math.max(lo, Math.min(hi, cy));
    } else {
      cy = box.y + box.h / 2;
    }
  }

  const placed = clampToFrame(cx, cy);
  return { zoom: z, cx: placed.x, cy: placed.y };
}

/**
 * Zoom with smoothstep ease in/out (~0.45s), hold, clamped crop.
 * Frames around content bounds; punch-ins stay balanced.
 */
function buildZoomFilter(box, outDur, contentBounds = null, stepKind = "pause") {
  const fps = 30;
  const total = Math.max(2, Math.round(outDur * fps));
  const easeN = Math.max(
    3,
    Math.round(Math.min(ZOOM_EASE_SEC, Math.max(0.2, outDur / 4)) * fps),
  );
  const holdEnd = Math.max(easeN, total - easeN);

  const framed = computeFramedZoom(box, contentBounds, stepKind);
  const { zoomPeak, cx, cy, content } = framed;

  console.log(
    `[render] zoom peak=${zoomPeak.toFixed(2)}x kind=${stepKind} center=(${cx.toFixed(0)},${cy.toFixed(0)})` +
      (box ? ` box=${Math.round(box.w)}x${Math.round(box.h)}` : " box=null") +
      ` content=${Math.round(content.w)}x${Math.round(content.h)}@(${Math.round(content.x)},${Math.round(content.y)})`,
  );

  const dz = (zoomPeak - 1).toFixed(4);
  const zPeak = zoomPeak.toFixed(4);
  // smoothstep(p) = p*p*(3-2*p); p = on/easeN (and reverse on ease-out)
  const easeIn =
    `1+${dz}*((on/${easeN})*(on/${easeN})*(3-2*(on/${easeN})))`;
  const pOut = `((on-${holdEnd})/${easeN})`;
  const easeOut =
    `${zPeak}-${dz}*(${pOut}*${pOut}*(3-2*${pOut}))`;
  const zExpr =
    `if(lte(on\\,${easeN})\\,${easeIn}\\,` +
    `if(lte(on\\,${holdEnd})\\,${zPeak}\\,${easeOut}))`;
  // Symmetric clamp — crop origin stays in-frame on both sides equally.
  const xExpr = `max(0\\,min(iw-iw/zoom\\,${cx.toFixed(2)}-iw/zoom/2))`;
  const yExpr = `max(0\\,min(ih-ih/zoom\\,${cy.toFixed(2)}-ih/zoom/2))`;

  return `zoompan=z='${zExpr}':x='${xExpr}':y='${yExpr}':d=1:s=${W}x${H}:fps=${fps}`;
}

/**
 * Dim outside the target — only during ease-in / pre-action so DOM changes
 * after a click (loading, scroll) don't leave a stuck spotlight hole.
 */
function buildSpotlightFilter(box, untilSec = 0.65) {
  if (!box || box.w < 8 || box.h < 8) return "";
  const x0 = Math.max(0, Math.floor(box.x - SPOTLIGHT_PAD));
  const y0 = Math.max(0, Math.floor(box.y - SPOTLIGHT_PAD));
  const x1 = Math.min(W, Math.ceil(box.x + box.w + SPOTLIGHT_PAD));
  const y1 = Math.min(H, Math.ceil(box.y + box.h + SPOTLIGHT_PAD));
  if (x1 <= x0 || y1 <= y0) return "";
  const dim = "black@0.14";
  const en = `enable='lte(t\\,${untilSec.toFixed(3)})'`;
  const parts = [];
  if (y0 > 0) {
    parts.push(`drawbox=x=0:y=0:w=${W}:h=${y0}:color=${dim}:t=fill:${en}`);
  }
  if (y1 < H) {
    parts.push(`drawbox=x=0:y=${y1}:w=${W}:h=${H - y1}:color=${dim}:t=fill:${en}`);
  }
  const midH = y1 - y0;
  if (x0 > 0) {
    parts.push(`drawbox=x=0:y=${y0}:w=${x0}:h=${midH}:color=${dim}:t=fill:${en}`);
  }
  if (x1 < W) {
    parts.push(
      `drawbox=x=${x1}:y=${y0}:w=${W - x1}:h=${midH}:color=${dim}:t=fill:${en}`,
    );
  }
  console.log(
    `[render] spotlight hole=${x0},${y0}→${x1},${y1} until=${untilSec.toFixed(2)}s`,
  );
  return parts.join(",");
}

/**
 * Soft post-zoom vignette — very light; heavy vignette reads as blur/ghosting.
 */
function buildVignetteFilter(_box) {
  // Disabled — vignette + zoompan read as muddy blur on screen demos.
  return "";
}

/**
 * Pulse timing/position for click|type steps.
 */
function clickPulsePlan(seg, outDur) {
  const kind = seg.stepKind;
  if (kind !== "click" && kind !== "type") return null;
  // "Read the draft" is a look-beat — don't fake-click a subject label.
  if (/^read\b|see the draft/i.test(String(seg.description ?? ""))) return null;
  const pt = seg.actionPoint;
  if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return null;
  let ax = Math.max(0, Math.min(W - 1, Math.round(pt.x)));
  let ay = Math.max(0, Math.min(H - 1, Math.round(pt.y)));
  let t0 = Math.min(0.55, Math.max(0.25, outDur * 0.22));
  let t1 = Math.min(outDur - 0.05, t0 + 0.55);
  // Generate-style CTAs: film jumps to loading instantly — captured Y lands on
  // Coming Soon. Aim the ring at the mid-form CTA band under our form zoom.
  if (isWideBottomCta(seg.box)) {
    ax = Math.round(W / 2);
    ay = Math.round(H * 0.58);
    t0 = 0.18;
    t1 = Math.min(outDur - 0.05, 0.62);
  }
  if (t1 <= t0) return null;
  return { kind, ax, ay, t0, t1 };
}

/**
 * Prefer viewer-facing `caption` from the planner; fall back to shortened
 * description only when caption is missing.
 */
function captionCopyForSeg(seg) {
  const viewer = String(seg.caption ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?…,:;]+$/g, "");
  if (
    viewer &&
    !/^(click|tap|visit|land|scroll|select|open)\b/i.test(viewer) &&
    !/[#.\[\]=]|:has-text|href=/i.test(viewer)
  ) {
    const words = viewer.split(/\s+/).slice(0, 6).join(" ");
    return words.charAt(0).toUpperCase() + words.slice(1);
  }

  const raw = seg.description || "";
  const short = shortenCaption(raw);
  if (!short) return "";
  // Analyze / similar with no box → don't pretend we clicked a missing control.
  if (!seg.box && /analy[sz]e/i.test(raw)) return "See the draft";
  if (!seg.box && seg.stepKind === "click" && /analy|subject/i.test(raw)) {
    return "See the draft";
  }
  return short;
}

/**
 * Render one lower-third caption PNG (full phrase, dark pill) via cards.js.
 */
async function prepareCaptionPng(seg, outPath) {
  const short = captionCopyForSeg(seg);
  if (!short) return null;
  // A fixed lower third lands straight on the primary CTA of any page whose
  // action sits low, hiding the thing the beat exists to show. Put the caption
  // on the opposite side of the frame from the target.
  const box = seg.box;
  const targetLow = box && box.y + box.h / 2 > H * 0.58;
  const position = targetLow ? "top" : "bottom";
  await renderCardPng(outPath, "caption", { text: short, position }, null);
  console.log(`[render] caption="${short}" ${position} third png`);
  return short;
}

/**
 * Fade caption PNG alpha in/out, then overlay at 0:0 (bar already positioned).
 * Returns filter_complex fragment ending at `outLabel` (e.g. `[vout]`).
 */
function captionOverlayGraph(zoomedLabel, captionInputIdx, outDur, outLabel) {
  const fade = CAPTION_FADE;
  const fadeOutStart = Math.max(fade + 0.12, outDur - fade - 0.05);
  return (
    `[${captionInputIdx}:v]format=rgba,` +
    `fade=t=in:st=0:d=${fade.toFixed(3)}:alpha=1,` +
    `fade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fade.toFixed(3)}:alpha=1[cap];` +
    `${zoomedLabel}[cap]overlay=0:0:format=auto` +
    outLabel
  );
}

async function pngToFadedClip(pngPath, outPath, durationSec) {
  const fadeOutStart = Math.max(0, durationSec - FADE_OUT);
  await run("ffmpeg", [
    "-y",
    "-loop",
    "1",
    "-i",
    pngPath,
    "-t",
    durationSec.toFixed(3),
    "-vf",
    `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0xFAF9F6,fade=t=in:st=0:d=${FADE_IN},fade=t=out:st=${fadeOutStart.toFixed(3)}:d=${FADE_OUT},format=yuv420p`,
    "-r",
    "30",
    "-c:v",
    "libx264",
    "-threads",
    X264_THREADS,
    "-pix_fmt",
    "yuv420p",
    outPath,
  ]);
}

/**
 * Build segment SFX: soft whoosh on zoom-in + click at action pulse.
 */
async function buildSegmentAudio(wavPath, outDur, pulse) {
  const whooshDelay = 60; // ms — with ease-in
  const clickDelay = pulse ? Math.round(pulse.t0 * 1000) : -1;
  const inputs = ["-y", "-f", "lavfi", "-i", `anullsrc=r=44100:cl=stereo`, "-t", outDur.toFixed(3)];
  const labels = ["[0:a]"];
  let n = 1;
  try {
    await access(SFX_WHOOSH);
    inputs.push("-i", SFX_WHOOSH);
    labels.push(`[${n}:a]adelay=${whooshDelay}|${whooshDelay},volume=3.2[w]`);
    n += 1;
  } catch {
    /* optional */
  }
  if (clickDelay >= 0) {
    try {
      await access(SFX_CLICK);
      inputs.push("-i", SFX_CLICK);
      labels.push(`[${n}:a]adelay=${clickDelay}|${clickDelay},volume=3.8[c]`);
      n += 1;
    } catch {
      /* optional */
    }
  }
  const mixIns = ["[0:a]"];
  if (labels.some((l) => l.includes("[w]"))) mixIns.push("[w]");
  if (labels.some((l) => l.includes("[c]"))) mixIns.push("[c]");
  const filterParts = labels.slice(1);
  // Louden + soft limiter so SFX read on laptop speakers without clipping hard.
  filterParts.push(
    `${mixIns.join("")}amix=inputs=${mixIns.length}:duration=first:dropout_transition=0:normalize=0,` +
      `volume=2.0,alimiter=limit=0.89:attack=5:release=50[aout]`,
  );
  await run("ffmpeg", [
    ...inputs,
    "-filter_complex",
    filterParts.join(";"),
    "-map",
    "[aout]",
    "-t",
    outDur.toFixed(3),
    wavPath,
  ]);
}

async function muxVideoAudio(videoPath, audioPath, outPath, outDur) {
  await run("ffmpeg", [
    "-y",
    "-i",
    videoPath,
    "-i",
    audioPath,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-shortest",
    "-t",
    outDur.toFixed(3),
    outPath,
  ]);
}

/**
 * Extract a footage window: spotlight → cursor → click ring → eased zoom →
 * vignette → caption PNG overlay → fades. Plain fps=30 CFR. Muxes soft SFX.
 */
async function extractSegment(rawPath, seg, outPath, speed = 1) {
  const dur = Math.max(0.2, seg.end - seg.start);
  const outDur = dur / speed;
  const fadeOutStart = Math.max(0, outDur - 0.25);
  const outDurS = outDur.toFixed(3);
  const zoom = buildZoomFilter(
    seg.box ?? null,
    outDur,
    seg.contentBounds ?? null,
    seg.stepKind ?? "pause",
  );
  const pulse = clickPulsePlan(seg, outDur);
  // Spotlight only through ease-in / just past the action — never for the whole beat.
  // Skip on wide bottom CTAs: post-click layout shift parks the hole on footer junk.
  const spotUntil = pulse
    ? Math.min(pulse.t0 + 0.12, 0.7)
    : Math.min(0.55, outDur * 0.28);
  const spotlight = isWideBottomCta(seg.box)
    ? ""
    : buildSpotlightFilter(seg.box ?? null, spotUntil);
  const vignette = buildVignetteFilter(seg.box ?? null);

  const tmpDir = path.dirname(outPath);
  const stem = path.basename(outPath, ".mp4");
  const videoOnly = path.join(tmpDir, `${stem}-v.mp4`);
  const audioWav = path.join(tmpDir, `${stem}-a.wav`);
  const captionPng = path.join(tmpDir, `${stem}-caption.png`);
  const captionText = await prepareCaptionPng(seg, captionPng);
  const hasCaption = Boolean(captionText);

  const pre = [
    `scale=${W}:${H}:force_original_aspect_ratio=decrease`,
    `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2`,
    `setpts=PTS/${speed}`,
    "fps=30",
    spotlight,
  ].filter(Boolean);
  const zoomChain = [zoom, vignette].filter(Boolean).join(",");
  const endFades =
    `fade=t=in:st=0:d=0.25,fade=t=out:st=${fadeOutStart.toFixed(3)}:d=0.25,format=yuv420p`;

  if (!pulse && !hasCaption) {
    await run("ffmpeg", [
      "-y",
      "-ss",
      seg.start.toFixed(3),
      "-i",
      rawPath,
      "-t",
      dur.toFixed(3),
      "-vf",
      [...pre, zoomChain, endFades].filter(Boolean).join(","),
      "-an",
      "-c:v",
      "libx264",
      "-threads",
      X264_THREADS,
      "-pix_fmt",
      "yuv420p",
      "-r",
      "30",
      "-fps_mode",
      "cfr",
      videoOnly,
    ]);
  } else if (!pulse && hasCaption) {
    const filter =
      `[0:v]${[...pre, zoomChain].filter(Boolean).join(",")}[zoomed];` +
      captionOverlayGraph("[zoomed]", 1, outDur, `[capped];`) +
      `[capped]${endFades},trim=duration=${outDurS},setpts=PTS-STARTPTS[vout]`;
    await run("ffmpeg", [
      "-y",
      "-ss",
      seg.start.toFixed(3),
      "-i",
      rawPath,
      "-t",
      dur.toFixed(3),
      "-loop",
      "1",
      "-t",
      outDurS,
      "-i",
      captionPng,
      "-filter_complex",
      filter,
      "-map",
      "[vout]",
      "-an",
      "-c:v",
      "libx264",
      "-threads",
      X264_THREADS,
      "-pix_fmt",
      "yuv420p",
      "-r",
      "30",
      "-fps_mode",
      "cfr",
      "-t",
      outDurS,
      videoOnly,
    ]);
  } else {
    console.log(
      `[render] click pulse kind=${pulse.kind} at=(${pulse.ax},${pulse.ay}) t=${pulse.t0.toFixed(2)}-${pulse.t1.toFixed(2)}s`,
    );
    const t0 = pulse.t0.toFixed(3);
    const t1 = pulse.t1.toFixed(3);
    // Cursor eases toward the action, then click ring pulses.
    // Tip of the arrow asset sits near (4,4) in a 64px source → ~2px at 36px.
    const curSize = 36;
    const tipX = 2;
    const tipY = 2;
    const x0 = Math.max(0, pulse.ax - 140);
    const y0 = Math.max(0, pulse.ay - 100);
    const moveT = Math.min(0.45, pulse.t0);
    const captionIdx = 3;
    let filter =
      `[0:v]${pre.join(",")}[base];` +
      `[1:v]format=rgba,scale=${curSize}:${curSize}[cur];` +
      `[base][cur]overlay=` +
      `x='${x0}+(${pulse.ax - tipX - x0})*min(1\\,t/${moveT.toFixed(3)})':` +
      `y='${y0}+(${pulse.ay - tipY - y0})*min(1\\,t/${moveT.toFixed(3)})':` +
      `enable='lte(t\\,${t1})':format=auto[aimed];` +
      `[2:v]format=rgba,` +
      `scale=w='max(32\\,trunc((48+220*(t-${t0}))/2)*2)':` +
      `h='max(32\\,trunc((48+220*(t-${t0}))/2)*2)':eval=frame[ring];` +
      `[aimed][ring]overlay=` +
      `x='${pulse.ax}-w/2':y='${pulse.ay}-h/2':` +
      `enable='between(t\\,${t0}\\,${t1})':format=auto[marked];` +
      `[marked]${zoomChain}[zoomed];`;
    if (hasCaption) {
      filter +=
        captionOverlayGraph("[zoomed]", captionIdx, outDur, `[capped];`) +
        `[capped]${endFades},trim=duration=${outDurS},setpts=PTS-STARTPTS[vout]`;
    } else {
      filter += `[zoomed]${endFades},trim=duration=${outDurS},setpts=PTS-STARTPTS[vout]`;
    }

    const args = [
      "-y",
      "-ss",
      seg.start.toFixed(3),
      "-i",
      rawPath,
      "-t",
      dur.toFixed(3),
      "-loop",
      "1",
      "-t",
      outDurS,
      "-i",
      CURSOR_PNG,
      "-loop",
      "1",
      "-t",
      outDurS,
      "-i",
      CLICK_RING_PNG,
    ];
    if (hasCaption) {
      args.push("-loop", "1", "-t", outDurS, "-i", captionPng);
    }
    args.push(
      "-filter_complex",
      filter,
      "-map",
      "[vout]",
      "-an",
      "-c:v",
      "libx264",
      "-threads",
      X264_THREADS,
      "-pix_fmt",
      "yuv420p",
      "-r",
      "30",
      "-fps_mode",
      "cfr",
      "-t",
      outDurS,
      videoOnly,
    );
    await run("ffmpeg", args);
  }

  await buildSegmentAudio(audioWav, outDur, pulse);
  await muxVideoAudio(videoOnly, audioWav, outPath, outDur);
}

async function probeHasAudio(file) {
  try {
    const out = await ffprobe([
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "stream=codec_type",
      "-of",
      "csv=p=0",
      file,
    ]);
    return out.includes("audio");
  } catch {
    return false;
  }
}

/** Ensure clip has a silent stereo track (title/outro cards). */
async function ensureSilentAudio(inPath, outPath, durationSec) {
  await run("ffmpeg", [
    "-y",
    "-i",
    inPath,
    "-f",
    "lavfi",
    "-i",
    `anullsrc=r=44100:cl=stereo`,
    "-t",
    durationSec.toFixed(3),
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-shortest",
    outPath,
  ]);
}

/** Hard-cut concat (best between differently-zoomed body beats — no ghosting). */
async function concatCuts(inputs, outPath) {
  if (inputs.length === 1) {
    await run("ffmpeg", ["-y", "-i", inputs[0], "-c", "copy", outPath]);
    return;
  }
  const listPath = `${outPath}.txt`;
  const body = inputs
    .map((f) => `file '${f.replace(/\\/g, "/")}'`)
    .join("\n");
  await writeFile(listPath, body);
  const hasAudio = await probeHasAudio(inputs[0]);
  await run("ffmpeg", [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-c:v",
    "libx264",
    "-threads",
    X264_THREADS,
    "-pix_fmt",
    "yuv420p",
    "-r",
    "30",
    "-fps_mode",
    "cfr",
    ...(hasAudio ? ["-c:a", "aac", "-b:a", "128k"] : ["-an"]),
    "-movflags",
    "+faststart",
    outPath,
  ]);
}

/**
 * Soft xfade — use for title↔body↔outro only.
 * Body beats should use concatCuts to avoid zoom/caption ghosting.
 */
async function concatWithXfade(inputs, outPath, fadeSec = XFADE) {
  if (inputs.length === 1) {
    await run("ffmpeg", ["-y", "-i", inputs[0], "-c", "copy", outPath]);
    return;
  }

  const durations = [];
  for (const file of inputs) {
    durations.push(await probeDuration(file));
  }

  const withAudio = [];
  for (const file of inputs) {
    withAudio.push(await probeHasAudio(file));
  }
  const allAudio = withAudio.every(Boolean);

  let filter = "";
  let lastV = "[0:v]";
  let lastA = "[0:a]";
  let offset = Math.max(0, durations[0] - fadeSec);
  for (let i = 1; i < inputs.length; i += 1) {
    const vOut = i === inputs.length - 1 ? "[vout]" : `[v${i}]`;
    filter += `${lastV}[${i}:v]xfade=transition=fade:duration=${fadeSec}:offset=${offset.toFixed(3)}${vOut};`;
    lastV = vOut;
    if (allAudio) {
      const aOut = i === inputs.length - 1 ? "[aout]" : `[a${i}]`;
      filter += `${lastA}[${i}:a]acrossfade=d=${fadeSec}:c1=tri:c2=tri${aOut};`;
      lastA = aOut;
    }
    offset += Math.max(0.1, durations[i] - fadeSec);
  }
  filter = filter.replace(/;$/, "");

  const args = ["-y"];
  for (const file of inputs) {
    args.push("-i", file);
  }
  args.push("-filter_complex", filter, "-map", "[vout]");
  if (allAudio) {
    args.push("-map", "[aout]", "-c:a", "aac", "-b:a", "128k");
  } else {
    args.push("-an");
  }
  args.push(
    "-c:v",
    "libx264",
    "-threads",
    X264_THREADS,
    "-pix_fmt",
    "yuv420p",
    "-r",
    "30",
    "-fps_mode",
    "cfr",
    "-movflags",
    "+faststart",
    outPath,
  );
  await run("ffmpeg", args);
}

async function resolveLogoPath(explicit) {
  const candidates = [
    explicit,
    process.env.DEMOBRO_LOGO,
    ...LOGO_CANDIDATES,
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // try next
    }
  }
  throw new Error(
    `DemoBro logo not found. Expected ${LOGO_CANDIDATES[0]}`,
  );
}

/**
 * @param {{
 *   rawVideoPath: string,
 *   timeline: { steps: Array<{ status: string, startMs: number, endMs: number }> },
 *   title: string,
 *   description: string,
 *   badges: string[],
 *   liveUrl?: string,
 *   repoUrl: string,
 *   outputPath: string,
 *   logoPath?: string,
 * }} opts
 */
export async function renderDemo(opts) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "demobro-render-"));
  try {
    const logoPath = await resolveLogoPath(opts.logoPath);
    const total = await probeDuration(opts.rawVideoPath);
    const sourceFps = (await probeFps(opts.rawVideoPath)) ?? 25;
    const segments = planSegments(opts.timeline, total);

    const contentSecs = segments.reduce((acc, s) => acc + (s.end - s.start), 0);
    const cards = TITLE_SECS + OUTRO_SECS;
    // Only title→body still xfades; body beats + outro are hard cuts.
    const xfadeLoss = XFADE;
    const projected = contentSecs + cards - xfadeLoss;
    let speed = 1;
    if (projected > MAX_SECS) {
      const budget = Math.max(8, MAX_SECS - cards + xfadeLoss * 0.5);
      speed = contentSecs / budget;
      speed = Math.min(2.0, Math.max(1, speed));
    }

    console.log(
      `[render] source=${sourceFps.toFixed(2)}fps interpolate=false speed=${speed.toFixed(2)}`,
    );

    const titlePng = path.join(tmp, "title.png");
    const outroPng = path.join(tmp, "outro.png");
    const titlePath = path.join(tmp, "title.mp4");
    const outroPath = path.join(tmp, "outro.mp4");

    await renderCardPng(
      titlePng,
      "title",
      {
        title: opts.title || "Demo",
        description: clampTitleDescription(
          opts.description || "A quick tour of the app",
        ),
        liveUrl: (opts.liveUrl || "").replace(/^https?:\/\//, ""),
        badges: opts.badges || [],
      },
      logoPath,
    );
    await renderCardPng(
      outroPng,
      "outro",
      { repoUrl: opts.repoUrl || "" },
      logoPath,
    );

    const titleSilent = path.join(tmp, "title-a.mp4");
    const outroSilent = path.join(tmp, "outro-a.mp4");
    await pngToFadedClip(titlePng, titlePath, TITLE_SECS);
    await pngToFadedClip(outroPng, outroPath, OUTRO_SECS);
    await ensureSilentAudio(titlePath, titleSilent, TITLE_SECS);
    await ensureSilentAudio(outroPath, outroSilent, OUTRO_SECS);

    const clipPaths = [];
    for (let i = 0; i < segments.length; i += 1) {
      const clip = path.join(tmp, `clip-${i}.mp4`);
      try {
        await extractSegment(opts.rawVideoPath, segments[i], clip, speed);
        clipPaths.push(clip);
      } catch (err) {
        // Losing one beat is far better than losing the whole demo, so drop it
        // and keep cutting — the tour still reads with the remaining beats.
        console.warn(
          `[render] beat ${i + 1}/${segments.length} failed, dropping it: ` +
            `${err instanceof Error ? err.message : err}`,
        );
      }
    }
    if (!clipPaths.length && segments.length) {
      throw new Error("Every beat failed to render.");
    }

    const bodyPath = path.join(tmp, "body.mp4");
    if (clipPaths.length) {
      // Hard cuts between beats — xfade + zoompan = ghosted double-UI frames.
      await concatCuts(clipPaths, bodyPath);
    } else {
      await extractSegment(
        opts.rawVideoPath,
        { start: 0, end: Math.min(total, 20) },
        bodyPath,
        1,
      );
    }

    await mkdir(path.dirname(opts.outputPath), { recursive: true });
    // Soft xfade title→body only. Hard-cut into outro — xfade from a zoomed
    // last beat into the cream card reads as ghosted double-UI.
    const titleBody = path.join(tmp, "title-body.mp4");
    await concatWithXfade([titleSilent, bodyPath], titleBody, 0.35);
    await concatCuts([titleBody, outroSilent], opts.outputPath);

    const finalDuration = await probeDuration(opts.outputPath);
    return {
      outputPath: opts.outputPath,
      durationSec: finalDuration,
      segments: segments.length,
      speed,
      logoPath,
      sourceFps,
      interpolate: false,
    };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

export async function writeTimelineFile(filePath, timeline) {
  await writeFile(filePath, JSON.stringify(timeline, null, 2));
}

export async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}
