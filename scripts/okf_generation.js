#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  atomicWriteJson,
  publishStagedDirectory,
  writeGenerationHistory,
} = require("./compile_okf_with_llmwiki.js");

function parseArgs(argv) {
  const command = argv[0] === "--help" || argv[0] === "-h" ? "help" : argv[0] || "list";
  const args = {
    command,
    root: process.cwd(),
    bundle: "",
    generation: "",
    noIngest: false,
    json: false,
  };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") args.root = requireValue(argv, ++i, arg);
    else if (arg === "--bundle") args.bundle = requireValue(argv, ++i, arg);
    else if (arg === "--generation") args.generation = requireValue(argv, ++i, arg);
    else if (arg === "--no-ingest") args.noIngest = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--help" || arg === "-h") args.command = "help";
    else throw new Error(`unknown argument: ${arg}`);
  }
  args.root = path.resolve(args.root);
  if (args.command !== "help" && !args.bundle) throw new Error("--bundle is required");
  return args;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function printHelp() {
  console.log(`okf_generation

Usage:
  node scripts/okf_generation.js list --bundle <topic-slug>
  node scripts/okf_generation.js rollback --bundle <topic-slug> --generation <id>

Options:
  --root DIR        Workspace root. Defaults to cwd.
  --no-ingest       Restore Markdown without rebuilding the Rust index.
  --json            Print machine-readable output.
`);
}

function listGenerations(args) {
  const root = historyRoot(args);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const manifestPath = path.join(root, entry.name, "manifest.json");
      const manifest = readJson(manifestPath, {});
      return {
        id: entry.name,
        generatedAt: manifest.generatedAt || null,
        status: manifest.generation?.status || "unknown",
        conceptCount: manifest.generation?.conceptCount ?? manifest.concepts?.length ?? 0,
        snapshot: fs.existsSync(path.join(root, entry.name, "bundle")),
      };
    })
    .sort((a, b) => b.id.localeCompare(a.id));
}

function rollbackGeneration(args) {
  if (!args.generation) throw new Error("rollback requires --generation");
  const sourceDir = path.join(historyRoot(args), args.generation, "bundle");
  const sourceManifestPath = path.join(historyRoot(args), args.generation, "manifest.json");
  if (!fs.existsSync(sourceDir) || !fs.existsSync(sourceManifestPath)) {
    throw new Error(`generation snapshot not found: ${args.generation}`);
  }
  const generationId = `${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 17)}-${process.pid}-rollback`;
  const stagingDir = path.join(args.root, ".okf-rag", "publish-staging", `${args.bundle}-${generationId}`);
  const targetBundleDir = path.join(args.root, "okf-rag-workspace", "okfs", args.bundle);
  removeDerived(stagingDir, args.root);
  fs.cpSync(sourceDir, stagingDir, { recursive: true, force: true });
  publishStagedDirectory({
    root: args.root,
    bundle: args.bundle,
    generationId,
    stagingDir,
    targetBundleDir,
  });

  const sourceManifest = readJson(sourceManifestPath, {});
  const manifest = {
    ...sourceManifest,
    generatedAt: new Date().toISOString(),
    generation: {
      ...(sourceManifest.generation || {}),
      id: generationId,
      status: "rolled-back",
      rolledBackFrom: args.generation,
      atomic: true,
    },
    targetBundleDir,
  };
  const currentManifestPath = path.join(args.root, ".okf-rag", "llmwiki-sync", `${args.bundle}.json`);
  atomicWriteJson(currentManifestPath, manifest);
  writeGenerationHistory(
    args.root,
    args.bundle,
    generationId,
    manifest,
    targetBundleDir
  );
  if (!args.noIngest) runRustIngest(args.root);
  return {
    status: "rolled-back",
    bundle: args.bundle,
    fromGeneration: args.generation,
    generation: generationId,
    targetBundleDir,
    ingested: !args.noIngest,
  };
}

function runRustIngest(root) {
  const workspaceExe = path.join(root, "okf-rag-workspace", "bin", "okf-rag.exe");
  const releaseExe = path.join(root, "target", "release", "okf-rag.exe");
  let command;
  let args;
  if (fs.existsSync(workspaceExe)) {
    command = workspaceExe;
    args = ["ingest", "--root", root];
  } else if (fs.existsSync(releaseExe)) {
    command = releaseExe;
    args = ["ingest", "--root", root];
  } else {
    command = process.platform === "win32" ? "cargo.exe" : "cargo";
    args = ["run", "-p", "okf-rag", "--release", "--", "ingest", "--root", root];
  }
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Rust ingest failed with exit code ${result.status}`);
}

function historyRoot(args) {
  return path.join(args.root, ".okf-rag", "generations", args.bundle);
}

function removeDerived(target, root) {
  const resolved = path.resolve(target);
  const derived = path.join(path.resolve(root), ".okf-rag");
  const relative = path.relative(derived, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`unsafe derived path: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "help") return printHelp();
  let result;
  if (args.command === "list") result = listGenerations(args);
  else if (args.command === "rollback") result = rollbackGeneration(args);
  else throw new Error(`unknown command: ${args.command}`);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else if (Array.isArray(result)) {
    if (result.length === 0) console.log(`no generations for bundle ${args.bundle}`);
    for (const item of result) {
      console.log(`${item.id} concepts=${item.conceptCount} status=${item.status} snapshot=${item.snapshot}`);
    }
  } else {
    console.log(`${result.status}: ${result.bundle} -> ${result.generation}`);
  }
}

try {
  main();
} catch (error) {
  console.error(`Error: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
