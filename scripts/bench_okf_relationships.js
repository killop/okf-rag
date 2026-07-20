#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { performance } = require("perf_hooks");

const { buildRelationshipGraph } = require("./okf_relationships.js");

function parseArgs(argv) {
  const args = {
    sizes: [100, 500, 1000],
    iterations: 5,
    output: path.resolve("reports", "okf-relationships-benchmark.json"),
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--sizes") {
      args.sizes = argv[++i]
        .split(",")
        .map((value) => Number.parseInt(value, 10))
        .filter((value) => Number.isFinite(value) && value > 1);
    } else if (argv[i] === "--iterations") {
      args.iterations = Number.parseInt(argv[++i], 10);
    } else if (argv[i] === "--output") {
      args.output = path.resolve(argv[++i]);
    } else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log("node scripts/bench_okf_relationships.js [--sizes 100,500,1000] [--iterations 5] [--output FILE]");
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  if (args.sizes.length === 0 || !Number.isFinite(args.iterations) || args.iterations < 1) {
    throw new Error("sizes and iterations must be positive");
  }
  return args;
}

function concept(index, count) {
  const id = String(index).padStart(5, "0");
  const next = String(index + 1).padStart(5, "0");
  const relation =
    index + 1 < count
      ? `Concept ${id} depends on [Concept ${next}](concept-${next}.md).`
      : `Concept ${id} is the terminal concept.`;
  return {
    relativePath: `concepts/concept-${id}.md`,
    text: `---\ntype: Reference\ntitle: Concept ${id}\ndescription: Synthetic relation benchmark concept ${id}.\n---\n\n${relation}\n`,
  };
}

function identity(entry) {
  return {
    title: /^title:\s*(.+)$/m.exec(entry.text)?.[1] || entry.relativePath,
  };
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function runCase(size, iterations) {
  const entries = Array.from({ length: size }, (_, index) => concept(index, size));
  const expected = new Set(
    Array.from({ length: size - 1 }, (_, index) => {
      const from = String(index).padStart(5, "0");
      const to = String(index + 1).padStart(5, "0");
      return `bench/concepts/concept-${from}|depends_on|bench/concepts/concept-${to}`;
    })
  );

  buildRelationshipGraph(entries, {
    bundle: "bench",
    identity,
    ownersBySlug: new Map(),
  });

  const durations = [];
  let graph;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const started = performance.now();
    graph = buildRelationshipGraph(entries, {
      bundle: "bench",
      identity,
      ownersBySlug: new Map(),
    });
    durations.push(performance.now() - started);
  }

  const actual = new Set(
    graph.relationships.map(
      (relationship) => `${relationship.from}|${relationship.predicate}|${relationship.to}`
    )
  );
  const truePositives = [...actual].filter((edge) => expected.has(edge)).length;
  const falseReverseEdges = graph.relationships.filter((relationship) =>
    actual.has(`${relationship.to}|${relationship.predicate}|${relationship.from}`)
  ).length;

  return {
    concepts: size,
    expectedRelations: expected.size,
    actualRelations: actual.size,
    precision: actual.size === 0 ? 0 : truePositives / actual.size,
    recall: expected.size === 0 ? 1 : truePositives / expected.size,
    falseReverseEdges,
    orphans: graph.orphans.length,
    p50Ms: Number(percentile(durations, 0.5).toFixed(3)),
    p95Ms: Number(percentile(durations, 0.95).toFixed(3)),
    minMs: Number(Math.min(...durations).toFixed(3)),
    maxMs: Number(Math.max(...durations).toFixed(3)),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    iterations: args.iterations,
    cases: args.sizes.map((size) => runCase(size, args.iterations)),
  };
  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
}

main();
