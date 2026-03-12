# Claude Code Usage Tracker

A lightweight VSCode/Cursor extension that displays real-time Claude Code token usage directly in your status bar.

## Features

- **Token count** — Shows current conversation token usage (e.g. `142.5k`)
- **Context window %** — How full your context window is, with color-coded warnings (yellow >65%, red >85%)
- **Cache status** — Whether prompt caching is active and time remaining on the 5-minute cache window
- **Session countdown** — Time remaining in your 5-hour Claude Code session


![alt text](<Claude Code Token Usage Tracker.png>)


## How It Works

The extension reads Claude Code's JSONL log files from `~/.claude/projects/`, finds recently modified logs, and parses token usage data from them. All metrics are scoped to a rolling 5-hour window — token counts, the session timer, and active session detection automatically reset as log entries age out of the window. Updates happen both on a polling interval and via file system watching for near-instant feedback.

- **Token count** only includes usage from the last 5 hours. Once entries fall outside the window, they are pruned and no longer count.
- **Active sessions** counts log files with activity in the last 10 minutes, reflecting actually running Claude Code instances rather than all files touched in the last 5 hours.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `claudeCounter.contextWindow` | `200000` | Context window size in tokens. All current Claude models (Opus, Sonnet, Haiku) use a 200k context window. |
| `claudeCounter.refreshIntervalSeconds` | `3` | How often the status bar refreshes (in seconds). |

## Installation

### From VSIX

1. Download the `.vsix` file
2. In VSCode/Cursor: `Extensions` > `...` > `Install from VSIX...`

### From Source

```bash
git clone <repo-url>
cd claude-counter-statusbar
npm install
npm run compile
```

Then press **F5** to launch the Extension Development Host for testing.

## Requirements

- VSCode ^1.85.0 or Cursor
- Claude Code must be installed and have been used at least once (so log files exist in `~/.claude/projects/`)
