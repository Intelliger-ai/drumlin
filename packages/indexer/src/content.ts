import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { IGNORED_DIRECTORIES } from "./discover.js";
import { CONTENT_EXTENSIONS, findMarkdownLinks } from "./analyze/mentions.js";

/**
 * Links written in prose.
 *
 * A content site's real navigation is substantially in its articles: on the
 * first app measured, a hub page was linked from eleven MDX guides and from no
 * component at all. Markdown is not parsed by ts-morph, so it has to be read
 * separately or those links do not exist as far as the graph is concerned.
 */

export interface ContentLinks {
  file: string;
  links: string[];
}

/** Every markdown or MDX document beneath `root`, with its internal links. */
export function collectContentLinks(root: string): ContentLinks[] {
  const results: ContentLinks[] = [];

  const walk = (directory: string, depth: number): void => {
    if (depth > 8) return;

    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const path = join(directory, entry.name);

      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || IGNORED_DIRECTORIES.has(entry.name)) {
          continue;
        }
        walk(path, depth + 1);
        continue;
      }

      if (!CONTENT_EXTENSIONS.includes(extname(entry.name) as never)) continue;

      try {
        const links = findMarkdownLinks(readFileSync(path, "utf8"));
        if (links.length > 0) results.push({ file: path, links });
      } catch {
        continue;
      }
    }
  };

  walk(root, 0);
  return results;
}
