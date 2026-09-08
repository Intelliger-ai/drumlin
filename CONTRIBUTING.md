# Contributing

## Getting set up

```bash
git clone https://github.com/Intelliger-ai/drumlin.git
cd drumlin
pnpm install
pnpm check
```

Node 22 or newer, and pnpm — the version is pinned in `packageManager`, so
Corepack will use the right one. There is an `.nvmrc` if you use nvm.

`pnpm check` is what CI runs: import boundaries, formatting, typecheck, tests.
It takes a few seconds. Run it before pushing rather than after.

```bash
pnpm check          # boundaries, format:check, typecheck, test
pnpm test:watch     # while working
pnpm build          # typecheck, then assemble packages/drumlin
pnpm smoke          # pack, install somewhere clean, drive the result
pnpm format         # apply Prettier
```

To run the CLI against the working tree without building:

```bash
pnpm drumlin check --app packages/indexer/fixtures/mixed-app
```

## A note on the comments

Code comments here explain **why**, at length, including approaches that were
tried and abandoned. That is deliberate: the hard part of this project is
judgement about what counts as a UX problem, and a comment recording why a
threshold is 0.6 or why a mechanism was removed is worth more than one
restating what the next line does. Please write them the same way, and please
do not delete them for brevity.

Some comments cite `vault/` and `Context/`, which are **not in this
repository** — they are private design notes and raw source material, listed in
`.gitignore`. Nothing you need to make a change is only in there. If a comment
leans on one so heavily that the code is unclear without it, that is a bug in
the comment; say so in the issue and it will be rewritten.

## Things worth knowing before you change them

**`packages/model`, `packages/core` and `packages/protocol` contain no IO.** No
filesystem, no `process`, no `ts-morph`, no sockets. `pnpm boundaries` enforces
it, and the reason is that these are the parts intended to be portable — a rule
that knows it is being asked over a socket cannot move. Push impure work into
`indexer` or `repo` and pass plain data across the seam.

**The CLI loads its commands with dynamic `import()`.** Not a style choice. The
`afterFileEdit` hook runs on every write an agent makes, against a 500ms
budget, and a static import list makes it load the rule engine and the
TypeScript compiler in order to post one filename to a socket. The build keeps
those imports split for the same reason; a single-file bundle measured slower
than no build at all. If you add a static import to `apps/cli/src/cli.ts`,
check what it costs.

**The fixtures under `packages/indexer/fixtures/` are test inputs.** Several
rules read source text rather than only the AST — confirmation markers, pending
copy, disabled states — so reformatting or tidying a fixture can change what the
analysis finds. Prettier is configured to leave them alone.

**Only the verifier can resolve an issue, and only a human can accept one.**
If a change makes either reachable from somewhere else, that is the change to
reconsider rather than the rule. `packages/engine/src/decisions.test.ts` and
`verify.test.ts` are where those properties live.

## Tests

Vitest, beside the code, named for behaviour rather than for the function under
test. The suite runs in a few seconds; keep it that way.

Two kinds are worth writing deliberately:

- **Tests that would have caught the bug you are fixing.** Preferably stated as
  a property rather than as the specific case. The daemon regression is the
  cautionary tale: resolution returned a plausible-looking path that did not
  exist, so any test asserting "returned something" would have passed.
- **`pnpm smoke`, for anything about packaging or paths.** The whole suite runs
  against the workspace, where every `@drumlin/*` resolves through a symlink
  that a published install does not have. Three bugs have now come from that
  gap. If you touch the build, resolution, or the Cursor plugin, pack it and
  install it.

## Commits and pull requests

Commit messages: a short summary line, then prose explaining why. Look at
`git log` for the register. The body is the place to record what you tried that
did not work — it is the most useful part six months later.

Keep mechanical changes in their own commit. A reformat mixed into a
behavioural diff makes the behavioural part unreviewable.

CI runs on Node 22 and 24, plus a packed install on Linux and macOS. All of it
has to be green.

## Reporting a bug

Include `drumlin --version`, your Node version, and what `drumlin check
--format json` produced if it is about a finding. If it is about a rule firing
when it should not, the smallest route that reproduces it is worth more than a
description of the real one.

Security issues go to [SECURITY.md](SECURITY.md) instead of the issue tracker.
