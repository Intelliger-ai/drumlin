# Security

## Reporting a vulnerability

Report privately through GitHub's
[private vulnerability reporting](https://github.com/Intelliger-ai/drumlin/security/advisories/new)
rather than opening an issue.

Please include what an attacker gains, the steps to reproduce, and the version
from `drumlin --version`. You should get an acknowledgement within a few days.

## What Drumlin does and does not touch

Worth stating plainly, because it narrows what a vulnerability here can mean.

Drumlin runs entirely on your machine. It makes no network requests, has no
account or server, and sends nothing anywhere — there is no model call in the
analysis path. It reads your source, and writes only to `.drumlin/` in the
project and to a local state directory for the daemon's socket and cache.

It does not execute your application. Analysis is `ts-morph` parsing source
into an AST; nothing in your codebase is imported or run. The unbuilt runtime
half would drive a browser, and when it lands that will be a different
statement.

The daemon listens on a Unix domain socket with mode `0600`, in a
user-owned directory. It is reachable by processes running as you, and not
over the network.

## The threat that shaped the design

The interesting adversary here is not a remote attacker but the coding agent
you are working with, which has a shell, runs as you, and is motivated to
finish its turn.

`accepted` is the only status that stops a finding being reported, so it is
the only one worth attacking. It is not exposed over MCP, the daemon refuses
the method, and the CLI classifies its caller and refuses anything that does
not look like a person at an interactive terminal. What made it believe a
human was present is recorded on the issue.

None of that is unbreakable, and it is not claimed to be — a determined agent
with a shell can allocate a pty. What makes it hold in practice is that the
refusal is the default path and every decision is a committed diff somebody
can read. If you find a way to record an acceptance that a person did not
make, that is a vulnerability and worth reporting even though the mechanism is
openly defeatable.

## Supported versions

Pre-1.0. Fixes go on `main` and into the next release; there are no
maintained branches yet.
