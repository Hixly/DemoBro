import type { RepoIngestOk } from "@/lib/github";
import { fetchPageStructure } from "@/lib/page-structure";

export type StoryboardStep = {
  id: string;
  description: string;
  /** CSS / Playwright-oriented selector or accessible-name hint */
  targetHint: string;
};

export type StoryboardResult = {
  steps: StoryboardStep[];
  model: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  pageTitle: string;
  finalUrl: string;
};

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
              "Caption-ready beat, max ~6 words, e.g. Try for free / Type your goal",
          },
          targetHint: {
            type: "string",
            description:
              "A CSS selector, Playwright :has-text() hint, or accessible name the browser can act on",
          },
        },
      },
    },
  },
} as const;

function requireApiKey(): string {
  const key = process.env.XAI_API_KEY?.trim();
  if (!key) {
    throw new Error(
      "XAI_API_KEY is not set. Add it to .env.local (local) or Railway service env vars.",
    );
  }
  return key;
}

function modelName(): string {
  return process.env.XAI_MODEL?.trim() || "grok-4.20-0309-non-reasoning";
}

function buildPrompt(args: {
  title: string;
  description: string;
  badges: string[];
  readmeExcerpt: string;
  liveUrl: string;
  pageTitle: string;
  elements: Array<{
    tag: string;
    name?: string;
    href?: string;
    selectorHint: string;
  }>;
}): string {
  const elementLines = args.elements
    .slice(0, 60)
    .map((el) => {
      const bits = [
        el.tag,
        el.name ? `name="${el.name}"` : null,
        el.href ? `href="${el.href}"` : null,
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
(captured by a real headless browser, not static HTML). ONLY plan steps around
these controls. Do NOT invent buttons, tabs, forms, or screens that are not listed.
UI that appears only after deep flows (post-login, post-submit results) is unknown
— do not fabricate steps for it.

${elementLines || "(no visible interactive elements — plan a gentle visit/scroll overview using body)"}

Propose 5-6 demo steps a first-time visitor can perform from this landing state. Rules:
- Each step is ONE concrete user action a browser can perform.
- Prefer 5 or 6 steps — enough to fill a ~20–25s tour, not a thin 3-click skim.
- Step 1 should land on / pause on the hero or primary landing view.
- Prefer real controls from the element list above (use their hint= values).
- Order steps sensibly for a first-time visitor (scan hero → primary CTA → secondary).
- If an input exists, a type step may precede clicking a related submit — only if BOTH are listed.
- NEVER invent post-flow result screens (drafts, dashboards, modals) that aren't in the list.
- description: caption-ready — max ~6 words, imperative, no filler.
- targetHint: a real selector or accessible-name hint suitable for Playwright (prefer hint= values).
- Do not invent payment/auth flows unless clearly present as a visible control.
- Do not include voiceover, captions, or music notes.
- Return JSON only matching the schema.`;
}

type GrokChatResponse = {
  choices?: Array<{ message?: { content?: string | null } }>;
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

function parseSteps(content: string): Array<{ description: string; targetHint: string }> {
  const parsed = JSON.parse(content) as {
    steps?: Array<{ description?: string; targetHint?: string }>;
  };
  if (!Array.isArray(parsed.steps)) {
    throw new Error("Grok response missing steps array.");
  }
  const steps = parsed.steps
    .map((step) => ({
      description: (step.description ?? "").trim(),
      targetHint: (step.targetHint ?? "").trim(),
    }))
    .filter((step) => step.description && step.targetHint);

  if (steps.length < 5 || steps.length > 6) {
    throw new Error(`Grok returned ${steps.length} steps; expected 5–6.`);
  }
  return steps;
}

export async function generateStoryboard(args: {
  liveUrl: string;
  repo: Pick<RepoIngestOk, "title" | "description" | "badges" | "raw">;
}): Promise<StoryboardResult> {
  const apiKey = requireApiKey();
  const model = modelName();

  const page = await fetchPageStructure(args.liveUrl);
  if (!page.ok) {
    throw new Error(page.error);
  }

  const prompt = buildPrompt({
    title: args.repo.title,
    description: args.repo.description,
    badges: args.repo.badges,
    readmeExcerpt: args.repo.raw.readmeExcerpt,
    liveUrl: page.structure.finalUrl,
    pageTitle: page.structure.title,
    elements: page.structure.elements,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);

  let res: Response;
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
      throw new Error("Grok took too long to write the storyboard (45s). Try again.");
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

  const data = (await res.json()) as GrokChatResponse;
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Grok returned an empty storyboard.");
  }

  const parsed = parseSteps(content);
  return {
    steps: parsed.map((step, index) => ({
      id: `step-${index + 1}-${Math.random().toString(36).slice(2, 8)}`,
      description: step.description,
      targetHint: step.targetHint,
    })),
    model: data.model ?? model,
    usage: {
      promptTokens: data.usage?.prompt_tokens,
      completionTokens: data.usage?.completion_tokens,
      totalTokens: data.usage?.total_tokens,
    },
    pageTitle: page.structure.title,
    finalUrl: page.structure.finalUrl,
  };
}
