#!/usr/bin/env node
/**
 * The whole loop, on a real repository, with a real regression.
 *
 * Everything else measures a part. This measures the thing Milestone B is for:
 * an agent edits a file, the turn ends, and Drumlin says something useful —
 * or, just as important, says nothing when nothing is wrong.
 *
 * It runs against a throwaway copy of a real app so the regression can be
 * genuinely introduced and then genuinely undone. Both directions are tested,
 * because a loop that always follows up is as useless as one that never does.
 *
 * Usage: node scripts/probe-loop.mjs <app-path>
 */
import { spawn, execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

// Required: see probe-mcp.mjs. Defaulting to cwd would also mean copying
// whatever directory you happened to be in into /tmp.
if (!process.argv[2]) {
  console.error("Usage: node scripts/probe-loop.mjs <app-path>");
  process.exit(1);
}

const source = resolve(process.argv[2]);
const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "../apps/cli/bin/drumlin.mjs");

const root = mkdtempSync(join(tmpdir(), "drumlin-loop-"));
const state = mkdtempSync(join(tmpdir(), "drumlin-loop-state-"));
let failures = 0;

function cleanup() {
  try {
    execFileSync(process.execPath, [cli, "daemon", "stop"], {
      env: { ...process.env, DRUMLIN_STATE_DIR: state },
      stdio: "ignore",
    });
  } catch {
    // Already gone.
  }
  rmSync(root, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
}
process.on("exit", cleanup);

function hook(event, payload, env = {}) {
  return new Promise((settle) => {
    const started = performance.now();
    const child = spawn(process.execPath, [cli, "hook", event], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, DRUMLIN_STATE_DIR: state, ...env },
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.resume();
    child.on("close", () => {
      let parsed = {};
      try {
        parsed = JSON.parse(stdout.trim() || "{}");
      } catch {
        parsed = { __unparseable: stdout };
      }
      settle({ ...parsed, __ms: performance.now() - started });
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

function cliRun(args) {
  return execFileSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, DRUMLIN_STATE_DIR: state },
  });
}

function check(label, condition, detail = "") {
  console.log(`  ${condition ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!condition) failures += 1;
}

// A copy, so the regression is real and the developer's repository is not.
console.log(`copying ${source}`);
cpSync(source, root, {
  recursive: true,
  filter: (path) => !/node_modules|\.next|\.git($|\/)/.test(path),
});
cliRun(["init", "--app", root]);

// A repository, because `--changed` asks Git what moved. Without this the
// probe would test the no-git path and report that as a failure of the loop.
for (const args of [
  ["init", "--initial-branch=main"],
  ["config", "user.email", "probe@drumlin.local"],
  ["config", "user.name", "Drumlin Probe"],
  ["add", "-A"],
  ["-c", "commit.gpgsign=false", "commit", "-m", "baseline", "--no-verify"],
]) {
  execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
}

const base = { workspace_roots: [root], conversation_id: `loop-${Date.now()}` };

// ── Turn 0: open the workspace and start a conversation ──────────────────────
console.log("\nopening the workspace");
await hook("workspace-open", { ...base, hook_event_name: "workspaceOpen" });
await new Promise((r) => setTimeout(r, 4_000));

const started = await hook("session-start", {
  ...base,
  hook_event_name: "sessionStart",
});
const sessionId = started.env?.DRUMLIN_SESSION;
const env = { DRUMLIN_SESSION: sessionId ?? base.conversation_id };
console.log(
  `  baseline captured in ${started.__ms.toFixed(0)}ms, session ${
    sessionId ? sessionId.slice(0, 12) : "MISSING"
  }`,
);
check("sessionStart returned a session id", Boolean(sessionId));
check(
  "sessionStart told the agent Drumlin is here",
  typeof started.additional_context === "string",
);

// ── Turn 1: a turn that touches nothing ──────────────────────────────────────
console.log("\nturn 1 — the agent changed nothing");
const quiet = await hook(
  "stop",
  { ...base, hook_event_name: "stop", status: "completed", loop_count: 0 },
  env,
);
check(
  "no follow-up when nothing changed",
  !quiet.followup_message,
  `${quiet.__ms.toFixed(0)}ms`,
);

// ── Turn 2: the agent adds a screen that fetches without an error state ──────
//
// Deliberately a high-severity rule. Only `state.route.no-error`,
// `async.mutation.no-feedback`, and `flow.destructive.no-confirm` are high or
// above, and the `stop` hook follows up on nothing below that — an orphaned
// route is a medium and stays in the report where it belongs. Getting this
// wrong is how the loop starts spending agent turns on cosmetics.
console.log("\nturn 2 — the agent adds a screen that fetches with no error state");
const orphan = join(root, "src", "app", "loop-probe-orphan", "page.tsx");
mkdirSync(dirname(orphan), { recursive: true });
writeFileSync(
  orphan,
  [
    '"use client";',
    "",
    'import { useQuery } from "@tanstack/react-query";',
    "",
    "export default function LoopProbeOrphan() {",
    "  const { data } = useQuery({",
    '    queryKey: ["loop-probe"],',
    '    queryFn: () => fetch("/api/loop-probe").then((r) => r.json()),',
    "  });",
    "",
    "  return <div>{data?.title}</div>;",
    "}",
    "",
  ].join("\n"),
);

const edit = await hook(
  "file-edit",
  { ...base, hook_event_name: "afterFileEdit", file_path: orphan },
  env,
);
console.log(`  afterFileEdit ${edit.__ms.toFixed(0)}ms`);
check("afterFileEdit stayed under 500ms", edit.__ms < 500, `${edit.__ms.toFixed(0)}ms`);

// The daemon debounces, as it would mid-turn.
await new Promise((r) => setTimeout(r, 2_000));

const followed = await hook(
  "stop",
  { ...base, hook_event_name: "stop", status: "completed", loop_count: 0 },
  env,
);
console.log(`  stop ${followed.__ms.toFixed(0)}ms`);
check(
  "stop followed up on the regression",
  Boolean(followed.followup_message),
  `${followed.__ms.toFixed(0)}ms`,
);
check("stop stayed under 2s", followed.__ms < 2_000, `${followed.__ms.toFixed(0)}ms`);

if (followed.followup_message) {
  console.log("\n  ── message sent to the agent ──");
  for (const line of followed.followup_message.split("\n")) {
    console.log(`  │ ${line}`);
  }
  console.log("  ──");

  check(
    "names the screen it is about",
    /loop-probe-orphan/.test(followed.followup_message),
  );
  check(
    "offers a fix rather than only a complaint",
    /Fix:/.test(followed.followup_message),
  );
  check(
    "leaves the agent a way to disagree",
    /explain why|intentional/i.test(followed.followup_message),
  );
}

// ── Turn 3: the same regression must not be reported twice ───────────────────
console.log("\nturn 3 — the agent ignored the follow-up");
const repeated = await hook(
  "stop",
  { ...base, hook_event_name: "stop", status: "completed", loop_count: 1 },
  env,
);
check(
  "does not repeat itself",
  !repeated.followup_message,
  `${repeated.__ms.toFixed(0)}ms`,
);

// ── Turn 4: a second, different regression still gets through ────────────────
console.log("\nturn 4 — a different regression after an absorbed one");
const second = join(root, "src", "app", "loop-probe-second", "page.tsx");
mkdirSync(dirname(second), { recursive: true });
writeFileSync(
  second,
  [
    '"use client";',
    "",
    'import { useQuery } from "@tanstack/react-query";',
    "",
    "export default function LoopProbeSecond() {",
    '  const { data } = useQuery({ queryKey: ["second"], queryFn: () => fetch("/api/x") });',
    "  return <div>{String(data)}</div>;",
    "}",
    "",
  ].join("\n"),
);
await hook(
  "file-edit",
  { ...base, hook_event_name: "afterFileEdit", file_path: second },
  env,
);
await new Promise((r) => setTimeout(r, 2_000));

const again = await hook(
  "stop",
  { ...base, hook_event_name: "stop", status: "completed", loop_count: 1 },
  env,
);
check(
  "still reports a new, different problem",
  Boolean(again.followup_message) &&
    /loop-probe-second/.test(again.followup_message ?? ""),
  `${again.__ms.toFixed(0)}ms`,
);

// ── The CLI agrees with the hook ─────────────────────────────────────────────
console.log("\nthe CLI sees the same thing");
const changed = cliRun(["check", "--app", root, "--changed"]);
check(
  "check --changed reports the introduced screens",
  changed.includes("loop-probe"),
);
check(
  "check --changed says its analysis was global",
  changed.includes("only the report is scoped"),
);

// ── Undo, and confirm it goes quiet ──────────────────────────────────────────
console.log("\nreverting both screens");
rmSync(dirname(orphan), { recursive: true, force: true });
rmSync(dirname(second), { recursive: true, force: true });
await hook(
  "file-edit",
  { ...base, hook_event_name: "afterFileEdit", file_path: orphan },
  env,
);
await new Promise((r) => setTimeout(r, 2_500));

const after = cliRun(["check", "--app", root]);
check(
  "the finding is gone once the code is",
  !after.includes("loop-probe"),
);

await hook("stop", { ...base, hook_event_name: "stop", status: "completed" }, env);

console.log(
  failures === 0
    ? "\nok — the loop reports real regressions, once each, and goes quiet when fixed"
    : `\n${failures} problem(s)`,
);
process.exit(failures === 0 ? 0 : 1);
