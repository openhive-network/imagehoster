# The image AIDEV runs this project's suites in (`environment.image` in
# .aidev/project.yaml). Suites run with `--network none`, so everything an
# install needs is in the image. Node comes from common-ci-configuration's
# node-test-tools image, the one CI's test job runs; this file pins no Node
# version. It adds yarn 1 (node-test-tools ships npm only), the make CI's test
# job uses, redis-server for the "(requires Redis)" tests, and a yarn offline
# mirror of the yarn.lock tarballs.
# Build and pin it with .aidev/runtime/build.sh; see .aidev/README.md.
ARG BASE_IMAGE=registry.gitlab.syncad.com/hive/common-ci-configuration/node-test-tools:develop
FROM ${BASE_IMAGE}

# No build-essential: sharp installs its prebuilt linux binaries, and secp256k1's
# failed native build falls back to its pure-JS implementation, as it already did
# offline.
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends make redis-server \
    && apt-get clean && rm -rf /var/lib/apt/lists/* \
    && npm install -g yarn@1.22.22 \
    && npm cache clean --force

# The mirror keeps the packed tarballs only (a third of the unpacked cache);
# `yarn install --offline` unpacks them into YARN_CACHE_FOLDER on first use.
ENV HOME=/tmp \
    YARN_YARN_OFFLINE_MIRROR=/opt/yarn-mirror \
    YARN_CACHE_FOLDER=/tmp/yarn-cache \
    DO_NOT_TRACK=1

COPY package.json yarn.lock /tmp/yarn-fetch/
RUN mkdir -p "$YARN_YARN_OFFLINE_MIRROR" \
    && cd /tmp/yarn-fetch \
    && yarn install --non-interactive --frozen-lockfile --no-progress --ignore-scripts \
    && cd / && rm -rf /tmp/yarn-fetch "$YARN_CACHE_FOLDER" \
    && chmod -R a+rX "$YARN_YARN_OFFLINE_MIRROR"
