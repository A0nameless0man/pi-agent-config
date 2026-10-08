import type { OVClient } from "./client.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { OVConfig } from "./config.js";
import { deriveHarnessSessionId } from "./shared/session-model.mjs";
import { enqueue, listPending, replayPending } from "./shared/pending-queue.mjs";
import { extractBranchCapturePayloads } from "./lib/capture-adapter.mjs";
import { countUndeliveredForSession, estimatePayloadTokens } from "./lib/takeover-core.mjs";

// --- SyncManager ---

export interface AddPayloadResult {
  accepted: boolean;
  delivered: boolean;
}

export interface SyncBranchResult {
  added: number;
  tokens: number;
  allDelivered: boolean;
}

function debugLog(message: string): void {
  const file = process.env.OV_DEBUG_LOG;
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Best effort; logging must never affect pi.
  }
}

export class SyncManager {
  private client: OVClient;
  private config: OVConfig;
  private ovSessionId: string | null = null;
  private syncedEntryCount = 0;

  constructor(client: OVClient, config: OVConfig) {
    this.client = client;
    this.config = config;
  }

  get sessionId(): string | null { return this.ovSessionId; }
  get syncedCount(): number { return this.syncedEntryCount; }

  restoreWatermark(n: number): void {
    const next = Math.max(0, Math.floor(Number(n) || 0));
    this.syncedEntryCount = next;
  }

  async ensureSession(piSessionId: string): Promise<boolean> {
    if (this.ovSessionId) return true;

    const id = deriveHarnessSessionId("pi-", piSessionId);
    this.ovSessionId = id;
    return true;
  }

  async replayPending(): Promise<void> {
    if (!this.client.connected) return;
    await replayPending(
      (path: string, init?: any) => this.client.fetchJSON(path, init, 10000),
      (stage: string, data: unknown) =>
        debugLog(`${stage}: ${JSON.stringify(data)}`),
    );
  }

  async flushForTakeover(): Promise<boolean> {
    if (!this.ovSessionId) return false;
    await this.replayPending();
    const pending = await listPending();
    return countUndeliveredForSession(pending, this.ovSessionId) === 0;
  }

  async syncBranch(branch: any[]): Promise<SyncBranchResult> {
    if (!this.ovSessionId) return { added: 0, tokens: 0, allDelivered: true };

    const extracted = extractBranchCapturePayloads(branch, this.syncedEntryCount, this.config);
    if (extracted.resetWatermark) this.syncedEntryCount = 0;
    let added = 0;
    let tokens = 0;
    let allDelivered = true;
    for (const payload of extracted.payloads) {
      const result = await this.addPayload(payload);
      if (!result.accepted) break;
      added++;
      tokens += estimatePayloadTokens(payload);
      allDelivered = allDelivered && result.delivered;
    }
    if (added === extracted.payloads.length) {
      this.syncedEntryCount = extracted.nextEntryCount;
    }
    if (added > 0 && !this.config.takeoverEnabled) {
      await this.commitIfNeeded();
    }
    return { added, tokens, allDelivered };
  }

  async addPayload(payload: any): Promise<AddPayloadResult> {
    if (!this.ovSessionId) return { accepted: false, delivered: false };
    const ok = await this.client.addMessagePayload(this.ovSessionId, payload);
    if (ok) return { accepted: true, delivered: true };
    await enqueue("addMessage", this.ovSessionId, payload);
    return { accepted: true, delivered: false };
  }

  /** Live pending-token count for this session, as the server reports it. */
  private async pendingTokens(): Promise<number> {
    if (!this.ovSessionId) return 0;
    const meta = await this.client.getSession(this.ovSessionId);
    return Number(meta?.pending_tokens || 0);
  }

  /**
   * LOCAL PATCH (hugua, 2026-10-08): never fire a commit the extraction model
   * cannot swallow. The local extraction model serves 262144 tokens; a larger
   * input fails with HTTP 400, and because a failed commit never advances the
   * watermark the next attempt is even bigger - that is how the OV queue ended
   * up with a 3M-requeue storm and 13-minute pi freezes.
   *
   * Every commit path must honour this cap. Only the turn_end path used to be
   * guarded, while session_shutdown and session_before_compact called commit()
   * directly and flushed an over-cap backlog as one giant request - exactly the
   * request that 400s. commit() now self-guards; pass force for a commit the
   * user asked for explicitly.
   */
  private async overPendingCap(pending?: number): Promise<boolean> {
    const cap = Number(this.config.commitMaxPendingTokens || 0);
    if (cap <= 0) return false;
    const value = pending ?? (await this.pendingTokens());
    if (value > cap) {
      debugLog(`commit skipped: pending ${value} > commitMaxPendingTokens ${cap}`);
      return true;
    }
    return false;
  }

  async commitIfNeeded(): Promise<void> {
    if (!this.ovSessionId) return;
    const pending = await this.pendingTokens();
    if (await this.overPendingCap(pending)) return;
    if (pending >= this.config.commitTokenThreshold) {
      await this.commit({ pendingTokens: pending });
    }
  }

  async commit(opts: {
    queueOnFailure?: boolean;
    keepRecentCount?: number;
    /** Skip the commitMaxPendingTokens guard. Reserved for explicit user commands. */
    force?: boolean;
    /** Pending count already fetched by the caller, to avoid a second round trip. */
    pendingTokens?: number;
  } = {}): Promise<any | null> {
    if (!this.ovSessionId) return null;
    if (!opts.force && (await this.overPendingCap(opts.pendingTokens))) return null;
    const response = await this.client.commitSessionResponse(
      this.ovSessionId,
      opts.keepRecentCount,
    );
    const result = response.result;
    if (!result) {
      debugLog(
        `commit: session=${this.ovSessionId} ok=false status=${response.status ?? 0} ` +
          `trace_id=${response.traceId || "none"} ` +
          `error=${response.error?.message || response.error?.code || "unknown"}`,
      );
      if (opts.queueOnFailure !== false) {
        await enqueue("commitSession", this.ovSessionId, {
          keep_recent_count: opts.keepRecentCount ?? this.config.commitKeepRecentCount,
        });
      }
      return null;
    }
    debugLog(
      `commit: session=${this.ovSessionId} ok=true trace_id=${result.trace_id || "none"}`,
    );
    return result;
  }

  async shutdown(): Promise<void> {
    return;
  }
}
