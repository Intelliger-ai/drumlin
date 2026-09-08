#!/usr/bin/env node
/**
 * Bundle the three executables.
 *
 * Until now the shipped entry points registered the `tsx` loader and imported
 * TypeScript directly. That is a fine way to develop and a bad way to ship: it
 * needs this checkout to stay where it was installed from, it cannot be
 * published to a registry, and it pays a transpile cost on every start.
 *
 * Bundled rather than compiled per package, because these are three programs
 * and not a library anyone imports. Inlining the workspace lets each app be
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

const EXTERNAL = ["ts-morph", "zod", "yaml", "@modelcontextprotocol/sdk"];

/**
 * `entry` is the module that actually calls `main`, which is not the same as
 * the module that defines it: the daemon and the MCP server both export it
 * uncalled so tests can drive them in-process.
 */
const TARGETS = [
  { name: "drumlin", app: "cli", entry: "main.ts" },
  { name: "drumlind", app: "daemon", entry: "bin.ts" },
  { name: "drumlin-mcp", app: "mcp", entry: "bin.ts" },
];

// esbuild strips types without reading them, so a build that skipped this
// would happily emit code that does not compile.
process.stdout.write("typechecking\n");
execFileSync("node", ["node_modules/typescript/bin/tsc", "--noEmit"], {
  cwd: root,
  stdio: "inherit",
});

for (const target of TARGETS) {
  const outdir = join(root, "apps", target.app, "dist");
  rmSync(outdir, { recursive: true, force: true });
  mkdirSync(outdir, { recursive: true });

  const result = await build({
    entryPoints: [join(root, "apps", target.app, "src", target.entry)],
    outdir,
    outExtension: { ".js": ".mjs" },
    // `main` rather than the entry's filename, so the executable is named
    // after the command and the chunks beside it are clearly not entry points.
    entryNames: target.name,
    chunkNames: "chunks/[name]-[hash]",
    bundle: true,
    splitting: true,
    platform: "node",
    target: "node22",
    format: "esm",
    external: EXTERNAL,
    sourcemap: true,
    // No shebang banner: every entry module already carries one and esbuild
    // hoists it. Adding another put a second `#!` on line two, which is a
    // syntax error rather than a comment.
    metafile: true,
    logLevel: "warning",
  });

  const bin = join(outdir, `${target.name}.mjs`);
  chmodSync(bin, 0o755);

  const outputs = Object.entries(result.metafile.outputs).filter(
    ([path]) => !path.endsWith(".map"),
  );
  const entryBytes =
    outputs.find(([path]) => path.endsWith(`${target.name}.mjs`))?.[1].bytes ??
    0;
  const total = outputs.reduce((sum, [, output]) => sum + output.bytes, 0);

  // The CLI writes the agent skill out when installing the plugin, so the
  // built artefact has to carry it rather than read it from a checkout that a
  // published install would not have.
  if (target.app === "cli") {
    const to = join(outdir, "skills", "drumlin", "SKILL.md");
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(
      join(root, "integrations/cursor/skills/drumlin/SKILL.md"),
      to,
    );
  }

  process.stdout.write(
    `${target.name.padEnd(13)} ` +
      `${String(Math.round(entryBytes / 1024)).padStart(4)}kB entry, ` +
      `${String(Math.round(total / 1024)).padStart(4)}kB total ` +
      `(${outputs.length - 1} chunks)  ${relative(root, bin)}\n`,
  );
}
