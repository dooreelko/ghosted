The Design section says the S3-SQLite risk is "Resolved... the managed-DB
fallback was never needed", but the networking discussion is kept "since it
may become relevant again if Lightsail's S3-backed-SQLite approach doesn't
pan out and the fallback reopens", and a later line leaves "How the
container reaches Proton is otherwise unresearched beyond that" standing.
These are the two remaining live hedges against an earlier explicit goal
of leaving no open questions in the readme.

Found by: opus review subagent, 2026-09-10, dispatched from moth i8hlt.

Fix direction: either resolve/research the Proton reachability question, or
explicitly reframe both hedges as accepted historical context (design-time
uncertainty that resolved) rather than live open questions.
