import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initRepo } from "@drumlin/repo";
import { InProcessEngine } from "./in-process.js";

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../indexer/fixtures/mixed-app",
);

/**
 * The session loop, end to end.
 *
 * This is the highest-stakes logic in Milestone B and the hardest to eyeball.
 * A `followup_message` spends a whole agent turn, so a diff that reports a
 * pre-existing finding as new does not merely annoy — it derails work. Each
 * test here corresponds to one way the loop can cry wolf.
 */
describe("session baselines", () => {
  let root: string;
  let state: string;
  const engine = new InProcessEngine();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "drumlin-session-"));
    cpSync(FIXTURE, root, { recursive: true });
    initRepo(root);

    // Sessions live per user, not in the repository. Redirect that per test,
    // or the suite writes into the developer's real session directory and
    // tests start seeing each other's baselines.
    state = mkdtempSync(join(tmpdir(), "drumlin-state-"));
    process.env["DRUMLIN_STATE_DIR"] = state;
  });

  afterEach(() => {
    delete process.env["DRUMLIN_STATE_DIR"];
    rmSync(root, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  });

  /** Add a route nothing links to, and return its absolute path. */
  function addScreen(segment: string, source: string): string {
    const file = join(root, "app", segment, "page.tsx");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, source);
    return file;
  }

  async function startSession(id: string): Promise<number> {
    const started = await engine.request("session.start", {
      root,
      app: root,
      sessionId: id,
    });
    return started.baseline;
  }

  it("snapshots the existing findings as the baseline", async () => {
    const baseline = await startSession("s-baseline");
    expect(baseline).toBeGreaterThan(0);
  });

  /**
   * The one that matters most. The fixture app is full of pre-existing
   * findings; a turn that changed nothing must introduce none of them.
   */
  it("reports nothing when a turn changes nothing", async () => {
    await startSession("s-quiet");

    const diff = await engine.request("session.diff", {
      root,
      app: root,
      sessionId: "s-quiet",
    });

    expect(diff.hadBaseline).toBe(true);
    expect(diff.introduced).toEqual([]);
    expect(diff.preexisting).toBeGreaterThan(0);
  });

  it("reports nothing for an unknown session rather than everything", async () => {
    // The failure mode being guarded: treating a missing baseline as an empty
    // baseline, which makes every finding in the repository look brand new.
    const diff = await engine.request("session.diff", {
      root,
      app: root,
      sessionId: "never-started",
    });

    expect(diff.hadBaseline).toBe(false);
    expect(diff.introduced).toEqual([]);
  });

  it("detects a finding the session introduced", async () => {
    await startSession("s-introduce");

    // A new screen nothing links to: an orphan, and a graph-scoped finding,
    // so this also exercises attribution resolving through a target node.
    const file = addScreen(
      "orphan-screen",
      "export default function Orphan() {\n  return <div>Orphan</div>;\n}\n",
    );

    await engine.request("session.touch", {
      sessionId: "s-introduce",
      files: [file],
    });

    const diff = await engine.request("session.diff", {
      root,
      app: root,
      sessionId: "s-introduce",
    });

    expect(diff.introduced.length).toBeGreaterThan(0);
    expect(
      diff.introduced.some((finding) => finding.ruleId === "flow.orphan"),
    ).toBe(true);
  });

  /**
   * Absorption is what stops the loop repeating itself. A finding the agent
   * declined to fix must not come back at the end of every later turn.
   */
  it("reports an introduced finding once when absorbing", async () => {
    await startSession("s-absorb");

    const file = addScreen(
      "absorbed",
      "export default function Absorbed() {\n  return <div>x</div>;\n}\n",
    );
    await engine.request("session.touch", {
      sessionId: "s-absorb",
      files: [file],
    });

    const first = await engine.request("session.diff", {
      root,
      app: root,
      sessionId: "s-absorb",
      absorb: true,
    });
    expect(first.introduced.length).toBeGreaterThan(0);

    const second = await engine.request("session.diff", {
      root,
      app: root,
      sessionId: "s-absorb",
      absorb: true,
    });
    expect(second.introduced).toEqual([]);
  });

  it("does not absorb unless asked", async () => {
    await startSession("s-no-absorb");

    const file = addScreen(
      "kept",
      "export default function Kept() {\n  return <div>x</div>;\n}\n",
    );
    await engine.request("session.touch", {
      sessionId: "s-no-absorb",
      files: [file],
    });

    const params = {
      root,
      app: root,
      sessionId: "s-no-absorb",
    } as const;
    const first = await engine.request("session.diff", params);
    const second = await engine.request("session.diff", params);

    expect(second.introduced.length).toBe(first.introduced.length);
  });

  /**
   * A hand-typed edit made while the agent worked produces a finding the
   * baseline has never seen. Blaming the agent for it is both wrong and
   * unfixable by the agent, which is the worst combination.
   */
  it("sets aside a new finding in code the session did not touch", async () => {
    await startSession("s-elsewhere");

    const mine = addScreen(
      "typed-by-hand",
      "export default function Typed() {\n  return <div>x</div>;\n}\n",
    );

    // The session reports touching a different, unrelated file.
    const theirs = join(root, "app", "page.tsx");
    await engine.request("session.touch", {
      sessionId: "s-elsewhere",
      files: [theirs],
    });

    const diff = await engine.request("session.diff", {
      root,
      app: root,
      sessionId: "s-elsewhere",
    });

    expect(diff.attributed).toBe(true);
    expect(diff.elsewhere).toBeGreaterThan(0);
    expect(
      diff.introduced.some((finding) =>
        finding.evidence.some((item) =>
          item.location?.file?.includes("typed-by-hand"),
        ),
      ),
    ).toBe(false);
  });

  /**
   * An empty changed list is ambiguous: the turn wrote nothing, or
   * `afterFileEdit` never fired, which happens whenever an agent writes
   * through a terminal command. Narrowing on that would silently switch the
   * feedback loop off.
   */
  it("falls back to fingerprints when no edits were recorded", async () => {
    await startSession("s-unrecorded");

    const file = addScreen(
      "unrecorded",
      "export default function Unrecorded() {\n  return <div>x</div>;\n}\n",
    );

    const diff = await engine.request("session.diff", {
      root,
      app: root,
      sessionId: "s-unrecorded",
    });

    expect(diff.attributed).toBeFalsy();
    expect(diff.introduced.length).toBeGreaterThan(0);
  });

  /**
   * The grace window is off unless asked for, and this is the test that
   * matters. With it on by default, a real regression came back as
   * `graceWithheld: 1, introduced: 0` — a loop that has switched itself off
   * while reporting success. `stop` fires seconds after the last write by
   * construction, so any default window suppresses everything.
   */
  it("does not withhold anything by default", async () => {
    await startSession("s-grace-default");

    const file = addScreen(
      "just-written",
      "export default function W() {\n  return <div>x</div>;\n}\n",
    );
    await engine.request("session.touch", {
      sessionId: "s-grace-default",
      files: [file],
    });

    const diff = await engine.request("session.diff", {
      root,
      app: root,
      sessionId: "s-grace-default",
    });

    expect(diff.graceWithheld).toBe(0);
    expect(diff.introduced.length).toBeGreaterThan(0);
  });

  it("withholds a recently written file when a window is asked for", async () => {
    await startSession("s-grace");

    const file = addScreen(
      "in-flight",
      "export default function InFlight() {\n  return <div>x</div>;\n}\n",
    );
    await engine.request("session.touch", {
      sessionId: "s-grace",
      files: [file],
    });

    const withheld = await engine.request("session.diff", {
      root,
      app: root,
      sessionId: "s-grace",
      graceMs: 60_000,
    });
    const reported = await engine.request("session.diff", {
      root,
      app: root,
      sessionId: "s-grace",
    });

    expect(withheld.graceWithheld).toBeGreaterThan(0);
    expect(withheld.introduced.length).toBeLessThan(reported.introduced.length);
  });

  it("honours the severity floor", async () => {
    await startSession("s-severity");

    const file = addScreen(
      "severity",
      "export default function Sev() {\n  return <div>x</div>;\n}\n",
    );
    await engine.request("session.touch", {
      sessionId: "s-severity",
      files: [file],
    });

    const all = await engine.request("session.diff", {
      root,
      app: root,
      sessionId: "s-severity",
    });
    const critical = await engine.request("session.diff", {
      root,
      app: root,
      sessionId: "s-severity",
      severity: "critical",
    });

    expect(critical.introduced.length).toBeLessThanOrEqual(
      all.introduced.length,
    );
    expect(
      critical.introduced.every((finding) => finding.severity === "critical"),
    ).toBe(true);
  });

  it("ignores a changed file that the indexer would never parse", async () => {
    await startSession("s-readme");

    const readme = join(root, "README.md");
    writeFileSync(readme, "# notes\n");

    const touched = await engine.request("session.touch", {
      sessionId: "s-readme",
      files: [readme],
    });

    expect(touched.recorded).toBe(0);
  });

  it("closes a session, and reports a second close as a no-op", async () => {
    await startSession("s-end");

    expect(
      (await engine.request("session.end", { sessionId: "s-end" })).closed,
    ).toBe(true);
    expect(
      (await engine.request("session.end", { sessionId: "s-end" })).closed,
    ).toBe(false);
  });

  /**
   * A host-supplied conversation id reaches the filesystem. One containing
   * `../` must not write outside the session directory.
   */
  it("does not let a traversal in the session id escape the state directory", async () => {
    const nasty = "../../../../etc/drumlin-escape";
    await engine.request("session.start", {
      root,
      app: root,
      sessionId: nasty,
    });

    const diff = await engine.request("session.diff", {
      root,
      app: root,
      sessionId: nasty,
    });

    // Round-trips by id, so the store is usable...
    expect(diff.hadBaseline).toBe(true);

    // ...while every file it wrote is a hash inside the session directory.
    const written = readdirSync(join(state, "sessions"));
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(/^[0-9a-f]{32}\.json$/);
  });
});
