i want to edit drafts locally using vim and ideally in some form of markdown. gitignored

----- AI agent updates -------

Decisions (brainstormed 2026-09-14):

- Sync model: manual pull-edit-push, no daemon/watcher, no auto two-way sync.
- Storage: one gitignored folder per draft (e.g. `.ghost-drafts/<slug>/`), holding
  both the last-known-remote snapshot and the human-editable markdown copy.
  Keeping these separate (rather than one file) is what enables conflict
  detection on push.
- Conflict handling: on push, compare the current remote draft against the
  stored snapshot from last pull. If they differ (someone edited via Ghost's
  own web UI meanwhile), abort and tell the user to re-pull. No auto-merge,
  no last-write-wins.
- Format conversion: Ghost content is lexical (JSON), not markdown, so pull/push
  convert lexical <-> markdown via an HTML bridge (lexical <-> html using
  Ghost's own koenig conversion packages, html <-> markdown via
  turndown/marked). Rejected: writing a direct lexical<->markdown converter
  (more code, no reuse of Ghost's own tooling) and rejected: markdown-card-only
  approach (would lose rich Ghost card support even for unrelated content).
  Known limitation: unsupported/rich Koenig cards may not round-trip cleanly
  through markdown; goal is to pass them through as opaque HTML rather than
  reinterpret/destroy them.
- Auth: Ghost Admin API key via env var; actual key value and setup notes live
  in `.local-secrets.md` per repo convention, never tracked.
- Location: new `packages/draft-sync/` (own package.json/deps), with a link
  from `scripts/` for discoverability, consistent with existing scripts/
  entrypoints.
- Testing: manual verification against a real draft for v1; no automated
  e2e required by this ticket's scope.


Technical design: docs/superpowers/specs/2026-09-14-draft-sync-design.md

----- AI agent updates (implementation, 2026-09-14) -------

Implemented on branch `lwlkt-draft-sync`, via subagent-driven-development
against the plan at docs/superpowers/plans/2026-09-14-draft-sync.md. All 7
code tasks + final whole-branch review complete, one fix round applied,
re-review clean. 23/23 tests pass (`packages/draft-sync`, `node --test`).

Correction to the "known limitation" decision above: the goal of passing
unsupported Koenig cards through as opaque HTML does NOT hold in practice.
Turndown/marked don't preserve card HTML unchanged -- converting a card
(image, embed, bookmark, etc.) to markdown and back silently loses or resets
card-specific state (e.g. an image card's caption gets emptied, its width
setting resets to default). This is accepted as a known v1 limitation (the
ticket's own scope is plain prose/markdown drafts) rather than fixed, but
`pull` now prints a stderr warning when a draft's content includes any node
type outside plain prose (paragraph/heading/quote/list/linebreak), so the
user is warned at pull time instead of silently losing data at push time.
See "Round-trip fidelity" in the design doc for the corrected description.

Two implementation details not decided during brainstorming, settled during
build:
- Two-stage guard on push: content-diff against the last-pulled lexical
  snapshot (as decided above) AND Ghost's own optimistic-lock `updated_at`
  check from the last-pulled metadata (not the metadata of the just-in-time
  read used for the content diff) -- catches a metadata-only race the
  content diff alone wouldn't.
- Slugs are validated against path traversal (reject `/`, `\`, `.`, `..`)
  before being used to build the local `.ghost-drafts/<slug>/` path.

Not yet done: the manual live-verification step (pull/push against a real
Ghost draft) has deliberately not been run by the agent -- it would touch
the live production Ghost site, which is outside the scope of automated
implementation. Left for the human to run (first real pull/push should
target a prose-only, ideally throwaway draft, given the round-trip caveat
above) or explicitly ask the agent to run it.

Integration into main not yet decided (merge / PR / keep-as-is) -- pending
human decision.


----- AI agent updates (manual verification bug, 2026-09-14) -------

Manual live verification (the "not yet done" step above) found `list` crashing
with `posts is not iterable`. Root cause: `@tryghost/admin-api`'s `browse()`
resolves to the posts array itself (with `.meta` attached), not a `{ posts }`
wrapper -- `bin/draft-sync.js` destructured `posts` off it, getting
`undefined`. Fixed (plain assignment instead of destructure); confirmed
against the live site (`list` now prints real drafts). `pull`/`push` were
unaffected -- they use `.read`/`.edit`, which do resolve to the object
directly, so no equivalent bug there. Full manual pull/push round-trip
against a real draft still not done.


----- AI agent updates (pull-all expansion, 2026-09-14) -------

Expanded (not changed): `pull` with no slug now pulls every remote draft,
instead of requiring one. Per-draft failure (existing local copy without
--force, no lexical content, etc) doesn't abort the batch -- each draft's
outcome is reported individually, and the command exits non-zero only if at
least one failed. `list`'s filter (`status:draft`) is reused for which
drafts to pull.
