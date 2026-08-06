import { mkdir, rm, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { recordStoryboard } from "./record.js";
import { renderDemo } from "./render.js";
import {
  getSupabaseAdmin,
  STORAGE_BUCKET,
  VIDEO_TTL_SECONDS,
} from "./supabase.js";
import { markJobReady, markJobStatus, uploadFinishedMp4 } from "./upload.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUTPUT = path.join(ROOT, "output");

const LIVE_URL = process.env.DEMOBRO_LIVE_URL ?? "https://what-color.com";
const REPO_URL =
  process.env.DEMOBRO_REPO_URL ?? "https://github.com/Hixly/WhatColor";

const FALLBACK = {
  title: "WhatColor",
  description:
    "Point your camera at anything and get the color name in real time.",
  badges: ["Next.js", "TypeScript", "Tailwind", "Supabase"],
  steps: [
    {
      id: "step-1",
      description: "Land on the WhatColor homepage hero",
      targetHint: "https://what-color.com/",
    },
    {
      id: "step-2",
      description: "Click Start Detecting Colors",
      targetHint: 'a:has-text("Start Detecting Colors")',
    },
    {
      id: "step-3",
      description: "Settle on the live camera view",
      targetHint: "video",
    },
    {
      id: "step-4",
      description: "Pause to sample the color under the crosshair",
      targetHint: 'button[aria-label="Pause & tap to sample"]',
    },
    {
      id: "step-5",
      description: "Open color details from the sampled name",
      targetHint: 'button[aria-label="Tap to view color details"]',
    },
    {
      id: "step-6",
      description: "Share the sampled color",
      targetHint: 'button[aria-label="Share color"]',
    },
  ],
};

async function ensureJobRow(meta) {
  const supabase = getSupabaseAdmin();
  const id = randomUUID();
  const now = new Date().toISOString();
  const row = {
    id,
    ip_hash: "checkpoint6-local",
    live_url: LIVE_URL,
    repo_url: REPO_URL,
    title: meta.title,
    description: meta.description,
    stack_badges: meta.badges,
    storyboard: { steps: meta.steps },
    status: "recording",
    stage: "touring_app",
    claimed_at: now,
    claimed_by: "checkpoint6",
    created_at: now,
    updated_at: now,
  };

  const { error } = await supabase.from("jobs").insert(row);
  if (error) {
    console.warn(`[checkpoint6] jobs insert skipped: ${error.message}`);
    return { id, persisted: false };
  }
  return { id, persisted: true };
}

async function main() {
  console.log(`[checkpoint6] live=${LIVE_URL}`);
  console.log(`[checkpoint6] repo=${REPO_URL}`);
  console.log(`[checkpoint6] bucket=${STORAGE_BUCKET}`);

  // Confirm Storage + jobs are reachable before recording.
  const supabase = getSupabaseAdmin();
  const { data: buckets, error: bucketError } =
    await supabase.storage.listBuckets();
  if (bucketError) {
    throw new Error(`listBuckets failed: ${bucketError.message}`);
  }
  const bucketNames = (buckets ?? []).map((b) => b.name);
  console.log(`[checkpoint6] storage buckets: ${bucketNames.join(", ") || "(none)"}`);
  if (!bucketNames.includes(STORAGE_BUCKET)) {
    throw new Error(
      `Expected storage bucket "${STORAGE_BUCKET}" not found. Set SUPABASE_STORAGE_BUCKET to an existing bucket.`,
    );
  }

  const meta = FALLBACK;
  const job = await ensureJobRow(meta);
  const jobId = job.id;
  console.log(`[checkpoint6] job=${jobId} persisted=${job.persisted}`);

  await mkdir(OUTPUT, { recursive: true });
  const recordResult = await recordStoryboard({
    liveUrl: LIVE_URL,
    steps: meta.steps,
    outputDir: OUTPUT,
    jobId,
  });

  const rawPath = recordResult.videoPath;
  console.log(`[checkpoint6] raw recording: ${rawPath}`);

  if (job.persisted) {
    await markJobStatus(jobId, "rendering", "cutting_video");
  }

  const finishedPath = path.join(OUTPUT, "final", `${jobId}.mp4`);
  const renderResult = await renderDemo({
    rawVideoPath: rawPath,
    timeline: recordResult.timeline,
    title: meta.title,
    description: meta.description,
    badges: meta.badges,
    liveUrl: LIVE_URL,
    repoUrl: REPO_URL,
    outputPath: finishedPath,
  });
  console.log(
    `[checkpoint6] rendered ${renderResult.durationSec.toFixed(1)}s → ${finishedPath}` +
      ` (source ${renderResult.sourceFps?.toFixed?.(1) ?? "?"}fps` +
      `, interpolate=${renderResult.interpolate})`,
  );

  const objectPath = `${jobId}/demo.mp4`;
  const uploaded = await uploadFinishedMp4({
    localPath: finishedPath,
    objectPath,
  });
  const expiresAt = new Date(
    Date.now() + VIDEO_TTL_SECONDS * 1000,
  ).toISOString();
  if (job.persisted) {
    await markJobReady(jobId, {
      objectPath: uploaded.objectPath,
      bytes: uploaded.bytes,
    });
  }

  // Spec: delete raw Playwright recording after successful render/upload.
  const rawDir = recordResult.videoDir;
  await rm(rawDir, { recursive: true, force: true });
  let rawGone = false;
  try {
    await access(rawPath);
  } catch {
    rawGone = true;
  }

  const report = {
    jobId,
    jobPersisted: job.persisted,
    finishedPath,
    objectPath: uploaded.objectPath,
    signedUrl: uploaded.signedUrl,
    expiresAt,
    ttlSeconds: VIDEO_TTL_SECONDS,
    durationSec: renderResult.durationSec,
    rawDeleted: rawGone,
    rawPathWas: rawPath,
    steps: recordResult.steps,
  };

  const reportPath = path.join(OUTPUT, "final", `${jobId}-report.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2));

  console.log("\n=== Checkpoint 6 report ===");
  console.log(`job: ${jobId}`);
  console.log(`local mp4: ${finishedPath}`);
  console.log(`storage: ${STORAGE_BUCKET}/${uploaded.objectPath}`);
  console.log(`signed url: ${uploaded.signedUrl}`);
  console.log(`expires at: ${expiresAt}`);
  console.log(`raw deleted: ${rawGone}`);
  console.log(`jobs row: ${job.persisted ? "yes" : "NO — table missing"}`);
  console.log(`report: ${reportPath}`);
}

main().catch((err) => {
  console.error(
    "[checkpoint6] failed:",
    err instanceof Error ? err.message : err,
  );
  process.exit(1);
});
