Moth i8hlt records a decision forced by executing the cutover: uploaded
themes are baked into the image, and the accepted consequence is "a theme
uploaded through the admin panel afterwards lives only in that container
and is lost on the next deploy. Changing themes is now a commit-and-rebuild."
This constraint currently exists only as a comment in
phase2/docker/Dockerfile. Neither phase2/readme.md nor phase2/migration.md
mentions it -- grep -i theme on both returns nothing. This is a live
operational trap: any future deploy or upgrade silently destroys an
admin-uploaded theme, and nothing warns the operator.

Found by: opus review subagent, 2026-09-10, dispatched from moth i8hlt.

Fix direction: document this constraint in phase2/readme.md, most likely in
the Upgrade process or Deploying section, since a deploy is exactly the
trigger.
