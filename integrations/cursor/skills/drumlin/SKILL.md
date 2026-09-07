---
name: drumlin
description: Use when changing navigation, adding or editing a route, wiring a mutation, or building UI in this Next.js app — and whenever a Drumlin finding is reported to you. Drumlin holds a graph of the product's screens, states, actions, and transitions, and knows things about this app that reading one file cannot tell you.
---

# Drumlin

Drumlin analyses this workspace as a UX graph rather than as a pile of files.
Four read-only MCP tools expose it. It records issues; it never closes them.

## When to reach for it

**Before changing navigation or a route.** Call `drumlin_get_flow` with the
route. Inbound links are the reason: what links *to* `/invoices/[id]` lives in
whatever imports it — a table column definition, a sidebar three directories
away — and reading the page file tells you nothing about it. Rename or remove a
route without checking and you leave a dead link the type checker will not catch.

**Before building a screen or a component.** Call `drumlin_project_summary`. It
names the design-system primitives already in the codebase and the route
sections that exist. Writing a new button when one already exists is the single
most common way an agent adds UX debt here.

**After editing.** Call `drumlin_check_changed`. It reports findings
attributable to the files you touched, or to files importing them.

**When handed an issue id.** Call `drumlin_get_issue` before doing anything
else. The packet has the acceptance criteria, the constraints, the files to
start in, and the command that re-tests it. A one-line finding message is not
enough to fix anything from.

## What the findings mean

Findings are about the product, not about the code. `flow.orphan` does not mean
a file is unused — it means a user cannot get to a screen. `state.no-error` does
not mean a try/catch is missing — it means a screen that fetches data has
nothing to show when the fetch fails.

So fix the experience, not the rule. Adding a link nobody will click to silence
an orphan finding makes the report clean and the product worse.

## What you cannot do

You cannot accept, close, or resolve an issue. There is no tool for it, the CLI
refuses `drumlin accept` when it detects an agent, and the daemon does not serve
the method at all. That is deliberate: an agent able to silence a finding will
eventually silence one to finish a turn.

Two things you can do instead, and should.

**If you fixed it, say so and have it checked.** Run
`drumlin claim <id> --note "what you changed"`. This re-derives the graph from
source, re-runs the rules, and reports whether the finding is actually gone. It
exits non-zero if it is not — so a claim that fails tells you your fix did not
work, which is worth knowing before you end the turn. It does not read your
note, so there is nothing to phrase carefully. Only Drumlin's verifier can mark
anything `resolved`.

It will refuse to resolve a finding that went quiet because the screen was
deleted or the rule was disabled. Do not reach for either; they are recorded as
`vanished` and `inconclusive` and read exactly as what they are.

**If you think the finding is wrong, argue.** Run
`drumlin propose <id> --reason "..."` and say so in your reply. The proposal
sits on the issue with your reasoning intact and changes nothing until a person
grants it with `drumlin accept <id>` or turns it down with `drumlin decline`.
Being right that a finding is a false positive is common; acting on being right
is what you must not do.

## The stop check

At the end of a turn, Drumlin compares the findings now against the findings
when the session started. A new high or critical problem in code you just wrote
comes back as a follow-up message.

If one arrives, either fix it or explain why it is wrong. Findings withheld for
files edited seconds ago are already filtered out, so a report means the code
settled that way.
