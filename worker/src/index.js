import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";
import { recordStoryboard } from "./record.js";
import { recordAgentTour } from "./agent-tour.js";
import { renderDemo } from "./render.js";
import {
  claimNextJob,
  markJobReady,
  markJobStatus,
  reapStaleJobs,
  uploadFinishedMp4,
} from "./upload.js";
import {
  JOB_TIMEOUT_MS,
  resolveWritableDir,
  toUserFacingError,
  withTimeout,
} from "./job-utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const WORKER_ID = process.env.RAILWAY_REPLICA_ID || hostname() || "worker";
const POLL_MS = Number(process.env.DEMOBRO_POLL_MS || 5000);
/** Grace on top of the job ceiling before another worker calls a job dead. */
const STALE_JOB_MS = JOB_TIMEOUT_MS + 2 * 60 * 1000;
const STALE_SWEEP_MS = 60_000;

/** Resolved once at startup; see resolveWritableDir. */
let OUTPUT = path.join(ROOT, "output");
let lastSweepAt = 0;

async function failJob(jobId, err, videoDir) {
  const message = toUserFacingError(err);
  console.error(`[worker] job ${jobId} failed:`, message);
  await markJobStatus(jobId, "failed", "failed", {
    error_message: message.slice(0, 500),
    expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
  }).catch(() => {});
  if (videoDir) {
    await rm(videoDir, { recursive: true, force: true }).catch(() => {});
  }
  const finishedPath = path.join(OUTPUT, "final", `${jobId}.mp4`);
  await rm(finishedPath, { force: true }).catch(() => {});
  await rm(`${finishedPath}.txt`, { force: true }).catch(() => {});
}

async function processJob(job) {
  const mode = job.storyboard?.mode === "agent" ? "agent" : "steps";
  const steps = job.storyboard?.steps ?? [];
  if (mode !== "agent" && !steps.length) {
    await failJob(job.id, new Error("Job has an empty storyboard."), null);
    return;
  }

  let videoDir = null;
  let alive = true;
  try {
    await withTimeout(
      (async () => {
        await mkdir(OUTPUT, { recursive: true });
        if (!alive) return;
        await markJobStatus(job.id, "recording", "discovering_tour");

        const recordResult =
          mode === "agent"
            ? await recordAgentTour({
                liveUrl: job.live_url,
                repoUrl: job.repo_url,
                title: job.title,
                description: job.description,
                outputDir: OUTPUT,
                jobId: job.id,
              })
            : await recordStoryboard({
                liveUrl: job.live_url,
                steps,
                outputDir: OUTPUT,
                jobId: job.id,
              });
        videoDir = recordResult.videoDir;
        if (!alive) return;

        await markJobStatus(job.id, "rendering", "cutting_video");

        const finishedPath = path.join(OUTPUT, "final", `${job.id}.mp4`);
        await renderDemo({
          rawVideoPath: recordResult.videoPath,
          timeline: recordResult.timeline,
          title: recordResult.title || job.title || "Untitled project",
          description: recordResult.description || job.description || "",
          badges: job.stack_badges || [],
          liveUrl: job.live_url,
          repoUrl: job.repo_url,
          outputPath: finishedPath,
        });
        if (!alive) return;

        const objectPath = `${job.id}/demo.mp4`;
        const uploaded = await uploadFinishedMp4({
          localPath: finishedPath,
          objectPath,
        });
        if (!alive) return;
        await markJobReady(job.id, {
          objectPath: uploaded.objectPath,
          bytes: uploaded.bytes,
        });

        await rm(videoDir, { recursive: true, force: true });
        videoDir = null;
        console.log(`[worker] job ${job.id} ready — raw deleted`);
      })(),
      JOB_TIMEOUT_MS,
      "Overall job timeout — stopped so the worker can keep going.",
    );
  } catch (err) {
    alive = false;
    await failJob(job.id, err, videoDir);
  }
}

async function sweepStaleJobs() {
  if (Date.now() - lastSweepAt < STALE_SWEEP_MS) return;
  lastSweepAt = Date.now();
  try {
    const swept = await reapStaleJobs(STALE_JOB_MS);
    if (swept.length) {
      console.warn(`[worker] swept ${swept.length} stalled job(s): ${swept.join(", ")}`);
    }
  } catch (err) {
    console.warn(
      "[worker] stale sweep failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

async function tick() {
  await sweepStaleJobs();
  const job = await claimNextJob(WORKER_ID);
  if (!job) return;
  console.log(`[worker] claimed ${job.id}`);
  try {
    await processJob(job);
  } catch (err) {
    // processJob handles its own failures; this is the last line of defence so
    // a claimed job can never keep an in-progress status after we move on.
    await failJob(job.id, err, null);
  }
}

async function loop() {
  try {
    await tick();
  } catch (err) {
    console.error(
      "[demobro-worker] tick error:",
      err instanceof Error ? err.message : err,
    );
  } finally {
    setTimeout(loop, POLL_MS);
  }
}

// A stray async error from Playwright or ffmpeg must not take the poller down.
process.on("unhandledRejection", (reason) => {
  console.error(
    "[demobro-worker] unhandled rejection:",
    reason instanceof Error ? reason.message : reason,
  );
});
process.on("uncaughtException", (err) => {
  console.error(
    "[demobro-worker] uncaught exception:",
    err instanceof Error ? err.message : err,
  );
});

async function main() {
  OUTPUT = await resolveWritableDir(OUTPUT);
  console.log(
    `[demobro-worker] polling every ${POLL_MS}ms as ${WORKER_ID} (job timeout ${Math.round(
      JOB_TIMEOUT_MS / 1000,
    )}s, output ${OUTPUT})`,
  );
  loop();
}

main().catch((err) => {
  console.error(
    "[demobro-worker] fatal startup error:",
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
