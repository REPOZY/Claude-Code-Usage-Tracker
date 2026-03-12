import * as fs from 'fs';

interface UsageData {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface SessionMetrics {
  tokensDisplay: string;
  progress: number;
  cache: string;
  sessionRemaining: string;
  model: string;
  activeSessionCount: number;
}

interface TokenEntry {
  timestamp: number;
  inputTokens: number;
  outputTokens: number;
}

interface CacheEvent {
  timestamp: number;
}

// Per-file incremental parse state
interface ParseState {
  byteOffset: number;
  entries: TokenEntry[];
  cacheEvents: CacheEvent[];
  latestModel: string;
}

// Raw data extracted from a single log file (within the 5h window)
interface FileData {
  totalOutputTokens: number;
  latestInputTokens: number;
  earliestTimestamp: number;
  lastCacheEvent: number;
  latestModel: string;
  latestEntryTimestamp: number;
}

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const ACTIVE_SESSION_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

// Map of file path → incremental parse state (survives across calls)
const stateMap = new Map<string, ParseState>();

export function resetParseState(): void {
  stateMap.clear();
}

/**
 * Incrementally parse a single JSONL log file.
 * Only reads newly appended bytes since the last call for this file.
 * Returns data filtered to the 5-hour window.
 */
async function parseFile(filePath: string): Promise<FileData | null> {
  try {
    const stat = await fs.promises.stat(filePath);
    let state = stateMap.get(filePath);

    // Reset if file was truncated (new session reusing same path)
    if (state && stat.size < state.byteOffset) {
      stateMap.delete(filePath);
      state = undefined;
    }

    if (!state) {
      state = {
        byteOffset: 0,
        entries: [],
        cacheEvents: [],
        latestModel: '',
      };
      stateMap.set(filePath, state);
    }

    // Parse only newly appended bytes
    if (stat.size > state.byteOffset) {
      const fd = await fs.promises.open(filePath, 'r');
      try {
        const readSize = stat.size - state.byteOffset;
        const buf = Buffer.alloc(readSize);
        await fd.read(buf, 0, readSize, state.byteOffset);

        const newContent = buf.toString('utf8');
        const endsComplete = newContent.endsWith('\n');
        const lines = newContent.split('\n');
        const parseCount = endsComplete ? lines.length : lines.length - 1;

        let bytesConsumed = 0;
        for (let i = 0; i < parseCount; i++) {
          bytesConsumed += Buffer.byteLength(lines[i], 'utf8') + 1;
          if (!lines[i].trim()) continue;
          try {
            const msg = JSON.parse(lines[i]);

            const ts = msg.timestamp ? new Date(msg.timestamp).getTime() : 0;

            const model = msg.model || msg.message?.model;
            if (model) {
              state.latestModel = model;
            }

            const usage: UsageData | undefined = msg.usage || msg.message?.usage;
            if (usage && ((usage.input_tokens || 0) > 0 || (usage.output_tokens || 0) > 0)) {
              state.entries.push({
                timestamp: ts || Date.now(),
                inputTokens: usage.input_tokens || 0,
                outputTokens: usage.output_tokens || 0,
              });
            }

            const cacheRead = usage?.cache_read_input_tokens || msg.cache_read_input_tokens || 0;
            const cacheCreation = usage?.cache_creation_input_tokens || msg.cache_creation_input_tokens || 0;
            if (cacheRead > 0 || cacheCreation > 0) {
              state.cacheEvents.push({ timestamp: ts || Date.now() });
            }
          } catch {
            // skip malformed lines
          }
        }

        state.byteOffset += bytesConsumed;
      } finally {
        await fd.close();
      }
    }

    // Prune entries older than 5 hours
    const cutoff = Date.now() - FIVE_HOURS_MS;
    state.entries = state.entries.filter(e => e.timestamp >= cutoff);
    state.cacheEvents = state.cacheEvents.filter(e => e.timestamp >= cutoff);

    if (state.entries.length === 0) {
      return null;
    }

    // Compute aggregated data from entries within the 5h window
    let totalOutputTokens = 0;
    let latestInputTokens = 0;
    let latestInputTimestamp = 0;
    let earliestTimestamp = Infinity;
    let latestEntryTimestamp = 0;

    for (const entry of state.entries) {
      totalOutputTokens += entry.outputTokens;

      if (entry.timestamp < earliestTimestamp) {
        earliestTimestamp = entry.timestamp;
      }
      if (entry.timestamp > latestEntryTimestamp) {
        latestEntryTimestamp = entry.timestamp;
      }

      // Track the most recent input token count (represents current context size)
      if (entry.inputTokens > 0 && entry.timestamp >= latestInputTimestamp) {
        latestInputTokens = entry.inputTokens;
        latestInputTimestamp = entry.timestamp;
      }
    }

    // Find the most recent cache event
    let lastCacheEvent = 0;
    for (const ce of state.cacheEvents) {
      if (ce.timestamp > lastCacheEvent) {
        lastCacheEvent = ce.timestamp;
      }
    }

    return {
      totalOutputTokens,
      latestInputTokens,
      earliestTimestamp: earliestTimestamp === Infinity ? 0 : earliestTimestamp,
      lastCacheEvent,
      latestModel: state.latestModel,
      latestEntryTimestamp,
    };
  } catch {
    return null;
  }
}

/**
 * Parse and aggregate all active log files within the 5-hour window.
 * Files should be sorted newest-first so the most recent model name wins.
 */
export async function parseActiveSessions(filePaths: string[], contextWindow: number): Promise<SessionMetrics | null> {
  const now = Date.now();

  let totalOutputTokens = 0;
  let latestInputTokens = 0;
  let earliestTimestamp = 0;
  let lastCacheEvent = 0;
  let latestModel = '';
  let hasData = false;
  let activeSessionCount = 0;

  for (const fp of filePaths) {
    const data = await parseFile(fp);
    if (!data) continue;

    hasData = true;

    totalOutputTokens += data.totalOutputTokens;

    // Use input tokens from the most recent file (first in sorted list)
    if (latestInputTokens === 0) {
      latestInputTokens = data.latestInputTokens;
    }

    if (earliestTimestamp === 0 || data.earliestTimestamp < earliestTimestamp) {
      earliestTimestamp = data.earliestTimestamp;
    }
    if (data.lastCacheEvent > lastCacheEvent) {
      lastCacheEvent = data.lastCacheEvent;
    }
    if (!latestModel && data.latestModel) {
      latestModel = data.latestModel;
    }

    // Count as active session if there was activity in the last 10 minutes
    if (data.latestEntryTimestamp > 0 && (now - data.latestEntryTimestamp) < ACTIVE_SESSION_THRESHOLD_MS) {
      activeSessionCount++;
    }
  }

  if (!hasData) return null;

  // Clean up stale entries from the state map
  const activeSet = new Set(filePaths);
  for (const key of stateMap.keys()) {
    if (!activeSet.has(key)) {
      stateMap.delete(key);
    }
  }

  const totalTokens = latestInputTokens + totalOutputTokens;
  const sessionAgeMs = earliestTimestamp > 0 ? now - earliestTimestamp : 0;
  const remainingMs = Math.max(0, FIVE_HOURS_MS - sessionAgeMs);
  const progress = Math.min(Math.round((totalTokens / contextWindow) * 100), 100);

  const cacheAgeMs = lastCacheEvent > 0 ? now - lastCacheEvent : Infinity;
  const cacheActive = cacheAgeMs < CACHE_TTL_MS;
  const cacheStr = cacheActive
    ? `Cache: ${Math.floor((CACHE_TTL_MS - cacheAgeMs) / 60000)}m`
    : 'Cache: inactive';

  return {
    tokensDisplay: (totalTokens / 1000).toFixed(1),
    progress,
    cache: cacheStr,
    sessionRemaining: earliestTimestamp > 0 ? formatTime(remainingMs) : 'unknown',
    model: latestModel ? formatModelName(latestModel) : 'Unknown',
    activeSessionCount,
  };
}

function formatModelName(model: string): string {
  if (model.includes('opus')) return 'Opus';
  if (model.includes('sonnet')) return 'Sonnet';
  if (model.includes('haiku')) return 'Haiku';
  return model.replace('claude-', '').split('-').slice(0, 2).join(' ');
}

function formatTime(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h${m}m` : `${m}m`;
}
