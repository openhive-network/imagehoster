#!/usr/bin/env bash
# The checks AIDEV's verification slots run (.aidev/project.yaml), as one junit
# report per suite: each named step is a test case, its log the failure body.
#
#   .aidev/run-checks.sh <suite> <step>...   steps: lint typecheck test redis build smoke
#
#   lint       ESLint on src/ (the first half of `make ci-test`, CI's test job)
#   typecheck  tsc --noEmit on src/ (tsconfig.json)
#   test       the mocha suite under nyc, as `make ci-test` runs it: every test its
#              own junit case in $out/unit-tests.xml, lcov + summary in $out/coverage
#   redis      the tests marked "(requires Redis)", which CI skips, against a
#              redis-server started on 127.0.0.1 inside the container; junit in
#              $out/redis-tests.xml. `--exit`: src/common.ts keeps its Redis client
#              open, so mocha would otherwise never return
#   build      `make lib`: tsc to lib/ plus lib/version.js (what the Dockerfile ships)
#   smoke      (after build) starts `node lib/app.js` with the default config and
#              asks /.well-known/healthcheck.json for {ok: true, version}
set -uo pipefail
cd "$(dirname "$0")/.."

suite="${1:?usage: $0 <suite> <step>...}"; shift
out="test-results/$suite"
rm -rf "$out"; mkdir -p "$out"
cases="$out/cases.tsv"; : > "$cases"

# shellcheck source=yarn-deps.sh
if ! source .aidev/yarn-deps.sh; then
    printf 'case\tinstall\tfail\t0\tyarn install --offline failed\n' >> "$cases"
    source .aidev/junit-helpers.sh; junit_write_cases "$out/junit.xml" "$suite" "$cases"
    exit 1
fi
source .aidev/junit-helpers.sh
PATH="$PWD/node_modules/.bin:$PATH"

status=0
step() {
    local name="$1"; shift
    local log="$out/$name.log" t0=$SECONDS rc=0
    echo "== $name" >&2
    "$@" > "$log" 2>&1 < /dev/null || rc=$?
    if [ "$rc" -eq 0 ]; then
        printf 'case\t%s\tpass\t%s\t\n' "$name" "$((SECONDS - t0))" >> "$cases"
    else
        status=1; tail -40 "$log" >&2
        printf 'case\t%s\tfail\t%s\texit %s\t%s\n' "$name" "$((SECONDS - t0))" "$rc" "$log" >> "$cases"
    fi
}

mocha_args=(--require ts-node/register --timeout 30000 --reporter mocha-junit-reporter)

unit_tests() {
    local junit="$out/unit-tests.xml"
    NODE_ENV=test run_with_junit_fallback "$junit" unit-tests \
        nyc -r lcov -r text-summary -e .ts -i ts-node/register --report-dir "$out/coverage" \
        mocha "${mocha_args[@]}" --reporter-options "mochaFile=$junit" test/*.ts
}

redis_tests() {
    local junit="$out/redis-tests.xml" port=6390 pid rc=0
    redis-server --bind 127.0.0.1 --port "$port" --save '' --appendonly no --dir /tmp > "$out/redis-server.log" 2>&1 &
    pid=$!
    for _ in $(seq 50); do redis-cli -p "$port" ping 2>/dev/null | grep -q PONG && break; sleep 0.2; done
    REDIS_URL="redis://127.0.0.1:$port" NODE_ENV=test run_with_junit_fallback "$junit" redis-tests \
        mocha "${mocha_args[@]}" --exit --reporter-options "mochaFile=$junit" --grep 'requires Redis' test/*.ts || rc=$?
    kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
    # --grep selecting nothing would pass vacuously
    grep -q '<testcase' "$junit" 2>/dev/null || { echo "no test matched 'requires Redis'" >&2; return 1; }
    return "$rc"
}

# The Makefile's `lib` target without its `node_modules` prerequisite (which would
# run a networked `yarn install`). A workflow's container has no usable .git, so
# the build hash comes from AIDEV_COMMIT_SHORT_SHA when git can't answer.
build_lib() {
    rm -rf lib
    tsc -p tsconfig.json --outDir lib || return 1
    local version hash
    version="$(node -p 'require("./package.json").version')"
    hash="$(git rev-parse --short HEAD 2>/dev/null || echo "${AIDEV_COMMIT_SHORT_SHA:-unknown}")"
    echo "module.exports = '${version}-${hash}-$(date +%s)';" > lib/version.js
    [ -f lib/app.js ] || { echo "lib/app.js was not built" >&2; return 1; }
}

smoke() {
    [ -f lib/app.js ] || { echo "no lib/app.js: run the build step first" >&2; return 1; }
    local port=18800 pid rc=1
    PORT="$port" NUM_WORKERS=1 LOG_LEVEL=info SERVICE_URL="http://127.0.0.1:$port" node lib/app.js > "$out/smoke-server.log" 2>&1 &
    pid=$!
    for _ in $(seq 60); do
        if PORT="$port" node -e '
fetch(`http://127.0.0.1:${process.env.PORT}/.well-known/healthcheck.json`).then(async (r) => {
  const body = await r.json();
  const want = require("./lib/version.js");
  if (r.status !== 200 || body.ok !== true || body.version !== want) { console.error("bad healthcheck:", r.status, body); process.exit(2); }
  console.log("healthcheck ok:", JSON.stringify(body));
}).catch(() => process.exit(1));'; then rc=0; break; fi
        kill -0 "$pid" 2>/dev/null || { echo "server exited" >&2; break; }
        sleep 0.5
    done
    kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
    [ "$rc" -eq 0 ] || tail -40 "$out/smoke-server.log" >&2
    return "$rc"
}

for s in "$@"; do
    case "$s" in
        lint) step lint eslint src/ ;;
        typecheck) step typecheck tsc -p tsconfig.json --noEmit ;;
        test) step test unit_tests ;;
        redis) step redis redis_tests ;;
        build) step build build_lib ;;
        smoke) step smoke smoke ;;
        *) echo "unknown step: $s" >&2; exit 2 ;;
    esac
done
junit_write_cases "$out/junit.xml" "$suite" "$cases"
exit "$status"
