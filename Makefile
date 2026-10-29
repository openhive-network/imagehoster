
SHELL := /bin/bash
PATH  := ./node_modules/.bin:$(PATH)

SRC_FILES := $(shell find src -name '*.ts')

all: lib

lib: $(SRC_FILES) node_modules tsconfig.json
	tsc -p tsconfig.json --outDir lib
	VERSION="$$(node -p 'require("./package.json").version')"; \
	BUILD="$$(git rev-parse --short HEAD)-$$(date +%s)"; \
	echo "module.exports = '$${VERSION}-$${BUILD}';" > lib/version.js
	touch lib

reports:
	mkdir reports

.PHONY: coverage
coverage: node_modules reports
	NODE_ENV=test nyc -r html -r text -e .ts -i ts-node/register \
		--report-dir reports/coverage \
		mocha --reporter nyan --require ts-node/register test/*.ts

.PHONY: devserver
devserver: node_modules
	@onchange -i 'src/**/*.ts' 'config/*' -- ts-node src/app.ts | bunyan -o short

.PHONY: test
test: node_modules
	@NODE_ENV=test mocha --require ts-node/register test/*.ts --grep '$(grep)'

.PHONY: ci-test
ci-test: node_modules reports
# Disabling pnpm audit for now because all packages are too old
# @TODO update and test packages
#	pnpm audit
	eslint src/
	NODE_ENV=test nyc -r lcov -e .ts -i ts-node/register \
		--report-dir reports/coverage \
		mocha --require ts-node/register \
		--timeout 30000 \
		--reporter $$([ -n "$$CI" ] && echo "mocha-junit-reporter" || echo "tap") \
		--reporter-options mochaFile=./reports/unit-tests/junit.xml \
		test/*.ts

.PHONY: lint
lint: node_modules
	eslint --fix src/

# pnpm-workspace.yaml links to the npm-common-config submodule's catalogs. A
# lockfile written against an older catalog than the submodule's (CI checks it out
# at develop's tip) fails the frozen install with ERR_PNPM_LOCKFILE_CONFIG_MISMATCH;
# only then the install is redone unfrozen, as common-ci-configuration's
# .pnpm_install_with_catalog_fallback does.
node_modules: package.json
	@log="$$(mktemp)"; \
	pnpm install --frozen-lockfile 2>&1 | tee "$$log"; rc=$${PIPESTATUS[0]}; \
	if [ "$$rc" -ne 0 ]; then \
		grep -q ERR_PNPM_LOCKFILE_CONFIG_MISMATCH "$$log" || { rm -f "$$log"; exit "$$rc"; }; \
		echo "The catalog changed since pnpm-lock.yaml was written: pnpm install --no-frozen-lockfile"; \
		pnpm install --no-frozen-lockfile || { rm -f "$$log"; exit 1; }; \
	fi; \
	rm -f "$$log"
	touch $@

.PHONY: clean
clean:
	rm -rf .nyc_output/
	rm -rf lib/
	rm -rf reports/

.PHONY: distclean
distclean: clean
	rm -rf node_modules/
