import type { StoryboardStep } from "@/lib/storyboard";

export type StepKind = "navigate" | "click" | "type" | "review";

const TIPS: Record<StepKind, string> = {
  navigate: "This is where your tour opens.",
  click: "We'll click this for the viewer — keep it to the money moments.",
  type: "We'll type this out on camera.",
  review: "A beat to show the result.",
};

export function tipForStepKind(kind: StepKind): string {
  return TIPS[kind];
}

function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

/**
 * Infer step kind from description + target — no schema change required.
 * Order matters: navigate before type (bare "enter" used to steal navigate steps).
 */
export function classifyStepKind(step: StoryboardStep): StepKind {
  const desc = step.description.toLowerCase();
  const hint = step.targetHint.trim();

  // URLs / landing language → navigate
  if (
    looksLikeUrl(hint) ||
    /\b(land|landing|navigate|visit|visiting|arrive|arriving)\b/.test(desc) ||
    /\b(home\s*page|homepage)\b/.test(desc) ||
    /\bgo\s+to\b/.test(desc) ||
    /\bopen\s+(the\s+)?(home\s*page|homepage|site|app|url)\b/.test(desc) ||
    /\bstart\s+(on|at|from)\b/.test(desc)
  ) {
    return "navigate";
  }

  // Typing — only clear typing verbs (not bare "enter" / "input" / "write")
  if (
    /\b(type|types|typing|typed)\b/.test(desc) ||
    /\bfill(s|ed|ing)?\s*(in|out)?\b/.test(desc) ||
    /\benter(s|ed|ing)?\s+(text|your|an?\s|the\s+\w+\s+into)\b/.test(desc) ||
    /\bkey\s*in\b/.test(desc) ||
    /\bpaste[sd]?\b/.test(desc)
  ) {
    return "type";
  }

  // Review / settle beats
  if (
    /\b(settle|review|preview|result)\b/.test(desc) ||
    (/\b(show|watch|view|see|look|camera)\b/.test(desc) &&
      !/\b(click|tap|press|select)\b/.test(desc))
  ) {
    return "review";
  }

  if (
    /\b(click|tap|press|select|hit)\b/.test(desc) ||
    /:has-text\(|aria-label=|\[role=|button/i.test(hint)
  ) {
    return "click";
  }

  if (
    /^(video|img|canvas|body|main|h[1-6])$/i.test(hint) ||
    (hint.startsWith(".") && !/\b(click|tap)\b/.test(desc))
  ) {
    return "review";
  }

  // "Open X" without homepage language → click (menus, modals)
  if (/\bopen\b/.test(desc)) return "click";

  return "click";
}

function extractQuoted(text: string): string | null {
  const m =
    text.match(/:has-text\(["']([^"']+)["']\)/) ||
    text.match(/text=["']([^"']+)["']/) ||
    text.match(/aria-label=["']([^"']+)["']/) ||
    text.match(/["']([^"']{2,80})["']/);
  return m?.[1]?.trim() || null;
}

/** Plain-English target for non-technical users. */
export function plainEnglishTarget(step: StoryboardStep, kind: StepKind): string {
  const hint = step.targetHint.trim();
  const quoted = extractQuoted(hint);

  if (kind === "navigate" || looksLikeUrl(hint)) {
    try {
      const host = new URL(hint).hostname.replace(/^www\./, "");
      return `opens ${host}`;
    } catch {
      return "opens the starting page";
    }
  }

  if (kind === "type") {
    if (quoted) return `types into “${quoted}”`;
    return "types into the field on screen";
  }

  if (kind === "review") {
    if (/^video$/i.test(hint)) return "shows the live video";
    if (quoted) return `highlights “${quoted}”`;
    return "pauses on the result";
  }

  if (quoted) {
    if (/^a\b/i.test(hint) || /link/i.test(step.description)) {
      return `clicks the “${quoted}” link`;
    }
    return `clicks the “${quoted}” button`;
  }
  if (/^button$/i.test(hint)) return "clicks the button";
  if (hint.startsWith(".")) return "clicks that control on the page";
  return "clicks the target on screen";
}
