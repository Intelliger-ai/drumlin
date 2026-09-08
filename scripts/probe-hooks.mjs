#!/usr/bin/env node
/**
 * Drive the hooks the way Cursor does, and time them.
 *
 * Cursor pipes a JSON payload on stdin, reads JSON on stdout, and enforces a
 * timeout. None of that is exercised by a unit test, and all of it is what
 * breaks in practice: a hook that prints a stray line, exits non-zero, or
 * takes four seconds is a hook that degrades the editor.
 *
 * The measurement matters as much as the pass/fail. `afterFileEdit` fires on
 * every write an agent makes, so its cost is paid dozens of times per turn.
 *
 * Usage: node scripts/probe-hooks.mjs <workspace>
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

// Required: see probe-mcp.mjs. Drumlin is not a fixture for itself.
if (!process.argv[2]) {
  console.error("Usage: node scripts/probe-hooks.mjs <app-path>");
  process.exit(1);
}

const root = resolve(process.argv[2]);
const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, "../apps/cli/bin/drumlin.mjs");

/** Budgets from apps/cli/src/commands/hook.ts, in milliseconds. */
const BUDGET = {
  "workspace-open": 3_000,
  "session-start": 15_000,
  "file-edit": 500,
  stop: 20_000,
};

function runHook(event, payload) {
  return new Promise((settle) => {
    const started = performance.now();
    const child = spawn(process.execPath, [cli, "hook", event], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(payload.__env ?? {}) },
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));

    child.on("close", (code) => {
      const ms = performance.now() - started;
      const { __env, ...rest } = payload;
      void rest;
      settle({ event, code, stdout: stdout.trim(), stderr: stderr.trim(), ms });
    });

    const { __env, ...body } = payload;
    void __env;
    child.stdin.end(JSON.stringify(body));
  });
}

let failures = 0;

function report(result, extra = "") {
  const budget = BUDGET[result.event];
  const slow = result.ms > budget;
  const bad = result.code !== 0;

  let parsed;
  let unparseable = false;
  try {
    parsed = JSON.parse(result.stdout || "{}");
  } catch {
    unparseable = true;
  }

  const flags = [];
  if (bad) flags.push(`exit ${result.code}`);
  if (unparseable) flags.push("stdout is not JSON");
  if (slow) flags.push(`over ${budget}ms budget`);
  if (flags.length > 0) failures += 1;

  console.log(
    `${result.event.padEnd(15)} ${`${result.ms.toFixed(0)}ms`.padStart(7)}` +
      `  ${flags.length === 0 ? "ok" : `FAIL: ${flags.join(", ")}`}` +
      (extra ? `  ${extra}` : ""),
  );
  if (result.stderr) console.log(`  stderr: ${result.stderr}`);
  return parsed ?? {};
}

const conversation = `probe-${Date.now()}`;
const base = { workspace_roots: [root], conversation_id: conversation };

console.log(`workspace ${root}\n`);

// 1. Window opens. Warms the daemon, must not wait for a cold index.
report(
  await runHook("workspace-open", {
    ...base,
    hook_event_name: "workspaceOpen",
  }),
);

// Give the daemon a moment to finish its first parse, as a real session would.
await new Promise((r) => setTimeout(r, 3_000));

// 2. Conversation starts. Snapshots the baseline, returns the session id.
const started = report(
  await runHook("session-start", {
    ...base,
    hook_event_name: "sessionStart",
    model: "probe",
  }),
);
const sessionId = started.env?.DRUMLIN_SESSION;
console.log(
  `  session ${sessionId ? sessionId.slice(0, 12) : "MISSING"}` +
    `${started.additional_context ? ", context sent to the agent" : ""}`,
);
if (!sessionId) failures += 1;

// 3. Agent writes files. The hot path: fires on every write.
const sessionEnv = { DRUMLIN_SESSION: sessionId ?? conversation };
const target = join(root, "src", "app", "page.tsx");
const edits = [];
for (let index = 0; index < 5; index += 1) {
  edits.push(
    await runHook("file-edit", {
      ...base,
      hook_event_name: "afterFileEdit",
      file_path: target,
      __env: sessionEnv,
    }),
  );
}
for (const edit of edits) report(edit);
const editTimes = edits.map((edit) => edit.ms).sort((a, b) => a - b);
console.log(
  `  median ${editTimes[Math.floor(editTimes.length / 2)].toFixed(0)}ms` +
    ` over ${edits.length} writes`,
);

// A markdown file must be ignored rather than indexed.
report(
  await runHook("file-edit", {
    ...base,
    hook_event_name: "afterFileEdit",
    file_path: join(root, "README.md"),
    __env: sessionEnv,
  }),
  "(non-source path)",
);

// 4. Turn ends. Diffs against the baseline.
const stopped = report(
  await runHook("stop", {
    ...base,
    hook_event_name: "stop",
    status: "completed",
    loop_count: 0,
    __env: sessionEnv,
  }),
);
console.log(
  stopped.followup_message
    ? `  follow-up sent:\n${stopped.followup_message
        .split("\n")
        .map((line) => `    ${line}`)
        .join("\n")}`
    : "  no follow-up — nothing new at high or above",
);

// 5. The loop cap. At the limit, stop escalating regardless of findings.
const capped = report(
  await runHook("stop", {
    ...base,
    hook_event_name: "stop",
    status: "completed",
    loop_count: 3,
    __env: sessionEnv,
  }),
  "(loop_count at the cap)",
);
if (capped.followup_message) {
  console.log("  FAIL: followed up despite reaching the loop cap");
  failures += 1;
} else {
  console.log("  correctly silent at the cap");
}

// 6. An aborted turn already has enough going wrong.
const aborted = report(
  await runHook("stop", {
    ...base,
    hook_event_name: "stop",
    status: "aborted",
    loop_count: 0,
    __env: sessionEnv,
  }),
  "(aborted turn)",
);
if (aborted.followup_message) {
  console.log("  FAIL: followed up on an aborted turn");
  failures += 1;
}

// 7. Garbage on stdin must not break the editor.
const garbage = await new Promise((settle) => {
  const started = performance.now();
  const child = spawn(process.execPath, [cli, "hook", "stop"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.on("close", (code) =>
    settle({
      event: "stop",
      code,
      stdout: stdout.trim(),
      stderr: "",
      ms: performance.now() - started,
    }),
  );
  child.stdin.end("not json at all {{{");
});
report(garbage, "(malformed stdin)");

console.log(
  failures === 0
    ? "\nok — every hook answered in budget with valid JSON"
    : `\n${failures} problem(s)`,
);
process.exit(failures === 0 ? 0 : 1);
