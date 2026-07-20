const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  booleanFromEnv,
  loadProjectLlmwikiEnv,
  parseProjectEnv,
  rootFromArgv,
} = require("./llmwiki_env.js");

test("parses allowed project LLM settings without returning secret values", () => {
  const parsed = parseProjectEnv(
    [
      "# local config",
      "LLMWIKI_PROVIDER=openai",
      'OPENAI_BASE_URL="https://example.test/v1"',
      "OPENAI_API_KEY='secret-value'",
      "UNRELATED_KEY=ignored",
    ].join("\n")
  );

  assert.equal(parsed.values.LLMWIKI_PROVIDER, "openai");
  assert.equal(parsed.values.OPENAI_BASE_URL, "https://example.test/v1");
  assert.equal(parsed.values.OPENAI_API_KEY, "secret-value");
  assert.deepEqual(parsed.ignoredKeys, ["UNRELATED_KEY"]);
});

test("loads project config while preserving explicit process environment", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "okf-rag-env-"));
  try {
    const file = path.join(root, ".okf-rag", "llmwiki.env");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      "LLMWIKI_MODEL=file-model\nOPENAI_API_KEY=file-secret\nLLMWIKI_OUTPUT_LANG=Chinese\n",
      "utf8"
    );
    const environment = { LLMWIKI_MODEL: "explicit-model" };

    const result = loadProjectLlmwikiEnv(root, environment);

    assert.equal(environment.LLMWIKI_MODEL, "explicit-model");
    assert.equal(environment.OPENAI_API_KEY, "file-secret");
    assert.equal(environment.LLMWIKI_OUTPUT_LANG, "Chinese");
    assert.deepEqual(result.configuredKeys, [
      "LLMWIKI_MODEL",
      "LLMWIKI_OUTPUT_LANG",
      "OPENAI_API_KEY",
    ]);
    assert.deepEqual(result.loadedKeys, ["LLMWIKI_OUTPUT_LANG", "OPENAI_API_KEY"]);
    assert.equal(result.exists, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("resolves project root from CLI arguments", () => {
  assert.equal(
    rootFromArgv(["--root", "child"], "C:\\workspace"),
    path.resolve("C:\\workspace", "child")
  );
});

test("parses boolean project settings strictly", () => {
  assert.equal(booleanFromEnv("true", "FLAG"), true);
  assert.equal(booleanFromEnv("0", "FLAG"), false);
  assert.throws(() => booleanFromEnv("sometimes", "FLAG"), /FLAG must be/);
});
