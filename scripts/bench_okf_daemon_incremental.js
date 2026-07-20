#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { performance } = require("perf_hooks");

function parseArgs(argv) {
  const args = {
    root: process.cwd(),
    iterations: 5,
    debounceMs: 250,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") args.root = requireValue(argv, ++i, arg);
    else if (arg === "--iterations") args.iterations = requirePositiveInt(argv, ++i, arg);
    else if (arg === "--debounce-ms") args.debounceMs = requirePositiveInt(argv, ++i, arg);
    else if (arg === "--json") args.json = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node scripts/bench_okf_daemon_incremental.js [--iterations N] [--debounce-ms N] [--json]");
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function requirePositiveInt(argv, index, flag) {
  const value = Number.parseInt(requireValue(argv, index, flag), 10);
  if (!Number.isFinite(value) || value < 1) throw new Error(`${flag} requires a positive integer`);
  return value;
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(sorted.length * p) - 1);
  return sorted[index];
}

function stats(values) {
  const average = values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    avgMs: Number(average.toFixed(2)),
    p50Ms: Number(percentile(values, 0.5).toFixed(2)),
    p95Ms: Number(percentile(values, 0.95).toFixed(2)),
    minMs: Number(Math.min(...values).toFixed(2)),
    maxMs: Number(Math.max(...values).toFixed(2)),
  };
}

function waitForExit(child, timeoutMs = 5_000) {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args.root);
  const bundle = `daemon-incremental-bench-${process.pid}-${Date.now()}`;
  const sourceDir = path.join(root, "okf-rag-workspace", "raw", bundle);
  const topicPath = path.join(sourceDir, "topic.md");
  const temporaryPath = path.join(sourceDir, "temporary.md");
  const adjacentDaemon = path.join(__dirname, "okf_llmwiki_daemon.js");
  const daemonScript = fs.existsSync(adjacentDaemon)
    ? adjacentDaemon
    : path.join(root, "scripts", "okf_llmwiki_daemon.js");

  const child = spawn(
    process.execPath,
    [
      daemonScript,
      "run",
      "--root",
      root,
      "--bundle",
      bundle,
      "--stage-only",
      "--no-ingest",
      "--no-initial",
      "--debounce-ms",
      String(args.debounceMs),
    ],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
  );

  let stdoutBuffer = "";
  let stderr = "";
  let readyResolve;
  let activeMeasurement = null;
  const ready = new Promise((resolve) => {
    readyResolve = resolve;
  });

  const consumeLine = (line) => {
    if (line.includes(sourceDir)) readyResolve();
    if (!activeMeasurement) return;
    if (line.includes("bridge run:")) {
      activeMeasurement.bridgeStartedAt = performance.now();
    } else if (line.startsWith("raw md -> sources:")) {
      activeMeasurement.syncSummary = line;
    } else if (line.includes("bridge exit:")) {
      const match = line.match(/bridge exit:\s+(\d+)/);
      activeMeasurement.exitCode = match ? Number.parseInt(match[1], 10) : 1;
      activeMeasurement.finishedAt = performance.now();
      const measurement = activeMeasurement;
      activeMeasurement = null;
      clearTimeout(measurement.timeout);
      measurement.resolve(measurement);
    }
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || "";
    for (const line of lines) consumeLine(line);
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const timeout = setTimeout(() => readyResolve(), 10_000);
  await ready;
  clearTimeout(timeout);
  if (child.exitCode !== null) throw new Error(`daemon exited before benchmark: ${stderr.trim()}`);
  if (!fs.existsSync(sourceDir)) throw new Error(`default raw inbox was not created: ${sourceDir}`);

  const pidPath = path.join(root, ".okf-rag", "llmwiki-daemon", `${bundle}.pid.json`);
  const pidRecord = JSON.parse(fs.readFileSync(pidPath, "utf8"));
  if (path.resolve(pidRecord.inbox || "") !== path.resolve(sourceDir)) {
    throw new Error(`daemon reported the wrong inbox: ${pidRecord.inbox || "missing"}`);
  }

  const measurements = [];
  const measure = async (name, operation) => {
    if (activeMeasurement) throw new Error("measurement overlap");
    const result = await new Promise((resolve, reject) => {
      activeMeasurement = {
        name,
        operationStartedAt: performance.now(),
        bridgeStartedAt: 0,
        finishedAt: 0,
        syncSummary: "",
        exitCode: null,
        timeout: null,
        resolve,
      };
      try {
        operation();
      } catch (error) {
        activeMeasurement = null;
        reject(error);
        return;
      }
      activeMeasurement.timeout = setTimeout(() => {
        if (activeMeasurement?.name === name) {
          activeMeasurement = null;
          reject(new Error(`timed out waiting for ${name}`));
        }
      }, 30_000);
    });
    if (result.exitCode !== 0 || !result.bridgeStartedAt) {
      throw new Error(`${name} failed: ${result.syncSummary || stderr.trim()}`);
    }
    measurements.push({
      name,
      triggerMs: result.bridgeStartedAt - result.operationStartedAt,
      bridgeMs: result.finishedAt - result.bridgeStartedAt,
      totalMs: result.finishedAt - result.operationStartedAt,
      syncSummary: result.syncSummary,
    });
    await new Promise((resolve) => setTimeout(resolve, args.debounceMs + 50));
  };

  try {
    await measure("create", () => fs.writeFileSync(topicPath, "# Topic\n\nversion 0\n", "utf8"));
    for (let i = 1; i <= args.iterations; i += 1) {
      await measure(`update-${i}`, () => {
        fs.writeFileSync(topicPath, `# Topic\n\nversion ${i}\n`, "utf8");
      });
    }
    await measure("add-second", () => {
      fs.writeFileSync(temporaryPath, "# Temporary\n\nwill be deleted\n", "utf8");
    });
    await measure("delete-second", () => fs.unlinkSync(temporaryPath));
  } finally {
    child.kill("SIGTERM");
    await waitForExit(child);
    const cleanupTargets = [
      sourceDir,
      path.join(root, ".okf-rag", "llmwiki-projects", bundle),
      path.join(root, ".okf-rag", "llmwiki-source-sync", `${bundle}.json`),
      path.join(root, ".okf-rag", "llmwiki-daemon", `${bundle}.pid.json`),
      path.join(root, ".okf-rag", "llmwiki-daemon", `${bundle}.state.json`),
      path.join(root, ".okf-rag", "llmwiki-daemon", `${bundle}.log`),
    ];
    for (const target of cleanupTargets) {
      const resolved = path.resolve(target);
      if (!resolved.startsWith(`${root}${path.sep}`)) throw new Error(`unsafe cleanup path: ${resolved}`);
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  }

  const result = {
    debounceMs: args.debounceMs,
    updateIterations: args.iterations,
    operations: measurements.map((item) => ({
      name: item.name,
      triggerMs: Number(item.triggerMs.toFixed(2)),
      bridgeMs: Number(item.bridgeMs.toFixed(2)),
      totalMs: Number(item.totalMs.toFixed(2)),
      syncSummary: item.syncSummary,
    })),
    aggregate: {
      trigger: stats(measurements.map((item) => item.triggerMs)),
      bridge: stats(measurements.map((item) => item.bridgeMs)),
      total: stats(measurements.map((item) => item.totalMs)),
    },
    warmAggregate: {
      trigger: stats(measurements.slice(1).map((item) => item.triggerMs)),
      bridge: stats(measurements.slice(1).map((item) => item.bridgeMs)),
      total: stats(measurements.slice(1).map((item) => item.totalMs)),
    },
  };

  if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`daemon incremental benchmark (${measurements.length} operations)`);
    console.log(`debounce: ${args.debounceMs} ms`);
    console.log(`trigger p50/p95: ${result.aggregate.trigger.p50Ms}/${result.aggregate.trigger.p95Ms} ms`);
    console.log(`bridge p50/p95: ${result.aggregate.bridge.p50Ms}/${result.aggregate.bridge.p95Ms} ms`);
    console.log(`total p50/p95: ${result.aggregate.total.p50Ms}/${result.aggregate.total.p95Ms} ms`);
    console.log(
      `warm total p50/p95: ${result.warmAggregate.total.p50Ms}/${result.warmAggregate.total.p95Ms} ms`
    );
  }
}

main().catch((error) => {
  console.error(`Error: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
