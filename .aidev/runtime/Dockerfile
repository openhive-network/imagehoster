# The image AIDEV runs this project's suites in (`environment.image` in
# .aidev/project.yaml). Suites run with `--network none`, so everything an
# install needs is in the image: the same Node 20 alpine image CI's test job and
# the Dockerfile build on (the project's mirror, pinned by digest), the yarn 1
# that image ships, the packages CI's test job adds, redis-server for the
# "(requires Redis)" tests, and a yarn cache filled from yarn.lock. Build and pin
# it with .aidev/runtime/build.sh; see .aidev/README.md.
FROM registry.gitlab.syncad.com/hive/imagehoster/node:20-alpine@sha256:5bac2112f1a27db4775ce6ead86db9e0cbc087f0dbddfe3cbc11ecea122d5294

RUN apk add --no-cache bash build-base git make redis

ENV HOME=/tmp \
    YARN_CACHE_FOLDER=/opt/yarn-cache \
    DO_NOT_TRACK=1

COPY package.json yarn.lock /tmp/yarn-fetch/
RUN cd /tmp/yarn-fetch \
    && yarn install --non-interactive --frozen-lockfile --no-progress --ignore-scripts \
    && cd / && rm -rf /tmp/yarn-fetch \
    && chmod -R a+rwX /opt/yarn-cache
