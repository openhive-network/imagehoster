# Sourced by the .aidev suite scripts: make node_modules match yarn.lock,
# offline, from the image's yarn offline mirror. A marker records the lockfile and Node it
# was installed for; it is written only after an install that succeeded, and an
# install whose tools don't resolve is redone.
lock_id="$(sha256sum yarn.lock | cut -d' ' -f1) $(node --version)"
marker=node_modules/.aidev-yarn-lock
if [ "$(cat "$marker" 2>/dev/null)" != "$lock_id" ] || [ ! -x node_modules/.bin/tsc ] || [ ! -x node_modules/.bin/mocha ]; then
    echo "node_modules is not current for yarn.lock: yarn install --offline" >&2
    yarn install --offline --frozen-lockfile --non-interactive --no-progress < /dev/null || return 1
    [ -x node_modules/.bin/tsc ] && [ -x node_modules/.bin/mocha ] || { echo "yarn install left no tsc/mocha" >&2; return 1; }
    printf '%s\n' "$lock_id" > "$marker.tmp" && mv "$marker.tmp" "$marker"
fi
