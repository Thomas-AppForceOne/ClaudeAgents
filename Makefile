.DEFAULT_GOAL := help
.PHONY: help build test test-install-live lint typecheck format-check check clean

help:
	@printf "Usage: make <target>\n\n"
	@printf "Routine:\n"
	@printf "  build              Compile TypeScript to dist/.\n"
	@printf "  test               Run the vitest suite (stubbed install/uninstall).\n"
	@printf "  lint               Run eslint.\n"
	@printf "  typecheck          Run tsc --noEmit.\n"
	@printf "  format-check       Run prettier --check.\n\n"
	@printf "Pre-release:\n"
	@printf "  check              Build + typecheck + lint + format-check + test.\n"
	@printf "  test-install-live  Live, non-stubbed install round-trip (slow).\n\n"
	@printf "Housekeeping:\n"
	@printf "  clean              Remove dist/.\n"

build:
	@npm run build

test:
	@npm test

lint:
	@npm run lint

typecheck:
	@npm run typecheck

format-check:
	@npm run format:check

# Full pre-release verification gate. Order matters: build first so
# typecheck and lint run against the same sources as test.
check: build typecheck lint format-check test

# Live install round-trip — exercises the real `npm install -g .`, the
# real installed binary, and every flag combination. Not part of `npm
# test`; intended as a pre-release gate. See tests/installer/live-install.sh.
test-install-live:
	@bash tests/installer/live-install.sh

clean:
	@rm -rf dist
