export const MIN_SUCCESSFUL_BEATS = 3;
export const MIN_BODY_DURATION_MS = 12_000;
export const TARGET_BODY_DURATION_MS = 13_000;
export const MIN_DISTINCT_STATES = 2;

const RENDERED_BEAT_LIMIT_MS = {
  pause: 4_000,
  nav: 4_100,
  type: 4_200,
  click: 4_300,
};

export function estimateBodyDurationMs(steps = []) {
  return steps
    .filter((step) => step.status === "succeeded")
    .reduce((total, step) => {
      const raw = Math.max(0, Number(step.endMs || 0) - Number(step.startMs || 0));
      const ceiling = RENDERED_BEAT_LIMIT_MS[step.stepKind] || 4_200;
      // Mirrors the renderer's concise lead/trail window and per-kind ceiling.
      return total + Math.min(ceiling, raw + 450);
    }, 0);
}

export function assessTourQuality(result) {
  const steps = Array.isArray(result?.steps) ? result.steps : [];
  const succeeded = steps.filter((step) => step.status === "succeeded");
  const interactions = succeeded.filter((step) =>
    ["type", "click", "nav"].includes(step.stepKind),
  );
  const distinctStates = new Set(
    succeeded.map((step) => step.stateFingerprint).filter(Boolean),
  ).size;
  const bodyDurationMs = estimateBodyDurationMs(succeeded);
  const reasons = [];
  if (succeeded.length < MIN_SUCCESSFUL_BEATS) {
    reasons.push(`needs ${MIN_SUCCESSFUL_BEATS} successful beats (got ${succeeded.length})`);
  }
  if (!interactions.length) reasons.push("needs a real interaction");
  if (bodyDurationMs < MIN_BODY_DURATION_MS) {
    reasons.push(`needs ${MIN_BODY_DURATION_MS / 1000}s body footage`);
  }
  if (distinctStates < MIN_DISTINCT_STATES) {
    reasons.push(`needs ${MIN_DISTINCT_STATES} distinct visual states`);
  }
  return {
    ok: reasons.length === 0,
    reasons,
    successfulBeats: succeeded.length,
    interactions: interactions.length,
    bodyDurationMs,
    distinctStates,
  };
}
