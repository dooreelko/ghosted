With an orphan-count alarm that can fire in production, there is currently
no runbook entry in phase2/readme.md telling an operator what to actually
do about it -- deorphan.sh isn't mentioned there at all. empty-store.sh
only appears as prose inside the upgrade narrative, not as a standalone
documented tool.

Found by: opus review subagent, 2026-09-10, dispatched from moth i8hlt.

Fix direction: add a short "Tools" or "Operational scripts" subsection (or
extend the monitoring/alarms discussion) documenting deorphan.sh and
empty-store.sh as standalone commands, including what each alarm firing
should prompt an operator to run.
