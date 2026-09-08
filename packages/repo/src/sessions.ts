import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { daemonPaths } from "./paths.js";

/**
 * Editing-session state.
 *
 * A session spans processes: Cursor's `sessionStart` hook runs one `drumlin`
 * invocation and `stop` runs another, so the baseline cannot live in memory
 * even when a daemon is available. It is a small JSON file instead, which has
 * the side benefit of making the hooks work identically with `--no-daemon`.
 *
 * Deliberately stored per user rather than in `.drumlin/`. A hook firing on
 * every edit must never write into the repository — Milestone A established
 * that only `drumlin init` creates `.drumlin/` — and a baseline is worthless
 * an hour later, so there is nothing here worth committing.
 */

export interface SessionRecord {
  id: string;
  root: string;
  startedAt: string;
  label?: string;
  /** Fingerprints of findings open when the session began. */
  baseline: string[];
  /** Absolute paths reported changed, in first-seen order. */
  changed: string[];
  /** Last time each path was reported, for the grace window. */
  touchedAt: Record<string, string>;
}

/** Sessions older than this are swept: a stale baseline is worse than none. */
const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;

export class SessionStore {
  private readonly dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? join(daemonPaths().dir, "sessions");
  }

  /**
   * Begin a session, adopting the host's own identifier when it has one.
   *
   * Cursor gives every conversation a `conversation_id`, and reusing it means
   * the `stop` hook finds the baseline without the two hooks having to pass
   * state between themselves.
   */
  start(
    record: Omit<SessionRecord, "id" | "changed" | "touchedAt"> & {
      id?: string;
    },
  ): SessionRecord {
    this.sweep();
    const session: SessionRecord = {
      id: record.id ?? randomUUID(),
      root: record.root,
      startedAt: record.startedAt,
      baseline: [...record.baseline],
      changed: [],
      touchedAt: {},
    };
    if (record.label) session.label = record.label;
    this.write(session);
    return session;
  }

  read(id: string): SessionRecord | undefined {
    const file = this.fileFor(id);
    if (!existsSync(file)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as SessionRecord;
      if (!parsed.id || !parsed.root) return undefined;
      return {
        ...parsed,
        baseline: parsed.baseline ?? [],
        changed: parsed.changed ?? [],
        touchedAt: parsed.touchedAt ?? {},
      };
    } catch {
      // A truncated write means no baseline, which the caller reports as
      // "cannot attribute" rather than failing the hook.
      return undefined;
    }
  }

  /** Record changed paths. Returns the session, or undefined if unknown. */
  touch(
    id: string,
    files: readonly string[],
    now: string,
  ): SessionRecord | undefined {
    const session = this.read(id);
    if (!session) return undefined;

    const known = new Set(session.changed);
    for (const file of files) {
      if (!known.has(file)) {
        session.changed.push(file);
        known.add(file);
      }
      session.touchedAt[file] = now;
    }

    this.write(session);
    return session;
  }

  /**
   * Add fingerprints to the baseline.
   *
   * Called once a finding has been put in front of the agent. From then on it
   * counts as pre-existing, because it has been said and repeating it is how a
   * tool gets ignored.
   */
  absorb(
    id: string,
    fingerprints: readonly string[],
  ): SessionRecord | undefined {
    if (fingerprints.length === 0) return this.read(id);
    const session = this.read(id);
    if (!session) return undefined;

    const known = new Set(session.baseline);
    for (const fingerprint of fingerprints) known.add(fingerprint);
    session.baseline = [...known].sort();

    this.write(session);
    return session;
  }

  end(id: string): boolean {
    const file = this.fileFor(id);
    if (!existsSync(file)) return false;
    rmSync(file, { force: true });
    return true;
  }

  private write(session: SessionRecord): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(
      this.fileFor(session.id),
      `${JSON.stringify(session, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  }

  /**
   * Hash the id into the filename.
   *
   * A host-supplied conversation id is untrusted input that would otherwise
   * reach `join`, and one containing `../` would write wherever it liked.
   */
  private fileFor(id: string): string {
    const digest = createHash("sha256").update(id).digest("hex").slice(0, 32);
    return join(this.dir, `${digest}.json`);
  }

  private sweep(): void {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    const cutoff = Date.now() - MAX_SESSION_AGE_MS;
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const file = join(this.dir, name);
      try {
        if (statSync(file).mtimeMs < cutoff) rmSync(file, { force: true });
      } catch {
        continue;
      }
    }
  }
}
