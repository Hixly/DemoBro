/**
 * Auto-generate a demo storyboard from ONLY liveUrl + github repo,
 * planning against a Playwright-hydrated DOM (not static HTML).
 */
import { captureHydratedPageStructure } from "./hydrate-page.js";

const STORYBOARD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["steps"],
  properties: {
    steps: {
      type: "array",
      minItems: 5,
      maxItems: 6,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["description", "targetHint"],
        properties: {
          description: {
            type: "string",
            description:
              "Caption-ready beat, max ~6 words, e.g. Visit homepage / Claim a spot",
          },
          targetHint: {
            type: "string",
            description:
              "A CSS selector, Playwright :has-text() hint, or accessible name",
          },
        },
      },
    },
  },
};

function requireApiKey() {
  const key = process.env.XAI_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "XAI_API_KEY is not set. Add it to .env.local (local) or worker env.",
    );
  }
  return key;
}

function modelName() {
  return process.env.XAI_MODEL?.trim() || "grok-4.20-0309-non-reasoning";
}

function buildPrompt(args) {
  const elementLines = args.elements
    .slice(0, 60)
    .map((el) => {
      const bits = [
        el.tag,
        el.name ? `name="${el.name}"` : null,
        el.href ? `href="${el.href}"` : null,
        el.disabled ? "disabled" : null,
        `hint=${el.selectorHint}`,
      ].filter(Boolean);
      return `- ${bits.join(" | ")}`;
    })
    .join("\n");

  return `You are planning a polished ~30 second product demo tour of a live web app.

Project title: ${args.title}
One-line description: ${args.description}
Tech stack badges: ${args.badges.join(", ") || "unknown"}
Live URL: ${args.liveUrl}
Page title: ${args.pageTitle || "(none)"}

README excerpt:
"""
${args.readmeExcerpt.slice(0, 1500)}
"""

GROUND TRUTH — interactive elements visible on the LANDING page after JS hydration
(this list is from a real headless browser, not static HTML). ONLY plan steps
around these controls. Do NOT invent buttons, tabs, forms, or screens that are
not listed. UI that appears only after deep flows (post-login, post-submit
results) is unknown — do not fabricate steps for it.

${elementLines || "(no visible interactive elements — plan a gentle visit/scroll overview only using body / headings)"}

Propose 5-6 demo steps a first-time visitor can perform from this landing state. Rules:
- Each step is ONE concrete browser action.
- Step 1 should visit/land on the homepage (targetHint can be the live URL or body).
- Prefer real controls from the element list (use their hint= values).
- Order steps sensibly for a first-time visitor (scan hero → primary CTA → secondary interest).
- If an input exists, a type step may precede clicking a related submit — but only if BOTH appear in the list.
- NEVER invent post-flow result screens (drafts, dashboards, modals) that aren't in the list.
- description: caption-ready — max ~6 words, imperative.
- targetHint: real selector or :has-text("...") from the list above.
- Skip payment/auth unless clearly present as a visible control.
- Return JSON only matching the schema.`;
}

function parseSteps(content) {
  const parsed = JSON.parse(content);
  if (!Array.isArray(parsed.steps)) {
    throw new Error("Grok response missing steps array.");
  }
  const steps = parsed.steps
    .map((step) => ({
      description: String(step.description ?? "").trim(),
      targetHint: String(step.targetHint ?? "").trim(),
    }))
    .filter((step) => step.description && step.targetHint);

  if (steps.length < 5 || steps.length > 6) {
    throw new Error(`Grok returned ${steps.length} steps; expected 5–6.`);
  }
  return steps;
}

/**
 * Lightweight GitHub ingest for the worker (ok or fallback title).
 * @param {string} githubUrl
 */
export async function ingestRepoLight(githubUrl) {
  const m = githubUrl.match(/github\.com\/([^/]+)\/([^/#?]+)/i);
  if (!m) {
    return {
      status: "fallback",
      title: "Demo",
      description: "A web app demo.",
      badges: [],
      readmeExcerpt: "",
    };
  }
  const owner = m[1];
  const repo = m[2].replace(/\.git$/, "");
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "DemoBro.video-worker",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers,
    });
    if (!repoRes.ok) {
      const title = repo.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      return {
        status: "fallback",
        title,
        description: "A web app demo.",
        badges: [],
        readmeExcerpt: "",
        owner,
        repo,
      };
    }
    const meta = await repoRes.json();
    let readmeExcerpt = "";
    const readmeRes = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/readme`,
      { headers: { ...headers, Accept: "application/vnd.github.raw" } },
    );
    if (readmeRes.ok) {
      const text = await readmeRes.text();
      readmeExcerpt = text.slice(0, 2000);
    }
    const title =
      (readmeExcerpt.match(/^#\s+(.+)$/m)?.[1] || meta.name || repo)
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .trim();
    return {
      status: "ok",
      title,
      description: meta.description || "A web app demo.",
      badges: meta.language ? [meta.language] : [],
      readmeExcerpt,
      owner,
      repo,
    };
  } catch {
    return {
      status: "fallback",
      title: repo.replace(/[-_]+/g, " "),
      description: "A web app demo.",
      badges: [],
      readmeExcerpt: "",
    };
  }
}

/**
 * @param {{ liveUrl: string, githubUrl: string }} args
 */
export async function generateStoryboardFromLive(args) {
  const apiKey = requireApiKey();
  const model = modelName();

  const repo = await ingestRepoLight(args.githubUrl);
  const page = await captureHydratedPageStructure(args.liveUrl);
  if (!page.ok) throw new Error(page.error);

  const prompt = buildPrompt({
    title: repo.title,
    description: repo.description,
    badges: repo.badges,
    readmeExcerpt: repo.readmeExcerpt || "",
    liveUrl: page.structure.finalUrl,
    pageTitle: page.structure.title,
    elements: page.structure.elements,
  });

  console.log(
    `[storyboard] planning from ${page.structure.elements.length} hydrated elements…`,
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);

  let res;
  try {
    res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        messages: [
          {
            role: "system",
            content:
              "You write concrete browser-demo storyboards from a hydrated landing-page element list. Never invent controls that are not listed. Respond with structured JSON only.",
          },
          { role: "user", content: prompt },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "demo_storyboard",
            schema: STORYBOARD_SCHEMA,
            strict: true,
          },
        },
      }),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error("Grok took too long to write the storyboard (45s).");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `Grok API error ${res.status}${detail ? `: ${detail.slice(0, 240)}` : ""}`,
    );
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("Grok returned an empty storyboard.");

  const parsed = parseSteps(content);
  const steps = parsed.map((step, index) => ({
    id: `step-${index + 1}-${Math.random().toString(36).slice(2, 8)}`,
    description: step.description,
    targetHint: step.targetHint,
  }));

  console.log(
    `[storyboard] ${steps.length} steps for "${repo.title}" (ingest=${repo.status})`,
  );
  for (const s of steps) {
    console.log(`[storyboard]  • ${s.description} → ${s.targetHint}`);
  }

  return {
    title: repo.title,
    description: repo.description,
    badges: repo.badges,
    ingestStatus: repo.status,
    storyboard: {
      steps,
      model: data.model ?? model,
      pageTitle: page.structure.title,
      finalUrl: page.structure.finalUrl,
      elementCount: page.structure.elements.length,
    },
  };
}
