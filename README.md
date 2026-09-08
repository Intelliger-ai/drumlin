# Drumlin

[![CI](https://github.com/Intelliger-ai/drumlin/actions/workflows/ci.yml/badge.svg)](https://github.com/Intelliger-ai/drumlin/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D22-blue)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

Drumlin reads a Next.js codebase, builds a graph of the product's screens,
states, actions and transitions, and runs deterministic rules over that graph
to find user-experience problems that no single file reveals.

It exists because coding agents are good at writing a route and bad at knowing
what the route is part of. An agent adding a page cannot see that nothing links
to it, that the section it joined has no error boundary, or that the button it
wired has no pending state. That knowledge is structural, so Drumlin keeps the
structure.

```
$ drumlin check

Drumlin check — .
28 screens · 19 actions · 314 edges
6 open · 0 new · 1 accepted
14 raw findings reduced to 7 by deduplication

UX-0001  high  8 screens under /reports fetch data with no error state, so a failed request fails silently on each.
    src/app/(reports)/reports/audit/page.tsx
    fix: Add an error boundary at /reports with a retry affordance; it covers every screen in the section.
    affects: /reports/audit, /reports/dashboard, /reports/weekly and 5 more
    state.route.no-error · deterministic · confidence 0.85

UX-0005  medium  /patients/[id] exists but nothing links to it, so it can only be reached by typing the URL.
    src/app/patients/[id]/page.tsx
    fix: Link to it from where the user would look for it, or delete it.
    flow.orphan · graph · confidence 0.80
```

Everything is local. No source leaves the machine, and there is no account, no
server and no model call in the analysis path.

## Requirements

**Node 22 or newer**, because the derived cache uses `node:sqlite`. Drumlin
says so and names your version rather than failing somewhere deeper.

**Next.js**, App Router or Pages Router. Mixed repositories are fine — the
graph records which router each route came from. Extraction is done with
`ts-morph`, so a JavaScript-only app parses but yields a much thinner graph.

**macOS or Linux.** The daemon speaks over a Unix domain socket, so Windows
needs WSL; install inside the WSL filesystem rather than across `/mnt/c`.

Nothing else is required to run `drumlin check`. The editor integration wants
Cursor; the rest of the tool does not care what you write code in.

## Install

```bash
npm install -g drumlin
```

> **Not published yet.** The package is built and verified — `pnpm smoke` packs
> it, installs it into a clean directory and drives it — but the first release
> is not on the registry, so the command above will 404 until it is. Use the
> source install below in the meantime; it produces the same three executables.

Then, in any Next.js app:

```bash
cd your-next-app
drumlin init      # creates .drumlin/, meant to be committed
drumlin check     # analyse and report
```

`drumlin check` is read-only apart from the issue records it maintains. On a
28-screen application it takes well under a second.

`.drumlin/` is the durable half: issue records, accepted decisions, the graph
identity baseline, config. Commit it, because that is what makes issue numbers
and decisions survive across machines and branches. `.drumlin/cache/` is
derived and already ignored.

Skipping `drumlin init` is allowed and sometimes what you want — `check` runs
fine without it. But nothing is stored, so the `UX-` numbers it prints last
only as long as the output, and no decision about them can be recorded.

### From source

```bash
git clone https://github.com/Intelliger-ai/drumlin.git
cd drumlin
pnpm install
pnpm build
ln -s "$PWD/packages/drumlin/dist/drumlin.mjs" ~/.local/bin/drumlin
```

`~/.local/bin` is not on the default `PATH` on macOS and may not exist. Create
it and add it, or link into a directory already on your `PATH`.

`pnpm build` typechecks, then bundles the three executables into
`packages/drumlin/dist/`. That directory is the npm package: one package
carrying `drumlin`, `drumlind` and `drumlin-mcp` together, which is also what
lets the CLI find its own daemon without searching for it.

For development, `apps/cli/bin/drumlin.mjs` runs the TypeScript directly
through `tsx` and always reflects the working tree. It is slower to start,
which matters only for the editor hooks.

## Commands

| Command              | What it does                                                   |
| -------------------- | -------------------------------------------------------------- |
| `drumlin init`       | Create `.drumlin/` so issue IDs survive across runs            |
| `drumlin check`      | Report UX findings. `--changed` limits it to what you touched  |
| `drumlin graph`      | Dump the graph as a readable outline or JSON                   |
| `drumlin context`    | Propose a role and permission model, and say what is unknown   |
| `drumlin rules`      | List the active rules                                          |
| `drumlin activate`   | Let Drumlin report findings while you code, in this project    |
| `drumlin deactivate` | Silence the editor hooks and agent tools here                  |
| `drumlin accept`     | Record a finding as an intentional deviation (human, at a tty) |
| `drumlin revoke`     | Undo an acceptance, or list what is currently silenced         |
| `drumlin propose`    | Make the case for accepting one; a human decides               |
| `drumlin decline`    | Turn down a proposal, leaving the issue open                   |
| `drumlin claim`      | Report a fix and have it checked                               |
| `drumlin verify`     | Re-derive from source; the only way to resolve an issue        |
| `drumlin export`     | Write issues out for Linear or GitHub                          |
| `drumlin connect`    | Install the Drumlin plugin into a coding agent                 |
| `drumlin daemon`     | Manage the background daemon: `start`, `stop`, `status`        |

`drumlin --help` lists every flag. Useful ones across commands: `--app` to pick
an app in a monorepo, `--format json` for anything that consumes the output,
`--severity` to raise the floor, `--fail-on` to exit non-zero in CI, and
`--no-daemon` to run cold in one process.

## The ten rules

All deterministic or structural. Nothing here is a model judgement.

| Rule                                     | What it catches                                       |
| ---------------------------------------- | ----------------------------------------------------- |
| `state.route.no-loading`                 | A route fetches but renders nothing while waiting     |
| `state.route.no-error`                   | A failed request fails silently                       |
| `state.route.no-not-found`               | A dynamic route has no answer for a bad id            |
| `flow.dead-end`                          | A screen a user can reach but not leave               |
| `flow.orphan`                            | A screen nothing links to                             |
| `context.navigation.drops-search-params` | Navigation that discards filters or search state      |
| `async.mutation.no-feedback`             | A mutation with no pending or result state            |
| `flow.destructive.no-confirm`            | A destructive action with no confirmation             |
| `ds.duplicate-primitive`                 | A primitive reimplemented next to the design system's |
| `component.select-overload`              | A select with far more options than a person can scan |

Rules about roles and permissions are deliberately absent. Drumlin can see
that a route checks a role but not which roles _should_ reach it, so that is a
question it asks rather than a rule it enforces.

## Findings that reach the agent while it works

Drumlin ships a Cursor plugin: an MCP server with four read-only tools and
hooks that re-index in the background as an agent edits, then hand new
high-severity findings back at the end of a turn.

```bash
drumlin connect cursor   # install the plugin, once per machine
drumlin activate         # switch it on, per project
```

Two things are needed between them, and neither is Drumlin's to do:

1. **Turn on "Allow local plugin imports"** in Cursor's dashboard settings.
   Local plugins are behind that flag, and without it the hooks are installed
   but never fire.
2. **Restart Cursor**, so it reads the new hooks and MCP declaration.

The second command is the point. A plugin installs once and its hooks fire in
every workspace you open, which would make "I want this on this project" and
"I want this reading every repository I own" the same decision. Until you run
`drumlin activate`, the hooks and the agent's tools stay silent, and because
the flag lives in the committed config, turning it on is a reviewable diff
rather than local state on one laptop.

`drumlin daemon status` after opening a workspace is how you tell it is live: a
warm workspace means the hooks reached the daemon.

## Who is allowed to make a finding go away

The part of Drumlin with the most design in it, because it is where a tool like
this usually fails. An agent that can silence a finding will eventually silence
one in order to finish its turn.

So the surface is split by what each action costs if it is wrong:

- **`drumlin accept`** — record a finding as an intentional deviation. The only
  action that stops a finding being reported, so it is the only one that needs
  a person: it refuses to run without an interactive terminal, refuses callers
  that look like an agent or CI, requires a written reason, and records what
  made it believe a human was there. It is not exposed over MCP at all.
- **`drumlin propose`** — the agent's version of the same argument. An agent
  that has just read the code is often right that a finding is a false
  positive, and giving it nowhere to say so is worse than letting it argue.
  A proposal changes nothing; a person accepts or declines it.
- **`drumlin revoke`** — undo an acceptance, or list what is currently
  silenced. Cheaper than accepting, because putting a finding back can only
  create work, never hide it. Run bare, it flags acceptances that carry no
  attestation.
- **`drumlin claim`** — an agent's assertion that it fixed something. Treated
  as a hint about what to test, not as proof.
- **`drumlin verify`** — re-runs the rule against fresh source. Only the
  verifier can move an issue to `resolved`, and it declines to when the subject
  was deleted or the rule was disabled rather than when the problem was fixed.

`drumlin export` renders open issues as Linear CSV, a `gh issue create` script,
or Markdown.

## Troubleshooting

**`drumlin: command not found` after installing globally.** npm's global bin
directory is not on your `PATH`. `npm prefix -g` prints the prefix; add its
`bin` subdirectory. With the source install, the same applies to
`~/.local/bin`, which macOS does not put on `PATH` by default.

**"Drumlin needs Node 22 or newer".** Exactly what it says, and the message
names the version you are on. `node:sqlite` arrived in Node 22 and the derived
cache uses it.

**"No Next.js app found at or beneath ."** Drumlin looks for a `next.config.*`
beside an `app/` or `pages/` directory. Run it from the app, or point at it with
`--app apps/web`.

**"Found 3 Next.js apps. Choose one with --app".** Deliberate. Analysing an
arbitrary one produces a report that looks plausible and describes a different
product, so it lists them and stops.

**Every run prints different `UX-` numbers.** There is no `.drumlin/` to keep
them in. Run `drumlin init` and commit the directory.

**The hooks never fire in Cursor.** In order: "Allow local plugin imports"
enabled, Cursor restarted, `drumlin activate` run in that project. Then
`drumlin daemon status` — no warm workspace means nothing has reached the
daemon yet.

**Analysis seems slow.** Check the daemon is being used: `drumlin daemon
status` should list your workspace as warm. Without it every command re-indexes
from cold. `--no-daemon` forces that deliberately, which is worth trying if you
suspect a stale index.

**`flow.orphan` reports a route that is reached by emailed link or bookmark.**
Nothing in the source links to it, which is all Drumlin can see. List it under
`entryPoints` in `.drumlin/config.yaml` and it becomes reachable by definition.

**A rule is wrong about your code.** Two honest answers. If it is wrong in
general, disable it in `.drumlin/config.yaml` under `rules.disabled`. If it is
wrong about this one case, `drumlin accept` it with a reason — that is what
acceptance is for, and the reason is what makes it reviewable later.

## Uninstall

```bash
drumlin daemon stop
npm uninstall -g drumlin
rm -rf ~/.cursor/plugins/local/drumlin   # if you ran `drumlin connect cursor`
rm -rf ~/Library/Caches/drumlin          # macOS
rm -rf ~/.local/state/drumlin            # Linux, unless XDG says otherwise
```

`.drumlin/` in your projects is yours — it holds the decisions people made, so
nothing removes it for you.

## Layout

```
packages/model      schemas and pure types; no IO
packages/core       the graph view, the rules, the issue logic; no IO
packages/indexer    ts-morph extraction of the graph from source
packages/repo       the .drumlin/ contract
packages/engine     the methods every surface calls
packages/protocol   the daemon wire format
packages/client     talking to the daemon
packages/drumlin    the assembled npm package; built, not written
apps/cli            drumlin
apps/daemon         drumlind, a warm index behind a unix socket
apps/mcp            the read-only MCP server
integrations/cursor the plugin
```

`model`, `core` and `protocol` are kept free of IO and parser imports, checked
by `pnpm boundaries` rather than by convention.

```bash
pnpm check    # boundaries, formatting, typecheck, tests
pnpm build    # typecheck, then assemble the package
pnpm smoke    # pack it, install it somewhere clean, and drive the result
```

[CONTRIBUTING.md](CONTRIBUTING.md) covers the rest.

## Status

Working: the graph, the ten rules, the CLI, issue records with stable `UX-`
numbers, the daemon, the Cursor plugin, the decision surface above, graph
identity matching across renames, and a runtime diff of the inferred graph
against observed browser behaviour.

Not yet: the Playwright adapter that produces those observations against a real
browser, the first npm release, and frameworks other than Next.js.

## License

Apache-2.0. See [LICENSE](LICENSE).
