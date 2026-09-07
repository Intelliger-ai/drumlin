# Indexer fixtures

`mixed-app/` is a deliberately small Next.js app that mixes App Router and Pages
Router, because the first real target does too.

Every Milestone A rule has both a positive and a negative case here, so a rule
that starts firing everywhere fails a test rather than reaching a report.

| Rule | Positive (should fire) | Negative (must stay quiet) |
|---|---|---|
| `state.route.no-loading` | `app/invoices/page.tsx` fetches, no `loading.tsx` | `app/invoices/[id]/` has `loading.tsx`; `app/page.tsx` fetches nothing |
| `state.route.no-error` | `app/invoices/page.tsx` | `app/invoices/[id]/` has `error.tsx` |
| `flow.dead-end` | `app/settings/page.tsx` offers no way onward | `app/invoices/[id]` links back |
| `flow.orphan` | `app/reports/page.tsx` — nothing links to it | every other screen is reachable |
| `context.navigation.drops-search-params` | invoices list to detail, filters dropped | — |
| `ds.duplicate-primitive` | `components/PrimaryButton.tsx` reimplements the shadcn button | `components/ui/button.tsx` is the primitive itself |
| `component.select-overload` | `Select` bound to `invoices.map` | — |
| `async.mutation.no-feedback` | `approveInvoice` in `app/invoices/actions.ts` | — |
| `flow.destructive.no-confirm` | `deleteInvoice` — irreversible, unconfirmed | `approveInvoice` is not destructive |

`mixed-app.golden.json` is the **expected** layer, in the sense of
`Actual / Expected / Proposed`. It is not a snapshot of extractor output, so the
test asserts that the extracted graph *contains* it. That keeps the golden a
human statement of what the app should look like, and lets extraction add detail
without breaking the test.

The fixture is not a runnable Next.js app and has no `package.json` on purpose —
it must never be installed or built, only parsed.
