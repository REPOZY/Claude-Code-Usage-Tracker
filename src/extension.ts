import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as chokidar from 'chokidar';
import { parseActiveSessions, resetParseState } from './parser';

const HOME = process.env.USERPROFILE || process.env.HOME || '';
const CLAUDE_DIR = path.join(HOME, '.claude', 'projects');
const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;

let statusBarItem: vscode.StatusBarItem;
let watcher: chokidar.FSWatcher | null = null;

/**
 * Find all .jsonl log files modified within the last 5 hours.
 * Returns paths sorted newest-first.
 */
async function findActiveLogFiles(): Promise<string[]> {
  try {
    await fs.promises.access(CLAUDE_DIR);
  } catch {
    return [];
  }

  const cutoff = Date.now() - FIVE_HOURS_MS;
  const files: { path: string; mtime: number }[] = [];

  const scan = async (dir: string) => {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await scan(fullPath);
      } else if (entry.name.endsWith('.jsonl')) {
        try {
          const stat = await fs.promises.stat(fullPath);
          if (stat.mtimeMs > cutoff) {
            files.push({ path: fullPath, mtime: stat.mtimeMs });
          }
        } catch {
          // skip inaccessible files
        }
      }
    }
  };

  try {
    await scan(CLAUDE_DIR);
  } catch {
    return [];
  }

  files.sort((a, b) => b.mtime - a.mtime);
  return files.map(f => f.path);
}

export function activate(context: vscode.ExtensionContext) {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  let contextWindow = vscode.workspace.getConfiguration('claudeCounter').get<number>('contextWindow', 200000);
  let refreshMs = vscode.workspace.getConfiguration('claudeCounter').get<number>('refreshIntervalSeconds', 3) * 1000;
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let updatePending = false;

  const updateStatusBar = async () => {
    if (updatePending) return;
    updatePending = true;
    try {
      const activeFiles = await findActiveLogFiles();

      if (activeFiles.length === 0) {
        statusBarItem.text = '$(spark) Claude: waiting...';
        statusBarItem.color = undefined;
        return;
      }

      const metrics = await parseActiveSessions(activeFiles, contextWindow);
      if (!metrics) {
        statusBarItem.text = '$(spark) Claude: waiting...';
        statusBarItem.color = undefined;
        return;
      }

      const progress = metrics.progress;
      if (progress > 85) {
        statusBarItem.color = new vscode.ThemeColor('errorForeground');
      } else if (progress > 65) {
        statusBarItem.color = new vscode.ThemeColor('warningForeground');
      } else {
        statusBarItem.color = '#b8b8b8';
      }

      const barLength = 10;
      const filled = Math.round((progress / 100) * barLength);
      const bar = '\u25A0'.repeat(filled) + '\u25A1'.repeat(barLength - filled);

      statusBarItem.text = `$(spark) ${metrics.tokensDisplay}k ${bar} ${metrics.progress}% • Reset in ${metrics.sessionRemaining}`;

      statusBarItem.tooltip = new vscode.MarkdownString(
        `**Claude Counter**\n\n` +
        `Model: ${metrics.model}\n\n` +
        `Output tokens: ${metrics.tokensDisplay}k / ${(contextWindow / 1000).toFixed(0)}k (${metrics.progress}%)\n\n` +
        `Messages sent: ${metrics.messageCount} (5h window)\n\n` +
        `Context (latest): ${metrics.contextDisplay} (input: ${metrics.inputTokensDisplay} + cache read: ${metrics.cacheReadDisplay} + cache write: ${metrics.cacheCreationDisplay})\n\n` +
        `Active sessions: ${metrics.activeSessionCount} | ${metrics.cache}\n\n` +
        `Resets in: ${metrics.sessionRemaining}`
      );
    } finally {
      updatePending = false;
    }
  };

  const startInterval = () => {
    if (intervalId !== null) clearInterval(intervalId);
    intervalId = setInterval(updateStatusBar, refreshMs);
  };

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('claudeCounter')) {
        contextWindow = vscode.workspace.getConfiguration('claudeCounter').get<number>('contextWindow', 200000);
        refreshMs = vscode.workspace.getConfiguration('claudeCounter').get<number>('refreshIntervalSeconds', 3) * 1000;
        resetParseState();
        startInterval();
        updateStatusBar();
      }
    })
  );

  updateStatusBar();
  startInterval();
  context.subscriptions.push({ dispose: () => { if (intervalId !== null) clearInterval(intervalId); } });

  try {
    if (fs.existsSync(CLAUDE_DIR)) {
      watcher = chokidar.watch(CLAUDE_DIR, {
        ignoreInitial: true,
        persistent: true,
        usePolling: true,
        interval: 2000,
        depth: 10
      });
      watcher.on('change', updateStatusBar);
      watcher.on('add', updateStatusBar);
      context.subscriptions.push({ dispose: () => watcher?.close() });
    }
  } catch {
    // watcher is optional — interval polling is the fallback
  }
}

export function deactivate() {
  if (watcher) watcher.close();
}
