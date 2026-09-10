Confirmed live: get-bucket-versioning on the data bucket returns empty
(not enabled). s3.tf only configures a public-access block. Given
empty-store.sh --yes and upgrade.sh's recovery path both issue
`aws s3 rm --recursive` against segments/, and the project's own decision
record states "there is no untouched second copy of the data here; the
store is the only copy," versioning plus a noncurrent-version-expiry
lifecycle rule is the cheapest available insurance and is currently absent.
Also absent: an AbortIncompleteMultipartUpload lifecycle rule, despite the
runtime role holding s3:AbortMultipartUpload.

Found by: opus review subagent, 2026-09-10, dispatched from moth i8hlt.

Fix direction: enable versioning on the data bucket in s3.tf, add a
noncurrent-version expiry (balance against storage cost) and an
AbortIncompleteMultipartUpload rule.
