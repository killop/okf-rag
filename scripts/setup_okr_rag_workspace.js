#!/usr/bin/env node
// Initializes the local OKR-RAG directory scaffold after git clone.
const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = {
    root: path.resolve(__dirname, ".."),
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) {
        throw new Error("--root requires a value");
      }
      args.root = path.resolve(value);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/setup_okr_rag_workspace.js [--root DIR]

Creates the local OKR-RAG scaffold after git clone. This script does not create,
edit, or validate .codex/config.toml. Codex MCP setup is documented in
setup-for-agent.md and should be applied manually.`);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  console.log(`dir: ${dirPath}`);
}

function writeFileIfMissing(filePath, content) {
  if (fs.existsSync(filePath)) {
    console.log(`keep: ${filePath}`);
    return;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
  console.log(`file: ${filePath}`);
}

function main() {
  const args = parseArgs(process.argv);
  const rootPath = path.resolve(args.root);

  const dirs = [
    ".okr-rag",
    ".okr-rag/models",
    ".codex",
    "okr-rag",
    "okr-rag-workspace",
    "okr-rag-workspace/okrs",
    "dist",
  ];

  for (const dir of dirs) {
    ensureDir(path.join(rootPath, dir));
  }

  writeFileIfMissing(
    path.join(rootPath, ".okr-rag", ".gitkeep"),
    "",
  );

  writeFileIfMissing(
    path.join(rootPath, ".okr-rag", "README.md"),
    [
      "# .okr-rag",
      "",
      "Derived runtime state for OKR-RAG.",
      "",
      "Generated indexes, caches, reports, lock files, and watcher state live here.",
      "Do not treat this directory as source truth. Source OKR Markdown belongs under `okr-rag-workspace/okrs/`.",
      "",
    ].join("\n"),
  );

  writeFileIfMissing(
    path.join(rootPath, ".codex", "config.toml.example"),
    [
      "[mcp_servers.okr-rag]",
      'type = "stdio"',
      'command = ".\\\\target\\\\release\\\\okr-rag.exe"',
      'args = ["mcp", "--root", "."]',
      "",
    ].join("\n"),
  );

  writeFileIfMissing(
    path.join(rootPath, "okr-rag", "README.md"),
    [
      "# okr-rag",
      "",
      "Source scaffold for the OKR-RAG Rust project.",
      "",
      "In this workspace layout, the active Rust crate lives under `crates/okr-rag/`.",
      "",
    ].join("\n"),
  );

  writeFileIfMissing(
    path.join(rootPath, "okr-rag-workspace", "README.md"),
    [
      "# okr-rag-workspace",
      "",
      "User-authored OKR Markdown lives under `okrs/`.",
      "",
      "Generated indexes and caches belong under `.okr-rag/`, not here.",
      "",
    ].join("\n"),
  );

  writeFileIfMissing(
    path.join(rootPath, "okr-rag-workspace", "index.md"),
    [
      "# OKR-RAG Workspace",
      "",
      "- `okrs/`: OKR Markdown source of truth.",
      "- `../.okr-rag/`: generated runtime state.",
      "",
    ].join("\n"),
  );

  writeFileIfMissing(
    path.join(rootPath, "okr-rag-workspace", "okrs", "index.md"),
    [
      "# OKR Sources",
      "",
      "Place OKR Markdown files in this directory, then run:",
      "",
      "```powershell",
      "target\\release\\okr-rag.exe ingest --force",
      "```",
      "",
    ].join("\n"),
  );

  writeFileIfMissing(
    path.join(rootPath, "okr-rag-workspace", "okrs", "local-first-okr-rag-demo.md"),
    [
      "---",
      "type: OKR",
      "title: Local-First OKR-RAG Demo",
      "description: Demonstrates the portable OKR-RAG workspace layout, local indexing, and project-scoped MCP setup.",
      "tags: [okr, demo, local-first, mcp, zvec]",
      "timestamp: 2026-06-24T00:00:00+08:00",
      "nocturne:",
      "  uri: okr://demo/local-first-okr-rag",
      "  disclosure: When testing whether a fresh OKR-RAG workspace can ingest, query, and expose local MCP memory.",
      "---",
      "",
      "# Local-First OKR-RAG Demo",
      "",
      "This demo OKR proves that the workspace contains at least one portable, indexable OKR memory document.",
      "",
      "## Objective 1: Make a fresh workspace queryable",
      "",
      "The workspace should become searchable without remote embedding APIs or project-specific hardcoding.",
      "",
      "### Key Results",
      "",
      "- KR1. `target\\release\\okr-rag.exe ingest --root . --force` builds a local index from `okr-rag-workspace/okrs/`.",
      "- KR2. `target\\release\\okr-rag.exe status --root .` reports at least one indexed concept.",
      "- KR3. `target\\release\\okr-rag.exe query --root . \"local first okr rag demo\"` returns this OKR.",
      "",
      "## Evidence",
      "",
      "- `setup-for-agent.md`: Agent setup and MCP config location.",
      "- `.codex/config.toml.example`: Project-local MCP config template.",
      "",
      "## Retrieval Notes",
      "",
      "- Recall this OKR for setup smoke tests, project-local MCP config, local indexing, and demo workspace validation.",
      "",
    ].join("\n"),
  );

  console.log("Codex MCP config was not changed. See setup-for-agent.md for manual project-local Codex setup.");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
