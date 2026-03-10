# Claude in Safari — Development Makefile
#
# Usage:
#   make dev          Build, launch app, create stable socket symlink
#   make build        Build without launching
#   make run          Launch an already-built app
#   make test         Run JS unit tests
#   make test-swift   Run Swift unit tests
#   make test-all     Run both JS and Swift tests
#   make send         Send a tool call:  make send TOOL=find ARGS='{"query":"Submit"}'
#   make list-tools   List all registered MCP tools
#   make status       Show app/socket/extension status
#   make clean        Kill app, remove sockets, clean DerivedData
#   make kill         Kill the running app (without cleaning build)

SHELL := /bin/bash

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

PROJECT     := ClaudeInSafari.xcodeproj
SCHEME      := ClaudeInSafari
TEST_SCHEME := ClaudeInSafariTests
DEST        := platform=macOS
USERNAME    := $(shell whoami)
SOCK_DIR    := /tmp/claude-mcp-browser-bridge-$(USERNAME)
DEV_SOCK    := $(SOCK_DIR)/dev.sock
APP_NAME    := Claude in Safari

# Resolve the DerivedData build directory (cached after first call)
BUILD_DIR    = $(shell xcodebuild -project $(PROJECT) -scheme $(SCHEME) -showBuildSettings 2>/dev/null \
                 | grep '^\s*BUILT_PRODUCTS_DIR' | head -1 | awk '{print $$3}')
APP_PATH     = $(BUILD_DIR)/$(APP_NAME).app

# ---------------------------------------------------------------------------
# Targets
# ---------------------------------------------------------------------------

.PHONY: dev build run kill test test-swift test-all send list-tools status clean help

help: ## Show this help
	@grep -E '^[a-z_-]+:.*##' $(MAKEFILE_LIST) | awk -F ':.*## ' '{printf "  %-14s %s\n", $$1, $$2}'

dev: build kill run ## Build, kill old, launch, create socket symlink
	@echo ""
	@echo "=== Claude in Safari is running ==="
	@echo "Socket: $(DEV_SOCK)"
	@echo ""
	@echo "Quick test:"
	@echo "  make list-tools"
	@echo "  make send TOOL=find ARGS='{\"query\":\"Submit\"}'"

build: ## Build the Xcode project
	@echo "Building..."
	@xcodebuild build \
		-project $(PROJECT) \
		-scheme $(SCHEME) \
		-destination "$(DEST)" \
		-quiet
	@echo "Build succeeded: $(APP_PATH)"

run: ## Launch the app and create stable socket symlink
	@# Kill any existing instance first (ignore errors)
	@pkill -f "$(APP_NAME).app/Contents/MacOS" 2>/dev/null || true
	@sleep 0.5
	@# Remove stale sockets
	@rm -f $(SOCK_DIR)/*.sock 2>/dev/null || true
	@echo "Launching $(APP_NAME)..."
	@open "$(APP_PATH)"
	@# Wait for the socket to appear (up to 5s)
	@for i in 1 2 3 4 5 6 7 8 9 10; do \
		sock=$$(ls $(SOCK_DIR)/*.sock 2>/dev/null | grep -v dev.sock | head -1); \
		if [ -n "$$sock" ]; then \
			ln -sf "$$sock" "$(DEV_SOCK)"; \
			echo "Socket ready: $(DEV_SOCK) -> $$sock"; \
			break; \
		fi; \
		sleep 0.5; \
	done
	@if [ ! -e "$(DEV_SOCK)" ]; then \
		echo "WARNING: Socket did not appear after 5s. Check Console.app for errors."; \
	fi

kill: ## Kill the running app
	@pkill -f "$(APP_NAME).app/Contents/MacOS" 2>/dev/null && echo "Killed $(APP_NAME)" || true

test: ## Run JavaScript unit tests
	@npm test

test-swift: ## Run Swift unit tests
	@xcodebuild test \
		-project $(PROJECT) \
		-scheme $(TEST_SCHEME) \
		-destination "$(DEST)" \
		CODE_SIGN_IDENTITY="" CODE_SIGNING_REQUIRED=NO \
		-quiet 2>&1 | tail -5

test-all: test test-swift ## Run all tests (JS + Swift)

# Tool invocation — usage: make send TOOL=find ARGS='{"query":"Submit"}'
# Safari MV2 requires the app to be frontmost for executeScript to work.
# The osascript activation + brief pause ensures the permission grant is active.
TOOL ?= read_page
ARGS ?= {}
send: ## Send a tool call (TOOL=name ARGS='{}')
	@osascript -e 'tell application "Safari" to activate' 2>/dev/null; sleep 0.3; python3 scripts/mcp-test.py call $(TOOL) '$(ARGS)'

list-tools: ## List all registered MCP tools
	@python3 scripts/mcp-test.py list

status: ## Show app, socket, and extension status
	@echo "=== App Process ==="
	@ps aux | grep "$(APP_NAME).app/Contents/MacOS" | grep -v grep || echo "  Not running"
	@echo ""
	@echo "=== Extension Process ==="
	@ps aux | grep "ClaudeInSafari Extension.appex" | grep -v grep || echo "  Not running"
	@echo ""
	@echo "=== Socket Directory ==="
	@ls -la $(SOCK_DIR)/ 2>/dev/null || echo "  $(SOCK_DIR)/ does not exist"
	@echo ""
	@echo "=== Build ==="
	@if [ -d "$(APP_PATH)" ]; then echo "  $(APP_PATH)"; else echo "  Not built (run: make build)"; fi

clean: kill ## Kill app, remove sockets, clean build
	@rm -rf $(SOCK_DIR) 2>/dev/null || true
	@echo "Cleaned sockets"
	@xcodebuild clean \
		-project $(PROJECT) \
		-scheme $(SCHEME) \
		-quiet 2>/dev/null || true
	@echo "Cleaned build"
