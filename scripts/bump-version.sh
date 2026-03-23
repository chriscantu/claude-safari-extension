#!/bin/bash
set -euo pipefail

BUMP="${1:?Usage: bump-version.sh <major|minor|patch>}"
APP_PLIST="ClaudeInSafari/Info.plist"
EXT_PLIST="ClaudeInSafari Extension/Info.plist"

# Read current version
CURRENT=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$APP_PLIST")
BUILD=$(/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" "$APP_PLIST")

IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"

case "$BUMP" in
    major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
    minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
    patch) PATCH=$((PATCH + 1)) ;;
    *) echo "Error: argument must be major, minor, or patch"; exit 1 ;;
esac

NEW_VERSION="${MAJOR}.${MINOR}.${PATCH}"
NEW_BUILD=$((BUILD + 1))

# Update both plists
for PLIST in "$APP_PLIST" "$EXT_PLIST"; do
    /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $NEW_VERSION" "$PLIST"
    /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $NEW_BUILD" "$PLIST"
done

# Update manifest.json
MANIFEST="ClaudeInSafari Extension/Resources/manifest.json"
sed -i '' "s/\"version\": \"$CURRENT\"/\"version\": \"$NEW_VERSION\"/" "$MANIFEST"

# Update project.yml (both occurrences)
sed -i '' "s/CFBundleShortVersionString: \"$CURRENT\"/CFBundleShortVersionString: \"$NEW_VERSION\"/" project.yml

echo "$NEW_VERSION"
