migration.md step 6 says the first validation run "will typically report
setting differences" from Ghost's own boot-time bookkeeping, and instructs
adding each key to settingsKeys in db-compare.mjs with a note. Nothing was
ever added -- it's still []. Either the actual cutover genuinely produced
zero setting differences (worth recording as a fact in migration.md rather
than leaving the instruction to look untested), or the gate was satisfied
some other way that isn't documented.

Found by: opus review subagent, 2026-09-10, dispatched from moth i8hlt.

Fix direction: check moth i8hlt / the actual cutover's validation output
(if recoverable) for whether setting differences occurred, and record the
outcome in migration.md step 6 either way.
