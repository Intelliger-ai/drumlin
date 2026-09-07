import { Project, ts } from "ts-morph";
import { IGNORED_DIRECTORIES, isIgnoredPath } from "./discover.js";

// Re-exported from here for the callers that already import it from this
// module. It lives in `discover.ts` because it is a string test with no need
// of a parser, and anything importing it from here would pay for ts-morph to
// ask whether a filename ends in `.tsx` — which the `afterFileEdit` hook did.

/**
 * A ts-morph project configured for syntactic analysis only.
 *
 * Type resolution is deliberately switched off. Walking node_modules to resolve
 * every import costs far more than the extra precision buys on a large app, and
 * every Milestone A rule is answerable from the AST. `DEC-0001` records that
 * type inference is the reason to be in TypeScript at all — this is where the
 * option gets reserved rather than spent.
 */
export function createProject(): Project {
  return new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    skipLoadingLibFiles: true,
    compilerOptions: {
      allowJs: true,
      jsx: ts.JsxEmit.Preserve,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      noResolve: true,
    },
  });
}

/**
 * Add every analyzable source file beneath `dir`, skipping build output and
 * vendored trees. Returns the files actually added.
 *
 * The exclusions are negative globs rather than a filter over the results,
 * because the cost is paid during globbing: pointing this at an app with a
 * local `node_modules` and filtering afterwards parses tens of thousands of
 * vendored files and exhausts the heap before the filter ever runs.
 */
export function addSourceDirectory(project: Project, dir: string): string[] {
  const patterns = [
    `${dir}/**/*.{ts,tsx,jsx,js,mjs,cjs}`,
    `!${dir}/**/*.d.ts`,
    ...[...IGNORED_DIRECTORIES].map((name) => `!${dir}/**/${name}/**`),
  ];

  const added = project.addSourceFilesAtPaths(patterns);

  const kept: string[] = [];
  for (const file of added) {
    const path = file.getFilePath();
    // Belt and braces: a symlink can still smuggle an ignored path in.
    if (isIgnoredPath(path) || path.endsWith(".d.ts")) {
      project.removeSourceFile(file);
      continue;
    }
    kept.push(path);
  }
  return kept.sort();
}

export { isAnalyzableSource } from "./discover.js";
