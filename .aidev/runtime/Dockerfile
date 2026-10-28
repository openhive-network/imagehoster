# The image AIDEV runs this project's suites in (`environment.image` in
# .aidev/project.yaml). Suites run with `--network none`, so everything an
# install needs is in the image. Node and pnpm come from common-ci-configuration's
# node-test-tools image, the one CI's test job runs; this file pins no Node or
# pnpm version. It adds the make CI's test job uses, redis-server for the
# "(requires Redis)" tests, and a pnpm store holding every pnpm-lock.yaml package.
# Build and pin it with .aidev/runtime/build.sh; see .aidev/README.md.
ARG BASE_IMAGE=registry.gitlab.syncad.com/hive/common-ci-configuration/node-test-tools:develop
FROM ${BASE_IMAGE}

# No build-essential: sharp installs its prebuilt linux binaries, and secp256k1's
# failed native build falls back to its pure-JS implementation, as it already did
# offline.
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends make redis-server \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# `pnpm fetch` needs the lockfile only. The suites run as the caller's uid, and
# pnpm writes into its store while installing from it, so the store is
# world-writable.
ENV HOME=/tmp \
    npm_config_store_dir=/opt/pnpm-store \
    DO_NOT_TRACK=1

COPY pnpm-lock.yaml /tmp/pnpm-fetch/
RUN cd /tmp/pnpm-fetch \
    && pnpm fetch --reporter=append-only \
    && cd / && rm -rf /tmp/pnpm-fetch \
    && chmod -R a+rwX "$npm_config_store_dir"
