import test from "node:test";
import assert from "node:assert/strict";
import {
  assessRenderedVideo,
  assessVisualStory,
  chooseBodyPlaybackSpeed,
  dedupeVisualSegments,
  normalizedFrameDifference,
  planRenderedBodyRepair,
  selectStoryArc,
  selectMeaningfulEnding,
  truthfulCaptionForSegment,
} from "../src/video-quality.js";

const segment = (description, caption, kind, start, end, box = null) => ({
  description,
  caption,
  stepKind: kind,
  start,
  end,
  box,
});

test("frame difference is normalized and deterministic", () => {
  assert.equal(
    normalizedFrameDifference(Buffer.from([0, 64]), Buffer.from([0, 64])),
    0,
  );
  assert.equal(
    normalizedFrameDifference(Buffer.from([0]), Buffer.from([255])),
    1,
  );
});

test("near-identical passive shots keep the stronger narrative beat", () => {
  const segments = [
    segment("Pause on hero CTA", "Manage agents at work", "pause", 0, 3.8),
    segment("Land on hero", "Meet Paperclip", "pause", 3.8, 7.6),
    segment("Open install", "Self-host in minutes", "click", 7.6, 11.8),
    segment("Copy command", "Start with one command", "click", 11.8, 16),
    segment("Show results", "Copied successfully", "pause", 16, 19.8),
  ];
  const same = Buffer.alloc(64 * 36, 24);
  const result = dedupeVisualSegments(
    segments,
    [same, same, Buffer.alloc(64 * 36, 80), Buffer.alloc(64 * 36, 120), Buffer.alloc(64 * 36, 160)],
  );
  assert.equal(result.segments.length, 4);
  assert.equal(result.segments[0].caption, "Meet Paperclip");
  assert.equal(result.dropped[0].sourceIndex, 0);
});

test("distinct passive shots are preserved", () => {
  const segments = [
    segment("Hero", "Meet it", "pause", 0, 4),
    segment("Features", "See features", "pause", 4, 8),
    segment("Action", "Try it", "click", 8, 12),
  ];
  const result = dedupeVisualSegments(segments, [
    Buffer.alloc(64 * 36, 10),
    Buffer.alloc(64 * 36, 80),
    Buffer.alloc(64 * 36, 160),
  ]);
  assert.equal(result.segments.length, 3);
  assert.equal(result.dropped.length, 0);
});

test("weak footer endings are removed when meaningful footage remains", () => {
  const segments = [
    segment("Hero", "Meet it", "pause", 0, 4),
    segment("Install", "Self-host", "click", 4, 8),
    segment("Copy", "Copied successfully", "click", 8, 12),
    segment("Footer", "See the full platform", "pause", 12, 16),
  ];
  const result = selectMeaningfulEnding(segments);
  assert.equal(result.segments.length, 3);
  assert.equal(result.segments.at(-1).caption, "Copied successfully");
  assert.equal(result.changes[0].reason, "removed weak trailing shot");
});

test("strongest product moment is promoted when dropping would make the tour too short", () => {
  const segments = [
    segment("Install", "Self-host", "click", 0, 3.8),
    segment("Copy", "Copied successfully", "click", 3.8, 7.6),
    segment("Footer", "See the full platform", "pause", 7.6, 11.9),
  ];
  const result = selectMeaningfulEnding(segments);
  assert.equal(result.segments.length, 3);
  assert.equal(result.segments.at(-1).caption, "Copied successfully");
  assert.equal(
    result.changes[0].reason,
    "promoted strongest product moment to ending",
  );
});

test("final media inspection accepts a healthy DemoBro render", () => {
  const result = assessRenderedVideo({
    durationSec: 18.4,
    bodyDurationSec: 14.5,
    width: 1920,
    height: 1080,
    fps: 30,
    hasVideo: true,
    hasAudio: true,
    bytes: 1_200_000,
    renderedSegments: 4,
    minBodySegments: 3,
  });
  assert.equal(result.ok, true);
});

test("near-floor body footage receives subtle render headroom", () => {
  const speed = chooseBodyPlaybackSpeed({
    contentDurationSec: 12.3,
    currentSpeed: 1,
    minBodySegments: 3,
  });
  assert.equal(Number(speed.toFixed(3)), 0.946);
  assert.equal(
    chooseBodyPlaybackSpeed({
      contentDurationSec: 14,
      currentSpeed: 1,
      minBodySegments: 3,
    }),
    1,
  );
});

test("small encoded body shortfalls are repaired with safety headroom", () => {
  const repair = planRenderedBodyRepair({
    bodyDurationSec: 11.64,
    minBodySegments: 3,
  });
  assert.equal(repair.needed, true);
  assert.equal(Number(repair.extensionSec.toFixed(2)), 0.41);
  assert.equal(Number(repair.targetSec.toFixed(2)), 12.05);
});

test("large body shortfalls still fail instead of being hidden", () => {
  const repair = planRenderedBodyRepair({
    bodyDurationSec: 9.5,
    minBodySegments: 3,
  });
  assert.equal(repair.needed, false);
});

test("story selection preserves hook, action, and verified payoff", () => {
  const segments = [
    segment("Land on hero", "Meet Product", "pause", 0, 3.8),
    segment("Browse feature one", "Feature one", "pause", 3.8, 7.6),
    segment("Browse feature two", "Feature two", "pause", 7.6, 11.4),
    segment("Type a prompt", "Describe your goal", "type", 11.4, 15.4),
    segment("Generate", "Generate the result", "click", 15.4, 19.4),
    {
      ...segment("Pause on generated result", "Review the result", "pause", 19.4, 23.4),
      resultVerified: true,
    },
  ];
  const selected = selectStoryArc(segments, { maxSegments: 5 }).segments;
  assert.equal(selected.length, 5);
  assert.equal(selected[0].caption, "Meet Product");
  assert.ok(selected.some((item) => item.stepKind === "type"));
  assert.equal(selected.at(-1).resultVerified, true);
});

test("unproven passive result captions are removed", () => {
  assert.equal(
    truthfulCaptionForSegment({
      caption: "Review the result",
      stepKind: "pause",
      resultVerified: false,
    }),
    "",
  );
  assert.equal(
    truthfulCaptionForSegment({
      caption: "Review the result",
      stepKind: "pause",
      resultVerified: true,
    }),
    "Review the result",
  );
});

test("visual review identifies a claimed result without proof", () => {
  const frames = [
    Buffer.alloc(64 * 36, 10),
    Buffer.alloc(64 * 36, 80),
    Buffer.alloc(64 * 36, 160),
  ];
  const review = assessVisualStory({
    segments: [
      segment("Land on hero", "Meet it", "pause", 0, 4),
      {
        ...segment("Generate result", "Generate the result", "click", 4, 8),
        resultExpected: true,
      },
      segment("Feature", "Fast workflow", "pause", 8, 12),
    ],
    frames,
  });
  assert.equal(review.lowConfidence, true);
  assert.match(review.reasons.join(" "), /no verified outcome/);
});

test("visual review records missing rendered frames as low confidence", () => {
  const review = assessVisualStory({
    segments: [
      segment("Land on hero", "Meet it", "pause", 0, 4),
      segment("Type a prompt", "Describe it", "type", 4, 8),
      segment("Open preview", "Preview", "click", 8, 12),
    ],
    frames: [null, null, null],
  });
  assert.equal(review.lowConfidence, true);
  assert.match(review.reasons.join(" "), /frames were unavailable/);
});

test("final media inspection blocks technically incomplete output", () => {
  const result = assessRenderedVideo({
    durationSec: 7,
    bodyDurationSec: 5,
    width: 1280,
    height: 720,
    fps: 15,
    hasVideo: true,
    hasAudio: false,
    bytes: 40_000,
    renderedSegments: 1,
    minBodySegments: 3,
  });
  assert.equal(result.ok, false);
  assert.match(result.reasons.join(" "), /audio/);
  assert.match(result.reasons.join(" "), /1920x1080/);
  assert.match(result.reasons.join(" "), /rendered body beats/);
});
