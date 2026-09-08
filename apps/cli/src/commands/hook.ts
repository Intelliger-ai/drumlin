import { existsSync } from "node:fs";
import { severityRank, type Finding, type Severity } from "@drumlin/model";
import { DaemonConnection, RemoteEngine, spawnDaemon } from "@drumlin/client";
// The `/paths` subpath, not the package root: the root loads ts-morph, and
// this hook needs one filename predicate. Worth ~200ms on every agent write.
import { isAnalyzableSource } from "@drumlin/indexer/paths";
import { daemonPaths, readActivation } from "@drumlin/repo";
import type { ParsedArgs } from "../args.js";

/**
 * `drumlin hook <event>` — the editor's entry point.
 *
 * One rule governs everything here: **never break the editor.** A hook that
 * throws, hangs, or prints garbage costs the developer their session, and they
 * will remove Drumlin rather than debug it. So every path exits 0 with valid
 * JSON, every path has a deadline, and a missing daemon is a silent no-op
 * rather than an error.
 *
 * Cursor's contract, which shapes the rest:
 *   - exit 0 and stdout JSON is honoured; exit 2 blocks; anything else is
 *     ignored and the action proceeds
 *   - `afterFileEdit` has no output at all, so it is pure notification
 *   - `stop` cannot block. Its only field is `followup_message`, which Cursor
 *     submits as the next user message — a new turn, not a held-open one
 *
 * See https://cursor.com/docs/hooks
 */

/** Hard ceiling per hook. Cursor's own default timeout is undocumented. */
const BUDGETS = {
  "workspace-open": 3_000,
  "session-start": 15_000,
  "file-edit": 500,
  stop: 20_000,
} as const;

/** Severity at or above which a `stop` follow-up is worth a whole agent turn. */
const FOLLOWUP_SEVERITY: Severity = "high";

/**
 * Stop following up once a conversation has been redirected this often.
 *
 * Cursor caps auto-follow-ups at five per script; stopping earlier is a
 * judgement about attention rather than about the limit. If three redirections
 * have not fixed it, a fourth will not either.
 */
const MAX_FOLLOWUPS = 3;

interface HookInput {
  hook_event_name?: string;
  conversation_id?: string;
  workspace_roots?: string[];
  file_path?: string;
  status?: string;
  loop_count?: number;
  model?: string;
  session_id?: string;
  edits?: Array<{ old_string?: string; new_string?: string }>;
}

export async function hookCommand(
  args: ParsedArgs,
  cwd: string,
): Promise<number> {
  const [event] = args.positional;
  if (!event) {
    process.stderr.write(
      "Usage: drumlin hook <workspace-open|session-start|file-edit|stop>\n" +
        "Reads the hook payload as JSON on stdin.\n",
    );
    return 1;
  }

  const budget = BUDGETS[event as keyof typeof BUDGETS] ?? 5_000;

  try {
    const input = await readInput(budget);
    const root = workspaceRoot(input, cwd);
    const output = await withDeadline(budget, () =>
      dispatch(event, input, root),
    );
    emit(output ?? {});
  } catch {
    // Deliberately silent. Diagnostics belong in `drumlin daemon log`, not in
    // the middle of somebody's editor session.
    emit({});
  }

  return 0;
}

async function dispatch(
  event: string,
  input: HookInput,
  root: string,
): Promise<Record<string, unknown>> {
  // The gate, and deliberately the first thing every hook passes through.
  //
  // The plugin is installed once per machine but its hooks fire in every
  // workspace, so without this the developer who wanted Drumlin on one project
  // got it on all of them — including repositories that are not theirs. Checked
  // here rather than inside each hook so a new hook cannot forget to ask, and
  // checked before anything spawns a daemon so an unactivated project costs a
  // file read.
  if (!readActivation(root).active) return {};

  switch (event) {
    case "workspace-open":
      return workspaceOpen(root);
    case "session-start":
      return sessionStart(input, root);
    case "file-edit":
      return fileEdit(input, root);
    case "stop":
      return stop(input, root);
    default:
      return {};
  }
}

/**
 * Start the daemon and set it parsing, without waiting for it.
 *
 * Fires when a window opens, which is the one moment a cold index is free:
 * nobody has asked a question yet.
 */
async function workspaceOpen(root: string): Promise<Record<string, unknown>> {
  const paths = daemonPaths();

  if (!existsSync(paths.socketFile)) {
    // Spawn without waiting for the socket. The next hook or tool call will
    // find it; holding the window open for a cold parse would be worse.
    void spawnDaemon({ paths, timeoutMs: 1 }).catch(() => false);
    return {};
  }

  const connection = await DaemonConnection.connect({
    socketFile: paths.socketFile,
  }).catch(() => undefined);
  if (!connection) return {};

  connection.notify("workspace.warm", { root });
  // A tick for the write to reach the socket before the process exits.
  await sleep(30);
  connection.close();
  return {};
}

/**
 * Snapshot what was already wrong, and tell the agent Drumlin is here.
 *
 * The `env` map is propagated by Cursor to every later hook in the session,
 * which is how `stop` finds the baseline without the hooks having to
 * coordinate between themselves.
 */
async function sessionStart(
  input: HookInput,
  root: string,
): Promise<Record<string, unknown>> {
  const engine = await attach();
  if (!engine) return {};

  try {
    const sessionId = input.conversation_id ?? input.session_id;
    const result = await engine.request("session.start", {
      root,
      ...(sessionId ? { sessionId } : {}),
      ...(input.model ? { label: input.model } : {}),
    });

    const output: Record<string, unknown> = {
      env: { DRUMLIN_SESSION: result.sessionId },
    };

    if (result.baseline > 0) {
      output["additional_context"] =
        `Drumlin is watching this workspace for UX regressions. ` +
        `${result.baseline} UX finding(s) already exist here — ` +
        `call the \`drumlin_project_summary\` tool for the shape of the app, ` +
        `or \`drumlin_check_changed\` after editing. ` +
        `New high-severity problems introduced during this session will be reported back to you.`;
    }

    return output;
  } finally {
    engine.close();
  }
}

/**
 * Tell the daemon a file moved. Nothing more.
 *
 * The tightest budget in the file, because this fires on every write an agent
 * makes. It sends two notifications and exits without waiting for either: the
 * daemon debounces and re-indexes on its own, and `stop` is where the answer
 * is collected.
 */
async function fileEdit(
  input: HookInput,
  root: string,
): Promise<Record<string, unknown>> {
  const file = input.file_path;
  if (!file) return {};

  // Filtered here rather than by the matcher, which keys on the tool that did
  // the writing (`Write`, `TabWrite`) and cannot express a path. Without this,
  // editing a README pays for a daemon connection to be told the file is
  // irrelevant.
  if (!isAnalyzableSource(file)) return {};

  const paths = daemonPaths();
  // No spawning here. A cold start takes seconds and this has milliseconds.
  if (!existsSync(paths.socketFile)) return {};

  const connection = await DaemonConnection.connect({
    socketFile: paths.socketFile,
  }).catch(() => undefined);
  if (!connection) return {};

  try {
    // One notification carrying both the file and the session, and no reply
    // awaited. Waiting for `session.touch` to be acknowledged cost 737ms
    // against a 500ms budget, because the daemon is single-threaded and the
    // reply queued behind the re-index this very message had just scheduled.
    connection.notify("workspace.touch", {
      root,
      files: [file],
      ...sessionOf(input),
    });
    // Long enough for the write to reach the socket, short enough not to
    // matter. Closing immediately can drop it.
    await sleep(15);
  } catch {
    // Nothing to report to; the daemon will hear about the file from its own
    // watcher.
  } finally {
    connection.close();
  }

  return {};
}

/**
 * The session this hook belongs to.
 *
 * `DRUMLIN_SESSION` comes from `sessionStart`'s `env` output, which Cursor
 * propagates to later hooks in the conversation. The conversation id is the
 * fallback, since `session.start` adopts it as the session id when given one.
 */
function sessionOf(input: HookInput): { sessionId?: string } {
  const sessionId = process.env["DRUMLIN_SESSION"] ?? input.conversation_id;
  return sessionId ? { sessionId } : {};
}

/**
 * Report what this turn introduced, as a follow-up message.
 *
 * Cursor submits a non-empty `followup_message` as the next user message,
 * which restarts the agent loop. That is the only lever available — there is no
 * way to hold the current turn open — and it is arguably the better one: the
 * finding arrives as an instruction the agent can reason about and argue with.
 */
async function stop(
  input: HookInput,
  root: string,
): Promise<Record<string, unknown>> {
  // An aborted or errored turn has enough going wrong already.
  if (input.status && input.status !== "completed") return {};
  if ((input.loop_count ?? 0) >= MAX_FOLLOWUPS) return {};

  const sessionId = process.env["DRUMLIN_SESSION"] ?? input.conversation_id;
  if (!sessionId) return {};

  const engine = await attach();
  if (!engine) return {};

  try {
    const result = await engine.request("session.diff", {
      root,
      sessionId,
      severity: FOLLOWUP_SEVERITY,
      absorb: true,
    });

    if (!result.hadBaseline || result.introduced.length === 0) return {};

    return { followup_message: followupMessage(result.introduced) };
  } finally {
    engine.close();
  }
}

/**
 * The message the agent receives.
 *
 * Written as a request with the evidence attached, not as a rule violation.
 * "flow.dead-end fired on screen.invoices.id" tells the agent nothing it can
 * act on; the finding's own message and proposal do.
 */
function followupMessage(findings: readonly Finding[]): string {
  const sorted = [...findings].sort(
    (a, b) => severityRank(b.severity) - severityRank(a.severity),
  );
  const shown = sorted.slice(0, 5);

  const lines = [
    shown.length === 1
      ? "Drumlin found a UX problem in what you just changed:"
      : `Drumlin found ${shown.length} UX problems in what you just changed:`,
    "",
  ];

  for (const finding of shown) {
    lines.push(`- ${finding.message} (${finding.severity}, ${finding.ruleId})`);
    if (finding.proposal) lines.push(`  Fix: ${finding.proposal}`);
    const location = finding.evidence.find((item) => item.location?.file);
    if (location?.location) {
      const { file, line } = location.location;
      lines.push(`  At: ${file}${line ? `:${line}` : ""}`);
    }
  }

  if (sorted.length > shown.length) {
    lines.push("", `${sorted.length - shown.length} more not shown.`);
  }

  lines.push(
    "",
    "Please fix these, or explain why the current behaviour is correct. " +
      "If it is intentional, tell me and I will record it with `drumlin accept`.",
  );

  return lines.join("\n");
}

function attach(): Promise<RemoteEngine | undefined> {
  // Never spawn from a hook that has a deadline: use the daemon if it is
  // there, and stay quiet if it is not.
  return RemoteEngine.attach({ spawn: false });
}

/**
 * The workspace to talk about.
 *
 * Cursor supplies `workspace_roots`; the process cwd is a fallback for hosts
 * that do not, and for running a hook by hand to see what it does.
 */
function workspaceRoot(input: HookInput, cwd: string): string {
  const roots = input.workspace_roots;
  if (Array.isArray(roots) && roots.length > 0 && roots[0]) return roots[0];
  return cwd;
}

function readInput(timeoutMs: number): Promise<HookInput> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve({});
      return;
    }

    let text = "";
    let settled = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      try {
        const parsed = JSON.parse(text.trim() || "{}") as HookInput;
        resolve(typeof parsed === "object" && parsed !== null ? parsed : {});
      } catch {
        resolve({});
      }
    };

    const timer = setTimeout(finish, Math.min(timeoutMs, 1_000));
    timer.unref?.();

    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      text += chunk;
    });
    process.stdin.on("end", () => {
      clearTimeout(timer);
      finish();
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      finish();
    });
  });
}

/**
 * Run something, or give up on it. Never rejects.
 *
 * The timer is cleared when the work wins, which matters more here than it
 * looks: leaving a live 20-second timer behind would keep the hook process
 * alive for 20 seconds after it had already answered, and the editor would be
 * left holding a pipe that is never going to say anything else.
 */
async function withDeadline<T>(
  ms: number,
  work: () => Promise<T>,
): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });

  try {
    return await Promise.race([work().catch(() => undefined), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function emit(output: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
