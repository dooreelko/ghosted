dump-to-sqlite.mjs, seed-from-sqlite.mjs, and reclaim-orphaned-segments.js
all wrap main() in .catch(err => { console.error(...); process.exit(1); }).
verify.mjs's main() does not. A throw outside its inner try -- a malformed
GHOST_ADMIN_API_KEY in generateAdminToken, a DNS failure in the first
checkUrls call, a missing fixture file -- surfaces as an unhandled
rejection with a raw stack trace instead of the {"ok":false,"step":...}
contract that deploy.sh and upgrade.sh both parse by exit code alone.

Found by: opus review subagent, 2026-09-10, dispatched from moth i8hlt.

Fix direction: add the same .catch() pattern used by the sibling CLIs.
