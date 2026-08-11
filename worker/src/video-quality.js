export const VISUAL_DUPLICATE_THRESHOLD = 0.018;
export const MIN_RENDERED_BODY_SECONDS = 11.8;
export const TARGET_RENDERED_BODY_SECONDS = 13;
export const MIN_BODY_PLAYBACK_SPEED = 0.9;
export const MAX_AUTOMATIC_BODY_REPAIR_SECONDS = 1.25;
export const BODY_REPAIR_HEADROOM_SECONDS = 0.25;

export function chooseBodyPlaybackSpeed({
  contentDurationSec,
  currentSpeed = 1,
  minBodySegments = 0,
}) {
  const content = Number(contentDurationSec);
  const speed = Number(currentSpeed);
  if (
    !minBodySegments ||
    !Number.isFinite(content) ||
    content <= 0 ||
    !Number.isFinite(speed) ||
    speed <= 0 ||
    content / speed >= TARGET_RENDERED_BODY_SECONDS
  ) {
    return speed;
  }
  return Math.max(
    MIN_BODY_PLAYBACK_SPEED,
    Math.min(speed, content / TARGET_RENDERED_BODY_SECONDS),
  );
}

export function planRenderedBodyRepair({ bodyDurationSec, minBodySegments = 0 }) {
  const body = Number(bodyDurationSec);
  if (
    !minBodySegments ||
    !Number.isFinite(body) ||
    body >= MIN_RENDERED_BODY_SECONDS
  ) {
    return { needed: false, extensionSec: 0, targetSec: body };
  }

  const targetSec = MIN_RENDERED_BODY_SECONDS + BODY_REPAIR_HEADROOM_SECONDS;
  const extensionSec = targetSec - body;
  if (extensionSec > MAX_AUTOMATIC_BODY_REPAIR_SECONDS) {
    return { needed: false, extensionSec: 0, targetSec };
  }
  return { needed: true, extensionSec, targetSec };
}

function durationOf(segment) {
  return Math.max(0, Number(segment?.end || 0) - Number(segment?.start || 0));
}

function textOf(segment) {
  return `${segment?.caption || ""} ${segment?.description || ""}`
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function storyPhaseOf(segment, index = 0) {
  const text = textOf(segment);
  if (segment?.resultVerified) return "outcome";
  if (index === 0 || /\b(land|hero|overview|meet|introduce)\b/.test(text)) {
    return "hook";
  }
  if (["click", "type", "nav"].includes(segment?.stepKind)) return "action";
  return "feature";
}

export function truthfulCaptionForSegment(segment) {
  const caption = String(segment?.caption || "").trim();
  if (!caption || segment?.resultVerified) return caption;
  const claimsVisibleOutcome =
    /\b(review|see|view|look at|here(?:'s| is)|your)\b.*\b(result|output|response|preview)\b/i.test(
      caption,
    );
  if (claimsVisibleOutcome && segment?.stepKind === "pause") return "";
  return caption;
}

function storyValueScore(segment, index) {
  let score = segmentValueScore(segment);
  const phase = storyPhaseOf(segment, index);
  if (phase === "hook") score += 5;
  if (phase === "action") score += 7;
  if (phase === "outcome") score += 12;
  if (segment?.stateChanged) score += 3;
  return score;
}

/** Keep a concise chronological hook → interaction → payoff arc. */
export function selectStoryArc(
  segments,
  { minSegments = 3, maxSegments = 5 } = {},
) {
  const source = Array.isArray(segments) ? segments : [];
  if (source.length <= maxSegments) {
    return { segments: [...source], dropped: [] };
  }

  const entries = source.map((segment, index) => ({
    segment,
    index,
    phase: storyPhaseOf(segment, index),
    score: storyValueScore(segment, index),
  }));
  const picked = new Set();
  const pickBest = (phase) => {
    const best = entries
      .filter((entry) => entry.phase === phase && !picked.has(entry.index))
      .sort((a, b) => b.score - a.score || a.index - b.index)[0];
    if (best) picked.add(best.index);
  };
  pickBest("hook");
  pickBest("action");
  pickBest("outcome");

  for (const entry of [...entries].sort(
    (a, b) => b.score - a.score || a.index - b.index,
  )) {
    if (picked.size >= maxSegments) break;
    picked.add(entry.index);
  }
  for (const entry of entries) {
    if (picked.size >= Math.min(minSegments, source.length)) break;
    picked.add(entry.index);
  }

  const selected = entries
    .filter((entry) => picked.has(entry.index))
    .sort((a, b) => a.index - b.index);
  return {
    segments: selected.map((entry) => entry.segment),
    dropped: entries
      .filter((entry) => !picked.has(entry.index))
      .map((entry) => ({
        sourceIndex: entry.index,
        reason: "lower-value story beat",
      })),
  };
}

export function assessVisualStory({
  segments,
  frames = [],
  minSegments = 3,
}) {
  const source = Array.isArray(segments) ? segments : [];
  const reasons = [];
  const phases = source.map((segment, index) => storyPhaseOf(segment, index));
  const hasInteraction = source.some((segment) =>
    ["click", "type", "nav"].includes(segment?.stepKind),
  );
  const expectsOutcome = source.some(
    (segment) =>
      segment?.resultExpected ||
      /\b(generate|submit|send|create|draft|run|analy[sz]e|convert|render|apply|predict|calculate|check|search|ask|compose|transform|process|summari[sz]e|translate)\b/i.test(
        `${segment?.description || ""} ${segment?.caption || ""}`,
      ),
  );
  const hasVerifiedOutcome = source.some((segment) => segment?.resultVerified);
  const falseOutcomeCaption = source.some((segment) => {
    const caption = String(segment?.caption || "");
    return (
      !segment?.resultVerified &&
      segment?.stepKind === "pause" &&
      /\b(review|see|view|look at)\b.*\b(result|output|response|preview)\b/i.test(
        caption,
      )
    );
  });

  const representatives = [];
  for (const frame of frames.filter(Boolean)) {
    if (
      representatives.every(
        (representative) =>
          normalizedFrameDifference(representative, frame) >
          VISUAL_DUPLICATE_THRESHOLD,
      )
    ) {
      representatives.push(frame);
    }
  }

  if (source.length < minSegments) reasons.push("too few story beats");
  if (!hasInteraction) reasons.push("no visible interaction");
  const reviewedFrameCount = frames.filter(Boolean).length;
  if (source.length && frames.length && reviewedFrameCount === 0) {
    reasons.push("rendered frames were unavailable for visual review");
  } else if (reviewedFrameCount && representatives.length < 2) {
    reasons.push("fewer than two visually distinct rendered states");
  }
  if (expectsOutcome && !hasVerifiedOutcome) {
    reasons.push("result-producing action has no verified outcome");
  }
  if (falseOutcomeCaption) reasons.push("outcome caption is not visually proven");

  return {
    ok: reasons.length === 0,
    lowConfidence: reasons.length > 0,
    reasons,
    phases,
    distinctVisualStates: representatives.length,
    hasInteraction,
    expectsOutcome,
    hasVerifiedOutcome,
    confidence: Math.max(0, 1 - reasons.length * 0.2),
  };
}

export function normalizedFrameDifference(left, right) {
  if (!left || !right || left.length === 0 || left.length !== right.length) {
    return 1;
  }
  let total = 0;
  for (let i = 0; i < left.length; i += 1) {
    total += Math.abs(left[i] - right[i]);
  }
  return total / (left.length * 255);
}

export function segmentValueScore(segment) {
  const text = textOf(segment);
  const kind = segment?.stepKind || "pause";
  let score = 0;

  if (kind === "click" || kind === "type") score += 4;
  else if (kind === "nav") score += 2;
  if (segment?.caption) score += 1;

  if (/\b(result|output|preview|response|success|created|generated|copied|saved|published|shipping|live)\b/.test(text)) {
    score += 5;
  }
  if (/\b(install|command|self-host|try|demo|create|generate|copy|share|export|submit)\b/.test(text)) {
    score += 3;
  }
  if (/\bmeet\b/.test(text)) score += 2;
  if (/\b(footer|back to top|learn more|read more)\b/.test(text)) score -= 5;
  if (/\b(?:see|view|explore|browse|discover)\s+(?:the\s+)?(?:full\s+)?(?:platform|site|website|product)\b/.test(text)) {
    score -= 4;
  }

  const box = segment?.box;
  if (box && Number.isFinite(box.y) && Number.isFinite(box.h)) {
    if (box.y + box.h / 2 > 1080 * 0.82) score -= 3;
  } else if (kind === "pause") {
    score -= 1;
  }
  return score;
}

function passiveBeat(segment) {
  return segment?.stepKind === "pause" || segment?.stepKind === "nav";
}

export function dedupeVisualSegments(
  segments,
  frames,
  {
    minSegments = 3,
    minBodySeconds = MIN_RENDERED_BODY_SECONDS,
    threshold = VISUAL_DUPLICATE_THRESHOLD,
  } = {},
) {
  const source = segments.map((segment, index) => ({
    segment,
    frame: frames[index] || null,
    sourceIndex: index,
  }));
  const kept = [];
  const dropped = [];
  const totalDuration = segments.reduce((sum, segment) => sum + durationOf(segment), 0);
  let droppedDuration = 0;

  for (const current of source) {
    const previous = kept[kept.length - 1];
    const difference = previous
      ? normalizedFrameDifference(previous.frame, current.frame)
      : 1;
    const canRemove =
      previous &&
      passiveBeat(previous.segment) &&
      passiveBeat(current.segment) &&
      difference <= threshold &&
      segments.length - dropped.length > minSegments;

    if (!canRemove) {
      kept.push(current);
      continue;
    }

    const previousScore = segmentValueScore(previous.segment);
    const currentScore = segmentValueScore(current.segment);
    const removePrevious = currentScore > previousScore;
    const candidate = removePrevious ? previous : current;
    const candidateDuration = durationOf(candidate.segment);
    if (totalDuration - droppedDuration - candidateDuration < minBodySeconds) {
      kept.push(current);
      continue;
    }

    droppedDuration += candidateDuration;
    dropped.push({
      sourceIndex: candidate.sourceIndex,
      difference,
      reason: "near-identical passive shot",
    });
    if (removePrevious) kept[kept.length - 1] = current;
  }

  return {
    segments: kept.map((entry) => entry.segment),
    dropped,
  };
}

export function isWeakEndingSegment(segment) {
  const text = textOf(segment);
  const kind = segment?.stepKind || "pause";
  const genericDestination =
    /\b(?:see|view|explore|browse|discover)\s+(?:the\s+)?(?:full\s+)?(?:platform|site|website|product)\b/.test(
      text,
    );
  const utility = /\b(footer|back to top|learn more|read more|privacy|terms)\b/.test(text);
  const box = segment?.box;
  const targetLow =
    box &&
    Number.isFinite(box.y) &&
    Number.isFinite(box.h) &&
    box.y + box.h / 2 > 1080 * 0.82;
  return (kind === "pause" || kind === "nav") && (genericDestination || utility || targetLow);
}

export function selectMeaningfulEnding(
  segments,
  {
    minSegments = 3,
    minBodySeconds = MIN_RENDERED_BODY_SECONDS,
  } = {},
) {
  const selected = [...segments];
  const changes = [];
  if (selected.length <= 1 || !isWeakEndingSegment(selected[selected.length - 1])) {
    return { segments: selected, changes };
  }

  const last = selected[selected.length - 1];
  let strongestIndex = 0;
  for (let i = 1; i < selected.length - 1; i += 1) {
    if (segmentValueScore(selected[i]) >= segmentValueScore(selected[strongestIndex])) {
      strongestIndex = i;
    }
  }
  const lastScore = segmentValueScore(last);
  const strongestScore = segmentValueScore(selected[strongestIndex]);
  if (strongestScore < lastScore + 2) return { segments: selected, changes };

  const withoutLastDuration = selected
    .slice(0, -1)
    .reduce((sum, segment) => sum + durationOf(segment), 0);
  if (
    selected.length - 1 >= minSegments &&
    withoutLastDuration >= minBodySeconds
  ) {
    selected.pop();
    changes.push({ reason: "removed weak trailing shot", sourceIndex: segments.length - 1 });
    return { segments: selected, changes };
  }

  const [strongest] = selected.splice(strongestIndex, 1);
  selected.push(strongest);
  changes.push({
    reason: "promoted strongest product moment to ending",
    sourceIndex: strongestIndex,
  });
  return { segments: selected, changes };
}

export function assessRenderedVideo({
  durationSec,
  bodyDurationSec,
  width,
  height,
  fps,
  hasVideo,
  hasAudio,
  bytes,
  renderedSegments,
  minBodySegments = 0,
}) {
  const reasons = [];
  if (!hasVideo) reasons.push("missing video stream");
  if (!hasAudio) reasons.push("missing audio stream");
  if (width !== 1920 || height !== 1080) {
    reasons.push(`expected 1920x1080 output (got ${width || 0}x${height || 0})`);
  }
  if (!Number.isFinite(fps) || fps < 24 || fps > 31) {
    reasons.push(`unexpected frame rate (${Number.isFinite(fps) ? fps.toFixed(2) : "unknown"})`);
  }
  if (!Number.isFinite(durationSec) || durationSec < 8 || durationSec > 30.5) {
    reasons.push(`unexpected duration (${Number.isFinite(durationSec) ? durationSec.toFixed(2) : "unknown"}s)`);
  }
  if (!Number.isFinite(bytes) || bytes < 150_000) {
    reasons.push("rendered file is unexpectedly small");
  }
  if (minBodySegments > 0 && renderedSegments < minBodySegments) {
    reasons.push(`needs ${minBodySegments} rendered body beats`);
  }
  if (minBodySegments > 0 && bodyDurationSec < MIN_RENDERED_BODY_SECONDS) {
    reasons.push(`needs ${MIN_RENDERED_BODY_SECONDS}s rendered body footage`);
  }
  return { ok: reasons.length === 0, reasons };
}
