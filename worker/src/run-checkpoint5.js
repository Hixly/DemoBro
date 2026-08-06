import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { recordStoryboard } from "./record.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUTPUT = path.join(ROOT, "output");

const LIVE_URL = process.env.DEMOBRO_LIVE_URL ?? "https://what-color.com";
const REPO_URL =
  process.env.DEMOBRO_REPO_URL ?? "https://github.com/Hixly/WhatColor";
const STORYBOARD_APIS = (
  process.env.DEMOBRO_STORYBOARD_API ??
  "http://localhost:3001/api/storyboard,http://localhost:3000/api/storyboard"
).split(",");

/**
 * WhatColor-tuned storyboard (landing → /app camera → sample → share).
 * Used when the web storyboard API is down, or as a known-good local path
 * for checkpoint 5 verification against the real DOM.
 */
const FALLBACK_STORYBOARD = {
  title: "WhatColor",
  model: "whatcolor-live-dom",
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

async function fetchStoryboard() {
  let lastError = "no storyboard API configured";
  for (const api of STORYBOARD_APIS.map((s) => s.trim()).filter(Boolean)) {
    try {
      console.log(`[checkpoint5] fetching storyboard from ${api}`);
      const res = await fetch(api, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ liveUrl: LIVE_URL, githubUrl: REPO_URL }),
      });
      const body = await res.json();
      if (!res.ok) {
        lastError = body?.error ?? `Storyboard API ${res.status}`;
        continue;
      }
      const steps = body?.storyboard?.steps;
      if (!Array.isArray(steps) || !steps.length) {
        lastError = "Storyboard API returned no steps";
        continue;
      }
      return {
        title: body.title,
        steps,
        model: body.storyboard.model,
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  console.warn(
    `[checkpoint5] storyboard API unavailable (${lastError}) — using local fallback steps`,
  );
  return FALLBACK_STORYBOARD;
}

async function main() {
  console.log(`[checkpoint5] live=${LIVE_URL}`);
  console.log(`[checkpoint5] repo=${REPO_URL}`);

  // Prefer DOM-verified local tour for checkpoint 5 reliability.
  // Set DEMOBRO_USE_API_STORYBOARD=1 to pull from the web Grok endpoint instead.
  const storyboard =
    process.env.DEMOBRO_USE_API_STORYBOARD === "1"
      ? await fetchStoryboard()
      : FALLBACK_STORYBOARD;
  console.log(
    `[checkpoint5] got ${storyboard.steps.length} steps for "${storyboard.title}" (${storyboard.model})`,
  );

  await mkdir(OUTPUT, { recursive: true });
  const result = await recordStoryboard({
    liveUrl: LIVE_URL,
    steps: storyboard.steps,
    outputDir: OUTPUT,
    jobId: `whatcolor-${Date.now()}`,
  });

  const reportPath = path.join(result.videoDir, "report.json");
  await writeFile(reportPath, JSON.stringify({ storyboard, result }, null, 2));

  console.log("\n=== Checkpoint 5 report ===");
  console.log(`video: ${result.videoPath}`);
  console.log(`report: ${reportPath}`);
  console.log(`succeeded: ${result.succeeded}  skipped: ${result.skipped}`);
  for (const step of result.steps) {
    const why = step.reason ? ` — ${step.reason}` : "";
    console.log(
      `${step.index}. [${step.status}] ${step.description} | ${step.targetHint}${why}`,
    );
  }
}

main().catch((err) => {
  console.error("[checkpoint5] failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
