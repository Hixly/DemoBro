import test from "node:test";
import assert from "node:assert/strict";
import { isMeaningfulResponseMeta } from "../src/page-readiness.js";

test("recognizes same-origin product responses", () => {
  assert.equal(
    isMeaningfulResponseMeta({
      url: "https://demo.example/api/generate",
      method: "POST",
      resourceType: "fetch",
      status: 200,
      origin: "https://demo.example",
    }),
    true,
  );
});

test("ignores analytics, cross-origin, and failed responses", () => {
  const base = {
    method: "POST",
    resourceType: "xhr",
    status: 200,
    origin: "https://demo.example",
  };
  assert.equal(
    isMeaningfulResponseMeta({ ...base, url: "https://demo.example/analytics" }),
    false,
  );
  assert.equal(
    isMeaningfulResponseMeta({ ...base, url: "https://api.other.example/run" }),
    false,
  );
  assert.equal(
    isMeaningfulResponseMeta({
      ...base,
      url: "https://demo.example/api/run",
      status: 503,
    }),
    false,
  );
  assert.equal(
    isMeaningfulResponseMeta({
      ...base,
      url: "https://demo.example/api/run",
      status: 422,
    }),
    false,
  );
});
