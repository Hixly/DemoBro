import test from "node:test";
import assert from "node:assert/strict";
import { buildDeterministicProductBeats } from "../src/agent-tour.js";

test("builds a generic first-attempt product loop from semantic DOM", () => {
  const beats = buildDeterministicProductBeats(
    [
      { tag: "h1", name: "Create something useful", visible: true },
      {
        tag: "textarea",
        name: "Describe your request",
        placeholder: "Describe your request",
        editable: true,
        visible: true,
      },
      { tag: "button", name: "Generate", visible: true, disabled: true },
      { tag: "input", name: "Enter your email", editable: true, visible: true },
      { tag: "button", name: "Notify Me", visible: true },
    ],
    { title: "Product" },
  );
  assert.equal(beats.length, 3);
  assert.match(beats[0].description, /Land/);
  assert.match(beats[1].description, /Type/);
  assert.match(beats[2].description, /Click/);
  assert.match(beats[2].targetHint, /Generate/);
  assert.doesNotMatch(beats.map((beat) => beat.targetHint).join(" "), /Notify|Enter your email/);
});
