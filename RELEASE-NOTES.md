# Release Notes

## v1.0.0 — Accurate Session Window Detection

### What Changed

The core session window logic has been completely rewritten to accurately detect when your 5-hour rate limit window actually started.

### The Problem

Previously, the extension used a rolling 5-hour cutoff to prune old log entries. This caused two visible bugs:

1. **Token counts and message counts would gradually decrease** on their own — entries were silently removed one-by-one as they aged past 5 hours, even mid-session.
2. **"Reset in" timer was inaccurate** — it was anchored to the oldest surviving entry after rolling pruning, not the true session start. This produced values like "Reset in 0m" when the real window had hours remaining.

### The Fix

The parser now uses **session gap detection** to find the true window start:

- All log entries across all projects are collected and sorted chronologically.
- The algorithm walks through them and detects gaps longer than 5 hours (e.g. after hitting a rate limit and waiting for it to reset).
- The first message after such a gap is recognized as the start of the current session window.
- Only entries within that detected window are counted.

This means:

- Token counts and message counts **only go up** during a session — no more mysterious decreases.
- The "Reset in" timer accurately counts down from the true session start.
- When the window expires, all counters reset to zero simultaneously.

### Architecture Changes

- `parseFile()` is now a pure data loader — it reads new bytes and populates `stateMap` with no pruning or aggregation.
- `computeWindowStart()` is a new function that implements the gap detection algorithm.
- All pruning and aggregation now happens in `parseActiveSessions()`, which filters entries to the detected window before computing metrics.
- On window expiry, `stateMap` is fully cleared (including byte offsets), forcing a complete re-parse so entries from the new window are properly discovered.

### Upgrade

No settings changes required. Install the new `.vsix` and reload your IDE.
