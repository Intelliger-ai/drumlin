#!/usr/bin/env node
/**
 * Enforces the DEC-0001 seam: `core` and `model` stay pure so porting them to
 * Rust later is mechanical rather than a rewrite.
 *
 * Pure means no filesystem, no process, no TypeScript compiler, no SQLite, and
 * no dependency on the impure packages. If this check fails, the port path is
 * closing — fix the import rather than relaxing the rule.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Packages that must contain no IO and no parser dependency. */
const PURE_PACKAGES = ["packages/model", "packages/core", "packages/protocol"];

const NODE_BUILTINS = [
  {
    pattern: /^node:/,
    why: "Node built-in (core must not touch the platform)",
  },
  {
    pattern: /^(fs|path|os|crypto|child_process|worker_threads|net|url|util)$/,
    why: "Node built-in",
  },
];

const IMPURE_PACKAGES = [
  { pattern: /^ts-morph$/, why: "TypeScript compiler (belongs in indexer)" },
  { pattern: /^typescript$/, why: "TypeScript compiler (belongs in indexer)" },
  { pattern: /^yaml$/, why: "serialization (belongs in repo)" },
  { pattern: /^@drumlin\/indexer$/, why: "impure package" },
  { pattern: /^@drumlin\/repo$/, why: "impure package" },
  { pattern: /^@drumlin\/engine$/, why: "impure package" },
  { pattern: /^@drumlin\/cli$/, why: "impure package" },
];

/**
 * Transport must not leak into the parts being ported.
 *
 * Milestone B added three packages that exist only to move bytes between
 * processes. None of them can appear in `core`: a rule that knows it is being
 * asked over a socket is a rule that cannot be translated.
 */
const TRANSPORT_PACKAGES = [
  {
    pattern: /^@drumlin\/protocol$/,
    why: "transport (core must not know it exists)",
  },
  { pattern: /^@drumlin\/client$/, why: "transport" },
  { pattern: /^@drumlin\/daemon$/, why: "transport" },
];

const FORBIDDEN = [...NODE_BUILTINS, ...IMPURE_PACKAGES, ...TRANSPORT_PACKAGES];

/**
 * Per-package exemptions.
 *
 * `protocol` describes the wire and is allowed to know the domain types that
 * travel over it, but nothing else — no sockets, no filesystem, no engine.
 */
const ALLOWED = {
  "packages/protocol": [/^@drumlin\/model$/],
};

const IMPORT_RE =
  /(?:^|\n)\s*(?:import|export)\b[^;\n]*?from\s*["']([^"']+)["']|(?:^|[^.\w])import\s*\(\s*["']([^"']+)["']\s*\)|(?:^|[^.\w])require\s*\(\s*["']([^"']+)["']\s*\)/g;

async function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      out.push(...(await walk(full)));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

const violations = [];

for (const pkg of PURE_PACKAGES) {
  const files = await walk(join(root, pkg, "src"));
  const exempt = ALLOWED[pkg] ?? [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    const lines = text.split("\n");
    for (const match of text.matchAll(IMPORT_RE)) {
      const spec = match[1] ?? match[2] ?? match[3];
      if (!spec) continue;
      if (exempt.some((pattern) => pattern.test(spec))) continue;
      const rule = FORBIDDEN.find((r) => r.pattern.test(spec));
      if (!rule) continue;
      const upto = text.slice(0, match.index ?? 0);
      const line = upto.split("\n").length;
      violations.push({
        file: relative(root, file),
        line,
        spec,
        why: rule.why,
        text: (lines[line - 1] ?? "").trim(),
      });
    }
  }
}

if (violations.length === 0) {
  console.log(
    `boundaries ok — ${PURE_PACKAGES.join(", ")} are free of IO and parser imports`,
  );
  process.exit(0);
}

console.error(`\nBoundary violations (${violations.length}):\n`);
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}`);
  console.error(`    imports "${v.spec}" — ${v.why}`);
  console.error(`    ${v.text}\n`);
}
console.error(
  "These packages must stay portable. Move the impure work into indexer or repo\n" +
    "and pass plain data across the seam. See vault/Decisions/DEC-0001 Core Language.md\n",
);
process.exit(1);
