#!/usr/bin/env node
// Initializes the OKF-RAG scaffold in the current target workspace.
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");

const RUNTIME_FILES = [
  "okf-rag.exe",
  "onnxruntime.dll",
  "onnxruntime_providers_shared.dll",
  "zvec_c_api.dll",
];

const TOOL_FILES = [
  "bench_okf_daemon_incremental.js",
  "bench_okf_relationships.js",
  "compile_okf_with_llmwiki.js",
  "diagnostics.js",
  "llmwiki_env.js",
  "okf_generation.js",
  "okf_llmwiki_daemon.js",
  "okf_maintain.js",
  "okf_pipeline.js",
  "okf_relationships.js",
  "openai_stream_adapter.js",
];

const SKILL_NAME = "okf-rag-okf-format";
const GITIGNORE_HEADER = "# OKF-RAG managed ignore";
const GITIGNORE_FOOTER = "# end OKF-RAG managed ignore";
const AGENT_BLOCK_START = "<!-- OKF-RAG:START -->";
const AGENT_BLOCK_END = "<!-- OKF-RAG:END -->";
const MINILM_PROVIDER = "minilm-l6-v2-onnx";
const MINILM_MODEL_DIR = "all-MiniLM-L6-v2";

function parseArgs(argv) {
  const args = {
    target: null,
    runtimeSource: null,
    allowSourceInstall: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--target" || arg === "--root") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      if (args.target) {
        throw new Error("Pass only one target directory. Use --target DIR.");
      }
      args.target = path.resolve(value);
    } else if (arg === "--runtime-source") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) {
        throw new Error("--runtime-source requires a value");
      }
      args.runtimeSource = path.resolve(value);
    } else if (arg === "--allow-source-install") {
      args.allowSourceInstall = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.target) {
    throw new Error("--target is required. Pass the agent's current project workspace root, not the okf-rag source repo.");
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/setup_okf_rag_workspace.js --target DIR [--runtime-source DIR]

Creates the local OKF-RAG workspace scaffold and copies the prebuilt runtime
into okf-rag-workspace/bin when release artifacts are available. It also
copies the bundled local MiniLM model when present, installs the OKF writing
skill into .agents/skills, installs portable orchestration tools under
okf-rag-workspace/tools, removes stale non-MiniLM index state, and writes
the tracked .gitignore rules for .okf-rag and okf-rag-workspace. It creates
.okf-rag/llmwiki.env.example for project-local provider configuration.

--target must be the project workspace where the current agent is working.
Do not point it at the okf-rag source repo. The script refuses that by default.
Use --allow-source-install only when intentionally dogfooding this source repo.

This script does not create, edit, or validate .codex/config.toml. Codex MCP
setup is documented in setup-for-agent.md and should be applied manually.`);
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

function hasRuntimeFiles(dirPath) {
  return RUNTIME_FILES.every((fileName) => fs.existsSync(path.join(dirPath, fileName)));
}

function hasMiniLmModel(dirPath) {
  return fs.existsSync(path.join(dirPath, "onnx", "model.onnx")) &&
    fs.existsSync(path.join(dirPath, "tokenizer.json"));
}

function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function firstRuntimeSource(targetPath, runtimeSource) {
  if (runtimeSource) {
    if (!hasRuntimeFiles(runtimeSource)) {
      throw new Error(`Missing one or more runtime artifacts in: ${runtimeSource}`);
    }
    return runtimeSource;
  }

  const scriptRoot = path.resolve(__dirname, "..");
  const candidates = [
    path.join(targetPath, "target", "release"),
    path.join(scriptRoot, "target", "release"),
    path.join(targetPath, "okf-rag-workspace", "bin"),
    path.join(scriptRoot, "okf-rag-workspace", "bin"),
  ];

  return candidates.find((candidate) => hasRuntimeFiles(candidate)) || null;
}

function copyFileIfChanged(source, destination) {
  if (path.resolve(source).toLowerCase() === path.resolve(destination).toLowerCase()) {
    console.log(`keep: ${destination}`);
    return;
  }

  if (fs.existsSync(destination)) {
    if (fileDigest(source) === fileDigest(destination)) {
      console.log(`keep: ${destination}`);
      return;
    }
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  console.log(`runtime: ${destination}`);
}

function fileDigest(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function copyRuntimeArtifacts(targetPath, runtimeSource) {
  const sourceDir = firstRuntimeSource(targetPath, runtimeSource);
  const destinationDir = path.join(targetPath, "okf-rag-workspace", "bin");

  if (!sourceDir) {
    console.log("runtime: not found; build release or pass --runtime-source, then rerun setup");
    return;
  }

  for (const fileName of RUNTIME_FILES) {
    copyFileIfChanged(path.join(sourceDir, fileName), path.join(destinationDir, fileName));
  }
}

function copyToolScripts(sourceRoot, targetPath) {
  const sourceDir = path.join(sourceRoot, "scripts");
  const destinationDir = path.join(targetPath, "okf-rag-workspace", "tools");
  fs.mkdirSync(destinationDir, { recursive: true });
  for (const fileName of TOOL_FILES) {
    const source = path.join(sourceDir, fileName);
    if (!fs.existsSync(source)) {
      throw new Error(`Missing bundled OKF-RAG tool: ${source}`);
    }
    copyFileIfChanged(source, path.join(destinationDir, fileName));
  }
}

function copyMiniLmModelIfPresent(sourceRoot, targetPath) {
  const sourceModel = path.join(sourceRoot, ".okf-rag", "models", MINILM_MODEL_DIR);
  const destinationModel = path.join(targetPath, ".okf-rag", "models", MINILM_MODEL_DIR);

  if (samePath(sourceModel, destinationModel)) {
    console.log(`model: keep ${destinationModel}`);
    return;
  }

  if (!hasMiniLmModel(sourceModel)) {
    console.log(`model: not found at ${sourceModel}`);
    console.log(`model: place sentence-transformers/all-MiniLM-L6-v2 under ${destinationModel}`);
    return;
  }

  fs.mkdirSync(path.dirname(destinationModel), { recursive: true });
  fs.cpSync(sourceModel, destinationModel, { recursive: true, force: true });
  console.log(`model: ${destinationModel}`);
}

function removePathIfExists(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return;
  }
  fs.rmSync(targetPath, { recursive: true, force: true });
  console.log(`stale: removed ${targetPath}`);
}

function cleanStaleEmbeddingState(targetPath) {
  const metaPath = path.join(targetPath, ".okf-rag");
  const embeddingPath = path.join(metaPath, "embedding.json");
  if (!fs.existsSync(embeddingPath)) {
    return;
  }

  let provider = "";
  try {
    provider = JSON.parse(fs.readFileSync(embeddingPath, "utf8")).provider || "";
  } catch {
    provider = "unreadable";
  }

  if (provider === MINILM_PROVIDER) {
    return;
  }

  removePathIfExists(path.join(metaPath, "embedding.json"));
  removePathIfExists(path.join(metaPath, "ingest-state.json"));
  removePathIfExists(path.join(metaPath, "active-slot.json"));
  removePathIfExists(path.join(metaPath, "manifest.tsv"));
  removePathIfExists(path.join(metaPath, "watcher-state.json"));
  removePathIfExists(path.join(metaPath, "ingest.lock"));
  removePathIfExists(path.join(metaPath, "index"));
  removePathIfExists(path.join(metaPath, "cache", "embeddings"));
}

function copySkillIfPresent(sourceRoot, targetPath) {
  const sourceSkill = path.join(sourceRoot, "skills", SKILL_NAME);
  if (!fs.existsSync(sourceSkill)) {
    console.log(`skill: missing ${sourceSkill}`);
    return;
  }

  const destinationSkill = path.join(targetPath, ".agents", "skills", SKILL_NAME);
  fs.mkdirSync(path.dirname(destinationSkill), { recursive: true });
  fs.cpSync(sourceSkill, destinationSkill, { recursive: true, force: true });
  console.log(`skill: ${destinationSkill}`);
}

function ensureGitignore(targetPath) {
  const gitignorePath = path.join(targetPath, ".gitignore");
  const block = [
    GITIGNORE_HEADER,
    "/.okf-rag/",
    "!/okf-rag-workspace/",
    "!/okf-rag-workspace/**",
    GITIGNORE_FOOTER,
  ].join("\n");

  const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf8") : "";
  const start = existing.indexOf(GITIGNORE_HEADER);
  const end = start >= 0 ? existing.indexOf(GITIGNORE_FOOTER, start) : -1;

  if (start >= 0 && end >= 0) {
    const afterEnd = end + GITIGNORE_FOOTER.length;
    const updated = `${existing.slice(0, start)}${block}${existing.slice(afterEnd)}`;
    if (updated === existing) {
      console.log(`gitignore: keep ${gitignorePath}`);
      return;
    }
    fs.writeFileSync(gitignorePath, updated, "utf8");
    console.log(`gitignore: ${gitignorePath}`);
    return;
  }

  const next = existing.endsWith("\n") || existing.length === 0 ? existing : `${existing}\n`;
  fs.writeFileSync(gitignorePath, `${next}\n${block}\n`, "utf8");
  console.log(`gitignore: ${gitignorePath}`);
}

function ensureManagedAgentBlock(targetPath, fileName) {
  const filePath = path.join(targetPath, fileName);
  const block = [
    AGENT_BLOCK_START,
    "## OKF-RAG",
    "",
    "Use the installed `okf-rag-okf-format` skill for OKF generation and maintenance.",
    "When OKF-RAG MCP is available, query it before searching raw OKF Markdown and do not repeat the same lookup with shell grep/rg.",
    "After MCP tools/list, background bootstrap starts daemons for raw topic folders containing Markdown; missing daemon-managed OKF output is regenerated automatically.",
    "Use `okf_rag_relationships` to inspect outgoing relations and incoming backlinks for a known concept.",
    "Keep OKF Markdown portable: never publish host absolute paths; use bundle-local relative `source_refs`, portable `okf-source://` source IDs, and Obsidian `[[file|title]]` relationship links.",
    "Project-local LLM provider settings belong in `.okf-rag/llmwiki.env`; keep keys out of Markdown and command arguments.",
    "Read `.okf-rag/INSTRUCTIONS.md` for project-owned generation priorities. Put daemon input under `okf-rag-workspace/raw/<topic-slug>/`; daemon-managed bundle output lives under `okf-rag-workspace/okfs/<topic-slug>/` and should not be edited as raw input.",
    AGENT_BLOCK_END,
  ].join("\n");
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  const start = existing.indexOf(AGENT_BLOCK_START);
  const end = start >= 0 ? existing.indexOf(AGENT_BLOCK_END, start) : -1;
  const next =
    start >= 0 && end >= 0
      ? `${existing.slice(0, start)}${block}${existing.slice(end + AGENT_BLOCK_END.length)}`
      : `${existing.trimEnd()}${existing.trim() ? "\n\n" : ""}${block}\n`;
  if (next !== existing) fs.writeFileSync(filePath, next, "utf8");
  console.log(`agent: ${filePath}`);
}

function main() {
  const args = parseArgs(process.argv);
  const targetPath = path.resolve(args.target);
  const sourceRoot = path.resolve(__dirname, "..");

  if (samePath(targetPath, sourceRoot) && !args.allowSourceInstall) {
    throw new Error([
      "Refusing to install into the okf-rag source repo.",
      `source repo: ${sourceRoot}`,
      "Pass --target <agent project workspace root> instead.",
      "If you are intentionally testing this source repo, add --allow-source-install.",
    ].join("\n"));
  }

  const dirs = [
    ".okf-rag",
    ".okf-rag/models",
    "okf-rag-workspace",
    "okf-rag-workspace/bin",
    "okf-rag-workspace/tools",
    "okf-rag-workspace/raw",
    "okf-rag-workspace/okfs",
  ];

  for (const dir of dirs) {
    ensureDir(path.join(targetPath, dir));
  }

  writeFileIfMissing(
    path.join(targetPath, ".okf-rag", ".gitkeep"),
    "",
  );

  writeFileIfMissing(
    path.join(targetPath, "okf-rag-workspace", "raw", ".gitkeep"),
    "",
  );

  writeFileIfMissing(
    path.join(targetPath, ".okf-rag", "README.md"),
    [
      "# .okf-rag",
      "",
      "Local configuration and derived runtime state for OKF-RAG.",
      "",
      "Generated indexes, caches, reports, lock files, and watcher state live here.",
      "Project-local LLM credentials and provider settings live in `llmwiki.env`; this file is ignored by Git and is never published as OKF knowledge.",
      "Do not treat this directory as source truth. Source OKF Markdown belongs under `okf-rag-workspace/okfs/`.",
      "",
    ].join("\n"),
  );

  writeFileIfMissing(
    path.join(targetPath, ".okf-rag", "llmwiki.env.example"),
    [
      "# Copy to .okf-rag/llmwiki.env and fill the values for this project.",
      "# Explicit process environment variables override this file.",
      "LLMWIKI_PROVIDER=openai",
      "OPENAI_BASE_URL=https://your-gateway.example/v1",
      "OPENAI_API_KEY=",
      "LLMWIKI_MODEL=your-model-name",
      "LLMWIKI_STREAM_ONLY_OPENAI=true",
      "LLMWIKI_OUTPUT_LANG=Chinese",
      "LLMWIKI_COMPILE_CONCURRENCY=1",
      "",
    ].join("\n"),
  );

  writeFileIfMissing(
    path.join(targetPath, "okf-rag-workspace", "README.md"),
    [
      "# okf-rag-workspace",
      "",
      "User-authored OKF Markdown lives under `okfs/`.",
      "",
      "Raw Markdown for daemon-managed generation lives under `raw/<topic-slug>/`.",
      "Start one daemon per topic without `--source` to create and watch that inbox automatically.",
      "",
      "The workspace-local runtime entrypoint lives under `bin/` when prebuilt artifacts are available.",
      "",
      "Portable pipeline, daemon, maintenance, and benchmark scripts live under `tools/`.",
      "",
      "Generated vector indexes and caches belong under `../.okf-rag/`. Deterministic Markdown navigation indexes may live under `okfs/`.",
      "",
    ].join("\n"),
  );

  writeFileIfMissing(
    path.join(targetPath, "okf-rag-workspace", "bin", "README.md"),
    [
      "# OKF-RAG Runtime",
      "",
      "Setup and release packaging place the runnable MCP executable and required DLLs here:",
      "",
      "```text",
      "okf-rag-workspace/bin/okf-rag.exe",
      "okf-rag-workspace/bin/onnxruntime.dll",
      "okf-rag-workspace/bin/onnxruntime_providers_shared.dll",
      "okf-rag-workspace/bin/zvec_c_api.dll",
      "```",
      "",
      "Point MCP hosts at this workspace-local executable, not at a repository build directory.",
      "",
    ].join("\n"),
  );

  writeFileIfMissing(
    path.join(targetPath, ".okf-rag", "INSTRUCTIONS.md"),
    [
      "# OKF-RAG Instructions",
      "",
      "Project-owned generation priorities belong here. This file is preserved by setup and is not published as OKF knowledge.",
      "",
    ].join("\n"),
  );

  writeFileIfMissing(
    path.join(targetPath, "okf-rag-workspace", "okfs", "local-first-okf-rag-demo.md"),
    [
      "---",
      "type: Reference",
      "title: Local-First OKF-RAG Demo",
      "description: Demonstrates the portable OKF-RAG workspace layout, local indexing, and project-scoped MCP setup.",
      "resource: okf://demo/local-first-okf-rag",
      "tags: [okf, demo, local-first, mcp, zvec]",
      "timestamp: 2026-06-24T00:00:00+08:00",
      "uri: okf://demo/local-first-okf-rag",
      "disclosure: When testing whether a fresh OKF-RAG workspace can ingest, query, and expose local MCP memory.",
      "---",
      "",
      "# Local-First OKF-RAG Demo",
      "",
      "This demo OKF proves that the workspace contains at least one portable, indexable OKF memory document.",
      "",
      "## Objective 1: Make a fresh workspace queryable",
      "",
      "The workspace should become searchable without remote embedding APIs or project-specific hardcoding.",
      "",
      "### Key Results",
      "",
      "- KR1. `okf-rag-workspace\\bin\\okf-rag.exe ingest --root . --force` builds a local index from `okf-rag-workspace/okfs/`.",
      "- KR2. `okf-rag-workspace\\bin\\okf-rag.exe status --root .` reports at least one indexed concept.",
      "- KR3. `okf-rag-workspace\\bin\\okf-rag.exe query --root . \"local first okf rag demo\"` returns this OKF.",
      "",
      "## Evidence",
      "",
      "- `setup-for-agent.md`: Agent setup and MCP config location.",
      "",
      "## Retrieval Notes",
      "",
      "- Recall this OKF for setup smoke tests, project-local MCP config, local indexing, and demo workspace validation.",
      "",
    ].join("\n"),
  );

  copyRuntimeArtifacts(targetPath, args.runtimeSource);
  copyToolScripts(sourceRoot, targetPath);
  copyMiniLmModelIfPresent(sourceRoot, targetPath);
  cleanStaleEmbeddingState(targetPath);
  copySkillIfPresent(sourceRoot, targetPath);
  ensureGitignore(targetPath);
  ensureManagedAgentBlock(targetPath, "AGENTS.md");
  ensureManagedAgentBlock(targetPath, "CLAUDE.md");

  console.log(`target: ${targetPath}`);
  console.log("Codex MCP config was not changed. See setup-for-agent.md for manual project-local Codex setup.");
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
