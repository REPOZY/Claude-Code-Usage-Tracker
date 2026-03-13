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
  inputTokensDisplay: string;
  outputTokensDisplay: string;
  cacheReadDisplay: string;
  cacheCreationDisplay: string;
}

interface TokenEntry {
  timestamp: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

interface CacheEvent {
  timestamp: number;
}

// Per-file incremental parse state
interface ParseState {
  byteOffset: number;
  // Deduplicated by requestId — only the final entry per API call is kept
  // (streaming produces multiple log lines per request with cumulative values)
  requestEntries: Map<string, TokenEntry>;
  cacheEvents: CacheEvent[];
  latestModel: string;
}

// Raw data extracted from a single log file (within the 5h window)
interface FileData {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
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

// Fixed window start: persists across updates until the window expires.
// This ensures the "Reset in" timer counts down to a fixed point and
// doesn't shift forward as entries age out.
let windowStartTimestamp = 0;

export function resetParseState(): void {
  stateMap.clear();
  windowStartTimestamp = 0;
}

/**
 * Incrementally parse a single JSONL log file.
 * Only reads newly appended bytes since the last call for this file.
 * Deduplicates by requestId to avoid counting streaming chunks multiple times.
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
        requestEntries: new Map(),
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
            if (model && model !== '<synthetic>') {
              state.latestModel = model;
            }

            const usage: UsageData | undefined = msg.usage || msg.message?.usage;
            const requestId: string | undefined = msg.requestId;

            if (usage && requestId) {
              const inputTokens = usage.input_tokens || 0;
              const outputTokens = usage.output_tokens || 0;
              const cacheReadTokens = usage.cache_read_input_tokens || 0;
              const cacheCreationTokens = usage.cache_creation_input_tokens || 0;

              if (inputTokens > 0 || outputTokens > 0 || cacheReadTokens > 0 || cacheCreationTokens > 0) {
                // Overwrite previous entry for same requestId: streaming chunks
                // have cumulative values, so the last one is the final total
                state.requestEntries.set(requestId, {
                  timestamp: ts || Date.now(),
                  inputTokens,
                  outputTokens,
                  cacheReadTokens,
                  cacheCreationTokens,
                });
              }

              if (cacheReadTokens > 0 || cacheCreationTokens > 0) {
                state.cacheEvents.push({ timestamp: ts || Date.now() });
              }
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

    // Prune entries older than 5 hours (memory housekeeping)
    const cutoff = Date.now() - FIVE_HOURS_MS;
    for (const [reqId, entry] of state.requestEntries) {
      if (entry.timestamp < cutoff) {
        state.requestEntries.delete(reqId);
      }
    }
    state.cacheEvents = state.cacheEvents.filter(e => e.timestamp >= cutoff);

    if (state.requestEntries.size === 0) {
      return null;
    }

    // Aggregate data from all deduplicated entries
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCacheCreationTokens = 0;
    let earliestTimestamp = Infinity;
    let latestEntryTimestamp = 0;

    for (const entry of state.requestEntries.values()) {
      totalInputTokens += entry.inputTokens;
      totalOutputTokens += entry.outputTokens;
      totalCacheReadTokens += entry.cacheReadTokens;
      totalCacheCreationTokens += entry.cacheCreationTokens;

      if (entry.timestamp < earliestTimestamp) {
        earliestTimestamp = entry.timestamp;
      }
      if (entry.timestamp > latestEntryTimestamp) {
        latestEntryTimestamp = entry.timestamp;
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
      totalInputTokens,
      totalOutputTokens,
      totalCacheReadTokens,
      totalCacheCreationTokens,
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

  // Check if the fixed window has expired — clear everything and start fresh
  if (windowStartTimestamp > 0 && now > windowStartTimestamp + FIVE_HOURS_MS) {
    for (const state of stateMap.values()) {
      state.requestEntries.clear();
      state.cacheEvents = [];
    }
    windowStartTimestamp = 0;
  }

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheCreationTokens = 0;
  let earliestTimestamp = 0;
  let lastCacheEvent = 0;
  let latestModel = '';
  let hasData = false;
  let activeSessionCount = 0;

  for (const fp of filePaths) {
    const data = await parseFile(fp);
    if (!data) continue;

    hasData = true;

    totalInputTokens += data.totalInputTokens;
    totalOutputTokens += data.totalOutputTokens;
    totalCacheReadTokens += data.totalCacheReadTokens;
    totalCacheCreationTokens += data.totalCacheCreationTokens;

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

  // Establish the fixed window start on first data
  if (windowStartTimestamp === 0) {
    windowStartTimestamp = earliestTimestamp;
  }

  // Clean up stale entries from the state map
  const activeSet = new Set(filePaths);
  for (const key of stateMap.keys()) {
    if (!activeSet.has(key)) {
      stateMap.delete(key);
    }
  }

  // Total tokens: all input types + output
  const totalTokens = totalInputTokens + totalCacheReadTokens + totalCacheCreationTokens + totalOutputTokens;

  // Timer counts down from the fixed window start + 5h
  const windowEndMs = windowStartTimestamp + FIVE_HOURS_MS;
  const remainingMs = Math.max(0, windowEndMs - now);
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
    sessionRemaining: formatTime(remainingMs),
    model: latestModel ? formatModelName(latestModel) : 'Unknown',
    activeSessionCount,
    inputTokensDisplay: formatTokenCount(totalInputTokens),
    outputTokensDisplay: formatTokenCount(totalOutputTokens),
    cacheReadDisplay: formatTokenCount(totalCacheReadTokens),
    cacheCreationDisplay: formatTokenCount(totalCacheCreationTokens),
  };
}

function formatModelName(model: string): string {
  if (model.includes('opus')) return 'Opus';
  if (model.includes('sonnet')) return 'Sonnet';
  if (model.includes('haiku')) return 'Haiku';
  return model.replace('claude-', '').split('-').slice(0, 2).join(' ');
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1000000) return (tokens / 1000000).toFixed(1) + 'M';
  if (tokens >= 1000) return (tokens / 1000).toFixed(1) + 'k';
  return tokens.toString();
}

function formatTime(ms: number): string {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h${m}m` : `${m}m`;
}
