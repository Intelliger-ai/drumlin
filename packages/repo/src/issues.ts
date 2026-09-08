import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IssueSchema, issueId, parseIssueId, type Issue } from "@drumlin/model";
import { repoPaths } from "./paths.js";

/**
 * Issue persistence.
 *
 * Issues are the one thing here that must survive everything else: a `UX-`
 * number appears in commit messages and in conversation, so it can never be
 * reassigned. The fingerprint index is what makes that possible across reruns,
 * since findings themselves carry no identity.
 */

interface IssuesIndex {
  /** Highest number ever allocated. Never decreases, even after deletions. */
  lastSequence: number;
  /** Problem fingerprint to issue ID. */
  byFingerprint: Record<string, string>;
}

const EMPTY_INDEX: IssuesIndex = { lastSequence: 0, byFingerprint: {} };

export class IssueStore {
  private readonly paths: ReturnType<typeof repoPaths>;
  private index: IssuesIndex;

  constructor(root: string) {
    this.paths = repoPaths(root);
    this.index = this.readIndex();
  }

  private readIndex(): IssuesIndex {
    if (!existsSync(this.paths.issuesIndexFile)) return { ...EMPTY_INDEX };
    try {
      const parsed = JSON.parse(
        readFileSync(this.paths.issuesIndexFile, "utf8"),
      ) as Partial<IssuesIndex>;
      return {
        lastSequence: parsed.lastSequence ?? 0,
        byFingerprint: parsed.byFingerprint ?? {},
      };
    } catch {
      return { ...EMPTY_INDEX };
    }
  }

  /** Every issue currently on disk, ordered by ID. */
  list(): Issue[] {
    const issues: Issue[] = [];
    for (const id of Object.values(this.index.byFingerprint)) {
      const issue = this.read(id);
      if (issue) issues.push(issue);
    }
    return issues.sort((a, b) => a.id.localeCompare(b.id));
  }

  read(id: string): Issue | undefined {
    const file = this.fileFor(id);
    if (!existsSync(file)) return undefined;
    try {
      return IssueSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    } catch {
      return undefined;
    }
  }

  /**
   * The issue ID for a problem fingerprint, allocating a new one if needed.
   *
   * Allocation is the only operation that advances the sequence, and it is
   * keyed on the fingerprint, so re-detecting the same problem returns the same
   * number rather than minting another.
   */
  idFor(fingerprint: string): { id: string; allocated: boolean } {
    const existing = this.index.byFingerprint[fingerprint];
    if (existing) return { id: existing, allocated: false };

    const next = this.index.lastSequence + 1;
    const id = issueId(next);
    this.index.lastSequence = next;
    this.index.byFingerprint[fingerprint] = id;
    return { id, allocated: true };
  }

  write(issue: Issue): void {
    mkdirSync(this.paths.issuesDir, { recursive: true });
    this.index.byFingerprint[issue.fingerprint] = issue.id;
    const sequence = parseIssueId(issue.id);
    if (sequence !== undefined && sequence > this.index.lastSequence) {
      this.index.lastSequence = sequence;
    }
    writeFileSync(
      this.fileFor(issue.id),
      `${JSON.stringify(issue, null, 2)}\n`,
      "utf8",
    );
  }

  /** Persist the fingerprint index. Call once after a batch of writes. */
  flush(): void {
    mkdirSync(this.paths.issuesDir, { recursive: true });
    const ordered: IssuesIndex = {
      lastSequence: this.index.lastSequence,
      byFingerprint: Object.fromEntries(
        Object.entries(this.index.byFingerprint).sort(([a], [b]) =>
          a.localeCompare(b),
        ),
      ),
    };
    writeFileSync(
      this.paths.issuesIndexFile,
      `${JSON.stringify(ordered, null, 2)}\n`,
      "utf8",
    );
  }

  private fileFor(id: string): string {
    return join(this.paths.issuesDir, `${id}.json`);
  }
}
