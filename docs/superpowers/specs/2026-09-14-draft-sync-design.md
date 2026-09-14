# Offline draft editing design (moth lwlkt)

Full technical design for `packages/draft-sync`. The moth ticket
(`lwlkt`) stays the decision record; this doc carries the technical
detail (exact deps, file layout, API calls) that would otherwise bloat
it.

## Package layout

```
packages/draft-sync/
  package.json
  bin/draft-sync.js        # CLI entrypoint
  src/
    admin-api.js            # thin wrapper over @tryghost/admin-api
    convert.js               # lexical <-> html <-> markdown
    store.js                 # .ghost-drafts/<slug>/ read/write
    pull.js
    push.js
scripts/draft-sync -> ../packages/draft-sync/bin/draft-sync.js   # symlink
```

`.ghost-drafts/` lives at repo root, added to `.gitignore`.

## Dependencies

- `@tryghost/admin-api` — official Node client, handles JWT signing
  from the Admin API key.
- `@tryghost/kg-lexical-html-renderer` — lexical -> html (pulled from
  the `Ghost/` submodule's own `koenig/` packages; vendored via
  `file:` dependency pointing into the submodule, not a separate npm
  install, so it always matches the running Ghost version).
- `@tryghost/kg-html-to-lexical` — html -> lexical, same sourcing.
- `turndown` — html -> markdown.
- `marked` — markdown -> html.

## Auth

`GHOST_ADMIN_API_KEY` env var, format `<id>:<secret>` as Ghost's Admin
API expects. Also needs `GHOST_ADMIN_API_URL` (site's admin root URL).
Both documented (names only, not values) here; actual values recorded
in `.local-secrets.md` under a "draft-sync" heading, per repo
convention for anything credential-shaped.

## Commands

### `draft-sync list`

Calls `GET /admin/posts/?filter=status:draft`, prints `id`, `slug`,
`title`, `updated_at` for each. No local state touched.

### `draft-sync pull <slug>`

1. `GET /admin/posts/slug/<slug>/?formats=lexical`.
2. Convert `lexical` field -> html (`kg-lexical-html-renderer`) -> markdown (`turndown`).
3. Write:
   - `.ghost-drafts/<slug>/original.lexical.json` — raw lexical string as returned, untouched.
   - `.ghost-drafts/<slug>/draft.md` — converted markdown, this is what gets edited.
   - `.ghost-drafts/<slug>/meta.json` — `{id, updated_at}` needed for the push PUT (Ghost's API requires the post `id` and current `updated_at` for optimistic-lock updates).
4. Refuses to overwrite an existing local folder unless `--force` (protects unpushed local edits from an accidental re-pull).

### `draft-sync push <slug>`

1. Read local `meta.json`, `original.lexical.json`, `draft.md`.
2. `GET /admin/posts/<id>/?formats=lexical` — fetch current remote state.
3. Compare remote `lexical` string against stored `original.lexical.json`.
   - Different -> abort: print a diff-free message ("remote draft
     changed since last pull, re-run `draft-sync pull <slug> --force`
     and reapply your edits") and exit non-zero. No merge attempted.
   - Same -> continue.
4. Convert `draft.md` -> html (`marked`) -> lexical (`kg-html-to-lexical`).
5. `PUT /admin/posts/<id>/` with the new `lexical` and the `updated_at`
   from `meta.json` (Ghost's optimistic-lock check; this is a second,
   narrower guard than step 3 — step 3 catches content drift, this
   catches a metadata race between step 2 and the PUT).
6. On success, overwrite local `original.lexical.json` and `meta.json`
   with the response's new state, so the next push's diff baseline is
   current.

## Round-trip fidelity

Turndown/marked pass through unrecognized HTML unchanged by default
(no custom card-token scheme needed for v1). A Koenig card that
renders to a `<div data-kg-card-*>` wrapper will show up in the
markdown as that raw HTML block; editing inside it in vim is possible
but not pleasant — acceptable per the ticket's scope (plain
prose/markdown drafts), documented as a known limitation rather than
solved.

## Error handling

Matches repo convention elsewhere (sync-ghost.sh): `set -e`-style
fail-fast, no auto-revert, leave local state as-is on failure so the
user can inspect/retry. No retries, no partial-write cleanup beyond
what Node's normal exceptions already do (nothing is written until
conversion succeeds).

## Testing

Manual for v1, per ticket scope: pull a real draft, edit in vim, push,
confirm in Ghost admin UI. No automated e2e.
