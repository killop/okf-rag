const assert = require("node:assert/strict");
const test = require("node:test");

const {
  sanitizeDiagnosticText,
  sanitizeDiagnosticValue,
} = require("./diagnostics.js");

test("sanitizes environment secrets and common credential shapes", () => {
  const providerKey = ["sk", "example-test-value-123456"].join("-");
  const inlineKey = ["sk", "example-another-value-123456"].join("-");
  const environment = {
    OPENAI_API_KEY: providerKey,
  };
  const text = sanitizeDiagnosticText(
    `Bearer abc.def key=visible ${inlineKey} OPENAI ${providerKey}`,
    environment
  );

  assert.equal(text.includes(providerKey), false);
  assert.equal(text.includes("abc.def"), false);
  assert.equal(text.includes(inlineKey), false);
  assert.match(text, /REDACTED/);
});

test("sanitizes nested values by secret-bearing key", () => {
  const sanitized = sanitizeDiagnosticValue({
    provider: { apiKey: "plain-value", baseURL: "https://example.test/v1" },
    error: "authorization=top-secret",
  });

  assert.equal(sanitized.provider.apiKey, "[REDACTED]");
  assert.equal(sanitized.provider.baseURL, "https://example.test/v1");
  assert.equal(sanitized.error.includes("top-secret"), false);
});
