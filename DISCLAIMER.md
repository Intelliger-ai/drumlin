# Disclaimer

**Read this before using this software.** By downloading, installing, or using
Drumlin, you accept everything set out below.

## No warranty

Drumlin is provided **"as is" and "as available", without warranty of any
kind**, express, implied, or statutory. That includes, without limitation, any
implied warranties of merchantability, fitness for a particular purpose, title,
accuracy, and non-infringement.

No warranty is given that Drumlin will be accurate, complete, current,
reliable, uninterrupted, error-free, secure, or fit for any purpose you have in
mind.

## No liability, in any form

**To the maximum extent permitted by applicable law, the authors,
contributors, copyright holders, and Intelliger AI accept no responsibility and
no liability of any kind whatsoever** arising from or connected to Drumlin or
its use.

This exclusion covers, without limitation: direct, indirect, incidental,
special, exemplary, punitive, and consequential damages; loss of profits,
revenue, goodwill, data, or anticipated savings; business interruption; service
outage; data corruption or loss; security incidents; regulatory penalties;
legal costs; reputational harm; and any claim brought by a third party.

It applies regardless of the legal theory advanced — contract, tort,
negligence, strict liability, warranty, statute, or otherwise — and applies
**even if advised in advance that such damages were possible**, and even if a
remedy is found to have failed of its essential purpose.

You use Drumlin entirely at your own risk, and you are solely responsible for
any consequence.

## The analysis is heuristic and incomplete

Drumlin infers a model of an application by statically analysing source code.
That inference is approximate, and it is wrong in both directions.

- **It misses real problems.** A clean report is not evidence that an
  application is free of user-experience defects, or of any other kind of
  defect. Anything determined at runtime, behind a dynamic import, through
  indirection, in a framework it does not model, or in a language it does not
  parse, is invisible to it.
- **It reports problems that are not real.** Findings are inferences about
  intent drawn from structure, and structure does not always mean what it
  looks like it means.
- Severity, confidence, and grouping are editorial judgements encoded in
  rules. They are not measurements, and they carry no guarantee of
  correctness or of relevance to your product.
- Support is limited to Next.js. Other frameworks may parse without producing
  anything meaningful, and a thin or empty graph is not a passing grade.

**Every finding requires human judgement before it is acted on.** Do not treat
Drumlin's output as a specification, a quality gate that means anything on its
own, or a substitute for testing, code review, QA, or usability research with
real users.

## The decision controls are process aids, not security boundaries

Drumlin restricts who may accept, claim, verify, or resolve an issue, and
records provenance for those decisions. This is **a workflow safeguard
designed in good faith, not a security control**.

Caller classification is best-effort and can be defeated by anyone or anything
determined to defeat it, including an AI agent with shell access, a
misconfigured environment, or a person acting through automation. Recorded
attestations reflect what the software could observe, not what actually
happened.

**No representation is made that these controls will prevent an automated
system from suppressing a finding, or that recorded provenance is accurate,
trustworthy, or admissible for any purpose.** Do not rely on them for audit,
compliance, assurance, or contractual evidence.

## Not professional advice, and not a compliance tool

Nothing Drumlin produces constitutes legal, regulatory, accessibility,
security, medical, financial, or other professional advice.

Drumlin is **not an accessibility audit, not a conformance assessment, and not
a compliance tool**. Using it does not make software conformant with WCAG at
any level, nor compliant with the Americans with Disabilities Act, Section 508,
the European Accessibility Act, EN 301 549, or any other law, standard,
regulation, or contractual obligation anywhere in the world. **No
representation is made that using Drumlin will achieve or contribute to
compliance with anything.** If you have accessibility or regulatory
obligations, engage qualified professionals and conduct proper audits,
including testing with disabled users.

Drumlin is **not a security tool**. It does not look for vulnerabilities, and
it must not be used as a security review.

## What it does on your machine

Drumlin runs locally. In the course of normal operation it reads source files
in the directories you point it at, writes to `.drumlin/` in your project,
maintains a derived cache and log outside your project, runs a background
daemon listening on a local Unix domain socket, and — where you install the
editor integration — registers hooks and a local MCP server that expose
analysis results to a coding agent.

You are responsible for deciding whether this is appropriate for your
environment, your source code, your employer's policies, your clients'
contracts, and the law where you are. You are responsible for reviewing the
source before running it, and for any agent you connect to it and the
permissions you grant that agent.

Removal instructions are in the README. No responsibility is accepted for data
written, cached, or removed.

## Third-party components and references

Drumlin depends on third-party open-source software under its own licences. No
responsibility is accepted for third-party code, its behaviour, its security,
or its terms, and you are responsible for your own compliance with those
licences.

Drumlin's rules reference principles collected as the Laws of UX by Jon
Yablonski at [lawsofux.com](https://lawsofux.com). The underlying principles
are established work in psychology and cognitive science, credited to their
respective researchers.

This project is **not affiliated with, endorsed by, sponsored by, or connected
to** Vercel, Next.js, Anthropic, OpenAI, Cursor, Linear, GitHub, Jon
Yablonski, Laws of UX, or any other organisation, product, or trademark named
anywhere in this repository. All trademarks belong to their respective owners,
and any reference is nominative and descriptive only.

Export features generate files for import into third-party systems. What those
systems do with them is between you and them.

## No support and no commitment

There is no obligation to provide support, maintenance, updates, bug fixes,
security patches, or continued availability. Published packages may change or
be removed, this repository may change or disappear without notice, and no
guarantee of backward compatibility is offered. Pin your versions and verify
what you install.

## Severability and precedence

If any part of this disclaimer is held unenforceable, it is limited or severed
to the minimum extent necessary and the remainder stays in force. Where
liability cannot lawfully be excluded, it is **limited to the maximum extent
permitted by applicable law, and in no event beyond zero pounds, dollars, or
euros**, this software having been supplied free of charge.

Nothing here purports to exclude liability that cannot lawfully be excluded,
such as liability for death or personal injury caused by negligence, or for
fraud.

This disclaimer supplements the [LICENSE](LICENSE) (Apache-2.0), whose warranty
and liability provisions, Sections 7 and 8, apply in full. Where this document
and the licence overlap, whichever more broadly protects the authors applies to
the fullest extent the law allows.
