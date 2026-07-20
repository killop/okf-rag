"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { publishedBundleRecoveryState } = require("./okf_llmwiki_daemon.js");

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
}

test("requests recovery when raw Markdown exists but the published bundle is missing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "okf-daemon-recovery-"));
  try {
    const raw = path.join(root, "okf-rag-workspace", "raw", "topic");
    write(path.join(raw, "source.md"), "# Source\n");
    const state = publishedBundleRecoveryState({
      root,
      bundle: "topic",
      sources: [raw],
      okfsDir: "",
    });

    assert.equal(state.needed, true);
    assert.match(state.reason, /directory is missing/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("uses the sync manifest to detect a partially deleted published bundle", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "okf-daemon-manifest-"));
  try {
    const raw = path.join(root, "okf-rag-workspace", "raw", "topic");
    const bundle = path.join(root, "okf-rag-workspace", "okfs", "topic");
    write(path.join(raw, "source.md"), "# Source\n");
    write(path.join(bundle, "index.md"), "# Topic\n");
    write(path.join(bundle, "concepts", "alpha.md"), "---\ntype: Reference\n---\n");
    write(
      path.join(root, ".okf-rag", "llmwiki-sync", "topic.json"),
      JSON.stringify({
        files: [
          { relativePath: "index.md" },
          { relativePath: "concepts/alpha.md" },
        ],
      })
    );
    const args = { root, bundle: "topic", sources: [raw], okfsDir: "" };

    assert.equal(publishedBundleRecoveryState(args).needed, false);
    fs.rmSync(path.join(bundle, "concepts", "alpha.md"), { force: true });
    const missing = publishedBundleRecoveryState(args);
    assert.equal(missing.needed, true);
    assert.match(missing.reason, /concepts\/alpha\.md/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("does not generate an empty topic when no raw Markdown exists", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "okf-daemon-empty-"));
  try {
    const raw = path.join(root, "okf-rag-workspace", "raw", "topic");
    fs.mkdirSync(raw, { recursive: true });
    const state = publishedBundleRecoveryState({
      root,
      bundle: "topic",
      sources: [raw],
      okfsDir: "",
    });

    assert.equal(state.needed, false);
    assert.equal(state.sourceHasMarkdown, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
