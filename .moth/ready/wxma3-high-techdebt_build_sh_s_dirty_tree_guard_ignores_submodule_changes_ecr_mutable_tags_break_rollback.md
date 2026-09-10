phase2/docker/build.sh's dirty-tree guard uses
`git status --porcelain --ignore-submodules` (default value "all"), which
suppresses both dirty content inside Ghost/ and an uncommitted
submodule-pointer change -- both change what goes into the image, since the
docker build context is $GHOST_DIR. The guard's own comment says "the
resulting image tag would not uniquely identify its contents", but that is
exactly what can happen if you forget to `git commit` the bumped submodule
pointer (the readme's own documented upgrade step 2).

Compounding it: phase2/iac/ecr.tf sets image_tag_mutability = "MUTABLE", so
re-pushing under an existing tag silently overwrites it with different
content -- breaking deploy.sh's rollback-by-previous-tag guarantee, since
the "previous tag" may no longer be the image that was actually verified
good.

Found by: opus review subagent, 2026-09-10, dispatched from moth i8hlt.

Fix direction: drop --ignore-submodules (or explicitly check the submodule
pointer separately) in build.sh's guard; consider IMMUTABLE tags on the ECR
repo.
