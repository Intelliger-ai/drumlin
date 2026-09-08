# Drumlin

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

Everything is local. No source leaves the machine, and there is no account,
no server and no model call in the analysis path.

## Install

Node 22+ and pnpm.

```bash
git clone git@github.com:Intelliger-ai/drumlin.git
cd drumlin
pnpm install
pnpm build
ln -s "$PWD/apps/cli/dist/drumlin.mjs" ~/.local/bin/drumlin
```

`pnpm build` typechecks, then bundles the three executables into `dist/` with
esbuild. It is worth doing rather than running the sources through `tsx`:
startup drops from about 170ms to about 40ms, which matters because the
`afterFileEdit` hook runs on every write an agent makes.

The bundle keeps its dynamic imports split into chunks rather than inlining
them, so `drumlin hook file-edit` still does not load the rule engine and
ts-morph in order to post a filename to a socket. A single-file bundle
measured _slower_ than no build at all.

For development, `apps/cli/bin/drumlin.mjs` runs the TypeScript directly and
always reflects the working tree.

## Use it

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

The second command is the point. A plugin installs once and its hooks fire in
every workspace you open, which would make "I want this on this project" and
"I want this reading every repository I own" the same decision. Until you run
`drumlin activate`, the hooks and the agent's tools stay silent, and because
the flag lives in the committed config, turning it on is a reviewable diff
rather than local state on one laptop.

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

## Layout

```
packages/model      schemas and pure types; no IO
packages/core       the graph view, the rules, the issue logic; no IO
packages/indexer    ts-morph extraction of the graph from source
packages/repo       the .drumlin/ contract
packages/engine     the methods every surface calls
packages/protocol   the daemon wire format
packages/client     talking to the daemon
apps/cli            drumlin
apps/daemon         drumlind, a warm index behind a unix socket
apps/mcp            the read-only MCP server
integrations/cursor the plugin
```

`model`, `core` and `protocol` are kept free of IO and parser imports, checked
by `pnpm boundaries` rather than by convention.

```bash
pnpm check    # boundaries, typecheck, tests
pnpm build    # typecheck, then bundle the three executables
```

## Status

Working: the graph, the ten rules, the CLI, issue records with stable `UX-`
numbers, the daemon, the Cursor plugin, the decision surface above, graph
identity matching across renames, and a runtime diff of the inferred graph
against observed browser behaviour.

Not yet: the Playwright adapter that produces those observations against a real
browser, publishing to a registry, and frameworks other than Next.js.

## License

Apache-2.0. See [LICENSE](LICENSE).
