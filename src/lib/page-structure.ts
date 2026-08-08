import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { assertSafePublicUrl } from "@/lib/ssrf";

const execFileAsync = promisify(execFile);

export type PageElement = {
  tag: string;
  role?: string;
  text?: string;
  name?: string;
  href?: string;
  type?: string;
  placeholder?: string;
  selectorHint: string;
  visible?: boolean;
  disabled?: boolean;
};

export type PageStructure = {
  finalUrl: string;
  title: string;
  elements: PageElement[];
  landmarks: string[];
};

/**
 * Capture page structure from a REAL hydrated DOM via the worker's Playwright
 * hydrate-cli (reuses enumerateElements — no cheerio/static HTML).
 */
export async function fetchPageStructure(
  liveUrl: string,
): Promise<
  | { ok: true; structure: PageStructure }
  | { ok: false; error: string }
> {
  const safe = await assertSafePublicUrl(liveUrl);
  if (!safe.ok) return { ok: false, error: safe.error };

  const workerDir = path.join(process.cwd(), "worker");
  const script = path.join(workerDir, "scripts", "hydrate-cli.mjs");

  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [script, safe.url.toString()],
      {
        cwd: workerDir,
        timeout: 90_000,
        maxBuffer: 8 * 1024 * 1024,
        env: process.env,
      },
    );
    if (stderr?.trim()) {
      console.warn("[page-structure] hydrate stderr:", stderr.slice(0, 400));
    }
    const parsed = JSON.parse(stdout) as
      | { ok: true; structure: PageStructure }
      | { ok: false; error: string };
    if (!parsed.ok) {
      return { ok: false, error: parsed.error || "Hydrated DOM capture failed." };
    }
    return { ok: true, structure: parsed.structure };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Hydrated DOM capture failed.";
    // execFile puts stdout on the error when exit code != 0
    const withStdout = err as { stdout?: string };
    if (withStdout.stdout) {
      try {
        const parsed = JSON.parse(String(withStdout.stdout)) as {
          ok?: boolean;
          error?: string;
        };
        if (parsed?.error) return { ok: false, error: parsed.error };
      } catch {
        /* fall through */
      }
    }
    return {
      ok: false,
      error: `Hydrated DOM capture failed (${message}). Is Playwright installed in worker/?`,
    };
  }
}
