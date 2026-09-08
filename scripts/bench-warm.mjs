#!/usr/bin/env node
/**
 * Warm re-index measurement.
 *
 * The number that decides whether the Cursor hooks are viable: if folding one
 * changed file into the graph costs as much as a cold index, the daemon buys
 * nothing and `afterFileEdit` cannot fire on every edit.
 *
 * Usage: node scripts/bench-warm.mjs <app-path> [iterations]
 */
import { register } from "tsx/esm/api";
import { utimesSync } from "node:fs";

register();

const { IndexSession, resolveApp } = await import("@drumlin/indexer");

const target = process.argv[2];
if (!target) {
  console.error("Usage: node scripts/bench-warm.mjs <app-path> [iterations]");
  process.exit(1);
}
const iterations = Number.parseInt(process.argv[3] ?? "5", 10);

const app = resolveApp({ root: target });

const coldStart = performance.now();
const session = new IndexSession(app);
const parseMs = performance.now() - coldStart;

const firstIndexStart = performance.now();
const first = session.index();
const firstIndexMs = performance.now() - firstIndexStart;

console.log(`${app.root}`);
console.log(
  `  ${session.files.length} files, ${first.stats.screens} screens, ${first.graph.edges.length} edges`,
);
console.log(`  cold parse       ${parseMs.toFixed(0)}ms`);
console.log(`  first analysis   ${firstIndexMs.toFixed(0)}ms`);
console.log(`  cold total       ${(parseMs + firstIndexMs).toFixed(0)}ms`);

// Touch a real screen file so the refresh has something to re-read.
const victim = first.graph.nodes.find((node) => node.type === "Screen")
  ?.sources?.[0]?.file;
const absolute = victim ? `${app.root}/${victim}` : session.files[0];

const samples = [];
for (let index = 0; index < iterations; index += 1) {
  const now = new Date();
  utimesSync(absolute, now, now);

  const start = performance.now();
  session.refresh([absolute]);
  const refreshMs = performance.now() - start;

  const analysisStart = performance.now();
  session.index();
  const analysisMs = performance.now() - analysisStart;

  samples.push({ refreshMs, analysisMs, total: refreshMs + analysisMs });
}

const totals = samples.map((sample) => sample.total).sort((a, b) => a - b);
const median = totals[Math.floor(totals.length / 2)];
const worst = totals[totals.length - 1];

console.log(
  `  warm re-index    median ${median.toFixed(0)}ms · worst ${worst.toFixed(0)}ms  (${iterations} runs, one file touched)`,
);
console.log(
  `  speedup          ${((parseMs + firstIndexMs) / median).toFixed(1)}x versus cold`,
);
