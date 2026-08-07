import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderCardPng, W, H } from "./cards.js";

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

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...opts,
    });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stderr);
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
 */
export function planSegments(timeline, totalDurationSec) {
  const steps = (timeline?.steps ?? []).filter((s) => s.status === "succeeded");
  if (!steps.length) {
    const end = Math.min(totalDurationSec, 22);
    const start = Math.max(0, end - 18);
    return [{ start, end }];
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
    segments.push({ start, end });
  }

  return segments.length
    ? segments
    : [{ start: 0, end: Math.min(totalDurationSec, 20) }];
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
    "-pix_fmt",
    "yuv420p",
    outPath,
  ]);
}

/**
 * Extract a footage window to a true 30fps CFR H.264 clip.
 * Screen demos use plain fps=30 (frame dup) — never minterpolate.
 * MCI on UI recordings invents motion and leaves pulsing dark halos.
 */
async function extractSegment(rawPath, seg, outPath, speed = 1) {
  const dur = Math.max(0.2, seg.end - seg.start);
  const outDur = dur / speed;
  const fadeOutStart = Math.max(0, outDur - 0.25);
  await run("ffmpeg", [
    "-y",
    "-ss",
    seg.start.toFixed(3),
    "-i",
    rawPath,
    "-t",
    dur.toFixed(3),
    "-vf",
    [
      `scale=${W}:${H}:force_original_aspect_ratio=decrease`,
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2`,
      `setpts=PTS/${speed}`,
      "fps=30",
      `fade=t=in:st=0:d=0.25`,
      `fade=t=out:st=${fadeOutStart.toFixed(3)}:d=0.25`,
    ].join(","),
    "-an",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-r",
    "30",
    "-fps_mode",
    "cfr",
    outPath,
  ]);
}

async function concatWithXfade(inputs, outPath) {
  if (inputs.length === 1) {
    await run("ffmpeg", ["-y", "-i", inputs[0], "-c", "copy", outPath]);
    return;
  }

  const durations = [];
  for (const file of inputs) {
    durations.push(await probeDuration(file));
  }

  let filter = "";
  let lastLabel = "[0:v]";
  let offset = Math.max(0, durations[0] - XFADE);
  for (let i = 1; i < inputs.length; i += 1) {
    const outLabel = i === inputs.length - 1 ? "[vout]" : `[v${i}]`;
    filter += `${lastLabel}[${i}:v]xfade=transition=fade:duration=${XFADE}:offset=${offset.toFixed(3)}${outLabel};`;
    lastLabel = outLabel;
    offset += Math.max(0.1, durations[i] - XFADE);
  }
  filter = filter.replace(/;$/, "");

  const args = ["-y"];
  for (const file of inputs) {
    args.push("-i", file);
  }
  args.push(
    "-filter_complex",
    filter,
    "-map",
    "[vout]",
    "-c:v",
    "libx264",
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
    const xfadeLoss = Math.max(0, segments.length - 1) * XFADE + 2 * XFADE;
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
        description: (opts.description || "A quick tour of the app").slice(0, 120),
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

    await pngToFadedClip(titlePng, titlePath, TITLE_SECS);
    await pngToFadedClip(outroPng, outroPath, OUTRO_SECS);

    const clipPaths = [];
    for (let i = 0; i < segments.length; i += 1) {
      const clip = path.join(tmp, `clip-${i}.mp4`);
      await extractSegment(opts.rawVideoPath, segments[i], clip, speed);
      clipPaths.push(clip);
    }

    const bodyPath = path.join(tmp, "body.mp4");
    if (clipPaths.length) {
      await concatWithXfade(clipPaths, bodyPath);
    } else {
      await extractSegment(
        opts.rawVideoPath,
        { start: 0, end: Math.min(total, 20) },
        bodyPath,
        1,
      );
    }

    await mkdir(path.dirname(opts.outputPath), { recursive: true });
    await concatWithXfade([titlePath, bodyPath, outroPath], opts.outputPath);

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
