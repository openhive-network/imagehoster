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

# install application dependencies
COPY package.json yarn.lock ./
RUN JOBS=max yarn install --non-interactive --frozen-lockfile

# copy in application source
COPY . .

# run tests and build typescript sources
RUN make lib ci-test

# prune modules
RUN yarn install --non-interactive --frozen-lockfile --production

# copy built application to runtime image
FROM node:${NODE_VERSION}-alpine
WORKDIR /app
COPY --from=build-stage /app/config config
COPY --from=build-stage /app/lib lib
COPY --from=build-stage /app/node_modules node_modules

# run in production mode
ENV NODE_ENV production
CMD [ "node", "lib/app.js" ]
