#!/usr/bin/env node
/**
 * CLI bridge so the Next.js storyboard route can capture a hydrated DOM
 * without bundling Playwright into the web app.
 *
 * Usage: node scripts/hydrate-cli.mjs <liveUrl>
 * Prints a single JSON object to stdout.
 */
import { captureHydratedPageStructure } from "../src/hydrate-page.js";

const liveUrl = process.argv[2];
if (!liveUrl) {
  process.stdout.write(
    JSON.stringify({ ok: false, error: "Usage: hydrate-cli.mjs <liveUrl>" }),
  );
  process.exit(1);
}

const result = await captureHydratedPageStructure(liveUrl);
process.stdout.write(JSON.stringify(result));
process.exit(result.ok ? 0 : 2);
