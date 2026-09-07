subtask of hi3zi

we'll implement sqlite over s3 and plug it into Ghost, smoke test locally with docker

## Decisions

Full technical design in `docs/superpowers/specs/2026-09-07-sqlite-s3-design.md`;
this entry stays the decision record.

**Storage: reuse SQLite's own WAL as the segment source**, not a custom
page-log. Base `.db` snapshot + per-commit WAL-frame segments on S3
(msgpack), JSON manifest (`root.json`) pointing at
`{baseSegmentId, walSegmentIds[]}`.
- Rejected: reimplementing a generic page-level segment store from
  scratch (closer literal port of chrisk60331/distributed-sqllite) —
  WAL frames already carry page numbers, which is exactly the
  write-set data needed for conflict detection, so reusing them avoids
  building a parallel mechanism.

**Manifest CAS: native S3 conditional writes** (If-Match/If-None-Match),
not a DynamoDB lock table. One S3 object is enough for a single mutable
pointer; a second AWS resource wasn't justified.

**Multi-writer, not single-writer** — explicitly not simplified away
despite this phase staying single-node for now, because Phase 2's
stated goal is to allow scaling beyond single-node later. Commit path:
snapshot at manifest version, commit locally, conditional-PUT the new
manifest; on conflict, diff write-sets (page numbers) — no overlap
rebases and retries, overlap discards and retries the whole
transaction. Up to 10 attempts, full-jitter backoff — matches the
python original's retry policy rather than inventing new numbers.

**Checkpointing: size-triggered OR time-triggered, whichever first**,
with the time trigger skipped if nothing changed since the last
checkpoint (no no-op checkpoints during idle periods).

**Integration: Knex client wrapping `better-sqlite3`**, not a custom
SQLite VFS — this is the integration shape `hi3zi` left as an accepted
unresolved risk, now resolved. Package lives at
`phase2/packages/sqlite-s3/`. Ghost's own config/core is unchanged in
shape (still looks like a `sqlite3` Knex client from Ghost's side).

**Smoke test: real throwaway S3 bucket via `aws cli`** (not OpenTofu —
disposable, not part of standing IaC), docker-compose running the
forked Ghost image against it. Verifies restart-survival and exercises
the multi-writer conflict/rebase path if feasible to simulate locally.
