scripts/deorphan.sh -> /home/doo/projects/ghost/phase2/scripts/deorphan.sh
is a leftover from testing the phase-directory reorganization. It's not
tracked in git, so it doesn't exist for anyone else who clones the repo,
and being an absolute path it also re-crosses the very phase boundary the
reorg was meant to establish (scripts/ now only holds cross-phase/
unclassified scripts).

Found by: opus review subagent, 2026-09-10, dispatched from moth i8hlt.

Fix direction: either remove the untracked symlink (it was a convenience
during interactive testing, not intended to ship) or, if a top-level
shortcut is actually wanted, add a proper relative symlink and commit it.
