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

# better-sqlite3's node_modules ships a host-built binary that doesn't load
# under this image's bookworm-slim runtime (different glibc) — rebuild it
# from source against this image's own toolchain instead of trusting the
# COPY'd host build. Purge the build toolchain afterward to keep the image
# slim; it's not needed at runtime.
RUN apt-get update -qq && \
    apt-get install -y -qq python3 make g++ > /dev/null && \
    cd /home/ghost/phase2-packages/sqlite-s3/node_modules/better-sqlite3 && \
    rm -rf build && npm run build-release && \
    apt-get purge -y -qq python3 make g++ > /dev/null && \
    apt-get autoremove -y -qq > /dev/null && \
    rm -rf /var/lib/apt/lists/*

USER ghost
ENV GHOST_CHECKOUT_DIR=/home/ghost
# stdbuf forces line-buffered stdout/stderr at the OS pipe level. Node's
# stdout, piped to a non-TTY consumer (exactly what Lightsail's log
# collector is), is asynchronously buffered by default -- under an abrupt
# process kill (e.g. Lightsail's "Took too long" deployment cancellation),
# any buffered-but-unflushed output is lost entirely. Ghost's own boot
# logging (transports: ["stdout"] in core/shared/config/defaults.json) was
# suspected to be getting silently eaten this way, regardless of how far
# boot actually got -- this forces every line out immediately instead.
CMD ["stdbuf", "-oL", "-eL", "node", "--import=/home/ghost/phase2-packages/ghost-sqlite-s3-launcher/src/preload.mjs", "index.js"]
