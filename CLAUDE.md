# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

A VSCode/Cursor extension that displays Claude Code token usage in the status bar. It parses Claude Code's JSONL log files from `~/.claude/projects/` and shows real-time metrics: token count, context window usage %, cache status, and 5-hour session countdown.

## Build & Development

```bash
npm run compile    # Build TypeScript to dist/
npm run watch      # Watch mode for development
```

Output goes to `dist/`. To test, open this folder in VSCode/Cursor and press F5 to launch the Extension Development Host.

## Architecture

Two source files in `src/`:

- **extension.ts** — VSCode extension lifecycle. Activates on startup, creates a status bar item, polls for updates on a configurable interval, and watches `~/.claude/projects/` for file changes via chokidar (with Windows polling). Reads two settings from `claudeCounter.*` configuration: `contextWindow` (default 200k) and `refreshIntervalSeconds` (default 3).

- **parser.ts** — Incrementally parses Claude Code JSONL log files. Stores timestamped token entries per file and prunes entries older than 5 hours on each update. `parseActiveSessions()` aggregates data across all active log files, computing total tokens (latest input + accumulated output within the 5h window), cache status (5-minute TTL), session countdown, and active session count (files with activity in the last 10 minutes). Returns a `SessionMetrics` object.

## Key Details

- Log file discovery: scans all subdirectories of `~/.claude/projects/` for `.jsonl` files modified within the last 5 hours.
- Token progress thresholds: >85% shows error color, >65% shows warning color.
- Cache is considered "active" if a cache read/creation event occurred within the last 5 minutes.
- All metrics (tokens, timer, sessions) are scoped to a rolling 5-hour window — entries older than 5h are automatically pruned from the in-memory state.
- Active session count uses a 10-minute activity threshold, not file mtime.
- The extension entry point is `dist/extension.js` (CommonJS, ES2020 target).
