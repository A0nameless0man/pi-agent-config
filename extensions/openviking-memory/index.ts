/**
 * OpenViking Memory Extension for Pi
 *
 * Port of the OpenCode OpenViking memory plugin (openviking-memory.ts) to the
 * Pi extension API. Exposes OpenViking's semantic memory capabilities as
 * tools for AI agents. Supports user profiles, preferences, entities, events,
 * cases, and patterns.
 *
 * Original plugin by: littlelory@convolens.net (Copyright 2026 Convolens)
 *
 * ## API mapping (opencode plugin → pi extension)
 *
 * | opencode | pi | notes |
 * |---|---|---|
 * | `tool("memsearch")` … | `pi.registerTool({name:"memsearch",…})` | zod → TypeBox (`StringEnum` from `@earendil-works/pi-ai`); `execute(args, context)` → `execute(toolCallId, params, signal, onUpdate, ctx)`; string return → `{content:[{type:"text",text}]}`; `context.abort` → `signal`; `context.sessionID` → `ctx.sessionManager.getSessionId()` |
 * | `event` `session.created` | `session_start` | same: ensure/reuse OpenViking session, process buffered messages |
 * | `event` `session.deleted` | `session_shutdown` | final commit + cleanup. For `reason:"reload"` the mapping is KEPT (same session continues in a new extension instance) |
 * | `event` `session.error` | *(none)* | no direct pi equivalent — skipped (a failed agent run still fires `message_end` for captured messages and auto-commit covers the rest) |
 * | `event` `message.updated` (role storage) | `message_end` (roles) | assistant role stored only when `stopReason === "stop"` (matches opencode `finish === "stop"`) |
 * | `event` `message.part.updated` (text capture) | `message_end` + `message_update` | `message_end` delivers the final text in one shot; `message_update` mirrors the streaming capture for crash-safety |
 * | `chat.message` synthetic part injection | `before_agent_start` returning `{message:{customType:"openviking-recall",content,display:false}}` | `display:false` = injected into the LLM context (custom messages convert to user-role messages) but hidden from the TUI (see plan-mode example) |
 * | `tool.execute.before` viking:// interception | `tool_call` returning `{block:true,reason}` | verified feasible: pi-agent-core converts a blocked call into an error tool result whose content is `reason` (visible to the model). Pi tool inputs: read `{path}` (+legacy `file_path`), grep `{pattern,path}`, find (pi's glob) `{pattern,path}` |
 * | `stop` hook | `session_shutdown` | flush debounced save + stop scheduler |
 *
 * ## Deviations from the source (intentional, pi-idiomatic)
 *
 * - The auto-commit scheduler is started on `session_start` (idempotently) and
 *   stopped on `session_shutdown`, because pi's extension docs require that no
 *   timers/background resources be started from the extension factory.
 * - Pi messages have no stable IDs; a synthetic ID `${role}:${timestamp}` is
 *   used as the message key for dedup/pending tracking (timestamp is fixed at
 *   message creation, so it is stable across streaming `message_update` events
 *   and the final `message_end`).
 * - The recall query is `before_agent_start`'s `event.prompt` (the raw user
 *   prompt after expansion) instead of extracting text from chat parts.
 * - Idempotency guard for recall injection: skip when the same prompt was
 *   injected within the last 60s (before_agent_start can re-fire for the same
 *   prompt on compaction-retry).
 */

import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core"
import { StringEnum, type TextContent } from "@earendil-works/pi-ai"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { Type } from "typebox"

const extensionFilePath = fileURLToPath(import.meta.url)
const extensionFileDir = path.dirname(extensionFilePath)

// ============================================================================
// Session State Management
// ============================================================================

interface SessionMapping {
  ovSessionId: string
  createdAt: number
  capturedMessages: Set<string> // Track captured message IDs to avoid duplicates
  messageRoles: Map<string, "user" | "assistant"> // Track message ID → role mapping
  pendingMessages: Map<string, string> // Track message ID → content for messages waiting for completion
  sendingMessages: Set<string> // Track message IDs currently being sent to avoid duplicate writes
  lastCommitTime?: number
  commitInFlight?: boolean
  commitTaskId?: string
  commitStartedAt?: number
  pendingCleanup?: boolean
}

// Persisted format for session mapping (for disk storage)
interface SessionMappingPersisted {
  ovSessionId: string
  createdAt: number
  capturedMessages: string[] // Set → Array
  messageRoles: [string, "user" | "assistant"][] // Map → Array of tuples
  pendingMessages: [string, string][] // Map → Array of tuples
  lastCommitTime?: number
  commitInFlight?: boolean
  commitTaskId?: string
  commitStartedAt?: number
  pendingCleanup?: boolean
}

// Session map file format
interface SessionMapFile {
  version: 1
  sessions: Record<string, SessionMappingPersisted> // piSessionId → mapping
  lastSaved: number // timestamp
}

// Map: Pi session ID → OpenViking session ID
const sessionMap = new Map<string, SessionMapping>()

// Buffer for messages that arrive before session mapping is established
interface BufferedMessage {
  messageId: string
  content?: string
  role?: "user" | "assistant"
  timestamp: number
}
const sessionMessageBuffer = new Map<string, BufferedMessage[]>() // sessionId → messages
const MAX_BUFFERED_MESSAGES_PER_SESSION = 100
const BUFFERED_MESSAGE_TTL_MS = 15 * 60 * 1000
const BUFFER_CLEANUP_INTERVAL_MS = 30 * 1000
let lastBufferCleanupAt = 0

// ============================================================================
// Logging
// ============================================================================

let logFilePath: string | null = null
let extensionDataDir: string | null = null

function ensureExtensionDataDir(): string | null {
  const dir = extensionFileDir
  try {
    fs.mkdirSync(dir, { recursive: true })
    return dir
  } catch (error) {
    console.error("Failed to ensure extension directory:", error)
    return null
  }
}

function initLogger() {
  const dir = ensureExtensionDataDir()
  if (!dir) return
  extensionDataDir = dir
  logFilePath = path.join(dir, "openviking-memory.log")
}

function safeStringify(obj: any): any {
  if (obj === null || obj === undefined) return obj
  if (typeof obj !== "object") return obj

  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.map((item) => safeStringify(item))
  }

  // Handle objects
  const result: any = {}
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const value = obj[key]
      if (typeof value === "function") {
        result[key] = "[Function]"
      } else if (typeof value === "object" && value !== null) {
        try {
          result[key] = safeStringify(value)
        } catch {
          result[key] = "[Circular or Non-serializable]"
        }
      } else {
        result[key] = value
      }
    }
  }
  return result
}

function log(level: "INFO" | "ERROR" | "DEBUG", toolName: string, message: string, data?: any) {
  if (!logFilePath) return

  const timestamp = new Date().toISOString()
  const logEntry = {
    timestamp,
    level,
    tool: toolName,
    message,
    ...(data && { data: safeStringify(data) }),
  }

  try {
    const logLine = JSON.stringify(logEntry) + "\n"
    fs.appendFileSync(logFilePath, logLine, "utf-8")
  } catch (error) {
    console.error("Failed to write to log file:", error)
  }
}

// ============================================================================
// Session Map Persistence
// ============================================================================

let sessionMapPath: string | null = null

function initSessionMapPath() {
  const dir = extensionDataDir ?? ensureExtensionDataDir()
  if (!dir) return
  extensionDataDir = dir
  sessionMapPath = path.join(dir, "openviking-session-map.json")
}

function serializeSessionMapping(mapping: SessionMapping): SessionMappingPersisted {
  return {
    ovSessionId: mapping.ovSessionId,
    createdAt: mapping.createdAt,
    capturedMessages: Array.from(mapping.capturedMessages),
    messageRoles: Array.from(mapping.messageRoles.entries()),
    pendingMessages: Array.from(mapping.pendingMessages.entries()),
    lastCommitTime: mapping.lastCommitTime,
    commitInFlight: mapping.commitInFlight,
    commitTaskId: mapping.commitTaskId,
    commitStartedAt: mapping.commitStartedAt,
    pendingCleanup: mapping.pendingCleanup,
  }
}

function deserializeSessionMapping(persisted: SessionMappingPersisted): SessionMapping {
  return {
    ovSessionId: persisted.ovSessionId,
    createdAt: persisted.createdAt,
    capturedMessages: new Set(persisted.capturedMessages),
    messageRoles: new Map(persisted.messageRoles),
    pendingMessages: new Map(persisted.pendingMessages),
    sendingMessages: new Set(),
    lastCommitTime: persisted.lastCommitTime,
    commitInFlight: persisted.commitInFlight,
    commitTaskId: persisted.commitTaskId,
    commitStartedAt: persisted.commitStartedAt,
    pendingCleanup: persisted.pendingCleanup,
  }
}

async function loadSessionMap(): Promise<void> {
  if (!sessionMapPath) return

  try {
    if (!fs.existsSync(sessionMapPath)) {
      log("INFO", "persistence", "No session map file found, starting fresh")
      return
    }

    const content = await fs.promises.readFile(sessionMapPath, "utf-8")
    const data: SessionMapFile = JSON.parse(content)

    if (data.version !== 1) {
      log("ERROR", "persistence", "Unsupported session map version", { version: data.version })
      return
    }

    for (const [piSessionId, persisted] of Object.entries(data.sessions)) {
      sessionMap.set(piSessionId, deserializeSessionMapping(persisted))
    }

    log("INFO", "persistence", "Session map loaded", {
      count: sessionMap.size,
      last_saved: new Date(data.lastSaved).toISOString(),
    })
  } catch (error: any) {
    log("ERROR", "persistence", "Failed to load session map", { error: error.message })

    // Backup corrupted file
    if (fs.existsSync(sessionMapPath)) {
      const backupPath = `${sessionMapPath}.corrupted.${Date.now()}`
      await fs.promises.rename(sessionMapPath, backupPath)
      log("INFO", "persistence", "Corrupted file backed up", { backup: backupPath })
    }
  }
}

async function saveSessionMap(): Promise<void> {
  if (!sessionMapPath) return

  try {
    const sessions: Record<string, SessionMappingPersisted> = {}
    for (const [piSessionId, mapping] of sessionMap.entries()) {
      sessions[piSessionId] = serializeSessionMapping(mapping)
    }

    const data: SessionMapFile = {
      version: 1,
      sessions,
      lastSaved: Date.now(),
    }

    // Atomic write: temp file + rename
    const tempPath = sessionMapPath + ".tmp"
    await fs.promises.writeFile(tempPath, JSON.stringify(data, null, 2), "utf-8")
    await fs.promises.rename(tempPath, sessionMapPath)

    log("DEBUG", "persistence", "Session map saved", { count: sessionMap.size })
  } catch (error: any) {
    log("ERROR", "persistence", "Failed to save session map", { error: error.message })
  }
}

// Debounced save to reduce disk I/O
let saveTimer: NodeJS.Timeout | null = null

function debouncedSaveSessionMap(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveSessionMap().catch((error) => {
      log("ERROR", "persistence", "Debounced save failed", { error: error.message })
    })
  }, 300)
}

// ============================================================================
// Configuration
// ============================================================================

interface OpenVikingConfig {
  endpoint: string
  apiKey: string
  enabled: boolean
  timeoutMs: number
  autoCommit?: {
    enabled: boolean
    intervalMinutes: number
  }
  // Auto memory recall configuration
  autoRecall?: {
    enabled: boolean
    limit: number
    scoreThreshold: number
    maxContentChars: number
    preferAbstract: boolean
    tokenBudget: number
  }
}

// ============================================================================
// API Response Types
// ============================================================================

interface OpenVikingResponse<T = unknown> {
  status: string
  result?: T
  error?: string | { code?: string; message?: string; details?: Record<string, unknown> }
  time?: number
  usage?: Record<string, number>
}

interface SearchResult {
  memories: any[]
  resources: any[]
  skills: any[]
  total: number
  query_plan?: string
}

type MemoryCounts = number | Record<string, number>

interface CommitResult {
  session_id: string
  status: string
  memories_extracted?: MemoryCounts
  active_count_updated?: number
  archived?: boolean
  task_id?: string
  message?: string
  stats?: {
    total_turns?: number
    contexts_used?: number
    skills_used?: number
    memories_extracted?: number
  }
}

interface SessionResult {
  session_id: string
}

interface TaskResult {
  task_id: string
  task_type: string
  status: "pending" | "running" | "completed" | "failed"
  created_at: number
  updated_at: number
  resource_id?: string
  result?: {
    session_id?: string
    memories_extracted?: MemoryCounts
    archived?: boolean
  }
  error?: string | null
}

type CommitStartResult =
  | { mode: "background"; taskId: string }
  | { mode: "completed"; result: CommitResult }

const DEFAULT_CONFIG: OpenVikingConfig = {
  endpoint: "http://localhost:1933",
  apiKey: "",
  enabled: true,
  timeoutMs: 30000,
  autoCommit: {
    enabled: true,
    intervalMinutes: 10,
  },
  autoRecall: {
    enabled: true,
    limit: 6,
    scoreThreshold: 0.15,
    maxContentChars: 500,
    preferAbstract: true,
    tokenBudget: 2000,
  },
}

function totalMemoriesExtracted(memories?: MemoryCounts): number {
  if (typeof memories === "number") {
    return memories
  }
  if (!memories || typeof memories !== "object") {
    return 0
  }
  return Object.entries(memories).reduce((sum, [key, value]) => {
    if (key === "total") {
      return sum
    }
    return sum + (typeof value === "number" ? value : 0)
  }, 0)
}

function totalMemoriesFromResult(result?: { memories_extracted?: MemoryCounts } | null): number {
  return totalMemoriesExtracted(result?.memories_extracted)
}

function clampRecallConfig(recall: NonNullable<OpenVikingConfig["autoRecall"]>): void {
  recall.limit = Math.max(1, Math.min(50, Math.round(recall.limit)))
  recall.scoreThreshold = Math.max(0, Math.min(1, recall.scoreThreshold))
  recall.tokenBudget = Math.max(100, Math.min(10000, Math.round(recall.tokenBudget)))
}

function loadConfig(): OpenVikingConfig {
  const configPath = path.join(extensionFileDir, "openviking-config.json")

  try {
    if (fs.existsSync(configPath)) {
      const fileContent = fs.readFileSync(configPath, "utf-8")
      const fileConfig = JSON.parse(fileContent)
      const config = {
        ...DEFAULT_CONFIG,
        ...fileConfig,
        autoCommit: fileConfig.autoCommit
          ? {
              ...DEFAULT_CONFIG.autoCommit,
              ...fileConfig.autoCommit,
            }
          : DEFAULT_CONFIG.autoCommit
            ? { ...DEFAULT_CONFIG.autoCommit }
            : undefined,
        autoRecall: fileConfig.autoRecall
          ? {
              ...DEFAULT_CONFIG.autoRecall,
              ...fileConfig.autoRecall,
            }
          : DEFAULT_CONFIG.autoRecall
            ? { ...DEFAULT_CONFIG.autoRecall }
            : undefined,
      }
      if (config.autoCommit) {
        config.autoCommit.intervalMinutes = getAutoCommitIntervalMinutes(config)
      }

      // Validate recall config ranges
      if (config.autoRecall) {
        clampRecallConfig(config.autoRecall)
      }

      // Environment variable takes precedence over config file
      if (process.env.OPENVIKING_API_KEY) {
        config.apiKey = process.env.OPENVIKING_API_KEY
      }

      return config
    }
  } catch (error) {
    console.warn(`Failed to load OpenViking config from ${configPath}:`, error)
  }

  // Check environment variable even if config file doesn't exist
  const config = {
    ...DEFAULT_CONFIG,
    autoCommit: DEFAULT_CONFIG.autoCommit ? { ...DEFAULT_CONFIG.autoCommit } : undefined,
    autoRecall: DEFAULT_CONFIG.autoRecall ? { ...DEFAULT_CONFIG.autoRecall } : undefined,
  }
  if (process.env.OPENVIKING_API_KEY) {
    config.apiKey = process.env.OPENVIKING_API_KEY
  }
  if (config.autoCommit) {
    config.autoCommit.intervalMinutes = getAutoCommitIntervalMinutes(config)
  }

  return config
}

// ============================================================================
// HTTP Client
// ============================================================================

interface HttpRequestOptions {
  method: "GET" | "POST" | "PUT" | "DELETE"
  endpoint: string
  body?: any
  timeoutMs?: number
  abortSignal?: AbortSignal
}

async function makeRequest<T = any>(config: OpenVikingConfig, options: HttpRequestOptions): Promise<T> {
  const url = `${config.endpoint}${options.endpoint}`
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  }

  if (config.apiKey) {
    headers["X-API-Key"] = config.apiKey
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? config.timeoutMs)

  // Chain with tool's abort signal if provided
  const signal = options.abortSignal
    ? AbortSignal.any([options.abortSignal, controller.signal])
    : controller.signal

  try {
    const response = await fetch(url, {
      method: options.method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal,
    })

    clearTimeout(timeout)

    if (!response.ok) {
      const errorText = await response.text()
      let errorMessage: string
      try {
        const errorJson = JSON.parse(errorText)
        // Handle case where error/message might be objects
        const rawError = errorJson.error || errorJson.message
        if (typeof rawError === "string") {
          errorMessage = rawError
        } else if (rawError && typeof rawError === "object") {
          errorMessage = JSON.stringify(rawError)
        } else {
          errorMessage = errorText
        }
      } catch {
        errorMessage = errorText
      }

      switch (response.status) {
        case 401:
        case 403:
          throw new Error("Authentication failed. Please check API key configuration.")
        case 404:
          throw new Error(`Resource not found: ${options.endpoint}`)
        case 500:
          throw new Error(`OpenViking server error: ${errorMessage}`)
        default:
          throw new Error(`Request failed (${response.status}): ${errorMessage}`)
      }
    }

    return (await response.json()) as T
  } catch (error: any) {
    clearTimeout(timeout)

    if (error.name === "AbortError") {
      throw new Error(`Request timeout after ${options.timeoutMs ?? config.timeoutMs}ms`)
    }

    if (error.message?.includes("fetch failed") || error.code === "ECONNREFUSED") {
      throw new Error(
        `OpenViking service unavailable at ${config.endpoint}. Please check if the service is running (try: openviking-server).`,
      )
    }

    throw error
  }
}

async function uploadLocalFile(config: OpenVikingConfig, filePath: string): Promise<string> {
  const fileBuffer = await fs.promises.readFile(filePath)
  const fileName = path.basename(filePath)
  const blob = new Blob([fileBuffer])
  const formData = new FormData()
  formData.append("file", blob, fileName)

  const headers: Record<string, string> = {}
  if (config.apiKey) headers["X-API-Key"] = config.apiKey

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs)

  try {
    const response = await fetch(`${config.endpoint}/api/v1/resources/temp_upload`, {
      method: "POST",
      headers,
      body: formData,
      signal: controller.signal,
    })

    clearTimeout(timeout)

    if (!response.ok) {
      const errorText = await response.text()
      switch (response.status) {
        case 413:
          throw new Error("File too large for upload. The server rejected the payload size.")
        case 415:
          throw new Error("Unsupported file type. The server rejected the content type of the uploaded file.")
        default:
          throw new Error(`File upload failed (${response.status}): ${errorText}`)
      }
    }

    const result = (await response.json()) as OpenVikingResponse<{ temp_file_id: string }>
    const tempFileId = unwrapResponse(result)?.temp_file_id
    if (!tempFileId) throw new Error("No temp_file_id returned from upload")
    return tempFileId
  } catch (error: any) {
    clearTimeout(timeout)

    if (error.name === "AbortError") {
      throw new Error(`File upload timed out after ${config.timeoutMs}ms`)
    }

    if (error.message?.includes("fetch failed") || error.code === "ECONNREFUSED") {
      throw new Error(
        `OpenViking service unavailable at ${config.endpoint}. Please check if the service is running (try: openviking-server).`,
      )
    }

    throw error
  }
}

function getResponseErrorMessage(error: OpenVikingResponse["error"]): string {
  if (!error) return "Unknown OpenViking error"
  if (typeof error === "string") return error
  return error.message || error.code || "Unknown OpenViking error"
}

function unwrapResponse<T>(response: OpenVikingResponse<T>): T {
  if (!response || typeof response !== "object") {
    throw new Error("OpenViking returned an invalid response")
  }
  if (response.status && response.status !== "ok") {
    throw new Error(getResponseErrorMessage(response.error))
  }
  return response.result as T
}

async function checkServiceHealth(config: OpenVikingConfig): Promise<boolean> {
  try {
    const response = await fetch(`${config.endpoint}/health`, {
      method: "GET",
      signal: AbortSignal.timeout(3000),
    })
    return response.ok
  } catch (error: any) {
    log("ERROR", "health", "OpenViking health check failed", {
      endpoint: config.endpoint,
      error: error.message,
    })
    return false
  }
}

// ============================================================================
// Session Lifecycle Helpers
// ============================================================================

function mergeMessageContent(existing: string | undefined, incoming: string): string {
  const next = incoming.trim()
  if (!next) return existing ?? ""
  if (!existing) return next
  if (next === existing) return existing
  if (next.startsWith(existing)) return next
  if (existing.startsWith(next)) return existing
  if (next.includes(existing)) return next
  if (existing.includes(next)) return existing
  return `${existing}\n${next}`.trim()
}

function upsertBufferedMessage(
  sessionId: string,
  messageId: string,
  updates: Partial<Pick<BufferedMessage, "role" | "content">>,
): void {
  const now = Date.now()

  if (now - lastBufferCleanupAt >= BUFFER_CLEANUP_INTERVAL_MS) {
    for (const [bufferedSessionId, bufferedMessages] of sessionMessageBuffer.entries()) {
      const freshMessages = bufferedMessages.filter((message) => now - message.timestamp <= BUFFERED_MESSAGE_TTL_MS)
      if (freshMessages.length === 0) {
        sessionMessageBuffer.delete(bufferedSessionId)
        continue
      }
      if (freshMessages.length !== bufferedMessages.length) {
        sessionMessageBuffer.set(bufferedSessionId, freshMessages)
      }
    }
    lastBufferCleanupAt = now
  }

  const existingBuffer = sessionMessageBuffer.get(sessionId) ?? []
  const freshBuffer = existingBuffer.filter((message) => now - message.timestamp <= BUFFERED_MESSAGE_TTL_MS)

  let buffered = freshBuffer.find((message) => message.messageId === messageId)
  if (!buffered) {
    while (freshBuffer.length >= MAX_BUFFERED_MESSAGES_PER_SESSION) {
      freshBuffer.shift()
    }
    buffered = { messageId, timestamp: now }
    freshBuffer.push(buffered)
  } else {
    buffered.timestamp = now
  }

  if (updates.role) {
    buffered.role = updates.role
  }
  if (updates.content) {
    buffered.content = mergeMessageContent(buffered.content, updates.content)
  }

  sessionMessageBuffer.set(sessionId, freshBuffer)
}

function cleanupOrphanedMessageBuffers(now: number): void {
  for (const [sessionId, buffer] of sessionMessageBuffer.entries()) {
    if (sessionMap.has(sessionId)) {
      continue
    }

    const oldestMessage = buffer[0]
    if (!oldestMessage) {
      sessionMessageBuffer.delete(sessionId)
      continue
    }

    if (now - oldestMessage.timestamp <= BUFFERED_MESSAGE_TTL_MS * 2) {
      continue
    }

    log("INFO", "buffer", "Cleaning up orphaned message buffer", {
      session_id: sessionId,
      buffer_age_ms: now - oldestMessage.timestamp,
      message_count: buffer.length,
    })
    sessionMessageBuffer.delete(sessionId)
  }
}

function getAutoCommitIntervalMinutes(config: OpenVikingConfig): number {
  const configured = Number(config.autoCommit?.intervalMinutes ?? DEFAULT_CONFIG.autoCommit?.intervalMinutes ?? 10)
  if (!Number.isFinite(configured)) {
    return DEFAULT_CONFIG.autoCommit?.intervalMinutes ?? 10
  }
  return Math.max(1, configured)
}

/**
 * Create or connect to OpenViking session for a Pi session
 */
async function ensureOpenVikingSession(
  piSessionId: string,
  config: OpenVikingConfig,
): Promise<string | null> {
  const existingMapping = sessionMap.get(piSessionId)
  const knownSessionId = existingMapping?.ovSessionId

  if (knownSessionId) {
    try {
      const response = await makeRequest<OpenVikingResponse<SessionResult>>(config, {
        method: "GET",
        endpoint: `/api/v1/sessions/${knownSessionId}`,
        timeoutMs: 5000,
      })
      const result = unwrapResponse(response)
      if (result) {
        log("INFO", "session", "Reconnected to persisted OpenViking session", {
          pi_session: piSessionId,
          openviking_session: knownSessionId,
        })
        return knownSessionId
      }
    } catch (error: any) {
      log("INFO", "session", "Persisted OpenViking session unavailable, creating a new one", {
        pi_session: piSessionId,
        openviking_session: knownSessionId,
        error: error.message,
      })
    }
  }

  try {
    const createResponse = await makeRequest<OpenVikingResponse<SessionResult>>(config, {
      method: "POST",
      endpoint: "/api/v1/sessions",
      body: {},
      timeoutMs: 5000,
    })

    const sessionId = unwrapResponse(createResponse)?.session_id
    if (!sessionId) {
      throw new Error("OpenViking did not return a session_id")
    }

    log("INFO", "session", "Created new OpenViking session", {
      pi_session: piSessionId,
      openviking_session: sessionId,
    })
    return sessionId
  } catch (error: any) {
    log("ERROR", "session", "Failed to create OpenViking session", {
      pi_session: piSessionId,
      error: error.message,
    })
    return null
  }
}

async function sleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      abortSignal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)

    function onAbort() {
      clearTimeout(timer)
      reject(new Error("Operation aborted"))
    }

    abortSignal?.addEventListener("abort", onAbort, { once: true })
  })
}

async function findRunningCommitTaskId(
  ovSessionId: string,
  config: OpenVikingConfig,
): Promise<string | undefined> {
  try {
    const response = await makeRequest<OpenVikingResponse<TaskResult[]>>(config, {
      method: "GET",
      endpoint: `/api/v1/tasks?task_type=session_commit&resource_id=${encodeURIComponent(ovSessionId)}&limit=10`,
      timeoutMs: 5000,
    })
    const tasks = unwrapResponse(response) ?? []
    const runningTask = tasks.find((task) => task.status === "pending" || task.status === "running")
    return runningTask?.task_id
  } catch (error: any) {
    log("ERROR", "session", "Failed to query running commit tasks", {
      openviking_session: ovSessionId,
      error: error.message,
    })
    return undefined
  }
}

function clearCommitState(mapping: SessionMapping): void {
  mapping.commitInFlight = false
  mapping.commitTaskId = undefined
  mapping.commitStartedAt = undefined
}

function isMissingCommitTaskError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  const message = error.message.toLowerCase()
  return message.includes("resource not found") || message.includes("not found")
}

let backgroundCommitSupported: boolean | null = null
const COMMIT_TIMEOUT_MS = 180000

async function detectBackgroundCommitSupport(config: OpenVikingConfig): Promise<boolean> {
  if (backgroundCommitSupported !== null) {
    return backgroundCommitSupported
  }

  const headers: Record<string, string> = {}
  if (config.apiKey) {
    headers["X-API-Key"] = config.apiKey
  }

  try {
    const response = await fetch(`${config.endpoint}/api/v1/tasks?limit=1`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(3000),
    })
    backgroundCommitSupported = response.ok
  } catch {
    backgroundCommitSupported = false
  }

  log(
    "INFO",
    "session",
    backgroundCommitSupported
      ? "Detected background commit API support"
      : "Detected legacy synchronous commit API",
    { endpoint: config.endpoint },
  )
  return backgroundCommitSupported
}

async function finalizeCommitSuccess(
  mapping: SessionMapping,
  piSessionId: string,
  config: OpenVikingConfig,
): Promise<void> {
  mapping.lastCommitTime = Date.now()
  mapping.capturedMessages.clear()
  clearCommitState(mapping)
  debouncedSaveSessionMap()

  await flushPendingMessages(piSessionId, mapping, config)

  if (mapping.pendingCleanup) {
    sessionMap.delete(piSessionId)
    sessionMessageBuffer.delete(piSessionId)
    await saveSessionMap()
    log("INFO", "session", "Cleaned up session mapping after commit completion", {
      openviking_session: mapping.ovSessionId,
      pi_session: piSessionId,
    })
  }
}

async function runSynchronousCommit(
  mapping: SessionMapping,
  piSessionId: string,
  config: OpenVikingConfig,
  abortSignal?: AbortSignal,
): Promise<CommitResult> {
  mapping.commitInFlight = true
  mapping.commitTaskId = undefined
  mapping.commitStartedAt = Date.now()
  debouncedSaveSessionMap()

  try {
    const response = await makeRequest<OpenVikingResponse<CommitResult>>(config, {
      method: "POST",
      endpoint: `/api/v1/sessions/${mapping.ovSessionId}/commit`,
      timeoutMs: Math.max(config.timeoutMs, COMMIT_TIMEOUT_MS),
      abortSignal,
    })
    const result = unwrapResponse(response)

    log("INFO", "session", "OpenViking synchronous commit completed", {
      openviking_session: mapping.ovSessionId,
      pi_session: piSessionId,
      memories_extracted: totalMemoriesFromResult(result),
      archived: result?.archived ?? false,
    })

    await finalizeCommitSuccess(mapping, piSessionId, config)
    return result
  } catch (error: any) {
    clearCommitState(mapping)
    debouncedSaveSessionMap()
    throw error
  }
}

async function flushPendingMessages(
  piSessionId: string,
  mapping: SessionMapping,
  config: OpenVikingConfig,
): Promise<void> {
  if (mapping.commitInFlight) {
    return
  }

  for (const messageId of Array.from(mapping.pendingMessages.keys())) {
    if (mapping.capturedMessages.has(messageId) || mapping.sendingMessages.has(messageId)) {
      continue
    }
    const role = mapping.messageRoles.get(messageId)
    const content = mapping.pendingMessages.get(messageId)
    if (!role || !content || !content.trim()) {
      continue
    }

    mapping.sendingMessages.add(messageId)
    try {
      log("DEBUG", "message", "Committing pending message content", {
        session_id: piSessionId,
        message_id: messageId,
        role,
        content_length: content.length,
      })

      const success = await addMessageToSession(mapping.ovSessionId, role, content, config)

      if (success) {
        const latestContent = mapping.pendingMessages.get(messageId)
        if (latestContent && latestContent !== content) {
          log("DEBUG", "message", "Message changed during send; keeping latest content pending", {
            session_id: piSessionId,
            message_id: messageId,
            role,
            previous_length: content.length,
            latest_length: latestContent.length,
          })
        } else {
          mapping.capturedMessages.add(messageId)
          mapping.pendingMessages.delete(messageId)
          debouncedSaveSessionMap()
          log("INFO", "message", `${role} message captured successfully`, {
            session_id: piSessionId,
            message_id: messageId,
            role,
          })
        }
      }
    } finally {
      mapping.sendingMessages.delete(messageId)
    }
  }
}

async function startBackgroundCommit(
  mapping: SessionMapping,
  piSessionId: string,
  config: OpenVikingConfig,
  abortSignal?: AbortSignal,
): Promise<CommitStartResult | null> {
  if (mapping.commitInFlight && mapping.commitTaskId) {
    return { mode: "background", taskId: mapping.commitTaskId }
  }

  const supportsBackgroundCommit = await detectBackgroundCommitSupport(config)
  if (!supportsBackgroundCommit) {
    try {
      const result = await runSynchronousCommit(mapping, piSessionId, config, abortSignal)
      return { mode: "completed", result }
    } catch (error: any) {
      log("ERROR", "session", "Failed to run synchronous commit", {
        openviking_session: mapping.ovSessionId,
        pi_session: piSessionId,
        error: error.message,
      })
      return null
    }
  }

  try {
    const response = await makeRequest<OpenVikingResponse<CommitResult>>(config, {
      method: "POST",
      endpoint: `/api/v1/sessions/${mapping.ovSessionId}/commit?wait=false`,
      timeoutMs: 5000,
      abortSignal,
    })
    const data = unwrapResponse(response)
    const taskId = data?.task_id
    if (!taskId) {
      throw new Error("OpenViking did not return a background task id")
    }

    mapping.commitInFlight = true
    mapping.commitTaskId = taskId
    mapping.commitStartedAt = Date.now()
    debouncedSaveSessionMap()

    log("INFO", "session", "OpenViking background commit accepted", {
      openviking_session: mapping.ovSessionId,
      pi_session: piSessionId,
      task_id: taskId,
    })
    return { mode: "background", taskId }
  } catch (error: any) {
    if (error.message?.includes("already has a commit in progress")) {
      const taskId = await findRunningCommitTaskId(mapping.ovSessionId, config)
      if (taskId) {
        mapping.commitInFlight = true
        mapping.commitTaskId = taskId
        mapping.commitStartedAt = mapping.commitStartedAt ?? Date.now()
        debouncedSaveSessionMap()
        log("INFO", "session", "Recovered existing background commit task", {
          openviking_session: mapping.ovSessionId,
          pi_session: piSessionId,
          task_id: taskId,
        })
        return { mode: "background", taskId }
      }
    }

    if (
      error.message?.includes("Request timeout") ||
      error.message?.includes("background task id")
    ) {
      backgroundCommitSupported = false
      try {
        const result = await runSynchronousCommit(mapping, piSessionId, config, abortSignal)
        return { mode: "completed", result }
      } catch (fallbackError: any) {
        log("ERROR", "session", "Failed to fall back to synchronous commit", {
          openviking_session: mapping.ovSessionId,
          pi_session: piSessionId,
          error: fallbackError.message,
        })
      }
    }

    log("ERROR", "session", "Failed to start OpenViking background commit", {
      openviking_session: mapping.ovSessionId,
      pi_session: piSessionId,
      error: error.message,
    })
    return null
  }
}

async function pollCommitTaskOnce(
  mapping: SessionMapping,
  piSessionId: string,
  config: OpenVikingConfig,
): Promise<TaskResult["status"] | "unknown"> {
  if (!mapping.commitInFlight) {
    return "unknown"
  }

  if (!mapping.commitTaskId) {
    const recoveredTaskId = await findRunningCommitTaskId(mapping.ovSessionId, config)
    if (!recoveredTaskId) {
      log("INFO", "session", "Clearing stale in-flight commit without task id", {
        openviking_session: mapping.ovSessionId,
        pi_session: piSessionId,
      })
      clearCommitState(mapping)
      debouncedSaveSessionMap()
      return "unknown"
    }

    mapping.commitTaskId = recoveredTaskId
    debouncedSaveSessionMap()
  }

  try {
    const response = await makeRequest<OpenVikingResponse<TaskResult>>(config, {
      method: "GET",
      endpoint: `/api/v1/tasks/${mapping.commitTaskId}`,
      timeoutMs: 5000,
    })
    const task = unwrapResponse(response)

    if (task.status === "pending" || task.status === "running") {
      return task.status
    }

    if (task.status === "completed") {
      const memoriesExtracted = totalMemoriesFromResult(task.result)
      const archived = task.result?.archived ?? false

      log("INFO", "session", "OpenViking background commit completed", {
        openviking_session: mapping.ovSessionId,
        pi_session: piSessionId,
        task_id: task.task_id,
        memories_extracted: memoriesExtracted,
        archived,
      })

      await finalizeCommitSuccess(mapping, piSessionId, config)

      return task.status
    }

    log("ERROR", "session", "OpenViking background commit failed", {
      openviking_session: mapping.ovSessionId,
      pi_session: piSessionId,
      task_id: task.task_id,
      error: task.error,
    })

    clearCommitState(mapping)
    debouncedSaveSessionMap()

    if (mapping.pendingCleanup) {
      sessionMap.delete(piSessionId)
      sessionMessageBuffer.delete(piSessionId)
      await saveSessionMap()
      log("INFO", "session", "Cleaned up session mapping after failed commit", {
        openviking_session: mapping.ovSessionId,
        pi_session: piSessionId,
      })
    }

    return task.status
  } catch (error: unknown) {
    if (isMissingCommitTaskError(error)) {
      log("INFO", "session", "Commit task disappeared; clearing stale state", {
        openviking_session: mapping.ovSessionId,
        pi_session: piSessionId,
        task_id: mapping.commitTaskId,
      })
      clearCommitState(mapping)
      debouncedSaveSessionMap()
      return "unknown"
    }

    log("ERROR", "session", "Failed to poll OpenViking background commit", {
      openviking_session: mapping.ovSessionId,
      pi_session: piSessionId,
      task_id: mapping.commitTaskId,
      error: error instanceof Error ? error.message : String(error),
    })
    return "unknown"
  }
}

async function waitForCommitCompletion(
  mapping: SessionMapping,
  piSessionId: string,
  config: OpenVikingConfig,
  abortSignal?: AbortSignal,
  timeoutMs = 180000,
): Promise<TaskResult | null> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    if (abortSignal?.aborted) {
      throw new Error("Operation aborted")
    }

    if (!mapping.commitInFlight) {
      return null
    }
    if (!mapping.commitTaskId) {
      const recoveredTaskId = await findRunningCommitTaskId(mapping.ovSessionId, config)
      if (!recoveredTaskId) {
        clearCommitState(mapping)
        debouncedSaveSessionMap()
        return null
      }

      mapping.commitTaskId = recoveredTaskId
      debouncedSaveSessionMap()
    }

    try {
      const response = await makeRequest<OpenVikingResponse<TaskResult>>(config, {
        method: "GET",
        endpoint: `/api/v1/tasks/${mapping.commitTaskId}`,
        timeoutMs: 5000,
        abortSignal,
      })
      const task = unwrapResponse(response)

      if (task.status === "completed") {
        const memoriesExtracted = totalMemoriesFromResult(task.result)
        const archived = task.result?.archived ?? false

        await finalizeCommitSuccess(mapping, piSessionId, config)

        log("INFO", "memcommit", "Background commit completed while waiting", {
          openviking_session: mapping.ovSessionId,
          pi_session: piSessionId,
          task_id: task.task_id,
          memories_extracted: memoriesExtracted,
          archived,
        })
        return task
      }

      if (task.status === "failed") {
        clearCommitState(mapping)
        debouncedSaveSessionMap()
        throw new Error(task.error || "Background commit failed")
      }

      await sleep(2000, abortSignal)
    } catch (error: unknown) {
      if (isMissingCommitTaskError(error)) {
        log("INFO", "session", "Commit task disappeared while waiting; clearing stale state", {
          openviking_session: mapping.ovSessionId,
          pi_session: piSessionId,
          task_id: mapping.commitTaskId,
        })
        clearCommitState(mapping)
        debouncedSaveSessionMap()
        return null
      }

      throw error
    }
  }

  return null
}

// ============================================================================
// Auto-Commit Scheduler
// ============================================================================

let autoCommitTimer: NodeJS.Timeout | null = null

function startAutoCommit(config: OpenVikingConfig) {
  if (autoCommitTimer) {
    log("INFO", "auto-commit", "Auto-commit scheduler already running")
    return
  }

  if (!config.autoCommit?.enabled) {
    log("INFO", "auto-commit", "Auto-commit disabled in config")
    return
  }

  const checkIntervalMs = 60 * 1000 // Check every minute

  autoCommitTimer = setInterval(async () => {
    await checkAndCommitSessions(config)
  }, checkIntervalMs)

  log("INFO", "auto-commit", "Auto-commit scheduler started", {
    check_interval_seconds: 60,
    commit_interval_minutes: getAutoCommitIntervalMinutes(config),
  })
}

function stopAutoCommit() {
  if (autoCommitTimer) {
    clearInterval(autoCommitTimer)
    autoCommitTimer = null
    log("INFO", "auto-commit", "Auto-commit scheduler stopped")
  }
}

async function checkAndCommitSessions(config: OpenVikingConfig): Promise<void> {
  const intervalMs = getAutoCommitIntervalMinutes(config) * 60 * 1000
  const now = Date.now()

  cleanupOrphanedMessageBuffers(now)

  for (const [piSessionId, mapping] of sessionMap.entries()) {
    if (mapping.commitInFlight) {
      await pollCommitTaskOnce(mapping, piSessionId, config)
      continue
    }

    if (mapping.pendingMessages.size > 0) {
      await flushPendingMessages(piSessionId, mapping, config)
    }

    const timeSinceLastCommit = now - (mapping.lastCommitTime ?? mapping.createdAt)
    const hasNewMessages = mapping.capturedMessages.size > 0

    if (timeSinceLastCommit >= intervalMs && hasNewMessages) {
      log("INFO", "auto-commit", "Triggering auto-commit", {
        pi_session: piSessionId,
        openviking_session: mapping.ovSessionId,
        time_since_last_commit_minutes: Math.floor(timeSinceLastCommit / 60000),
        captured_messages_count: mapping.capturedMessages.size,
      })

      await startBackgroundCommit(mapping, piSessionId, config)
    }
  }
}

/**
 * Add message to OpenViking session
 */
async function addMessageToSession(
  ovSessionId: string,
  role: "user" | "assistant",
  content: string,
  config: OpenVikingConfig,
): Promise<boolean> {
  try {
    const response = await makeRequest<OpenVikingResponse<void>>(config, {
      method: "POST",
      endpoint: `/api/v1/sessions/${ovSessionId}/messages`,
      body: { role, content },
      timeoutMs: 5000,
    })
    unwrapResponse(response)

    log("INFO", "message", "Message added to OpenViking session", {
      openviking_session: ovSessionId,
      role,
      content_length: content.length,
    })
    return true
  } catch (error: any) {
    log("ERROR", "message", "Failed to add message to OpenViking session", {
      openviking_session: ovSessionId,
      role,
      error: error.message,
    })
    return false
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

function formatSearchResults(
  result: SearchResult,
  toolName: string,
  query: string,
  extra?: Record<string, unknown>,
): string {
  const { memories = [], resources = [], skills = [] } = result
  const allResults = [...memories, ...resources, ...skills]
  if (allResults.length === 0) {
    log("INFO", toolName, "No results found", { query })
    return "No results found matching the query."
  }
  log("INFO", toolName, "Search completed", { count: allResults.length })
  return JSON.stringify(
    { total: result.total ?? allResults.length, memories, resources, skills, ...extra },
    null,
    2,
  )
}

function resolveSearchMode(
  requestedMode: "auto" | "fast" | "deep" | undefined,
  query: string,
  sessionId?: string,
): "fast" | "deep" {
  if (requestedMode === "fast" || requestedMode === "deep") {
    return requestedMode
  }

  if (sessionId) {
    return "deep"
  }

  const normalized = query.trim()
  const wordCount = normalized ? normalized.split(/\s+/).length : 0
  if (normalized.includes("?") || normalized.length >= 80 || wordCount >= 8) {
    return "deep"
  }

  return "fast"
}

function validateVikingUri(uri: string, toolName: string): string | null {
  if (!uri.startsWith("viking://")) {
    const error = `Invalid URI format. Must start with "viking://". Example: viking://user/memories/`
    log("ERROR", toolName, "Invalid URI format", { uri })
    return `Error: ${error}`
  }
  return null
}

// ============================================================================
// Memory Recall: Types, Ranking & Dedup
// ============================================================================

/** Shape returned by OpenViking search API, adapted for recall use. */
interface RecallSearchItem {
  uri: string
  score: number
  title?: string
  abstract?: string
  content?: string
  type?: string
  category?: string
  level?: number
  overview?: string
}

const AUTO_RECALL_TIMEOUT_MS = 5_000

// ─── Scoring helpers ───

function recallClampScore(value: number | undefined): number {
  if (typeof value !== "number" || Number.isNaN(value)) return 0
  return Math.max(0, Math.min(1, value))
}

const RECALL_STOPWORDS = new Set([
  "what", "when", "where", "which", "who", "whom", "whose", "why", "how",
  "did", "does", "is", "are", "was", "were", "the", "and", "for", "with",
  "from", "that", "this", "your", "you",
])

const RECALL_TOKEN_RE = /[a-z0-9]{2,}/gi

const PREFERENCE_QUERY_RE = /prefer|preference|favorite|favourite|like|偏好|喜欢|爱好|更倾向/i
const TEMPORAL_QUERY_RE = /when|what time|date|day|month|year|yesterday|today|tomorrow|last|next|什么时候|何时|哪天|几月|几年|昨天|今天|明天|上周|下周|上个月|下个月|去年|明年/i

interface RecallQueryProfile {
  tokens: string[]
  wantsPreference: boolean
  wantsTemporal: boolean
}

function buildRecallQueryProfile(query: string): RecallQueryProfile {
  const text = query.trim()
  const allTokens = text.toLowerCase().match(RECALL_TOKEN_RE) ?? []
  const tokens = allTokens.filter((t) => !RECALL_STOPWORDS.has(t))
  return {
    tokens,
    wantsPreference: PREFERENCE_QUERY_RE.test(text),
    wantsTemporal: TEMPORAL_QUERY_RE.test(text),
  }
}

function lexicalOverlapBoost(tokens: string[], text: string): number {
  if (tokens.length === 0 || !text) return 0
  const haystack = ` ${text.toLowerCase()} `
  let matched = 0
  for (const token of tokens.slice(0, 8)) {
    if (haystack.includes(` ${token} `) || haystack.includes(token)) {
      matched += 1
    }
  }
  return Math.min(0.2, (matched / Math.min(tokens.length, 4)) * 0.2)
}

function isEventMemory(item: RecallSearchItem): boolean {
  const cat = (item.category ?? "").toLowerCase()
  return cat === "events" || item.uri.includes("/events/")
}

function isPreferencesMemory(item: RecallSearchItem): boolean {
  return item.category === "preferences" || item.uri.includes("/preferences/") || item.uri.endsWith("/preferences")
}

function isLeafLikeMemory(item: RecallSearchItem): boolean {
  return item.level === 2
}

function rankForInjection(item: RecallSearchItem, query: RecallQueryProfile): number {
  const baseScore = recallClampScore(item.score)
  const abstract = (item.abstract ?? item.overview ?? "").trim()
  const leafBoost = isLeafLikeMemory(item) ? 0.12 : 0
  const eventBoost = query.wantsTemporal && isEventMemory(item) ? 0.1 : 0
  const preferenceBoost = query.wantsPreference && isPreferencesMemory(item) ? 0.08 : 0
  const overlapBoost = lexicalOverlapBoost(query.tokens, `${item.uri} ${abstract}`)
  return baseScore + leafBoost + eventBoost + preferenceBoost + overlapBoost
}

// ─── Dedup + selection ───

function normalizeDedupeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim()
}

function isEventOrCaseMemory(item: RecallSearchItem): boolean {
  const cat = (item.category ?? "").toLowerCase()
  const uri = item.uri.toLowerCase()
  return cat === "events" || cat === "cases" || uri.includes("/events/") || uri.includes("/cases/")
}

function getMemoryDedupeKey(item: RecallSearchItem): string {
  const abstract = normalizeDedupeText(item.abstract ?? item.overview ?? "")
  const cat = (item.category ?? "").toLowerCase() || "unknown"
  if (abstract && !isEventOrCaseMemory(item)) {
    return `abstract:${cat}:${abstract}`
  }
  return `uri:${item.uri}`
}

function pickMemoriesForInjection(
  items: RecallSearchItem[],
  limit: number,
  queryText: string,
  scoreThreshold: number = 0,
): RecallSearchItem[] {
  if (items.length === 0 || limit <= 0) return []

  const query = buildRecallQueryProfile(queryText)
  const sorted = [...items].sort((a, b) => rankForInjection(b, query) - rankForInjection(a, query))

  const deduped: RecallSearchItem[] = []
  const seen = new Set<string>()
  for (const item of sorted) {
    const key = getMemoryDedupeKey(item)
    if (seen.has(key)) continue
    seen.add(key)
    deduped.push(item)
  }

  // Prefer leaf memories first, then supplement with non-leaf
  const leaves = deduped.filter((item) => isLeafLikeMemory(item))
  if (leaves.length >= limit) return leaves.slice(0, limit)

  const picked = [...leaves]
  const used = new Set(leaves.map((item) => item.uri))
  for (const item of deduped) {
    if (picked.length >= limit) break
    if (used.has(item.uri)) continue
    if (recallClampScore(item.score) < scoreThreshold) continue
    picked.push(item)
  }
  return picked
}

// ─── Post-processing ───

function postProcessMemories(
  items: RecallSearchItem[],
  maxContentChars: number,
  preferAbstract: boolean,
): RecallSearchItem[] {
  return items.map((item) => {
    const abstract = (item.abstract ?? "").trim()
    const content = (item.content ?? "").trim()
    let displayContent: string
    if (preferAbstract && abstract) {
      displayContent = abstract.length > maxContentChars ? abstract.slice(0, maxContentChars) + "..." : abstract
    } else if (content) {
      displayContent = content.length > maxContentChars ? content.slice(0, maxContentChars) + "..." : content
    } else if (abstract) {
      displayContent = abstract.length > maxContentChars ? abstract.slice(0, maxContentChars) + "..." : abstract
    } else {
      displayContent = ""
    }
    return { ...item, content: displayContent, abstract: abstract || undefined }
  })
}

function formatMemoryBlock(
  items: RecallSearchItem[],
  maxChars: number,
  tokenBudget: number,
): string {
  if (items.length === 0) return ""

  const maxBlockChars = tokenBudget * 4 // 4 chars ≈ 1 token
  let usedChars = 0
  const lines: string[] = ["<relevant-memories>"]

  for (const item of items) {
    const title = item.title ? `${item.title}\n` : ""
    const content = item.content ?? ""
    const entry = `<memory uri="${item.uri}">\n${title}${content}\n</memory>`
    const entryChars = entry.length + 1 // +1 for newline

    if (usedChars + entryChars > maxBlockChars) break
    lines.push(entry)
    usedChars += entryChars
  }

  if (usedChars === 0) return ""
  lines.push("</relevant-memories>")
  lines.push("Use the `memread` tool with a memory's URI and level=\"overview\" or level=\"read\" to retrieve more details.")
  return lines.join("\n")
}

// ─── Shared recall logic ───

/**
 * Run the full auto-recall pipeline: search → rank → dedup → format.
 * Returns the formatted injection block or null if no results.
 */
async function runAutoRecall(config: OpenVikingConfig, query: string): Promise<string | null> {
  const rawResults = await performRecallSearch(config, query)
  if (rawResults.length === 0) return null

  const ranked = pickMemoriesForInjection(
    rawResults,
    config.autoRecall?.limit ?? 6,
    query,
    config.autoRecall?.scoreThreshold ?? 0.15,
  )
  if (ranked.length === 0) return null

  const processed = postProcessMemories(
    ranked,
    config.autoRecall?.maxContentChars ?? 500,
    config.autoRecall?.preferAbstract ?? true,
  )

  return formatMemoryBlock(
    processed,
    config.autoRecall?.maxContentChars ?? 500,
    config.autoRecall?.tokenBudget ?? 2000,
  ) || null
}

/** Perform search against OpenViking with a timeout guard. Returns empty on any failure. */
async function performRecallSearch(config: OpenVikingConfig, query: string): Promise<RecallSearchItem[]> {
  try {
    const response = await makeRequest<OpenVikingResponse<{ memories?: RecallSearchItem[]; results?: RecallSearchItem[] }>>(
      config,
      {
        method: "POST",
        endpoint: "/api/v1/search/find",
        body: { query: query.slice(0, 4000), limit: 20, mode: "auto" },
        timeoutMs: AUTO_RECALL_TIMEOUT_MS,
      },
    )
    const result = unwrapResponse(response)
    return result?.memories ?? result?.results ?? []
  } catch {
    return []
  }
}

// ============================================================================
// Message Capture Helpers (pi-specific event adaptation)
// ============================================================================

/** Extract the visible text of a user or assistant message. */
function extractMessageText(message: AgentMessage): string {
  if (message.role === "user") {
    if (typeof message.content === "string") return message.content
    return message.content
      .filter((block): block is TextContent => block.type === "text")
      .map((block) => block.text)
      .join("\n")
  }
  if (message.role === "assistant") {
    return message.content
      .filter((block): block is TextContent => block.type === "text")
      .map((block) => block.text)
      .join("\n")
  }
  return ""
}

/**
 * Pi messages carry no stable ID, so derive one. `timestamp` is fixed at
 * message creation, which keeps the ID stable across streaming
 * `message_update` events and the final `message_end` for the same message.
 */
function makeMessageId(message: AgentMessage): string {
  return `${message.role}:${message.timestamp}`
}

// ============================================================================
// Extension Export
// ============================================================================

export default async function openVikingMemoryExtension(pi: ExtensionAPI): Promise<void> {
  const config = loadConfig()
  initLogger()
  initSessionMapPath()

  if (!config.enabled) {
    console.log("OpenViking Memory Extension is disabled in configuration")
    return
  }

  log("INFO", "extension", "OpenViking Memory Extension initialized", { endpoint: config.endpoint })

  // Load session map from disk
  await loadSessionMap()

  const healthy = await checkServiceHealth(config)
  log("INFO", "health", healthy ? "OpenViking health check passed" : "OpenViking health check failed", {
    endpoint: config.endpoint,
  })

  // ──────────────────────────────────────────────────────────────────────
  // Session lifecycle: create/reuse the OpenViking session when a pi
  // session starts, and commit + clean up when it is torn down.
  //
  // Note: the auto-commit scheduler is deliberately NOT started here — pi's
  // extension docs require that no timers/background resources be created in
  // the factory (it also runs for invocations that never start a session).
  // It starts on session_start instead.
  // ──────────────────────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    startAutoCommit(config) // idempotent

    const sessionId = ctx.sessionManager.getSessionId()
    if (!sessionId) {
      log("ERROR", "event", "session_start event missing sessionId")
      return
    }

    log("INFO", "event", "Pi session started", { session_id: sessionId })

    // Already mapped (e.g. extension reload for the same session): just flush
    // any pending messages; the persisted mapping reconnects to the same
    // OpenViking session.
    const existing = sessionMap.get(sessionId)
    if (existing) {
      await flushPendingMessages(sessionId, existing, config)
      return
    }

    // Create or connect to OpenViking session (non-blocking)
    const ovSessionId = await ensureOpenVikingSession(sessionId, config)
    if (ovSessionId) {
      sessionMap.set(sessionId, {
        ovSessionId,
        createdAt: Date.now(),
        capturedMessages: new Set(),
        messageRoles: new Map(),
        pendingMessages: new Map(),
        sendingMessages: new Set(),
        lastCommitTime: undefined,
        commitInFlight: false,
      })

      // Process buffered messages that arrived before session mapping
      const bufferedMessages = sessionMessageBuffer.get(sessionId)
      if (bufferedMessages && bufferedMessages.length > 0) {
        log("INFO", "event", "Processing buffered messages", {
          session_id: sessionId,
          count: bufferedMessages.length,
        })

        const mapping = sessionMap.get(sessionId)!
        for (const buffered of bufferedMessages) {
          // Store role if available
          if (buffered.role) {
            mapping.messageRoles.set(buffered.messageId, buffered.role)
          }
          // Store content as pending if available
          if (buffered.content) {
            mapping.pendingMessages.set(
              buffered.messageId,
              mergeMessageContent(mapping.pendingMessages.get(buffered.messageId), buffered.content),
            )
          }
        }

        await flushPendingMessages(sessionId, mapping, config)

        // Clear buffer
        sessionMessageBuffer.delete(sessionId)
      }

      debouncedSaveSessionMap()
      log("INFO", "event", "Session mapping established", {
        pi_session: sessionId,
        openviking_session: ovSessionId,
      })
    } else {
      log("ERROR", "event", "Failed to establish session mapping", {
        session_id: sessionId,
      })
    }
  })

  pi.on("session_shutdown", async (event, ctx) => {
    // pi tears down the extension runtime on quit, reload, and session
    // replacement. Mirrors the source plugin's session.deleted + stop logic.
    stopAutoCommit()

    const sessionId = ctx.sessionManager.getSessionId()
    if (!sessionId) return

    const mapping = sessionMap.get(sessionId)
    if (mapping) {
      await flushPendingMessages(sessionId, mapping, config)

      if (mapping.capturedMessages.size > 0 || mapping.commitInFlight) {
        // On reload the same pi session continues in a fresh extension
        // instance, so KEEP the mapping (the new instance reconnects to the
        // same OpenViking session via the persisted map). For quit and
        // session replacement the mapping is cleaned up once the commit
        // completes.
        if (event.reason !== "reload") {
          mapping.pendingCleanup = true
        }
        if (!mapping.commitInFlight) {
          await startBackgroundCommit(mapping, sessionId, config)
        }
      } else if (event.reason !== "reload") {
        sessionMap.delete(sessionId)
        sessionMessageBuffer.delete(sessionId) // Clean up buffer
        await saveSessionMap()
        log("INFO", "event", "Session mapping removed", {
          pi_session: sessionId,
          openviking_session: mapping.ovSessionId,
        })
      }
    }

    // Flush any pending debounced save (mirrors the source's stop hook) so
    // in-flight commit state survives the instance teardown
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
    await saveSessionMap()

    log("INFO", "event", "Pi session shutdown handled", {
      session_id: sessionId,
      reason: event.reason,
    })
  })

  // ──────────────────────────────────────────────────────────────────────
  // Message capture: pi has no session.created ordering guarantee relative
  // to message events on resume, so content captured before a mapping exists
  // is buffered (same dedup/pending/buffer logic as the source).
  // ──────────────────────────────────────────────────────────────────────

  pi.on("message_start", async (event, ctx) => {
    const message = event.message
    if (message.role !== "user" && message.role !== "assistant") return

    const sessionId = ctx.sessionManager.getSessionId()
    if (!sessionId) return

    const messageId = makeMessageId(message)
    const mapping = sessionMap.get(sessionId)

    if (!mapping) {
      // Buffer role until session mapping exists
      upsertBufferedMessage(sessionId, messageId, { role: message.role })
      return
    }

    // Mirrors the source's message.updated role storage: user roles are
    // stored immediately; assistant roles only when the message completes
    // (handled in message_end where stopReason is available).
    if (message.role === "user" && !mapping.messageRoles.has(messageId)) {
      mapping.messageRoles.set(messageId, message.role)
    }
  })

  // Assistant streaming updates: capture partial text into pendingMessages so
  // a crash mid-stream still leaves the partial content pending (mirrors the
  // source's message.part.updated streaming capture).
  pi.on("message_update", async (event, ctx) => {
    const message = event.message
    if (message.role !== "assistant") return

    const sessionId = ctx.sessionManager.getSessionId()
    if (!sessionId) return

    const text = extractMessageText(message)
    if (!text.trim()) return

    const messageId = makeMessageId(message)
    const mapping = sessionMap.get(sessionId)

    if (!mapping) {
      upsertBufferedMessage(sessionId, messageId, { content: text })
      return
    }

    if (mapping.capturedMessages.has(messageId)) return

    mapping.pendingMessages.set(
      messageId,
      mergeMessageContent(mapping.pendingMessages.get(messageId), text),
    )
  })

  pi.on("message_end", async (event, ctx) => {
    const message = event.message
    if (message.role !== "user" && message.role !== "assistant") return

    const sessionId = ctx.sessionManager.getSessionId()
    if (!sessionId) return

    const messageId = makeMessageId(message)
    const text = extractMessageText(message)
    const mapping = sessionMap.get(sessionId)

    if (!mapping) {
      // Buffer this message for later processing
      upsertBufferedMessage(sessionId, messageId, message.role ? { role: message.role } : {})
      if (text.trim()) {
        upsertBufferedMessage(sessionId, messageId, { content: text })
      }
      log("DEBUG", "message", "Message buffered (no session mapping yet)", {
        session_id: sessionId,
        message_id: messageId,
        role: message.role,
      })
      return
    }

    // Role storage: assistant role only when the message finished normally
    // (matches the source's `finish === "stop"` condition)
    if (message.role === "user") {
      if (!mapping.messageRoles.has(messageId)) {
        mapping.messageRoles.set(messageId, "user")
      }
    } else if (message.role === "assistant" && message.stopReason === "stop") {
      mapping.messageRoles.set(messageId, "assistant")
    }

    // Capture final text as pending (final content overrides the streaming
    // partial captured in message_update via mergeMessageContent)
    if (text.trim() && !mapping.capturedMessages.has(messageId)) {
      mapping.pendingMessages.set(
        messageId,
        mergeMessageContent(mapping.pendingMessages.get(messageId), text),
      )
    }

    await flushPendingMessages(sessionId, mapping, config)
  })

  // ──────────────────────────────────────────────────────────────────────
  // Auto-recall: search OpenViking on every user prompt and inject a
  // <relevant-memories> block into the MODEL's context only.
  //
  // pi's before_agent_start result `message` becomes a role:"custom" message
  // in the LLM context (custom messages convert to user-role messages).
  // display:false means the TUI does not render it (see plan-mode example),
  // exactly like opencode's synthetic text part.
  // ──────────────────────────────────────────────────────────────────────

  let lastRecallPrompt: string | null = null
  let lastRecallAt = 0
  const RECALL_IDEMPOTENCY_MS = 60_000

  pi.on("before_agent_start", async (event) => {
    try {
      if (!config.autoRecall?.enabled) return

      const query = (event.prompt ?? "").trim()
      if (!query) return

      // Idempotency: before_agent_start can re-fire for the same prompt
      // (e.g. compaction-retry); skip if a recall block for this turn was
      // already injected.
      const now = Date.now()
      if (query === lastRecallPrompt && now - lastRecallAt < RECALL_IDEMPOTENCY_MS) return

      const block = await runAutoRecall(config, query)
      if (!block) return

      lastRecallPrompt = query
      lastRecallAt = now

      return {
        message: {
          customType: "openviking-recall",
          content: block,
          display: false,
        },
      }
    } catch (error: any) {
      log("ERROR", "recall", "Auto recall failed in before_agent_start, skipping silently", {
        error: error?.message ?? String(error),
      })
    }
  })

  // ──────────────────────────────────────────────────────────────────────
  // viking:// interception: block pi's built-in read/grep/find tools when
  // their path argument is a viking:// URI and redirect to the OpenViking
  // tools. pi-agent-core turns a blocked tool call into an error tool result
  // whose content is `reason` (visible to the model) — equivalent to the
  // source's tool.execute.before throwing.
  // ──────────────────────────────────────────────────────────────────────

  pi.on("tool_call", async (event) => {
    if (event.toolName !== "read" && event.toolName !== "grep" && event.toolName !== "find") return

    const input = event.input as Record<string, unknown>
    // read uses `path` (legacy alias `file_path`); grep/find use `path`
    const filePath = input?.path ?? input?.file_path ?? ""
    if (typeof filePath !== "string" || !filePath.startsWith("viking://")) return

    const uri = filePath as string

    if (event.toolName === "read") {
      log("INFO", "hook", "Redirecting read -> memread for viking:// URI", { uri })
      return {
        block: true,
        reason:
          `viking:// URIs are not filesystem paths. Use the "memread" tool instead.\n` +
          `Example: memread(uri="${uri}", level="auto")`,
      }
    }

    if (event.toolName === "find") {
      log("INFO", "hook", "Redirecting find -> membrowse for viking:// URI", { uri })
      return {
        block: true,
        reason:
          `viking:// URIs are not filesystem paths. Use the "membrowse" tool instead.\n` +
          `Example: membrowse(uri="${uri}", view="list", recursive=true)`,
      }
    }

    if (event.toolName === "grep") {
      const query = input?.pattern ?? ""
      log("INFO", "hook", "Redirecting grep -> memsearch for viking:// URI", { uri, query })
      return {
        block: true,
        reason:
          `viking:// URIs are not filesystem paths. Use the "memsearch" tool to search memories.\n` +
          `Example: memsearch(query="${query}", target_uri="${uri}")`,
      }
    }
  })

  // ==========================================================================
  // Tools
  // ==========================================================================

  // Helper: the source returns plain strings (including "Error: ..." text)
  // as tool output; replicate that exact semantics as pi tool content.
  function textResult(text: string): AgentToolResult {
    return { content: [{ type: "text", text }] } as AgentToolResult
  }

  pi.registerTool({
    name: "memread",
    label: "Memory Read",
    description:
      "Retrieve the content of a specific memory, resource, or skill at a given viking:// URI.\n\nProgressive loading levels:\n- abstract: brief summary\n- overview: structured directory overview\n- read: full content\n- auto: choose overview for directories and read for files\n\nUse when:\n- You have a URI from memsearch or membrowse\n- You need to inspect a memory, resource, or skill in more detail\n\nRequires: Complete viking:// URI (e.g., viking://user/memories/profile.md)",
    parameters: Type.Object({
      uri: Type.String({
        description:
          "Complete viking:// URI from search results or list output (e.g., viking://user/memories/profile.md, viking://agent/memories/context.md)",
      }),
      level: Type.Optional(
        StringEnum(["auto", "abstract", "overview", "read"] as const, {
          description: "'auto' (directory->overview, file->read), 'abstract' (brief summary), 'overview' (directory summary), 'read' (full content)",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      log("INFO", "memread", "Reading memory", { uri: params.uri, level: params.level })

      // Validate URI format
      const validationError = validateVikingUri(params.uri, "memread")
      if (validationError) return textResult(validationError)

      try {
        let level = params.level ?? "auto"
        if (level === "auto") {
          try {
            const statResponse = await makeRequest<OpenVikingResponse<{ isDir?: boolean }>>(config, {
              method: "GET",
              endpoint: `/api/v1/fs/stat?uri=${encodeURIComponent(params.uri)}`,
              abortSignal: signal,
            })
            const statResult = unwrapResponse(statResponse)
            level = statResult?.isDir ? "overview" : "read"
          } catch {
            level = "read"
          }
        }

        const response = await makeRequest<OpenVikingResponse<string | Record<string, unknown>>>(config, {
          method: "GET",
          endpoint: `/api/v1/content/${level}?uri=${encodeURIComponent(params.uri)}`,
          abortSignal: signal,
        })

        const content = unwrapResponse(response)
        if (!content) {
          log("INFO", "memread", "No content found", { uri: params.uri })
          return textResult(`No content found at ${params.uri}`)
        }

        log("INFO", "memread", "Read completed", { uri: params.uri, level })
        return textResult(typeof content === "string" ? content : JSON.stringify(content, null, 2))
      } catch (error: any) {
        log("ERROR", "memread", "Read failed", { error: error.message, uri: params.uri })
        return textResult(`Error: ${error.message}`)
      }
    },
  })

  pi.registerTool({
    name: "membrowse",
    label: "Memory Browse",
    description:
      "Browse the OpenViking filesystem structure for a specific URI.\n\nViews:\n- list: list immediate children, or recurse when `recursive=true`\n- tree: return a directory tree view\n- stat: return metadata for a single file or directory\n\nUse when:\n- You need to discover available URIs before reading\n- You want to inspect directory structure under memories/resources/skills\n- You need file metadata before deciding how to read it\n\nRequires: Complete viking:// URI",
    parameters: Type.Object({
      uri: Type.String({
        description:
          "Complete viking:// URI to inspect (e.g., viking://user/memories/, viking://agent/memories/, viking://resources/zh/)",
      }),
      view: Type.Optional(
        StringEnum(["list", "tree", "stat"] as const, {
          description: "'list' for directory listing, 'tree' for recursive tree view, 'stat' for metadata on a single URI",
        }),
      ),
      recursive: Type.Optional(
        Type.Boolean({ description: "Only used with view='list'. Recursively list descendants." }),
      ),
      simple: Type.Optional(
        Type.Boolean({ description: "Only used with view='list'. Return simpler URI-oriented output." }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      log("INFO", "membrowse", "Browsing URI", { args: params })

      // Validate URI format
      const validationError = validateVikingUri(params.uri, "membrowse")
      if (validationError) return textResult(validationError)

      try {
        const view = params.view ?? "list"
        const encodedUri = encodeURIComponent(params.uri)

        if (view === "stat") {
          const response = await makeRequest<OpenVikingResponse<Record<string, unknown>>>(config, {
            method: "GET",
            endpoint: `/api/v1/fs/stat?uri=${encodedUri}`,
            abortSignal: signal,
          })
          const result = unwrapResponse(response)
          return textResult(JSON.stringify({ view, item: result }, null, 2))
        }

        const endpoint = view === "tree"
          ? `/api/v1/fs/tree?uri=${encodedUri}`
          : `/api/v1/fs/ls?uri=${encodedUri}&recursive=${params.recursive ? "true" : "false"}&simple=${params.simple ? "true" : "false"}`
        const response = await makeRequest<OpenVikingResponse<any[]>>(config, {
          method: "GET",
          endpoint,
          abortSignal: signal,
        })

        const result = unwrapResponse(response)
        const items = Array.isArray(result) ? result : []
        if (items.length === 0) {
          return textResult(`No items found at ${params.uri}`)
        }

        return textResult(JSON.stringify({ view, count: items.length, items }, null, 2))
      } catch (error: any) {
        log("ERROR", "membrowse", "Browse failed", { error: error.message, uri: params.uri })
        return textResult(`Error: ${error.message}`)
      }
    },
  })

  pi.registerTool({
    name: "memcommit",
    label: "Memory Commit",
    description:
      "Commit the current pi session to OpenViking and extract persistent memories from the accumulated conversation.\n\nBy default this tool commits the OpenViking session mapped to the current pi session. Use `session_id` only when you need to target a specific OpenViking session manually.\n\nUse when:\n- You want a mid-session memory extraction without ending the chat\n- You want recently discussed preferences, entities, or cases persisted immediately\n\nAutomatically extracts and stores:\n- User profile, preferences, entities, events → viking://user/memories/\n- Agent cases and patterns → viking://agent/memories/\n\nReturns background commit progress or completion details, including task_id, memories_extracted, and archived.",
    parameters: Type.Object({
      session_id: Type.Optional(
        Type.String({
          description:
            "Optional explicit OpenViking session ID. Omit to commit the current pi session's mapped OpenViking session.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const piSessionId = ctx.sessionManager.getSessionId()

      let sessionId = params.session_id
      if (!sessionId && piSessionId) {
        const mapping = sessionMap.get(piSessionId)
        if (mapping) {
          sessionId = mapping.ovSessionId
        }
      }

      log("INFO", "memcommit", "Committing session", {
        requested_session_id: params.session_id,
        resolved_session_id: sessionId,
        pi_session_id: piSessionId,
      })

      if (!sessionId) {
        return textResult("Error: No OpenViking session is associated with the current pi session. Start or resume a normal pi session first, or pass an explicit session_id.")
      }

      try {
        const mapping = piSessionId ? sessionMap.get(piSessionId) : undefined
        const resolvedMapping = mapping?.ovSessionId === sessionId ? mapping : undefined

        if (resolvedMapping) {
          await flushPendingMessages(
            piSessionId ?? sessionId,
            resolvedMapping,
            config,
          )
        }

        if (resolvedMapping?.commitInFlight) {
          const task = await waitForCommitCompletion(
            resolvedMapping,
            piSessionId ?? sessionId,
            config,
            signal,
          )
          if (task?.status === "completed") {
            const memoriesExtracted = totalMemoriesFromResult(task.result)
            return textResult(JSON.stringify(
              {
                message: `Memory extraction complete: ${memoriesExtracted} memories extracted`,
                session_id: task.result?.session_id ?? sessionId,
                status: task.status,
                memories_extracted: memoriesExtracted,
                archived: task.result?.archived ?? false,
                task_id: task.task_id,
              },
              null,
              2,
            ))
          }
        }

        const tempMapping: SessionMapping = resolvedMapping ?? {
          ovSessionId: sessionId,
          createdAt: Date.now(),
          capturedMessages: new Set(),
          messageRoles: new Map(),
          pendingMessages: new Map(),
          sendingMessages: new Set(),
        }

        const commitStart = await startBackgroundCommit(
          tempMapping,
          piSessionId ?? sessionId,
          config,
          signal,
        )
        if (!commitStart) {
          throw new Error("Failed to start background commit")
        }

        if (commitStart.mode === "completed") {
          const memoriesExtracted = totalMemoriesFromResult(commitStart.result)
          return textResult(JSON.stringify(
            {
              message: `Memory extraction complete: ${memoriesExtracted} memories extracted`,
              session_id: commitStart.result.session_id ?? sessionId,
              status: commitStart.result.status ?? "completed",
              memories_extracted: memoriesExtracted,
              archived: commitStart.result.archived ?? false,
            },
            null,
            2,
          ))
        }

        const task = await waitForCommitCompletion(
          tempMapping,
          piSessionId ?? sessionId,
          config,
          signal,
        )

        if (!task) {
          return textResult(JSON.stringify(
            {
              message: "Commit is still processing in the background",
              session_id: sessionId,
              status: "accepted",
              task_id: commitStart.taskId,
            },
            null,
            2,
          ))
        }

        const memoriesExtracted = totalMemoriesFromResult(task.result)
        return textResult(JSON.stringify(
          {
            message: `Memory extraction complete: ${memoriesExtracted} memories extracted`,
            session_id: task.result?.session_id ?? sessionId,
            status: task.status,
            memories_extracted: memoriesExtracted,
            archived: task.result?.archived ?? false,
            task_id: task.task_id,
          },
          null,
          2,
        ))
      } catch (error: any) {
        log("ERROR", "memcommit", "Commit failed", {
          error: error.message,
          session_id: sessionId,
        })
        return textResult(`Error: ${error.message}`)
      }
    },
  })

  pi.registerTool({
    name: "memsearch",
    label: "Memory Search",
    description:
      "Search OpenViking memories, resources, and skills through a unified interface.\n\nModes:\n- auto: choose between fast similarity search and deep context-aware search\n- fast: use simple semantic similarity search\n- deep: use intent analysis and optional session context\n\nReturns memories, resources, and skills with relevance scores and match reasons.\n\nUse when:\n- You want to find relevant memories or resources by meaning\n- You need a single search tool instead of choosing between low-level APIs\n- You want deeper retrieval for complex or ambiguous questions",
    parameters: Type.Object({
      query: Type.String({
        description: "Search query - can be natural language, a complex question, or a task description",
      }),
      target_uri: Type.Optional(
        Type.String({
          description:
            "Limit search to a specific URI prefix (e.g., viking://resources/, viking://user/memories/). Omit to search all contexts.",
        }),
      ),
      mode: Type.Optional(
        StringEnum(["auto", "fast", "deep"] as const, {
          description: "Search mode. 'auto' chooses based on query complexity and session context, 'fast' forces /find, 'deep' forces /search",
        }),
      ),
      session_id: Type.Optional(
        Type.String({
          description:
            "Optional OpenViking session ID for context-aware search. If omitted in auto/deep mode, the current pi session mapping will be used when available.",
        }),
      ),
      limit: Type.Optional(Type.Number({ description: "Max results (default: 10)" })),
      score_threshold: Type.Optional(Type.Number({ description: "Optional minimum score threshold" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      log("INFO", "memsearch", "Executing unified search", { args: params })

      const piSessionId = ctx.sessionManager.getSessionId()

      // Auto-inject session_id if not provided
      let sessionId = params.session_id
      if (!sessionId && piSessionId) {
        const mapping = sessionMap.get(piSessionId)
        if (mapping) {
          sessionId = mapping.ovSessionId
          log("INFO", "memsearch", "Auto-injected session context", {
            pi_session: piSessionId,
            openviking_session: sessionId,
          })
        }
      }

      const mode = resolveSearchMode(params.mode, params.query, sessionId)
      const requestBody: {
        query: string
        limit: number
        target_uri?: string
        session_id?: string
        score_threshold?: number
      } = {
        query: params.query,
        limit: params.limit ?? 10,
      }
      if (params.target_uri) requestBody.target_uri = params.target_uri
      if (params.score_threshold !== undefined) requestBody.score_threshold = params.score_threshold
      if (mode === "deep" && sessionId) requestBody.session_id = sessionId

      try {
        const response = await makeRequest<OpenVikingResponse<SearchResult>>(config, {
          method: "POST",
          endpoint: mode === "deep" ? "/api/v1/search/search" : "/api/v1/search/find",
          body: requestBody,
          abortSignal: signal,
        })

        const result = unwrapResponse(response) ?? { memories: [], resources: [], skills: [], total: 0 }
        return textResult(formatSearchResults(result, "memsearch", params.query, {
          mode,
          query_plan: result.query_plan,
        }))
      } catch (error: any) {
        log("ERROR", "memsearch", "Search failed", { error: error.message, args: params })
        return textResult(`Error: ${error.message}`)
      }
    },
  })

  pi.registerTool({
    name: "memwrite",
    label: "Memory Write",
    description:
      "Write content to a specific file in OpenViking memory at a given viking:// URI.\n\nModes:\n- replace: overwrite existing file content entirely (default)\n- append: add content to the end of an existing file\n- create: create a new file, failing if it already exists\n\nUse when:\n- You want to manually write or update a memory, resource, or knowledge entry\n- You need to store information that wasn't captured through conversation\n- You want to correct or supplement existing memory content\n\nRequires: Complete viking:// URI pointing to a file (not directory).\nParent directories are created automatically if they don't exist.",
    parameters: Type.Object({
      uri: Type.String({
        description:
          "Complete viking:// URI for the file to write (e.g., viking://user/memories/notes.md, viking://resources/knowledge/api-design.md)",
      }),
      content: Type.String({
        description: "The content to write to the file",
      }),
      mode: Type.Optional(
        StringEnum(["replace", "append", "create"] as const, {
          description: "Write mode. 'replace' overwrites the file, 'append' adds to the end, 'create' fails if the file already exists. Default: replace",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      log("INFO", "memwrite", "Writing content", { uri: params.uri, mode: params.mode })

      const validationError = validateVikingUri(params.uri, "memwrite")
      if (validationError) return textResult(validationError)

      try {
        const writeMode = params.mode ?? "replace"

        // For "create" mode: check that the file does NOT already exist
        if (writeMode === "create") {
          try {
            const statResult = await makeRequest<OpenVikingResponse<{ isDir?: boolean }>>(config, {
              method: "GET",
              endpoint: `/api/v1/fs/stat?uri=${encodeURIComponent(params.uri)}`,
              abortSignal: signal,
            })
            if (statResult && statResult.status === "ok" && statResult.result) {
              return textResult(`Error: File already exists at ${params.uri}. Use mode="replace" to overwrite or mode="append" to add content.`)
            }
          } catch {
            // File does not exist, proceed with create
          }
        }

        // Auto-create parent directories
        const uriPath = params.uri.replace(/\/[^/]+$/, "")
        try {
          await makeRequest(config, {
            method: "POST",
            endpoint: "/api/v1/fs/mkdir",
            body: { uri: uriPath },
            abortSignal: signal,
          })
          log("INFO", "memwrite", "Ensured parent directory exists", { parentUri: uriPath })
        } catch (mkdirError: any) {
          // Directory may already exist, skip silently
          log("INFO", "memwrite", "mkdir skipped", { error: mkdirError.message })
        }

        const response = await makeRequest<OpenVikingResponse<{
          uri: string
          root_uri: string
          context_type: string
          mode: string
          written_bytes: number
          semantic_updated: boolean
          vector_updated: boolean
          queue_status: string
        }>>(config, {
          method: "POST",
          endpoint: "/api/v1/content/write",
          body: {
            uri: params.uri,
            content: params.content,
            mode: writeMode,
            wait: true,
          },
          abortSignal: signal,
        })

        const result = unwrapResponse(response)
        if (!result) return textResult("Error: No response from write operation")

        return textResult([
          `Written successfully to ${result.uri}`,
          `  Bytes: ${result.written_bytes}`,
          `  Mode: ${result.mode}`,
          `  Semantic updated: ${result.semantic_updated}`,
          `  Vector updated: ${result.vector_updated}`,
          `  Queue: ${result.queue_status}`,
        ].join("\n"))
      } catch (error: any) {
        log("ERROR", "memwrite", "Write failed", { error: error.message, args: params })
        return textResult(`Error: ${error.message}`)
      }
    },
  })

  pi.registerTool({
    name: "memimport",
    label: "Memory Import",
    description:
      "Import resources into OpenViking knowledge base.\n\nSupports:\n- Remote URLs (http/https) — passed directly to the server\n- Local files — uploaded automatically via temp_upload\n- Local directories — zip first, then pass the .zip path\n\nContent is automatically parsed, indexed, and made searchable.\nIncremental updates supported when specifying a target URI that already exists.\n\nUse when:\n- You want to import documentation, articles, or reference materials\n- You need to add external or local knowledge to the memory system\n- You want to update existing resources with newer content",
    parameters: Type.Object({
      path: Type.String({
        description:
          "URL or local file path to import. URLs are fetched server-side; local files are uploaded first. For directories, zip them and pass the .zip path.",
      }),
      to: Type.Optional(
        Type.String({
          description:
            "Target viking:// URI for the imported resource (must be in resources scope, e.g., viking://resources/docs/somethin.md). Omit for auto-placement.",
        }),
      ),
      reason: Type.Optional(
        Type.String({
          description: "Reason for adding this resource (improves search relevance)",
        }),
      ),
      wait: Type.Optional(
        Type.Boolean({
          description: "Wait for semantic processing to complete. Default: false",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      log("INFO", "memimport", "Importing resource", { path: params.path, to: params.to })

      try {
        const isUrl = /^https?:\/\//i.test(params.path)
        let isLocalFile = false
        if (!isUrl) {
          try {
            await fs.promises.access(params.path)
            isLocalFile = true
          } catch {
            isLocalFile = false
          }
        }

        let requestBody: {
          path?: string
          temp_file_id?: string
          to?: string
          reason?: string
          wait: boolean
        } = {
          wait: params.wait ?? false,
        }

        if (isUrl) {
          requestBody.path = params.path
        } else if (isLocalFile) {
          const stats = await fs.promises.stat(params.path)
          if (stats.isDirectory()) {
            return textResult("Error: Directory import is not supported directly. Please zip the directory first (e.g., `zip -r archive.zip ./my-dir`) and pass the .zip file path.")
          }
          log("INFO", "memimport", "Uploading local file", { path: params.path, size: stats.size })
          const tempFileId = await uploadLocalFile(config, params.path)
          requestBody.temp_file_id = tempFileId
        } else {
          return textResult(`Error: Path not found or not a valid URL: ${params.path}`)
        }

        if (params.to) requestBody.to = params.to
        if (params.reason) requestBody.reason = params.reason

        const response = await makeRequest<OpenVikingResponse<{
          status: string
          root_uri: string
          source_path: string
          errors: string[]
        }>>(config, {
          method: "POST",
          endpoint: "/api/v1/resources",
          body: requestBody,
          abortSignal: signal,
        })

        const result = unwrapResponse(response)
        if (!result) return textResult("Error: No response from import operation")

        if (result.errors && result.errors.length > 0) {
          return textResult([
            "Import completed with errors:",
            `  Status: ${result.status}`,
            `  URI: ${result.root_uri}`,
            `  Source: ${result.source_path}`,
            `  Errors: ${result.errors.join(", ")}`,
          ].join("\n"))
        }

        return textResult([
          "Imported successfully:",
          `  Status: ${result.status}`,
          `  URI: ${result.root_uri}`,
          `  Source: ${result.source_path}`,
        ].join("\n"))
      } catch (error: any) {
        log("ERROR", "memimport", "Import failed", { error: error.message, args: params })
        return textResult(`Error: ${error.message}`)
      }
    },
  })

  log("INFO", "extension", "OpenViking Memory Extension registered", {
    endpoint: config.endpoint,
    tools: ["memread", "membrowse", "memcommit", "memsearch", "memwrite", "memimport"],
  })
}
