import test from "node:test";
import assert from "node:assert/strict";
import { toUserFacingError } from "../src/job-utils.js";

test("tour quality failures hide internal metrics and explain the next step", () => {
  const message = toUserFacingError(
    new Error(
      "Tour quality check failed: needs 3 successful beats (got 0); needs a real interaction; needs 12s body footage; needs 2 distinct visual states.",
    ),
  );

  assert.equal(
    message,
    "We opened your project but couldn't capture a complete interactive demo. Nothing was published. Please try again, or send us this run so we can investigate.",
  );
  assert.doesNotMatch(message, /beats|12s|visual states/i);
});
