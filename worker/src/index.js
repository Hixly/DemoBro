import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";
import { recordStoryboard } from "./record.js";
import { recordAgentTour } from "./agent-tour.js";
import { renderDemo } from "./render.js";
import { claimNextJob, markJobReady, markJobStatus, uploadFinishedMp4 } from "./upload.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUTPUT = path.join(ROOT, "output");
const WORKER_ID = process.env.RAILWAY_REPLICA_ID || hostname() || "worker";
const POLL_MS = Number(process.env.DEMOBRO_POLL_MS || 5000);

async function processJob(job) {
  const mode = job.storyboard?.mode === "agent" ? "agent" : "steps";
  const steps = job.storyboard?.steps ?? [];
  if (mode !== "agent" && !steps.length) {
    await markJobStatus(job.id, "failed", "failed", {
      error_message: "Job has an empty storyboard.",
    });
    return;
  }

  await mkdir(OUTPUT, { recursive: true });
  let videoDir = null;

  try {
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

    const objectPath = `${job.id}/demo.mp4`;
    const uploaded = await uploadFinishedMp4({
      localPath: finishedPath,
      objectPath,
    });
    await markJobReady(job.id, {
      objectPath: uploaded.objectPath,
      bytes: uploaded.bytes,
    });

    await rm(videoDir, { recursive: true, force: true });
    console.log(`[worker] job ${job.id} ready — raw deleted`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[worker] job ${job.id} failed:`, message);
    await markJobStatus(job.id, "failed", "failed", {
      error_message: message.slice(0, 500),
      expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    }).catch(() => {});
    if (videoDir) {
      await rm(videoDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function tick() {
  const job = await claimNextJob(WORKER_ID);
  if (!job) return;
  console.log(`[worker] claimed ${job.id}`);
  await processJob(job);
}

console.log(`[demobro-worker] polling every ${POLL_MS}ms as ${WORKER_ID}`);

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

loop();
