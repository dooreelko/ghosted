readme.md's Cost table says "ECR (private image registry) | ~\$0.10-0.20 |
One image kept at a time; storage-only cost". Live reality: 11 images,
1.51 GB, and get-lifecycle-policy returns LifecyclePolicyNotFoundException
-- nothing deletes old images. Growth is roughly 137 MB per deploy,
forever. The dollar figure is coincidentally still about right today
(~\$0.15/mo) but the described mechanism ("one image kept at a time")
doesn't exist, and the true number drifts upward with every future deploy.

Found by: opus review subagent, 2026-09-10, dispatched from moth i8hlt.

Fix direction: add an ECR lifecycle policy (keep last N images) in
phase2/iac/ecr.tf, and correct the Cost table's description once one
exists.
