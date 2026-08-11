import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSegmentEndFilter,
  computeFramedZoom,
  planSegments,
} from "../src/render.js";

test("pause shots preserve the full-page composition", () => {
  const shot = computeFramedZoom(
    { x: 650, y: 220, w: 620, h: 520 },
    { x: 560, y: 80, w: 800, h: 900 },
    "pause",
  );
  assert.equal(shot.zoomPeak, 1);
  assert.equal(shot.cx, 960);
});

test("action emphasis stays subtle and horizontally centered", () => {
  const shot = computeFramedZoom(
    { x: 760, y: 700, w: 400, h: 64 },
    { x: 120, y: 80, w: 1680, h: 900 },
    "click",
  );
  assert.ok(shot.zoomPeak >= 1.08);
  assert.ok(shot.zoomPeak <= 1.2);
  assert.equal(shot.cx, 960);
});

test("full-bleed pages are never digitally enlarged", () => {
  const shot = computeFramedZoom(
    { x: 820, y: 500, w: 280, h: 64 },
    { x: 0, y: 0, w: 1920, h: 1080 },
    "type",
  );
  assert.equal(shot.zoomPeak, 1);
});

test("long static waits are trimmed into crisp beats", () => {
  const segments = planSegments(
    {
      steps: [
        {
          status: "succeeded",
          stepKind: "pause",
          startMs: 0,
          endMs: 8_000,
        },
      ],
    },
    10,
  );
  assert.equal(segments.length, 1);
  assert.ok(segments[0].end - segments[0].start <= 3.21);
});

test("click beats align their pulse with the recorded action", () => {
  const [segment] = planSegments(
    {
      steps: [
        {
          status: "succeeded",
          stepKind: "click",
          startMs: 1_000,
          endMs: 9_000,
          actionOffsetMs: 900,
        },
      ],
    },
    12,
  );
  assert.ok(segment.end - segment.start <= 3.81);
  assert.ok(Math.abs(segment.actionTimeSec - 0.55) < 0.01);
});

test("the final beat fades into the cream outro background", () => {
  const filter = buildSegmentEndFilter(3.2, true);
  assert.match(filter, /fade=t=out/);
  assert.match(filter, /color=0xFAF9F6/);
  assert.equal(buildSegmentEndFilter(3.2, false), "format=yuv420p");
});
