#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const {
  sanitizeDiagnosticText,
  sanitizeDiagnosticValue,
} = require("./diagnostics.js");
const {
  booleanFromEnv,
  loadProjectLlmwikiEnv,
  rootFromArgv,
} = require("./llmwiki_env.js");

const OUTPUT_RECOVERY_INTERVAL_MS = 30_000;

function parseCli(argv) {
  const knownCommands = new Set(["run", "start", "stop", "status", "supervise"]);
  const command = knownCommands.has(argv[0]) ? argv[0] : "run";
  const rest = command === "run" && argv[0] !== "run" ? argv : argv.slice(1);

  const args = {
    command,
    root: process.cwd(),
    sources: [],
    inbox: "",
    bundle: "",
    project: "",
    exportDir: "",
    okfsDir: "",
    okfRagBin: process.env.OKF_RAG_BIN || "",
    llmwikiRoot: process.env.LLMWIKI_REPO || "",
    llmwikiBin: process.env.LLMWIKI_BIN || "",
    llmwikiPackage: process.env.LLMWIKI_PACKAGE || "",
    nodePackage: process.env.LLMWIKI_NODE_PACKAGE || "",
    llmwikiRuntime: process.env.LLMWIKI_RUNTIME_DIR || "",
    provider: process.env.LLMWIKI_PROVIDER || "",
    model: process.env.LLMWIKI_MODEL || "",
    openaiBaseUrl: process.env.OPENAI_BASE_URL || "",
    streamOnlyOpenai: booleanFromEnv(
      process.env.LLMWIKI_STREAM_ONLY_OPENAI,
      "LLMWIKI_STREAM_ONLY_OPENAI"
    ),
    streamAdapterPort: 0,
    lang: process.env.LLMWIKI_OUTPUT_LANG || "Chinese",
    concurrency: process.env.LLMWIKI_COMPILE_CONCURRENCY || "",
    mirrorWorkspace: process.env.OKF_RAG_MIRROR_WORKSPACE || "",
    debounceMs: 1500,
    watchProjectSources: null,
    initial: true,
    once: false,
    resetProject: false,
    stageOnly: false,
    skipCompile: false,
    skipLint: false,
    strictLint: false,
    skipMaintain: false,
    noPruneSources: false,
    writeLinks: true,
    writeIndex: false,
    failOnDuplicates: false,
    noRecallFields: false,
    noIngest: false,
    force: false,
    dryRun: false,
    fastSkip: true,
    authoritativePrune: true,
    deterministicDedupe: true,
    atomicPublish: true,
    json: false,
    help: false,
  };

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--root") args.root = requireValue(rest, ++i, arg);
    else if (arg === "--source") args.sources.push(requireValue(rest, ++i, arg));
    else if (arg === "--inbox") args.inbox = requireValue(rest, ++i, arg);
    else if (arg === "--bundle") args.bundle = requireValue(rest, ++i, arg);
    else if (arg === "--llmwiki-project") args.project = requireValue(rest, ++i, arg);
    else if (arg === "--export-dir") args.exportDir = requireValue(rest, ++i, arg);
    else if (arg === "--okfs-dir") args.okfsDir = requireValue(rest, ++i, arg);
    else if (arg === "--okf-rag-bin") args.okfRagBin = requireValue(rest, ++i, arg);
    else if (arg === "--llmwiki-root") args.llmwikiRoot = requireValue(rest, ++i, arg);
    else if (arg === "--llmwiki-bin") args.llmwikiBin = requireValue(rest, ++i, arg);
    else if (arg === "--llmwiki-package") args.llmwikiPackage = requireValue(rest, ++i, arg);
    else if (arg === "--node-package") args.nodePackage = requireValue(rest, ++i, arg);
    else if (arg === "--llmwiki-runtime") args.llmwikiRuntime = requireValue(rest, ++i, arg);
    else if (arg === "--provider") args.provider = requireValue(rest, ++i, arg);
    else if (arg === "--model") args.model = requireValue(rest, ++i, arg);
    else if (arg === "--openai-base-url") args.openaiBaseUrl = requireValue(rest, ++i, arg);
    else if (arg === "--stream-only-openai") args.streamOnlyOpenai = true;
    else if (arg === "--stream-adapter-port") {
      args.streamAdapterPort = parseNonNegativeInt(requireValue(rest, ++i, arg), arg);
    }
    else if (arg === "--lang") args.lang = requireValue(rest, ++i, arg);
    else if (arg === "--concurrency") args.concurrency = String(parsePositiveInt(requireValue(rest, ++i, arg), arg));
    else if (arg === "--mirror-workspace") args.mirrorWorkspace = requireValue(rest, ++i, arg);
    else if (arg === "--debounce-ms") args.debounceMs = parsePositiveInt(requireValue(rest, ++i, arg), arg);
    else if (arg === "--watch-project-sources") args.watchProjectSources = true;
    else if (arg === "--no-watch-project-sources") args.watchProjectSources = false;
    else if (arg === "--no-initial") args.initial = false;
    else if (arg === "--once") args.once = true;
    else if (arg === "--reset-project") args.resetProject = true;
    else if (arg === "--stage-only") args.stageOnly = true;
    else if (arg === "--skip-compile") args.skipCompile = true;
    else if (arg === "--skip-lint") args.skipLint = true;
    else if (arg === "--strict-lint") args.strictLint = true;
    else if (arg === "--skip-maintain") args.skipMaintain = true;
    else if (arg === "--no-prune-sources") args.noPruneSources = true;
    else if (arg === "--write-links") args.writeLinks = true;
    else if (arg === "--no-write-links") args.writeLinks = false;
    else if (arg === "--write-index") args.writeIndex = true;
    else if (arg === "--fail-on-duplicates") args.failOnDuplicates = true;
    else if (arg === "--no-recall-fields") args.noRecallFields = true;
    else if (arg === "--no-ingest") args.noIngest = true;
    else if (arg === "--force") args.force = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--no-fast-skip") args.fastSkip = false;
    else if (arg === "--no-authoritative-prune") args.authoritativePrune = false;
    else if (arg === "--no-deterministic-dedupe") args.deterministicDedupe = false;
    else if (arg === "--no-atomic-publish") args.atomicPublish = false;
    else if (arg === "--json") args.json = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }

  return args;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parsePositiveInt(value, flag) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`${flag} requires a positive integer`);
  }
  return parsed;
}

function parseNonNegativeInt(value, flag) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${flag} requires a non-negative integer`);
  }
  return parsed;
}

function printHelp() {
  console.log(`okf_llmwiki_daemon

Run llm-wiki-compiler as a long-lived OKF producer for okf-rag.

Commands:
  run      Run in the foreground.
  start    Start a detached background daemon and write a pid/log file.
  stop     Stop the background daemon for a bundle.
  status   Show pid/log/status for a bundle.

Usage:
  node scripts/okf_llmwiki_daemon.js run --source docs/raw.md --bundle resource-hot-update-yooasset
  node scripts/okf_llmwiki_daemon.js start --source docs/raw.md --bundle resource-hot-update-yooasset
  node scripts/okf_llmwiki_daemon.js status --bundle resource-hot-update-yooasset
  node scripts/okf_llmwiki_daemon.js stop --bundle resource-hot-update-yooasset

Important options:
  --root DIR                 okf-rag workspace root. Defaults to cwd.
  --source PATH_OR_URL       Markdown file/directory or source to ingest. May repeat.
  --inbox DIR                Watched raw Markdown inbox. Cannot be combined with --source.
                             Defaults to okf-rag-workspace/raw/<bundle>/ when no source is given.
  --bundle SLUG              Target folder under okf-rag-workspace/okfs.
  --llmwiki-project DIR      Persistent llmwiki project. Defaults to .okf-rag/llmwiki-projects/<bundle>.
  --okf-rag-bin EXE          Explicit Rust okf-rag executable for ingest.
  --mirror-workspace DIR     Copy okf-rag-workspace elsewhere after each successful run.
  --lang TEXT                llmwiki compile language. Defaults to Chinese.
  --provider NAME            Set LLMWIKI_PROVIDER for llmwiki commands.
  --model NAME               Set LLMWIKI_MODEL.
  --openai-base-url URL      Set the OpenAI-compatible base URL without exposing the key.
  --stream-only-openai       Adapt non-stream llmwiki calls to a stream-only upstream API.
  --concurrency N            Max concurrent llmwiki LLM calls.
  --debounce-ms N            File-change debounce. Defaults to 1500.
  --watch-project-sources    Also watch the llmwiki project's sources/ directory.
  --no-watch-project-sources Do not watch the llmwiki project's sources/ directory.
  --no-initial               Start watching without running the first compile/sync.
  --once                     Run one bridge pass and exit. Useful for smoke tests.

Bridge pass-through:
  --write-links --no-write-links --write-index --fail-on-duplicates --no-ingest --skip-maintain
  --no-recall-fields --force --dry-run --llmwiki-root DIR --llmwiki-bin EXE
  --llmwiki-package NAME --node-package NAME --llmwiki-runtime DIR --export-dir DIR --okfs-dir DIR
  --reset-project --stage-only --skip-compile --skip-lint --no-prune-sources
  --strict-lint
  --no-fast-skip --no-authoritative-prune --no-deterministic-dedupe --no-atomic-publish

Notes:
  Project-local LLM settings are loaded from .okf-rag/llmwiki.env. Explicit
  process environment variables override the file.
  llmwiki's native "watch" command only recompiles wiki/. This daemon runs the
  full compile -> export OKF -> sync okfs -> Rust ingest/mirror loop.
`);
}

async function main() {
  const argv = process.argv.slice(2);
  const projectEnv = argv.some((arg) => arg === "--help" || arg === "-h")
    ? { file: path.join(rootFromArgv(argv), ".okf-rag", "llmwiki.env"), exists: false, configuredKeys: [], loadedKeys: [], ignoredKeys: [] }
    : loadProjectLlmwikiEnv(rootFromArgv(argv));
  const args = parseCli(argv);
  args.projectEnv = projectEnv;
  if (args.help) {
    printHelp();
    return;
  }

  args.root = path.resolve(args.root);
  args.bundle = slugify(args.bundle || inferBundleName(args.sources) || "llmwiki-generated");
  if (!args.bundle) throw new Error("--bundle resolved to an empty slug");
  configureInbox(args);
  args.project = path.resolve(
    args.root,
    args.project || path.join(".okf-rag", "llmwiki-projects", args.bundle)
  );

  if (args.command === "start") return startDaemon(args);
  if (args.command === "stop") return stopDaemon(args);
  if (args.command === "status") return statusDaemon(args);
  if (args.command === "supervise") return superviseDaemon(args);
  return runDaemon(args);
}

function configureInbox(args) {
  if (args.inbox && args.sources.length > 0) {
    throw new Error("--inbox cannot be combined with --source");
  }

  const defaultInbox = path.join(
    args.root,
    "okf-rag-workspace",
    "raw",
    args.bundle
  );
  args.inbox = path.resolve(args.root, args.inbox || defaultInbox);

  if (
    args.sources.length === 0 &&
    new Set(["run", "start", "supervise"]).has(args.command)
  ) {
    fs.mkdirSync(args.inbox, { recursive: true });
    args.sources.push(args.inbox);
  }
}

function daemonPaths(args) {
  const dir = path.join(args.root, ".okf-rag", "llmwiki-daemon");
  return {
    dir,
    pidFile: path.join(dir, `${args.bundle}.pid.json`),
    logFile: path.join(dir, `${args.bundle}.log`),
    stateFile: path.join(dir, `${args.bundle}.state.json`),
  };
}

function readPidRecord(args) {
  const { pidFile } = daemonPaths(args);
  try {
    return JSON.parse(fs.readFileSync(pidFile, "utf8"));
  } catch {
    return null;
  }
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function startDaemon(args) {
  const paths = daemonPaths(args);
  fs.mkdirSync(paths.dir, { recursive: true });
  const previous = readPidRecord(args);
  if (previous && isAlive(previous.pid)) {
    console.log(`daemon already running: pid ${previous.pid}`);
    console.log(`log: ${paths.logFile}`);
    return;
  }

  const childArgs = [__filename, "supervise", ...process.argv.slice(3)];
  const out = fs.openSync(paths.logFile, "a");
  const child = spawn(process.execPath, childArgs, {
    cwd: args.root,
    detached: true,
    stdio: ["ignore", out, out],
    windowsHide: true,
  });
  child.unref();

  writePidRecord(args, {
    pid: child.pid,
    supervisorPid: child.pid,
    workerPid: null,
    bundle: args.bundle,
    root: args.root,
    project: args.project,
    sources: args.sources,
    inbox: args.inbox,
    projectEnv: args.projectEnv,
    logFile: paths.logFile,
    startedAt: new Date().toISOString(),
  });

  console.log(`daemon started: pid ${child.pid}`);
  console.log(`log: ${paths.logFile}`);
}

function stopDaemon(args) {
  const paths = daemonPaths(args);
  const record = readPidRecord(args);
  const pid = record?.supervisorPid || record?.pid;
  if (!record || !pid) {
    console.log(`daemon not running for bundle ${args.bundle}`);
    return;
  }
  if (!isAlive(pid)) {
    fs.rmSync(paths.pidFile, { force: true });
    console.log(`stale pid removed for bundle ${args.bundle}`);
    return;
  }
  killProcessTree(pid);
  fs.rmSync(paths.pidFile, { force: true });
  writeDaemonState(args, { status: "stopped", stoppedAt: new Date().toISOString() });
  console.log(`daemon stopped: pid ${pid}`);
}

function killProcessTree(pid) {
  if (process.platform === "win32") {
    const result = spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    if (result.status === 0) return;
  }
  process.kill(pid);
}

function statusDaemon(args) {
  const paths = daemonPaths(args);
  const record = readPidRecord(args);
  const state = readJson(paths.stateFile, null);
  const supervisorPid = record?.supervisorPid || record?.pid || null;
  const running = supervisorPid && isAlive(supervisorPid);
  const status = {
    bundle: args.bundle,
    running: Boolean(running),
    pid: supervisorPid,
    supervisorPid,
    workerPid: record?.workerPid || state?.workerPid || null,
    root: args.root,
    project: record?.project || args.project,
    sources: record?.sources || state?.sources || args.sources,
    inbox: record?.inbox || state?.inbox || args.inbox,
    projectEnv: record?.projectEnv || state?.projectEnv || args.projectEnv,
    logFile: paths.logFile,
    stateFile: paths.stateFile,
    state,
  };
  if (args.json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  console.log(`bundle: ${status.bundle}`);
  console.log(`running: ${status.running ? "yes" : "no"}`);
  if (status.pid) console.log(`pid: ${status.pid}`);
  console.log(`project: ${status.project}`);
  console.log(`inbox: ${status.inbox}`);
  console.log(`llm config: ${status.projectEnv.file}`);
  if (status.projectEnv.configuredKeys.length > 0) {
    console.log(`llm config keys: ${status.projectEnv.configuredKeys.join(", ")}`);
  }
  if (status.sources.length > 0) console.log(`sources: ${status.sources.join(", ")}`);
  console.log(`log: ${status.logFile}`);
  if (status.state) {
    console.log(`state: ${status.stateFile}`);
    console.log(`phase: ${status.state.pipeline?.stage || status.state.status || "unknown"}`);
    if (status.state.lastRun?.durationMs != null) {
      console.log(`last run: ${status.state.lastRun.durationMs} ms (${status.state.lastRun.status})`);
    }
  }
}

async function superviseDaemon(args) {
  const paths = daemonPaths(args);
  fs.mkdirSync(paths.dir, { recursive: true });
  let worker = null;
  let stopping = false;
  let restartCount = 0;

  const shutdown = () => {
    stopping = true;
    if (worker?.pid && isAlive(worker.pid)) killProcessTree(worker.pid);
    const current = readPidRecord(args);
    if (current?.supervisorPid === process.pid || current?.pid === process.pid) {
      fs.rmSync(paths.pidFile, { force: true });
    }
    writeDaemonState(args, { status: "stopped", stoppedAt: new Date().toISOString() });
  };
  process.on("SIGINT", () => {
    shutdown();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    shutdown();
    process.exit(143);
  });
  process.on("exit", shutdown);

  while (!stopping) {
    const workerArgs = [__filename, "run", ...process.argv.slice(3)];
    worker = spawn(process.execPath, workerArgs, {
      cwd: args.root,
      env: {
        ...process.env,
        OKF_LLMWIKI_SUPERVISOR_PID: String(process.pid),
      },
      stdio: "inherit",
      windowsHide: true,
    });
    writePidRecord(args, {
      pid: process.pid,
      supervisorPid: process.pid,
      workerPid: worker.pid,
      bundle: args.bundle,
      root: args.root,
      project: args.project,
      sources: args.sources,
      inbox: args.inbox,
      projectEnv: args.projectEnv,
      logFile: paths.logFile,
      startedAt: new Date().toISOString(),
      restartCount,
    });
    writeDaemonState(args, {
      status: "starting",
      supervisorPid: process.pid,
      workerPid: worker.pid,
      restartCount,
      startedAt: new Date().toISOString(),
    });

    const exitCode = await new Promise((resolve) => {
      worker.on("error", () => resolve(1));
      worker.on("exit", (code) => resolve(code ?? 1));
    });
    worker = null;
    if (stopping || args.once) break;
    restartCount += 1;
    const backoffMs = Math.min(10_000, restartCount * 1_000);
    writeDaemonState(args, {
      status: "restarting",
      restartCount,
      lastWorkerExitCode: exitCode,
      restartAfterMs: backoffMs,
    });
    await delay(backoffMs);
  }
}

async function runDaemon(args) {
  const paths = daemonPaths(args);
  fs.mkdirSync(paths.dir, { recursive: true });
  const supervisorPid = Number.parseInt(process.env.OKF_LLMWIKI_SUPERVISOR_PID || "", 10) || null;
  if (!supervisorPid) {
    writePidRecord(args, {
      pid: process.pid,
      supervisorPid: null,
      workerPid: process.pid,
      bundle: args.bundle,
      root: args.root,
      project: args.project,
      sources: args.sources,
      inbox: args.inbox,
      projectEnv: args.projectEnv,
      logFile: paths.logFile,
      startedAt: new Date().toISOString(),
    });
  }

  let running = false;
  let pendingReason = "";
  let lastExitCode = 0;
  let timer = null;
  let heartbeat = null;
  let lastOutputRecoveryAt = 0;

  writeDaemonState(args, {
    status: "starting",
    bundle: args.bundle,
    root: args.root,
    project: args.project,
    sources: args.sources,
    inbox: args.inbox,
    projectEnv: args.projectEnv,
    supervisorPid,
    workerPid: process.pid,
    debounceMs: args.debounceMs,
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    pendingReason: null,
  });

  const runBridge = async (reason) => {
    if (running) {
      pendingReason = reason;
      writeDaemonState(args, { pendingReason, status: "running" });
      return;
    }
    running = true;
    pendingReason = "";
    writeDaemonState(args, {
      status: "running",
      pendingReason: null,
      currentRun: { reason, startedAt: new Date().toISOString() },
    });
    const result = await invokeBridge(args, reason, paths.stateFile);
    lastExitCode = result.exitCode;
    args.resetProject = false;
    running = false;
    writeDaemonState(args, {
      status: result.exitCode === 0 ? "idle" : "degraded",
      currentRun: null,
      lastRun: {
        reason,
        status: result.exitCode === 0 ? "succeeded" : "failed",
        exitCode: result.exitCode,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
        durationMs: result.durationMs,
      },
      lastError: result.error || null,
      pendingReason: pendingReason || null,
    });
    if (pendingReason) {
      const nextReason = pendingReason;
      pendingReason = "";
      await runBridge(nextReason);
    }
  };

  const schedule = (reason) => {
    if (timer) clearTimeout(timer);
    writeDaemonState(args, {
      status: running ? "running" : "queued",
      pendingReason: reason,
      queuedAt: new Date().toISOString(),
    });
    timer = setTimeout(() => {
      timer = null;
      runBridge(reason).catch((error) => {
        const message = sanitizeDiagnosticText(error.message || error);
        console.error(`[${new Date().toISOString()}] daemon error: ${message}`);
        writeDaemonState(args, {
          status: "degraded",
          lastError: message,
        });
      });
    }, args.debounceMs);
  };

  const cleanup = () => {
    if (timer) clearTimeout(timer);
    if (heartbeat) clearInterval(heartbeat);
    try {
      const current = readPidRecord(args);
      if (!supervisorPid && current?.pid === process.pid) {
        fs.rmSync(paths.pidFile, { force: true });
      }
    } catch {
      // Best effort cleanup.
    }
    writeDaemonState(args, {
      status: supervisorPid ? "worker-stopped" : "stopped",
      workerPid: null,
      stoppedAt: new Date().toISOString(),
    });
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });

  console.log(`[${new Date().toISOString()}] okf llmwiki daemon running`);
  console.log(`bundle: ${args.bundle}`);
  console.log(`project: ${args.project}`);
  console.log(`llm config: ${args.projectEnv.file}`);
  if (args.projectEnv.configuredKeys.length > 0) {
    console.log(`llm config keys: ${args.projectEnv.configuredKeys.join(", ")}`);
  }

  if (args.initial) {
    await runBridge("initial");
  }
  if (args.once) {
    process.exitCode = lastExitCode;
    return;
  }

  const watchers = openWatchers(args, schedule);
  if (watchers.length === 0) {
    console.log("warning: no watch targets are available; daemon will stay alive for manual stop.");
  }
  console.log("watching:");
  for (const watcher of watchers) console.log(`- ${watcher.label}`);

  writeDaemonState(args, {
    status: "idle",
    watchTargets: watchers.map((watcher) => watcher.label),
    heartbeatAt: new Date().toISOString(),
  });
  heartbeat = setInterval(() => {
    const recovery = publishedBundleRecoveryState(args);
    if (
      recovery.needed &&
      !running &&
      !timer &&
      Date.now() - lastOutputRecoveryAt >= OUTPUT_RECOVERY_INTERVAL_MS
    ) {
      lastOutputRecoveryAt = Date.now();
      schedule(`published bundle recovery: ${recovery.reason}`);
    } else if (!recovery.needed) {
      lastOutputRecoveryAt = 0;
    }
    writeDaemonState(args, {
      heartbeatAt: new Date().toISOString(),
      workerPid: process.pid,
      pendingReason: pendingReason || null,
      status: running ? "running" : timer || pendingReason ? "queued" : "idle",
      publishedBundle: recovery,
    });
  }, 5_000);

  setInterval(() => {}, 60 * 60 * 1000);
  await new Promise(() => {});
}

function invokeBridge(args, reason, stateFile) {
  return new Promise((resolve) => {
    const bridge = path.join(__dirname, "compile_okf_with_llmwiki.js");
    const bridgeArgs = buildBridgeArgs(args);
    console.log("");
    console.log(`[${new Date().toISOString()}] bridge run: ${reason}`);
    console.log(`$ ${[process.execPath, bridge, ...bridgeArgs].map(quoteArg).join(" ")}`);

    const startedAt = new Date();
    let settled = false;
    const child = spawn(process.execPath, [bridge, ...bridgeArgs], {
      cwd: args.root,
      env: {
        ...process.env,
        OKF_PIPELINE_STATE_FILE: stateFile,
      },
      stdio: "inherit",
      windowsHide: true,
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      const message = sanitizeDiagnosticText(error.message);
      console.error(`[${new Date().toISOString()}] bridge spawn failed: ${message}`);
      const finishedAt = new Date();
      resolve({
        exitCode: 1,
        error: message,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
      });
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      const exitCode = code ?? 1;
      console.log(`[${new Date().toISOString()}] bridge exit: ${exitCode}`);
      const finishedAt = new Date();
      resolve({
        exitCode,
        error: exitCode === 0 ? null : `bridge exited with code ${exitCode}`,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
      });
    });
  });
}

function buildBridgeArgs(args) {
  const out = ["--root", args.root, "--bundle", args.bundle, "--llmwiki-project", args.project];
  for (const source of args.sources) out.push("--source", source);
  pushValue(out, "--export-dir", args.exportDir);
  pushValue(out, "--okfs-dir", args.okfsDir);
  pushValue(out, "--okf-rag-bin", args.okfRagBin);
  pushValue(out, "--llmwiki-root", args.llmwikiRoot);
  pushValue(out, "--llmwiki-bin", args.llmwikiBin);
  pushValue(out, "--llmwiki-package", args.llmwikiPackage);
  pushValue(out, "--node-package", args.nodePackage);
  pushValue(out, "--llmwiki-runtime", args.llmwikiRuntime);
  pushValue(out, "--provider", args.provider);
  pushValue(out, "--model", args.model);
  pushValue(out, "--openai-base-url", args.openaiBaseUrl);
  pushFlag(out, "--stream-only-openai", args.streamOnlyOpenai);
  if (args.streamOnlyOpenai) {
    pushValue(out, "--stream-adapter-port", String(args.streamAdapterPort));
  }
  pushValue(out, "--lang", args.lang);
  pushValue(out, "--concurrency", args.concurrency);
  pushValue(out, "--mirror-workspace", args.mirrorWorkspace);
  pushFlag(out, "--reset-project", args.resetProject);
  pushFlag(out, "--stage-only", args.stageOnly);
  pushFlag(out, "--skip-compile", args.skipCompile);
  pushFlag(out, "--skip-lint", args.skipLint);
  pushFlag(out, "--strict-lint", args.strictLint);
  pushFlag(out, "--skip-maintain", args.skipMaintain);
  pushFlag(out, "--no-prune-sources", args.noPruneSources);
  pushFlag(out, "--write-links", args.writeLinks);
  pushFlag(out, "--no-write-links", !args.writeLinks);
  pushFlag(out, "--write-index", args.writeIndex);
  pushFlag(out, "--fail-on-duplicates", args.failOnDuplicates);
  pushFlag(out, "--no-recall-fields", args.noRecallFields);
  pushFlag(out, "--no-ingest", args.noIngest);
  pushFlag(out, "--force", args.force);
  pushFlag(out, "--dry-run", args.dryRun);
  pushFlag(out, "--no-fast-skip", !args.fastSkip);
  pushFlag(out, "--no-authoritative-prune", !args.authoritativePrune);
  pushFlag(out, "--no-deterministic-dedupe", !args.deterministicDedupe);
  pushFlag(out, "--no-atomic-publish", !args.atomicPublish);
  return out;
}

function pushValue(out, flag, value) {
  if (value) out.push(flag, value);
}

function pushFlag(out, flag, enabled) {
  if (enabled) out.push(flag);
}

function openWatchers(args, schedule) {
  const localSources = args.sources
    .filter((source) => !isUrl(source))
    .map((source) => path.resolve(args.root, source))
    .filter((source) => fs.existsSync(source));
  const hasLocalWatchSources = localSources.length > 0;
  const includeProjectSources =
    args.watchProjectSources === null ? !hasLocalWatchSources : args.watchProjectSources;

  const targets = [];
  for (const source of localSources) targets.push(source);
  const projectSources = path.join(args.project, "sources");
  if (includeProjectSources && fs.existsSync(projectSources)) targets.push(projectSources);

  const uniqueTargets = [...new Set(targets.map((target) => path.resolve(target)))];
  const watchers = [];
  for (const target of uniqueTargets) {
    const watcher = watchTarget(target, schedule);
    if (watcher) watchers.push(watcher);
  }
  return watchers;
}

function watchTarget(target, schedule) {
  const stat = fs.statSync(target);
  const watchDir = stat.isDirectory() ? target : path.dirname(target);
  const basename = stat.isDirectory() ? "" : path.basename(target);
  const label = stat.isDirectory() ? `${target}${path.sep}` : target;

  const onChange = (event, fileName) => {
    if (basename && fileName && path.basename(String(fileName)) !== basename) return;
    if (!basename && fileName && path.extname(String(fileName)).toLowerCase() !== ".md") {
      return;
    }
    const detail = fileName ? `${event}:${fileName}` : event;
    schedule(`${label} ${detail}`);
  };

  try {
    const watcher = fs.watch(watchDir, { recursive: stat.isDirectory() }, onChange);
    watcher.on("error", (error) => {
      console.error(`watch error for ${label}: ${error.message}`);
    });
    return { label, watcher };
  } catch (error) {
    console.error(`failed to watch ${label}: ${error.message}`);
    return null;
  }
}

function publishedBundleRecoveryState(args) {
  const okfsDir = path.resolve(
    args.root,
    args.okfsDir || path.join("okf-rag-workspace", "okfs")
  );
  const targetBundleDir = path.join(okfsDir, args.bundle);
  const sourceHasMarkdown = args.sources
    .filter((source) => !isUrl(source))
    .map((source) => path.resolve(args.root, source))
    .some((source) => containsMarkdown(source));
  const state = {
    needed: false,
    reason: null,
    targetBundleDir,
    sourceHasMarkdown,
  };
  if (!sourceHasMarkdown) return state;
  if (!fs.existsSync(targetBundleDir)) {
    return { ...state, needed: true, reason: "target bundle directory is missing" };
  }

  const manifestPath = path.join(
    args.root,
    ".okf-rag",
    "llmwiki-sync",
    `${args.bundle}.json`
  );
  const manifest = readJson(manifestPath, null);
  const managedFiles = Array.isArray(manifest?.files) ? manifest.files : [];
  if (managedFiles.length > 0) {
    const missing = managedFiles.find((entry) => {
      const relativePath = String(entry?.relativePath || "");
      return !relativePath || !fs.existsSync(path.join(targetBundleDir, relativePath));
    });
    if (missing) {
      return {
        ...state,
        needed: true,
        reason: `managed output is missing: ${missing.relativePath || "unknown"}`,
      };
    }
    return state;
  }

  const conceptsDir = path.join(targetBundleDir, "concepts");
  if (!fs.existsSync(path.join(targetBundleDir, "index.md")) || !containsMarkdown(conceptsDir)) {
    return { ...state, needed: true, reason: "published index or concepts are missing" };
  }
  return state;
}

function containsMarkdown(target) {
  if (!fs.existsSync(target)) return false;
  const stat = fs.statSync(target);
  if (stat.isFile()) return path.extname(target).toLowerCase() === ".md";
  if (!stat.isDirectory()) return false;
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const child = path.join(target, entry.name);
    if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".md") return true;
    if (entry.isDirectory() && containsMarkdown(child)) return true;
  }
  return false;
}

function writePidRecord(args, record) {
  const paths = daemonPaths(args);
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.pidFile, JSON.stringify(record, null, 2) + "\n", "utf8");
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeDaemonState(args, changes) {
  const { stateFile } = daemonPaths(args);
  const previous = readJson(stateFile, {});
  const next = sanitizeDiagnosticValue({
    ...previous,
    ...changes,
    bundle: args.bundle,
    root: args.root,
    project: args.project,
    updatedAt: new Date().toISOString(),
  });
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  const temporary = `${stateFile}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(next, null, 2) + "\n", "utf8");
  fs.renameSync(temporary, stateFile);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function inferBundleName(sources) {
  if (sources.length === 0) return "";
  const first = sources[0];
  if (isUrl(first)) {
    try {
      const url = new URL(first);
      return path.basename(url.pathname) || url.hostname;
    } catch {
      return "web-source";
    }
  }
  const trimmed = first.replace(/[\\/]+$/, "");
  return path.basename(trimmed, path.extname(trimmed));
}

function isUrl(value) {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value);
}

function slugify(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/['"`]/g, "")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function quoteArg(value) {
  const text = String(value);
  return /\s/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(
      `Error: ${sanitizeDiagnosticText(error instanceof Error ? error.message : error)}`
    );
    process.exit(1);
  });
}

module.exports = {
  containsMarkdown,
  publishedBundleRecoveryState,
};
