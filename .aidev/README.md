# imagehoster under AIDEV

AIDEV verifies changes to this service through the slots in `project.yaml`, integrates
them into `aidev/integration`, and people merge that into `develop` through merge
requests (as in hive/denser). GitLab CI doesn't run for AIDEV branches; see
`.gitlab-ci.yml` `workflow:`.

## Suites

`.aidev/run-checks.sh <suite> <step>...` runs the named steps and writes
`test-results/<suite>/junit.xml`, one test case per step, with the step's log tail as
the failure body. The mocha steps also write one junit case per test.

| Step | What |
|---|---|
| `lint` | `eslint src/` (as `make ci-test`) |
| `typecheck` | `tsc --noEmit` on `src/` |
| `test` | the mocha suite under nyc, as `make ci-test` (CI's `test` job) runs it; junit in `unit-tests.xml`, lcov in `coverage/` |
| `redis` | the `(requires Redis)` tests, which CI skips, against a `redis-server` on 127.0.0.1 in the container; junit in `redis-tests.xml` |
| `build` | `make lib`: `tsc` to `lib/` plus `lib/version.js` |
| `smoke` | (after `build`) `node lib/app.js` with the default config answers `/.well-known/healthcheck.json` |

| Slot | Steps |
|---|---|
| quick | lint, typecheck, test |
| full, canary | lint, typecheck, test, redis, build, smoke |
| baseline, coverage | test |
| static | lint, typecheck |
| system | build, smoke, redis |

At onboarding (develop `3420b54`) `redis` fails one case: `proxy-auth should reject
invalid signature (requires Redis)` expects 401, while the handler answers 400 like every
other `InvalidSignature`. CI never saw it because it runs without Redis.

Not covered: the S3 blob store (`src/s3-blob-store.ts`; the tests use memory stores),
the whitelist's PostgREST lookup, and `docker build` of the production `Dockerfile`
(slots have no docker daemon).

## The test runtime image (`runtime/`)

The suites run in a container with `--network none` and your uid. The image is the
project's mirrored `node:24.21.0-alpine3.23` (the one CI and the `Dockerfile` use) pinned by
digest, with yarn 1 as that image ships it, the packages CI's test job adds except
`build-base` (sharp ships prebuilt musl binaries; secp256k1 falls back to pure JS),
`redis`, and a yarn offline mirror (`/opt/yarn-mirror`, the packed tarballs of
`yarn.lock`, every optional platform package included because yarn 1 fetches them
all). `yarn-deps.sh` installs `node_modules` offline from it, unpacking into a yarn
cache under `/tmp` on the first install in a container.

When `package.json` dependencies, `yarn.lock` or `runtime/Dockerfile` change, rebuild and re-pin
**in the same commit**:

```bash
.aidev/runtime/build.sh --push   # registry digest if aidev-<input hash> exists, else build + push
# put the printed repo@sha256:<digest> into project.yaml environment.image
```

Run a suite by hand the same way AIDEV does:

```bash
docker run --rm --network none --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -v "$PWD":/work -w /work <environment.image> .aidev/run-checks.sh quick lint typecheck test
```
