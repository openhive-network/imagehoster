# The image AIDEV runs this project's suites in (`environment.image` in
# .aidev/project.yaml). Suites run with `--network none`, so everything an
# install needs is in the image: the same Node 24 alpine image CI's test job and
# the Dockerfile build on (the project's mirror, pinned by digest), the yarn 1
# that image ships, the packages CI's test job adds, redis-server for the
# "(requires Redis)" tests, and a yarn offline mirror of the yarn.lock tarballs.
# Build and pin it with .aidev/runtime/build.sh; see .aidev/README.md.
FROM registry.gitlab.syncad.com/hive/imagehoster/node:24.21.0-alpine3.23@sha256:9ec4a2e289874ed0d722e1772ec2de45d2801541db8612f3638b26f128c69ac2

# No build-base: sharp installs its prebuilt linuxmusl binaries, and secp256k1's
# failed native build falls back to its pure-JS implementation, as it already did
# offline.
RUN apk add --no-cache bash git make redis

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
