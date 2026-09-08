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

# sqlite-s3's own node_modules (including better-sqlite3's native binary)
# must be installed here, not copied from the host: the host's toolchain
# and glibc don't match this image's bookworm-slim runtime, and relying on
# a COPY'd host node_modules also silently depends on the build machine
# having already run `npm install` there (and ships its devDependencies
# into the runtime image besides). A build toolchain is needed only to
# compile better-sqlite3's native extension, then purged to keep the image
# slim.
RUN apt-get update -qq && \
    apt-get install -y -qq python3 make g++ > /dev/null && \
    cd /home/ghost/phase2-packages/sqlite-s3 && npm install --omit=dev && \
    cd node_modules/better-sqlite3 && rm -rf build && npm run build-release && cd ../.. && \
    apt-get purge -y -qq python3 make g++ > /dev/null && \
    apt-get autoremove -y -qq > /dev/null && \
    rm -rf /var/lib/apt/lists/*

RUN cd /home/ghost/phase2-packages/ghost-sqlite-s3-launcher && npm install --omit=dev

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
