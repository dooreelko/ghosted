# Moth Agent Guide

This guide helps LLM agents work effectively with moth, a git-based file issue tracker.

## Overview

Moth stores issues as markdown files in `.moth/` directories organized by status (ready, doing, done). Each issue has a unique ID, severity, and slug derived from the title.
NEVER manupulate the moth files directly, ALWAYS use `moth` cli for any changes.

**Note**: Moth automatically recreates missing status directories (e.g., if git removes empty directories). As long as `config.yml` exists, moth will recover gracefully.

## Workflow Commands

See `moth --agent-help`

## Sensitive data

Moth specs (and other tracked files, including phase docs) are public information. Never put
exact AWS resource IDs (instance/VPC/subnet/SG/route-table/gateway/distribution/hosted-zone IDs),
credential or parameter names, account IDs, or similar identifiers directly into tracked files.

Instead, write them into `.local-secrets.md` (gitignored, lives at the repo root) under a heading
for the relevant task/feature, and reference resources in tracked files by role/tag (e.g. "the
appserver instance, tagged app:ghost-classic") with a pointer to `.local-secrets.md` for the exact
value.


