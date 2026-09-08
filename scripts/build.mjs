#!/usr/bin/env node
/**
 * Assemble the published package.
 *
 * Until now the shipped entry points registered the `tsx` loader and imported
 * TypeScript directly. That is a fine way to develop and a bad way to ship: it
 * needs this checkout to stay where it was installed from, it cannot be
 * published to a registry, and it pays a transpile cost on every start.
 *
 * Bundled rather than compiled per package, because these are three programs
 * and not a library anyone imports. Inlining the workspace lets the result be
 * published on its own, with no `@drumlin/*` to resolve at runtime.
 *
 * Split, though, and that part is not optional. `cli.ts` imports its commands
 * through `await import()` so that `drumlin hook file-edit` — which runs on
 * every write an agent makes, against a 500ms budget — does not load the rule
 * engine and ts-morph in order to post a filename to a socket. A plain bundle
 * inlines those dynamic imports and undoes it: measured at 309ms against
 * 176ms for the tsx path, so the first build was slower than no build at all.
 * `splitting` keeps each command in its own chunk, loaded when asked for.
 *
 * One esbuild pass over all three entry points, into one directory, for two
 * reasons. The three programs share most of their code — engine, indexer,
 * model — and splitting across a single pass lets them share the chunks
 * instead of carrying three copies. And the output is then a single directory
 * that is exactly the npm package, so `drumlind` is guaranteed to sit beside
 * `drumlin`, which is what the daemon lookup in packages/client relies on.
 *
 * The four real npm dependencies stay external. They are already someone
 * else's build output, and `ts-morph` carries the TypeScript compiler —
 * inlining it would cost more than it saves.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The assembled package: manifest checked in, everything else written here. */
const pkg = join(root, "packages", "drumlin");
const outdir = join(pkg, "dist");

const EXTERNAL = ["ts-morph", "zod", "yaml", "@modelcontextprotocol/sdk"];

/**
 * `in` is the module that actually calls `main`, which is not the same as the
 * module that defines it: the daemon and the MCP server both export it uncalled
 * so tests can drive them in-process. `out` is the command name, so the
 * executable is named after the command rather than after `bin.ts`.
 */
const ENTRIES = [
  { in: join(root, "apps/cli/src/main.ts"), out: "drumlin" },
  { in: join(root, "apps/daemon/src/bin.ts"), out: "drumlind" },
  { in: join(root, "apps/mcp/src/bin.ts"), out: "drumlin-mcp" },
];

/**
 * Files the package needs that are not code.
 *
 * The skill because the CLI writes it out when installing the Cursor plugin,
 * so the artefact has to carry its own copy rather than reach back into a
 * checkout a published install does not have. The README and LICENSE because
 * npm reads them from inside the tarball, and `files` cannot reach above the
 * package directory.
 */
const CARRIED = [
  {
    from: "integrations/cursor/skills/drumlin/SKILL.md",
    to: "dist/skills/drumlin/SKILL.md",
  },
  { from: "README.md", to: "README.md" },
  { from: "LICENSE", to: "LICENSE" },
];

// esbuild strips types without reading them, so a build that skipped this
// would happily emit code that does not compile.
process.stdout.write("typechecking\n");
execFileSync("node", ["node_modules/typescript/bin/tsc", "--noEmit"], {
  cwd: root,
  stdio: "inherit",
});

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

const result = await build({
  entryPoints: ENTRIES,
  outdir,
  outExtension: { ".js": ".mjs" },
  chunkNames: "chunks/[name]-[hash]",
  bundle: true,
  splitting: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: EXTERNAL,
  sourcemap: true,
  // No shebang banner: every entry module already carries one and esbuild
  // hoists it. Adding another put a second `#!` on line two, which is a syntax
  // error rather than a comment.
  metafile: true,
  logLevel: "warning",
});

for (const { from, to } of CARRIED) {
  const target = join(pkg, to);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(join(root, from), target);
}

const outputs = Object.entries(result.metafile.outputs).filter(
  ([path]) => !path.endsWith(".map"),
);
const shared = outputs.filter(([, output]) => !output.entryPoint);

for (const entry of ENTRIES) {
  const bin = join(outdir, `${entry.out}.mjs`);
  chmodSync(bin, 0o755);

  const own = outputs.find(([path]) => path.endsWith(`${entry.out}.mjs`));
  process.stdout.write(
    `${entry.out.padEnd(13)} ` +
      `${kb(own?.[1].bytes ?? 0).padStart(4)}kB entry  ` +
      `${relative(root, bin)}\n`,
  );
}

process.stdout.write(
  `${"shared".padEnd(13)} ${kb(bytes(shared)).padStart(4)}kB ` +
    `across ${shared.length} chunks  ` +
    `${kb(bytes(outputs))}kB total\n`,
);

function bytes(entries) {
  return entries.reduce((sum, [, output]) => sum + output.bytes, 0);
}

function kb(value) {
  return String(Math.round(value / 1024));
}
