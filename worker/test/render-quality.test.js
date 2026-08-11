import test from "node:test";
import assert from "node:assert/strict";
import { computeFramedZoom } from "../src/render.js";

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
