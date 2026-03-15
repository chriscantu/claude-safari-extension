# Claude in Safari — Development Makefile
#
# Usage:
#   make dev            Build + relaunch app + health check (preserves Safari state)
#   make reload-ext     Activate Safari to trigger extension load (safe — no pluginkit!)
#   make functional-check  Verify executeScript works (not just queue polling)
#   make safari-restart Nuclear option: quit Safari, reopen (resets Allow Unsigned Extensions!)
#   make health         Verify extension is responding
#   make doctor         Full diagnostic of all prerequisites
#   make build          Build without launching
#   make run            Launch an already-built app
#   make test           Run JS unit tests
#   make test-swift     Run Swift unit tests
#   make test-all       Run both JS and Swift tests
#   make send           Send a tool call:  make send TOOL=find ARGS='{"query":"Submit"}'
#   make list-tools     List all registered MCP tools
#   make status         Show app/socket/extension status
#   make clean          Kill app, remove sockets, clean DerivedData
#   make kill           Kill the running app (without cleaning build)

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
APP_GROUP   := $(HOME)/Library/Group Containers/group.com.chriscantu.claudeinsafari
EXT_BUNDLE  := com.chriscantu.claudeinsafari.extension

# Resolve the DerivedData build directory (cached after first call)
BUILD_DIR    = $(shell xcodebuild -project $(PROJECT) -scheme $(SCHEME) -showBuildSettings 2>/dev/null \
                 | grep '^\s*BUILT_PRODUCTS_DIR' | head -1 | awk '{print $$3}')
APP_PATH     = $(BUILD_DIR)/$(APP_NAME).app

# ---------------------------------------------------------------------------
# Targets
# ---------------------------------------------------------------------------

.PHONY: dev build run kill test test-swift test-all send list-tools status clean help \
        health doctor queue-clean safari-quit safari-open safari-restart reload-ext functional-check

help: ## Show this help
	@grep -E '^[a-z_-]+:.*##' $(MAKEFILE_LIST) | awk -F ':.*## ' '{printf "  %-16s %s\n", $$1, $$2}'

# ---------------------------------------------------------------------------
# Dev workflow
# ---------------------------------------------------------------------------

dev: build kill queue-clean run reload-ext health ## Build + relaunch + activate Safari + verify
	@echo ""
	@echo "=== Claude in Safari is running ==="
	@echo "Socket: $(DEV_SOCK)"
	@echo ""
	@echo "Quick test:"
	@echo "  make list-tools"
	@echo "  make send TOOL=find ARGS='{\"query\":\"Submit\"}'"

# ---------------------------------------------------------------------------
# Build + launch
# ---------------------------------------------------------------------------

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

kill: ## Kill the running app (including zombie Xcode debug processes)
	@# Kill any Xcode debugserver instances attached to our app — these can leave
	@# zombie processes in TX (traced/stopped) state that block extension loading.
	@for pid in $$(ps -eo pid,ppid,comm 2>/dev/null | grep debugserver | awk '{print $$1}'); do \
		child=$$(ps -eo pid,ppid,comm 2>/dev/null | awk -v ppid="$$pid" '$$2 == ppid && /$(APP_NAME)/ {print $$1}'); \
		if [ -n "$$child" ]; then \
			kill -9 $$pid 2>/dev/null && echo "Killed debugserver ($$pid) holding zombie app ($$child)"; \
			sleep 0.5; \
			kill -9 $$child 2>/dev/null; \
		fi; \
	done
	@pkill -f "$(APP_NAME).app/Contents/MacOS" 2>/dev/null && echo "Killed $(APP_NAME)" || true

# ---------------------------------------------------------------------------
# Extension reload (no Safari restart — preserves Allow Unsigned Extensions)
# ---------------------------------------------------------------------------

reload-ext: ## Activate Safari and navigate to trigger extension load (NO pluginkit!)
	@echo "Activating Safari to load extension..."
	@# IMPORTANT: Do NOT use pluginkit -e ignore/use here!
	@# pluginkit toggling poisons browser.tabs.query and executeScript permissions,
	@# requiring a full Safari restart + re-enable to recover. The app relaunch
	@# (kill + run) already registers the updated .appex with Safari.
	@if pgrep -x Safari >/dev/null 2>&1; then \
		osascript -e 'tell application "Safari" to activate' 2>/dev/null || true; \
		sleep 0.5; \
		osascript -e 'tell application "Safari" to open location "https://example.com"' 2>/dev/null || true; \
		sleep 2; \
	else \
		open -a Safari; \
		sleep 3; \
		osascript -e 'tell application "Safari" to open location "https://example.com"' 2>/dev/null || true; \
		sleep 2; \
	fi
	@echo "Extension activated"

# ---------------------------------------------------------------------------
# Safari lifecycle (nuclear option — resets Allow Unsigned Extensions!)
# ---------------------------------------------------------------------------

safari-restart: safari-quit safari-open ## Quit + reopen Safari (resets Allow Unsigned Extensions!)
	@echo ""
	@echo "WARNING: 'Allow Unsigned Extensions' was reset by the Safari restart."
	@echo "  -> Safari > Develop > Allow Unsigned Extensions"
	@echo "  -> Then run: make health"

safari-quit: ## Quit Safari (tabs are preserved on restart)
	@if pgrep -x Safari >/dev/null 2>&1; then \
		echo "Quitting Safari..."; \
		osascript -e 'tell application "Safari" to quit' 2>/dev/null || true; \
		for i in 1 2 3 4 5 6 7 8 9 10 11 12; do \
			pgrep -x Safari >/dev/null 2>&1 || break; \
			sleep 0.5; \
		done; \
		if pgrep -x Safari >/dev/null 2>&1; then \
			echo "WARNING: Safari did not quit cleanly after 6s"; \
		else \
			echo "Safari quit"; \
		fi; \
	fi

safari-open: ## Open Safari and navigate to a page (triggers extension load)
	@echo "Opening Safari..."
	@open -a Safari
	@sleep 3
	@osascript -e 'tell application "Safari" to open location "https://example.com"' 2>/dev/null || true
	@sleep 2
	@echo "Safari opened"

# ---------------------------------------------------------------------------
# Queue management
# ---------------------------------------------------------------------------

queue-clean: ## Clear stale App Group queue and responses
	@echo '[]' > "$(APP_GROUP)/pending_requests.json" 2>/dev/null || true
	@find "$(APP_GROUP)/responses" -name "*.json" -delete 2>/dev/null || true
	@echo "Queue cleaned"

# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------

health: ## Verify extension is polling the App Group queue
	@echo "Checking extension health (up to 10s)..."
	@echo '["HEALTH_CHECK"]' > "$(APP_GROUP)/pending_requests.json"
	@healthy=false; \
	for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do \
		content=$$(cat "$(APP_GROUP)/pending_requests.json" 2>/dev/null); \
		if [ "$$content" = "[]" ] || [ -z "$$content" ]; then \
			healthy=true; \
			break; \
		fi; \
		sleep 0.5; \
	done; \
	if [ "$$healthy" = "true" ]; then \
		echo "Extension is healthy (polling active)"; \
	else \
		echo ""; \
		echo "*** Extension is NOT responding ***"; \
		echo ""; \
		echo "Checklist:"; \
		echo "  1. Safari > Develop > Allow Unsigned Extensions (resets every Safari launch!)"; \
		echo "  2. Safari > Settings > Extensions > Claude in Safari (must be enabled)"; \
		echo "  3. Toggle extension off/on in Safari Settings, then: make health"; \
		echo "  4. Nuclear option: make safari-restart (then re-enable Allow Unsigned Extensions)"; \
		echo ""; \
		echo "Run 'make doctor' for full diagnostics."; \
		echo '[]' > "$(APP_GROUP)/pending_requests.json" 2>/dev/null || true; \
		exit 1; \
	fi

# ---------------------------------------------------------------------------
# Diagnostics
# ---------------------------------------------------------------------------

doctor: ## Full diagnostic of all prerequisites and runtime state
	@echo "=== Build Tools ==="
	@which xcodebuild >/dev/null 2>&1 && echo "  [ok] xcodebuild" || echo "  [!!] xcodebuild not found"
	@which python3 >/dev/null 2>&1 && echo "  [ok] python3" || echo "  [!!] python3 not found"
	@which npm >/dev/null 2>&1 && echo "  [ok] npm" || echo "  [!!] npm not found"
	@echo ""
	@echo "=== Build State ==="
	@if [ -d "$(APP_PATH)" ]; then echo "  [ok] App: $(APP_PATH)"; else echo "  [!!] App not built (run: make build)"; fi
	@if [ -f "$(APP_PATH)/Contents/PlugIns/ClaudeInSafari Extension.appex/Contents/Resources/background.js" ]; then \
		echo "  [ok] Extension appex contains background.js"; \
	else \
		echo "  [!!] Extension appex missing background.js"; \
	fi
	@# Verify all manifest scripts exist in the build
	@missing=0; \
	for f in $$(python3 -c "import json; m=json.load(open('ClaudeInSafari Extension/Resources/manifest.json')); print(' '.join(m['background']['scripts']))" 2>/dev/null); do \
		built="$(APP_PATH)/Contents/PlugIns/ClaudeInSafari Extension.appex/Contents/Resources/$$f"; \
		if [ ! -f "$$built" ]; then \
			echo "  [!!] Missing in build: $$f"; \
			missing=1; \
		fi; \
	done; \
	if [ $$missing -eq 0 ]; then echo "  [ok] All background scripts present in build"; fi
	@# Verify source matches build
	@stale=0; \
	for f in $$(python3 -c "import json; m=json.load(open('ClaudeInSafari Extension/Resources/manifest.json')); print(' '.join(m['background']['scripts']))" 2>/dev/null); do \
		src="ClaudeInSafari Extension/Resources/$$f"; \
		built="$(APP_PATH)/Contents/PlugIns/ClaudeInSafari Extension.appex/Contents/Resources/$$f"; \
		if [ -f "$$src" ] && [ -f "$$built" ]; then \
			if ! diff -q "$$src" "$$built" >/dev/null 2>&1; then \
				echo "  [!!] Stale in build: $$f (source differs from built copy)"; \
				stale=1; \
			fi; \
		fi; \
	done; \
	if [ $$stale -eq 0 ]; then echo "  [ok] Build matches source"; fi
	@echo ""
	@echo "=== Runtime State ==="
	@ps aux | grep "$(APP_NAME).app/Contents/MacOS" | grep -v grep >/dev/null 2>&1 \
		&& echo "  [ok] Native app running" || echo "  [!!] Native app not running (run: make dev)"
	@if [ -S "$(DEV_SOCK)" ]; then echo "  [ok] Socket: $(DEV_SOCK)"; else echo "  [!!] Socket missing"; fi
	@pgrep -x Safari >/dev/null 2>&1 && echo "  [ok] Safari running" || echo "  [!!] Safari not running"
	@echo ""
	@echo "=== App Group ==="
	@if [ -d "$(APP_GROUP)" ]; then echo "  [ok] Container exists"; else echo "  [!!] Container missing"; fi
	@pending=$$(cat "$(APP_GROUP)/pending_requests.json" 2>/dev/null); \
	if [ "$$pending" = "[]" ] || [ -z "$$pending" ]; then \
		echo "  [ok] Queue empty"; \
	else \
		count=$$(echo "$$pending" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "?"); \
		echo "  [!!] Queue has $$count stale entries (run: make queue-clean)"; \
	fi
	@resp_count=$$(find "$(APP_GROUP)/responses" -name "*.json" 2>/dev/null | wc -l | tr -d ' '); \
	if [ "$$resp_count" -gt 0 ]; then \
		echo "  [!!] $$resp_count stale response files (run: make queue-clean)"; \
	else \
		echo "  [ok] No stale responses"; \
	fi
	@echo ""
	@echo "=== Extension Health ==="
	@echo '["HEALTH_CHECK"]' > "$(APP_GROUP)/pending_requests.json"
	@healthy=false; \
	for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do \
		content=$$(cat "$(APP_GROUP)/pending_requests.json" 2>/dev/null); \
		if [ "$$content" = "[]" ] || [ -z "$$content" ]; then \
			healthy=true; \
			break; \
		fi; \
		sleep 0.5; \
	done; \
	if [ "$$healthy" = "true" ]; then \
		echo "  [ok] Extension is polling"; \
	else \
		echo "  [!!] Extension is NOT polling"; \
		echo ""; \
		echo "  Fix:"; \
		echo "    1. Safari > Develop > Allow Unsigned Extensions (resets every Safari launch!)"; \
		echo "    2. Safari > Settings > Extensions > Claude in Safari (must be enabled)"; \
		echo "    3. Toggle extension off/on, then: make health"; \
		echo '[]' > "$(APP_GROUP)/pending_requests.json" 2>/dev/null || true; \
	fi

# ---------------------------------------------------------------------------
# Functional check (verifies executeScript permissions, not just queue polling)
# ---------------------------------------------------------------------------

functional-check: ## Verify a real tool call works (executeScript + tab access)
	@echo "Running functional check (read_page on active tab)..."
	@osascript -e 'tell application "Safari" to activate' 2>/dev/null; sleep 0.5
	@result=$$(python3 scripts/mcp-test.py call read_page '{}' 2>&1); \
	if echo "$$result" | grep -qi "error\|not found\|cannot access\|timed out"; then \
		echo ""; \
		echo "*** FUNCTIONAL CHECK FAILED ***"; \
		echo "$$result" | head -20; \
		echo ""; \
		echo "Extension can poll queue but cannot access tabs."; \
		echo "  1. Safari > Settings > Extensions > Claude in Safari > Website Access: All Websites"; \
		echo "  2. If that's already set, try: make safari-restart"; \
		exit 1; \
	elif echo "$$result" | grep -q "Viewport\|heading\|link\|generic\|button"; then \
		echo "Functional check passed (read_page returned accessibility tree)"; \
	else \
		echo ""; \
		echo "*** FUNCTIONAL CHECK INCONCLUSIVE ***"; \
		echo "$$result" | head -10; \
		echo ""; \
		echo "Could not parse response. Check manually."; \
		exit 1; \
	fi

# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

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

# ---------------------------------------------------------------------------
# Tool invocation
# ---------------------------------------------------------------------------

# Usage: make send TOOL=find ARGS='{"query":"Submit"}'
# Safari MV2 requires the app to be frontmost for executeScript to work.
# The osascript activation + brief pause ensures the permission grant is active.
TOOL ?= read_page
ARGS ?= {}
send: ## Send a tool call (TOOL=name ARGS='{}')
	@osascript -e 'tell application "Safari" to activate' 2>/dev/null; sleep 2; python3 scripts/mcp-test.py call $(TOOL) '$(ARGS)'

list-tools: ## List all registered MCP tools
	@python3 scripts/mcp-test.py list

# ---------------------------------------------------------------------------
# Status + cleanup
# ---------------------------------------------------------------------------

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
	@# IMPORTANT: Must run clean + build in one xcodebuild invocation.
	@# A standalone `xcodebuild clean` followed by a separate `xcodebuild build`
	@# produces an invalid app signature ("code has no resources but signature
	@# indicates they must be present"), causing pluginkit to silently drop the
	@# extension registration and the extension to disappear from Safari Settings.
	@xcodebuild clean build \
		-project $(PROJECT) \
		-scheme $(SCHEME) \
		-destination "$(DEST)" \
		-quiet 2>/dev/null || true
	@echo "Cleaned and rebuilt"
