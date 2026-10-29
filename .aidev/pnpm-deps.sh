# Sourced by the .aidev suite scripts: make node_modules match pnpm-lock.yaml,
# offline, from the image's pnpm store. A marker records the lockfile and Node it
# was installed for; it is written only after an install that succeeded, and an
# install whose tools don't resolve is redone. pnpm-workspace.yaml links to the
# npm-common-config submodule's catalogs, so the submodule must be checked out.
[ -f pnpm-workspace.yaml ] || { echo "pnpm-workspace.yaml does not resolve: is the npm-common-config submodule checked out?" >&2; return 1; }
lock_id="$(sha256sum pnpm-lock.yaml | cut -d' ' -f1) $(node --version)"
marker=node_modules/.aidev-pnpm-lock
if [ "$(cat "$marker" 2>/dev/null)" != "$lock_id" ] || [ ! -x node_modules/.bin/tsc ] || [ ! -x node_modules/.bin/mocha ]; then
    echo "node_modules is not current for pnpm-lock.yaml: pnpm install --offline" >&2
    pnpm install --offline --frozen-lockfile --reporter=append-only < /dev/null || return 1
    [ -x node_modules/.bin/tsc ] && [ -x node_modules/.bin/mocha ] || { echo "pnpm install left no tsc/mocha" >&2; return 1; }
    printf '%s\n' "$lock_id" > "$marker.tmp" && mv "$marker.tmp" "$marker"
fi
