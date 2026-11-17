# Node comes from hive/common-ci-configuration: its .docker_build_job_template
# passes --build-arg NODE_VERSION=$NODE_IMAGE_VERSION. There is no default; a
# local build passes it too, e.g. --build-arg NODE_VERSION=24.
ARG NODE_VERSION

# Both stages are glibc (Debian slim), so the prebuilt sharp binaries pnpm
# installs in the build stage are the ones the runtime stage loads.
FROM node:${NODE_VERSION}-slim AS build-stage

WORKDIR /app

# install build dependencies
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        build-essential \
        git \
        make \
    && rm -rf /var/lib/apt/lists/*

# pnpm at the version common-ci-configuration (the npm-common-config submodule)
# builds its images with
COPY npm-common-config/docker-bake.hcl npm-common-config/
RUN PNPM_VERSION="$(sed -n '/^variable "PNPM_VERSION"/,/^}/s/^ *default *= *"\(.*\)"/\1/p' npm-common-config/docker-bake.hcl)" \
    && npm install -g "pnpm@${PNPM_VERSION:?no PNPM_VERSION in npm-common-config/docker-bake.hcl}" \
    && npm cache clean --force

# install application dependencies through the Makefile's node_modules target,
# which falls back to an unfrozen install when the submodule's catalogs moved past
# pnpm-lock.yaml. `make lib ci-test` below depends on that target too, so when
# `COPY . .` leaves package.json newer than node_modules it reinstalls the same way.
COPY Makefile package.json pnpm-lock.yaml ./
COPY npm-common-config/pnpm-config/pnpm-workspace.yaml ./
RUN make node_modules

# copy in application source
COPY . .

# run tests and build typescript sources
RUN make lib ci-test

# prune modules
RUN pnpm prune --prod

# copy built application to runtime image
FROM node:${NODE_VERSION}-slim

# glibc's allocator fragments under sharp's long-running libvips threads; sharp
# recommends jemalloc on glibc (and, seeing it loaded, keeps one libvips thread
# per core instead of falling back to one).
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends libjemalloc2 \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s "$(dpkg -L libjemalloc2 | grep '/libjemalloc\.so\.2$')" /usr/local/lib/libjemalloc.so.2
ENV LD_PRELOAD=/usr/local/lib/libjemalloc.so.2

WORKDIR /app
COPY --from=build-stage /app/config config
COPY --from=build-stage /app/lib lib
COPY --from=build-stage /app/node_modules node_modules

# run in production mode
ENV NODE_ENV production
CMD [ "node", "lib/app.js" ]
