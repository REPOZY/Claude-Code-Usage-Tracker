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

- **parser.ts** — Incrementally parses Claude Code JSONL log files. Deduplicates entries by `requestId` to avoid counting streaming chunks multiple times (Claude Code logs multiple lines per API call during streaming, each with cumulative token values). Uses a fixed 5-hour window (from earliest entry) that fully resets when expired, matching Anthropic's rate limit behavior. Returns a `SessionMetrics` object.

## Key Details

- Log file discovery: scans all subdirectories of `~/.claude/projects/` for `.jsonl` files modified within the last 5 hours.
- Token metric: cumulative `output_tokens` across all deduplicated requests in the 5h window. Output tokens are the primary rate-limit driver (highest API cost weight). Cache read tokens are explicitly excluded from API rate limits per Anthropic docs. The `contextWindow` setting (default 200k) represents the user's estimated output token budget — users should calibrate based on when they hit their actual rate limit.
- Message count: total deduplicated API calls (`requestId`s) across all session files in the 5h window. Shown in tooltip as "Messages sent".
- Streaming deduplication: a single API call produces multiple JSONL entries (one per content block during streaming), all sharing the same `requestId`. Only the last entry per `requestId` is kept since values are cumulative.
- The `input_tokens` field in logs is typically very small (1-3); the real input is in the cache fields (`cache_read_input_tokens`, `cache_creation_input_tokens`).
- Token progress thresholds: >85% shows error color, >65% shows warning color.
- Cache is considered "active" if a cache read/creation event occurred within the last 5 minutes.
- Window model: uses a fixed 5-hour window starting from the earliest tracked entry. When `now > windowStart + 5h`, all data clears and the extension shows "waiting" until new activity. This means the "Reset in" timer counts down to a fixed point and the display cleanly resets to zero when it expires.
- Active session count uses a 10-minute activity threshold, not file mtime.
- Synthetic entries (model: `<synthetic>`) are filtered out of model name tracking.
- The extension entry point is `dist/extension.js` (CommonJS, ES2020 target).
