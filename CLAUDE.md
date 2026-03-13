# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A VSCode/Cursor extension that displays Claude Code token usage in the status bar. It parses Claude Code's JSONL log files from `~/.claude/projects/` and shows real-time metrics: token count, usage %, cache status, and 5-hour session countdown.

## Build & Development

```bash
npm run compile    # Build TypeScript to dist/
npm run watch      # Watch mode for development
```

Output goes to `dist/`. To test, open this folder in VSCode/Cursor and press F5 to launch the Extension Development Host.

## Architecture

Two source files in `src/`:

- **extension.ts** — VSCode extension lifecycle. Activates on startup, creates a status bar item, polls for updates on a configurable interval, and watches `~/.claude/projects/` for file changes via chokidar (with Windows polling). Reads two settings from `claudeCounter.*` configuration: `contextWindow` (default 200k) and `refreshIntervalSeconds` (default 3). Tooltip shows token breakdown: context (latest request) and output (cumulative).

- **parser.ts** — Incrementally parses Claude Code JSONL log files. Three-phase design:
  1. `parseFile()` — pure data loader. Reads new bytes, deduplicates by `requestId` (streaming produces multiple entries per API call with cumulative values), populates `stateMap`. No pruning or aggregation.
  2. `computeWindowStart()` — session gap detection. Sorts all entry timestamps chronologically and walks them: any gap > 5h means a new session started. Returns the true current window start.
  3. `parseActiveSessions()` — orchestrator. Calls `parseFile()` for each file, determines the window start via `computeWindowStart()`, filters entries to the detected window, and aggregates into a `SessionMetrics` object.

## Key Details

- Log file discovery: scans all subdirectories of `~/.claude/projects/` for `.jsonl` files modified within the last 5 hours.
- Token metric: cumulative `output_tokens` across all deduplicated requests in the detected session window. Output tokens are the primary rate-limit driver (highest API cost weight). Cache read tokens are explicitly excluded from API rate limits per Anthropic docs. The `contextWindow` setting (default 200k) represents the user's estimated output token budget — users should calibrate based on when they hit their actual rate limit.
- Message count: total deduplicated API calls (`requestId`s) across all session files in the window. Shown in tooltip as "Messages sent".
- Streaming deduplication: a single API call produces multiple JSONL entries (one per content block during streaming), all sharing the same `requestId`. Only the last entry per `requestId` is kept since values are cumulative.
- The `input_tokens` field in logs is typically very small (1-3); the real input is in the cache fields (`cache_read_input_tokens`, `cache_creation_input_tokens`).
- Token progress thresholds: >85% shows error color, >65% shows warning color.
- Cache is considered "active" if a cache read/creation event occurred within the last 5 minutes.
- Window model: uses session gap detection to find the true window start. Walks all entries chronologically; any gap > 5h indicates a new session. The "Reset in" timer counts down from `windowStart + 5h`. On expiry, `stateMap` is fully cleared (including byte offsets) so files are re-parsed from scratch for the next window. During a window, counts only go up — no rolling pruning.
- Active session count uses a 10-minute activity threshold, not file mtime.
- Synthetic entries (model: `<synthetic>`) are filtered out of model name tracking.
- The extension entry point is `dist/extension.js` (CommonJS, ES2020 target).
