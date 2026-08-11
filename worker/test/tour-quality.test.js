import test from "node:test";
import assert from "node:assert/strict";
import { assessTourQuality } from "../src/tour-quality.js";

const step = (kind, startMs, endMs, state) => ({
  status: "succeeded",
  stepKind: kind,
  startMs,
  endMs,
  stateFingerprint: state,
});

test("rejects title-plus-landing style recordings", () => {
  const quality = assessTourQuality({ steps: [step("pause", 0, 3200, "hero")] });
  assert.equal(quality.ok, false);
  assert.match(quality.reasons.join(" "), /successful beats/);
  assert.match(quality.reasons.join(" "), /real interaction/);
});

test("accepts a multi-state interactive first-attempt tour", () => {
  const quality = assessTourQuality({
    steps: [
      step("pause", 0, 3200, "hero"),
      step("type", 3600, 7000, "filled"),
      step("click", 7400, 11_900, "result"),
    ],
  });
  assert.equal(quality.ok, true);
  assert.equal(quality.successfulBeats, 3);
  assert.equal(quality.distinctStates, 3);
});
