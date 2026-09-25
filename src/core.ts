import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"

const require = createRequire(import.meta.url)

export interface Config {
  accessToken: string
  accountId?: string
  source: "opencode-db" | "codex"
}

export interface UsageWindowPayload {
  used_percent?: unknown
  limit_window_seconds?: unknown
  reset_after_seconds?: unknown
  reset_at?: unknown
}

export interface UsagePayload {
  plan_type?: unknown
  rate_limit?: unknown
  additional_rate_limits?: unknown
  credits?: unknown
  rate_limit_reset_credits?: unknown
}

export interface NormalizedWindow {
  label: string
  usedPercent: number
  windowSeconds: number
  resetInSec: number
  limitReached: boolean
}

export interface Credits {
  hasCredits: boolean
  unlimited: boolean
  balance: string
}

export interface NormalizedPayload {
  plan?: string
  windows: NormalizedWindow[]
  credits?: Credits
  resetCredits?: number
  error?: string
}

export const DEFAULT_CODEX_AUTH_FILE = join(homedir(), ".codex", "auth.json")
export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"
export const CODEX_USAGE_TIMEOUT_MS = 15_000
const DASHBOARD_URL = "https://chatgpt.com/codex/settings/usage"

export type UsageFailure =
  | "disabled"
  | "no-config"
  | "unauthorized"
  | "rate-limited"
  | "http-error"
  | "unexpected-response"
  | "timeout"
  | "request-failed"

export type UsageRequestResult =
  | { ok: true; payload: UsagePayload }
  | { ok: false; reason: UsageFailure; status?: number }

type UsageFetcher = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal; redirect: "error" },
) => Promise<Response>

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export function toNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (typeof value !== "string" || !value.trim()) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function toStringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const result = toStringValue(value)
    if (result) return result
  }
  return undefined
}

export function getDefaultOpenCodeDbPath(): string {
  if (process.env.OPENCODE_DB_PATH) {
    return resolve(process.env.OPENCODE_DB_PATH)
  }
  const xdgData = process.env.XDG_DATA_HOME
  if (xdgData && xdgData.trim()) {
    return join(xdgData.trim(), "opencode", "opencode.db")
  }
  return join(homedir(), ".local", "share", "opencode", "opencode.db")
}

function queryOpenCodeDb(dbPath: string): { value: string } | null {
  if (!existsSync(dbPath)) return null

  // 1. Try bun:sqlite
  if (typeof (globalThis as any).Bun !== "undefined") {
    try {
      const { Database } = require("bun:sqlite")
      const db = new Database(dbPath, { readonly: true })
      try {
        const row = db
          .query(
            "SELECT value FROM credential WHERE integration_id = 'openai' ORDER BY active DESC, time_updated DESC LIMIT 1",
          )
          .get() as { value: string } | null
        return row
      } finally {
        db.close()
      }
    } catch {
      // Fall through to node:sqlite
    }
  }

  // 2. Try node:sqlite
  try {
    const { DatabaseSync } = require("node:sqlite")
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      const stmt = db.prepare(
        "SELECT value FROM credential WHERE integration_id = 'openai' ORDER BY active DESC, time_updated DESC LIMIT 1",
      )
      const row = stmt.get() as { value: string } | undefined
      return row ?? null
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

export function loadConfigFromOpenCodeDb(dbPath: string = getDefaultOpenCodeDbPath()): Config | null {
  try {
    const row = queryOpenCodeDb(dbPath)
    if (!row || !row.value) return null
    const parsed = JSON.parse(row.value) as unknown
    if (!isRecord(parsed)) return null

    const accessToken = firstString(parsed.access, parsed.access_token, parsed.accessToken)
    if (!accessToken) return null

    let accountId: string | undefined
    if (isRecord(parsed.metadata)) {
      accountId = firstString(parsed.metadata.accountID, parsed.metadata.accountId)
    }
    if (!accountId) {
      accountId = firstString(parsed.account_id, parsed.accountId)
    }

    return accountId ? { accessToken, accountId, source: "opencode-db" } : { accessToken, source: "opencode-db" }
  } catch {
    return null
  }
}

function isTrustedCodexAuthFile(path: string): boolean {
  if (path !== DEFAULT_CODEX_AUTH_FILE) return false
  const directory = dirname(path)
  try {
    const directoryStats = lstatSync(directory)
    const fileStats = lstatSync(path)
    if (
      directoryStats.isSymbolicLink() ||
      !directoryStats.isDirectory() ||
      fileStats.isSymbolicLink() ||
      !fileStats.isFile() ||
      fileStats.nlink > 1
    ) {
      return false
    }
    const compare = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value)
    if (
      compare(resolve(directory)) !== compare(resolve(realpathSync(directory))) ||
      compare(resolve(path)) !== compare(resolve(realpathSync(path)))
    ) {
      return false
    }
    return process.platform === "win32" || (fileStats.mode & 0o077) === 0
  } catch {
    return false
  }
}

export function loadConfigFromCodexAuthFile(
  readFile: (path: string, encoding: "utf8") => string = (path) => readFileSync(path, "utf8"),
  isTrustedFile: (path: string) => boolean = isTrustedCodexAuthFile,
): Config | null {
  try {
    if (!isTrustedFile(DEFAULT_CODEX_AUTH_FILE)) return null
    const parsed = JSON.parse(readFile(DEFAULT_CODEX_AUTH_FILE, "utf8")) as unknown
    if (!isRecord(parsed) || !isRecord(parsed.tokens)) return null
    const accessToken = firstString(parsed.tokens.access_token, parsed.tokens.accessToken)
    if (!accessToken) return null
    const accountId = firstString(parsed.tokens.account_id, parsed.tokens.accountId)
    return accountId ? { accessToken, accountId, source: "codex" } : { accessToken, source: "codex" }
  } catch {
    return null
  }
}

export function loadConfig(options?: {
  dbPath?: string
  readCodexFile?: (path: string, encoding: "utf8") => string
  isTrustedCodexFile?: (path: string) => boolean
}): Config | null {
  // 1. Primary: load from OpenCode database
  const fromDb = loadConfigFromOpenCodeDb(options?.dbPath)
  if (fromDb) return fromDb

  // 2. Fallback: load from ~/.codex/auth.json
  const fromCodex = loadConfigFromCodexAuthFile(options?.readCodexFile, options?.isTrustedCodexFile)
  if (fromCodex) return fromCodex

  return null
}

export function isUsageDisabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.OPENCODE_CODEX_USAGE_DISABLED?.trim().toLowerCase() === "true"
}

export async function fetchUsage(
  options: {
    readConfig?: () => Config | null
    fetchImpl?: UsageFetcher
    timeoutMs?: number
    disabled?: boolean
  } = {},
): Promise<UsageRequestResult> {
  if (options.disabled ?? isUsageDisabled()) return { ok: false, reason: "disabled" }
  let config: Config | null
  try {
    config = (options.readConfig ?? (() => loadConfig()))()
  } catch {
    return { ok: false, reason: "no-config" }
  }
  if (!config) return { ok: false, reason: "no-config" }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis)
  if (!fetchImpl) return { ok: false, reason: "request-failed" }

  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${config.accessToken}`,
    Referer: DASHBOARD_URL,
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  }
  if (config.accountId) {
    headers["ChatGPT-Account-ID"] = config.accountId
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? CODEX_USAGE_TIMEOUT_MS)
  try {
    const response = await fetchImpl(CODEX_USAGE_URL, {
      headers,
      signal: controller.signal,
      redirect: "error",
    })
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: "unauthorized", status: response.status }
    }
    if (response.status === 429) {
      return { ok: false, reason: "rate-limited", status: response.status }
    }
    if (!response.ok) {
      return { ok: false, reason: "http-error", status: response.status }
    }
    if (!(response.headers.get("content-type") ?? "").includes("application/json")) {
      return { ok: false, reason: "unexpected-response" }
    }
    let raw: unknown
    try {
      raw = await response.json()
    } catch {
      return { ok: false, reason: "unexpected-response" }
    }
    return isRecord(raw) ? { ok: true, payload: raw as UsagePayload } : { ok: false, reason: "unexpected-response" }
  } catch {
    return { ok: false, reason: controller.signal.aborted ? "timeout" : "request-failed" }
  } finally {
    clearTimeout(timeout)
  }
}

function resetInSeconds(window: UsageWindowPayload): number {
  const resetAfter = toNumber(window.reset_after_seconds)
  if (resetAfter !== undefined) return Math.max(0, Math.floor(resetAfter))
  const resetAt = toNumber(window.reset_at)
  if (resetAt === undefined) return 0
  const resetAtMs = resetAt > 1_000_000_000_000 ? resetAt : resetAt * 1000
  return Math.max(0, Math.floor((resetAtMs - Date.now()) / 1000))
}

function labelForWindow(seconds: number, fallback: string): string {
  if (seconds <= 6 * 3600) return "5h"
  if (seconds >= 6 * 86400 && seconds <= 8 * 86400) return "Weekly"
  if (seconds >= 27 * 86400 && seconds <= 32 * 86400) return "Monthly"
  if (seconds >= 86400) return `${Math.round(seconds / 86400)}d`
  return fallback
}

function normalizeWindow(label: string, window: unknown, limitReached: boolean): NormalizedWindow | null {
  if (!isRecord(window)) return null
  const usedPercent = toNumber(window.used_percent)
  const windowSeconds = toNumber(window.limit_window_seconds)
  if (usedPercent === undefined || windowSeconds === undefined || windowSeconds < 0) return null
  return {
    label: labelForWindow(windowSeconds, label),
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
    windowSeconds,
    resetInSec: resetInSeconds(window as UsageWindowPayload),
    limitReached,
  }
}

function normalizeRateLimit(label: string, rateLimit: unknown): NormalizedWindow[] {
  if (!isRecord(rateLimit)) return []
  const limitReached = rateLimit.limit_reached === true
  return [
    normalizeWindow(label, rateLimit.primary_window, limitReached),
    normalizeWindow(label, rateLimit.secondary_window, limitReached),
  ].filter((item): item is NormalizedWindow => Boolean(item))
}

export function normalizePayload(payload: UsagePayload): NormalizedPayload {
  const windows = normalizeRateLimit("Usage", payload.rate_limit)
  if (Array.isArray(payload.additional_rate_limits)) {
    for (const item of payload.additional_rate_limits) {
      if (!isRecord(item)) continue
      const name = toStringValue(item.limit_name) ?? toStringValue(item.metered_feature) ?? "Extra"
      for (const window of normalizeRateLimit(name, item.rate_limit)) {
        windows.push({
          ...window,
          label: name || window.label,
        })
      }
    }
  }
  windows.sort((a, b) => a.windowSeconds - b.windowSeconds)
  if (!windows.length) {
    return {
      windows,
      error: isRecord(payload.rate_limit) ? "usage windows missing" : "rate_limit missing",
    }
  }
  const creditsPayload = isRecord(payload.credits) ? payload.credits : undefined
  const credits = creditsPayload
    ? {
        hasCredits: creditsPayload.has_credits === true,
        unlimited: creditsPayload.unlimited === true,
        balance: toStringValue(creditsPayload.balance) ?? "0",
      }
    : undefined
  const resetCreditsPayload = isRecord(payload.rate_limit_reset_credits) ? payload.rate_limit_reset_credits : undefined
  return {
    plan: toStringValue(payload.plan_type) ?? "Unknown",
    windows,
    credits,
    resetCredits: toNumber(resetCreditsPayload?.available_count),
  }
}
