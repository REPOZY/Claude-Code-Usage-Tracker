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
  contextDisplay: string;
  outputDisplay: string;
  cacheReadDisplay: string;
  cacheCreationDisplay: string;
  inputTokensDisplay: string;
  messageCount: number;
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
 * No pruning or aggregation — that happens in parseActiveSessions.
 */
async function parseFile(filePath: string): Promise<void> {
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
  } catch {
    // skip files that can't be read
  }
}

/**
 * Determine the true window start by walking all entries chronologically.
 * Anthropic's rate limit resets every 5 hours from your first message.
 * If there's a gap > 5h between entries, the later entry starts a new window.
 * This correctly detects session boundaries after rate limit pauses.
 */
function computeWindowStart(allTimestamps: number[]): number {
  if (allTimestamps.length === 0) return 0;

  allTimestamps.sort((a, b) => a - b);

  let windowStart = allTimestamps[0];
  for (const ts of allTimestamps) {
    if (ts > windowStart + FIVE_HOURS_MS) {
      // This entry came after the previous window expired — new window
      windowStart = ts;
    }
  }

  return windowStart;
}

/**
 * Parse and aggregate all active log files within the 5-hour window.
 * Files should be sorted newest-first so the most recent model name wins.
 *
 * Token metric: cumulative output tokens across all sessions.
 * Output tokens are the primary driver of rate limits (5x cost vs input)
 * and cache read tokens are explicitly excluded from API rate limits.
 * Context info is shown separately in the tooltip for reference.
 */
export async function parseActiveSessions(filePaths: string[], contextWindow: number): Promise<SessionMetrics | null> {
  const now = Date.now();

  // Check if the fixed window has expired — clear everything and start fresh.
  // We clear the entire stateMap (including byte offsets) so that parseFile()
  // re-reads files from scratch and can discover entries for the new window.
  if (windowStartTimestamp > 0 && now > windowStartTimestamp + FIVE_HOURS_MS) {
    stateMap.clear();
    windowStartTimestamp = 0;
  }

  // Phase 1: Parse all files (incremental loading only, no pruning)
  for (const fp of filePaths) {
    await parseFile(fp);
  }

  // Clean up stale entries from the state map
  const activeSet = new Set(filePaths);
  for (const key of stateMap.keys()) {
    if (!activeSet.has(key)) {
      stateMap.delete(key);
    }
  }

  // Phase 2: Determine true window start if not yet established
  if (windowStartTimestamp === 0) {
    const allTimestamps: number[] = [];
    for (const state of stateMap.values()) {
      for (const entry of state.requestEntries.values()) {
        allTimestamps.push(entry.timestamp);
      }
    }

    if (allTimestamps.length === 0) return null;

    windowStartTimestamp = computeWindowStart(allTimestamps);
  }

  // Phase 3: Aggregate from stateMap, counting only entries within the current window
  const windowEnd = windowStartTimestamp + FIVE_HOURS_MS;

  let totalOutput = 0;
  let totalMessages = 0;
  let latestRequestTimestamp = 0;
  let latestInputTokens = 0;
  let latestCacheRead = 0;
  let latestCacheCreation = 0;
  let lastCacheEvent = 0;
  let latestModel = '';
  let activeSessionCount = 0;
  let hasData = false;

  for (const state of stateMap.values()) {
    let fileLatestEntryTs = 0;
    let fileHasWindowEntries = false;

    for (const entry of state.requestEntries.values()) {
      // Only count entries within the current window
      if (entry.timestamp < windowStartTimestamp || entry.timestamp > windowEnd) {
        continue;
      }

      fileHasWindowEntries = true;
      totalOutput += entry.outputTokens;
      totalMessages++;

      if (entry.timestamp > latestRequestTimestamp) {
        latestRequestTimestamp = entry.timestamp;
        latestInputTokens = entry.inputTokens;
        latestCacheRead = entry.cacheReadTokens;
        latestCacheCreation = entry.cacheCreationTokens;
      }
      if (entry.timestamp > fileLatestEntryTs) {
        fileLatestEntryTs = entry.timestamp;
      }
    }

    if (fileHasWindowEntries) {
      hasData = true;

      // Count as active session if there was activity in the last 10 minutes
      if (fileLatestEntryTs > 0 && (now - fileLatestEntryTs) < ACTIVE_SESSION_THRESHOLD_MS) {
        activeSessionCount++;
      }

      for (const ce of state.cacheEvents) {
        if (ce.timestamp >= windowStartTimestamp && ce.timestamp <= windowEnd && ce.timestamp > lastCacheEvent) {
          lastCacheEvent = ce.timestamp;
        }
      }

      if (!latestModel && state.latestModel) {
        latestModel = state.latestModel;
      }
    }
  }

  if (!hasData) return null;

  // Primary metric: cumulative output tokens
  const latestFullInput = latestInputTokens + latestCacheRead + latestCacheCreation;
  const remainingMs = Math.max(0, windowEnd - now);
  const progress = Math.min(Math.round((totalOutput / contextWindow) * 100), 100);

  const cacheAgeMs = lastCacheEvent > 0 ? now - lastCacheEvent : Infinity;
  const cacheActive = cacheAgeMs < CACHE_TTL_MS;
  const cacheStr = cacheActive
    ? `Cache: ${Math.floor((CACHE_TTL_MS - cacheAgeMs) / 60000)}m`
    : 'Cache: inactive';

  return {
    tokensDisplay: (totalOutput / 1000).toFixed(1),
    progress,
    cache: cacheStr,
    sessionRemaining: formatTime(remainingMs),
    model: latestModel ? formatModelName(latestModel) : 'Unknown',
    activeSessionCount,
    contextDisplay: formatTokenCount(latestFullInput),
    outputDisplay: formatTokenCount(totalOutput),
    cacheReadDisplay: formatTokenCount(latestCacheRead),
    cacheCreationDisplay: formatTokenCount(latestCacheCreation),
    inputTokensDisplay: formatTokenCount(latestInputTokens),
    messageCount: totalMessages,
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
