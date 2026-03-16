# Onboarding UI Design — Claude in Safari

**Date:** 2026-03-16
**Status:** Approved
**Phase:** 7 — Polish & Distribution

---

## Overview

A first-run onboarding flow and persistent menu bar presence for Claude in Safari. The app is a bridge that connects Claude Code to Safari — not Claude itself — and the UI must communicate that relationship clearly while guiding power users through the required system setup with minimal friction.

---

## Target User

Power users comfortable with macOS Settings but not the terminal. The same audience as the Claude Chrome extension: product managers, marketers, and tech-forward enthusiasts who use Claude regularly and aren't afraid of a Settings panel, but won't read a README.

---

## App Presence Model

**Menu bar app** (`LSUIElement = true`). The app lives in the menu bar like Dropbox or 1Password — always visible, never in the Dock. A robot icon with a status dot is the persistent UI artifact.

### Icon System

All icons use **white on Claude orange (`#d97757`)** exclusively — no other colors. The robot icon uses the orange background-cutout technique for the eyes (same as the camera lens detail), so the design stays strictly two-color.

**Robot SVG** (used at all sizes):
- White head, antenna, body, arms
- Orange eyes (= background reveals through, no extra color needed)
- Context-aware eye fill: orange on orange containers, dark on dark menu bar pill

### Menu Bar Icon States

| State | Appearance |
|-------|-----------|
| Connected | White robot + green dot |
| Needs Attention | White robot + yellow dot |
| Not Connected | White robot (dimmed) + red dot |

The "white + orange only" rule applies to the robot icon and all step icon containers. The status dots (green / yellow / red) are explicitly exempted — they are system semantic colors that users recognize across all macOS apps to mean "good / warning / error." Using brand orange for all three would destroy their meaning.

---

## Onboarding Flow

### First-Launch Detection

On every app launch, check whether all three permissions are already granted and the extension is enabled. If all pass, skip onboarding entirely (reinstall / update path). If any fail, show onboarding starting at the first incomplete step. Detection uses the same APIs as the polling table below.

First-launch state is **not** stored in `UserDefaults` — permission state is ground truth. This means onboarding re-appears after a reinstall only if permissions were actually revoked, which is the correct behavior.

### "I'll Set This Up Later" Behavior

Tapping this on the Welcome screen dismisses the window immediately. The menu bar icon appears in **Not Connected** (dimmed) state. The menu offers **"Open Setup"** as the primary action. On subsequent launches, onboarding re-appears automatically until all permissions are granted (same first-launch detection logic above).

### Timeline: 3 Segments, 5 Screens

The timeline strip shows 3 segments (one per permission step). It is **not shown** on the Welcome screen or the Done screen — those are entry and exit states, not steps. Segment states: pending (gray) → active (orange) → done (green ✓).

Shown automatically on first launch. Dismissed after all steps complete or via "I'll set this up later." Can be reopened from the menu via "Open Setup Again."

### Structure: Focused Step + Mini Timeline (Option C)

One step at a time with a 3-segment timeline strip at the bottom. Chosen per Apple HIG:
- **Progressive disclosure**: show only what's needed in the moment
- **Grouping by relevance**: the 3 Safari sub-steps share the same context (Safari Settings) and belong on one card
- **Avoid permission fatigue**: Apple explicitly warns against sequential individual permission requests

### Step Count: 3 (not 5)

The Safari extension requires 3 sub-steps (enable Develop menu, allow unsigned extensions, enable extension). These are presented as numbered instructions on a single card rather than 3 separate wizard steps. This keeps the timeline to 3 segments, which feels achievable before starting.

### Permission Detection: Auto + Manual Fallback

Per Apple HIG best practices:
- Each step **auto-detects** completion by polling the relevant API
- A **"I already did this →"** fallback button is always visible for the case where detection lags or the user completed a step before the app was watching
- A spinner with contextual text ("Watching for permission to be granted…") shows the app is actively monitoring

| Step | Detection API | Reliability |
|------|--------------|-------------|
| Safari Extension | `SFSafariExtensionManager.getStateOfSafariExtension()` | Fast async callback |
| Screen Recording | `CGPreflightScreenCaptureAccess()` polled at 500ms | Instant, synchronous |
| Accessibility | `AXIsProcessTrusted()` polled at 500ms | Instant, synchronous |

---

## Screen Inventory

### Screen 1 — Welcome

- Large robot icon (white SVG, 72×72px orange rounded rect)
- "Works with Claude Code" badge (orange tint)
- Headline: **"Connect Claude Code to Safari"**
- Body: bridge framing — "Claude in Safari is a bridge that gives Claude Code a real browser…"
- Duration hint: "Setup takes about 2 minutes."
- Primary CTA: **"Get Started →"** (Apple system blue)
- Secondary: "I'll set this up later" (ghost, gray)

### Screen 2 — Step 1: Safari Extension

- Puzzle piece icon (white SVG on orange)
- Title: **"Enable the Safari Extension"**
- Subtitle: "This is the part of the bridge that runs inside Safari."
- 3 numbered sub-steps (orange number circles):
  1. Safari → Settings → Advanced → "Show features for web developers"
  2. Develop menu → "Allow Unsigned Extensions"
  3. Safari → Settings → Extensions → toggle Claude in Safari on
- Detecting spinner (orange): "Watching for the extension to connect…"
- Primary CTA: **"Open Safari Settings"** (system blue — opens `safari-settings://` or `Safari.app`)
- Fallback: "I already did this →"
- Timeline strip: segment 1 active (orange), 2–3 pending (gray)

### Screen 3 — Step 2: Screen Recording

- Camera icon (white body, orange lens ring, white lens glass)
- Title: **"Allow Screen Recording"**
- Body: "Claude Code needs to see the browser to help you… Your screen is never stored or shared."
- Instruction box: path to System Settings → Screen Recording
- Detecting spinner: "Watching for permission to be granted…"
- Primary CTA: **"Open System Settings"** (opens `x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture`)
- Fallback: "I already did this →"
- Timeline: segment 1 done (green ✓), 2 active (orange), 3 pending

### Screen 4 — Step 3: Accessibility

- Accessibility person icon (white SVG on orange)
- Title: **"Allow Accessibility Access"**
- Body: "This lets Claude Code resize and position Safari's window… Used only for window management, nothing else."
- Instruction box: path to System Settings → Accessibility
- Detecting spinner: "Watching for permission to be granted…"
- Primary CTA: **"Open System Settings"** (opens `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`)
- Fallback: "I already did this →"
- Timeline: segments 1–2 done (green ✓), 3 active (orange)

### Screen 5 — Done

- Large orange checkmark icon (white stroke on orange rounded rect)
- Title: **"You're all set!"**
- Body: "Claude Code can now use Safari. Ask Claude to open a page, fill a form, or take a screenshot — it'll just work. Look for the robot icon in your menu bar whenever the connection is active."
- Primary CTA: **"Done"** (system blue) — closes window

---

## Menu Bar Click Menu

### Connected State

```
┌─────────────────────────────────────┐
│ [robot] Claude in Safari            │
│         Connected · Claude Code     │
│         can use Safari              │
├─────────────────────────────────────┤
│ 🔍  Check Connection                │
│ 🧭  Open Safari                     │
│ ⚙️  Open Setup Again                │
├─────────────────────────────────────┤
│     Quit                            │
└─────────────────────────────────────┘
```

### Needs Attention State

Triggered when a previously-granted permission is revoked (detected via the same polling mechanism used during setup, running continuously).

```
┌─────────────────────────────────────┐
│ [robot] Action Required             │ ← amber header
│         Screen Recording permission │
│         was removed                 │
├─────────────────────────────────────┤
│ 🔧  Fix This →                      │ ← orange, bold
├─────────────────────────────────────┤
│ 🧭  Open Safari                     │
├─────────────────────────────────────┤
│     Quit                            │
└─────────────────────────────────────┘
```

"Fix This →" re-enters the setup flow at the broken step.

---

## Branding & Visual Identity

| Element | Value |
|---------|-------|
| App name | Claude in Safari |
| Relationship framing | "bridge" / "Connect Claude Code to Safari" |
| Badge copy | "Works with Claude Code" |
| Primary brand color | `#d97757` (Claude / Anthropic orange) |
| Icon style | White SVG on orange rounded rect |
| App icon shape | Rounded rect, 20px corner radius (large), 16px (step icons) |
| System action buttons | Apple system blue (`#0071e3`) — HIG convention |
| Timeline active | `#d97757` |
| Timeline done | `#34c759` (system green) |
| Typography | SF Pro (system font, `-apple-system`) |

---

## Architecture Changes Required

| Change | File | Notes |
|--------|------|-------|
| `LSUIElement = true` | `Info.plist` | Removes Dock presence, enables menu bar |
| `NSStatusItem` setup | `AppDelegate.swift` | Menu bar icon + menu construction |
| `OnboardingWindowController` | New Swift file | Manages the 5-screen flow |
| Permission polling | New Swift file or `AppDelegate` extension | `AXIsProcessTrusted`, `CGPreflightScreenCaptureAccess`, `SFSafariExtensionManager` |
| Continuous permission monitoring | `AppDelegate` | Same APIs on a `Timer` with 5s interval (post-setup only — not during active onboarding which uses 500ms). Timer starts after Done screen is dismissed. Invalidated only on app quit. On state change → update `NSStatusItem` image and menu immediately. |
| `SFSafariExtensionManager` import | Target entitlements | Requires `com.apple.developer.safari-extension` entitlement — already present for the extension target; confirm it is also on the main app target before using `SFSafariExtensionManager` from `AppDelegate`. If unavailable (unsigned dev build), fall back to treating extension state as "unknown" and rely on the "I already did this →" manual path for step 1. |

---

## Out of Scope

- App Store / notarization (separate Phase 7 item)
- Notification permission onboarding (already requested at launch via existing `requestNotificationAuthorization()`; notification permission is not surfaced in the Needs Attention state — it is advisory-only and non-blocking)
- Claude Code CLI detection or version checking
- In-app help or documentation beyond the setup flow

## LSUIElement & Quit Path

Changing `LSUIElement` to `true` removes the app from `Cmd-Tab` and the Dock. The only quit path becomes **Quit** in the menu bar menu. This is intentional and consistent with other macOS menu bar utilities. The Quit item must always be visible in all menu states (Connected, Needs Attention, Not Connected).
