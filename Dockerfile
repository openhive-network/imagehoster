# Node comes from hive/common-ci-configuration: its .docker_build_job_template
# passes --build-arg NODE_VERSION=$NODE_IMAGE_VERSION. There is no default; a
# local build passes it too, e.g. --build-arg NODE_VERSION=24.
ARG NODE_VERSION

FROM node:${NODE_VERSION}-alpine AS build-stage

WORKDIR /app

# install build dependencies
RUN apk add \
    --no-cache \
    bash \
    build-base \
    git \
    make

# pnpm at the version common-ci-configuration (the npm-common-config submodule)
# builds its images with
COPY npm-common-config/docker-bake.hcl npm-common-config/
RUN PNPM_VERSION="$(sed -n '/^variable "PNPM_VERSION"/,/^}/s/^ *default *= *"\(.*\)"/\1/p' npm-common-config/docker-bake.hcl)" \
    && npm install -g "pnpm@${PNPM_VERSION:?no PNPM_VERSION in npm-common-config/docker-bake.hcl}" \
    && npm cache clean --force

# install application dependencies; pnpm-workspace.yaml links to the submodule's
# catalogs. A lockfile written against an older catalog than the submodule's (CI
# checks it out at develop's tip) fails the frozen install with
# ERR_PNPM_LOCKFILE_CONFIG_MISMATCH; only then the install is redone unfrozen, as
# common-ci-configuration's .pnpm_install_with_catalog_fallback does.
COPY package.json pnpm-lock.yaml ./
COPY npm-common-config/pnpm-config/pnpm-workspace.yaml ./
RUN rc=0; pnpm install --frozen-lockfile > /tmp/pnpm-install.log 2>&1 || rc=$?; \
    cat /tmp/pnpm-install.log; \
    if [ "$rc" -ne 0 ]; then \
        grep -q ERR_PNPM_LOCKFILE_CONFIG_MISMATCH /tmp/pnpm-install.log || exit "$rc"; \
        echo "The catalog changed since pnpm-lock.yaml was written: pnpm install --no-frozen-lockfile"; \
        pnpm install --no-frozen-lockfile || exit $?; \
    fi

# copy in application source
COPY . .

# run tests and build typescript sources
RUN make lib ci-test

# prune modules
RUN pnpm prune --prod

# copy built application to runtime image
FROM node:${NODE_VERSION}-alpine
WORKDIR /app
COPY --from=build-stage /app/config config
COPY --from=build-stage /app/lib lib
COPY --from=build-stage /app/node_modules node_modules

# run in production mode
ENV NODE_ENV production
CMD [ "node", "lib/app.js" ]
