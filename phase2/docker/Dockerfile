# syntax=docker/dockerfile:1
# Stage B of the two-stage build (see docs/superpowers/specs/2026-09-08-phase2-docker-iac-design.md).
# Stage A (Ghost's own Dockerfile.production, target=full) is built separately
# by build.sh and passed in as BASE_IMAGE — this file never touches Ghost's
# own Dockerfile or source.
ARG BASE_IMAGE
FROM ${BASE_IMAGE}

USER root
COPY --chown=nobody:nogroup phase2/packages/sqlite-s3 /home/ghost/phase2-packages/sqlite-s3
COPY --chown=nobody:nogroup phase2/packages/ghost-sqlite-s3-launcher /home/ghost/phase2-packages/ghost-sqlite-s3-launcher
RUN cd /home/ghost/phase2-packages/ghost-sqlite-s3-launcher && npm install --omit=dev

USER ghost
ENV GHOST_CHECKOUT_DIR=/home/ghost
CMD ["node", "--import=/home/ghost/phase2-packages/ghost-sqlite-s3-launcher/src/preload.mjs", "index.js"]
