import { describe, expect, it } from "bun:test"
import {
  fetchUsage,
  getDefaultOpenCodeDbPath,
  isRecord,
  isUsageDisabled,
  loadConfig,
  normalizePayload,
  toNumber,
  type UsagePayload,
} from "../src/core.js"

describe("core helper functions", () => {
  it("toNumber parses numbers and valid numeric strings", () => {
    expect(toNumber(42)).toBe(42)
    expect(toNumber("123")).toBe(123)
    expect(toNumber("0")).toBe(0)
    expect(toNumber("")).toBeUndefined()
    expect(toNumber("abc")).toBeUndefined()
    expect(toNumber(null)).toBeUndefined()
    expect(toNumber(undefined)).toBeUndefined()
    expect(toNumber(NaN)).toBeUndefined()
    expect(toNumber(Infinity)).toBeUndefined()
  })

  it("isRecord correctly identifies objects", () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord({ a: 1 })).toBe(true)
    expect(isRecord(null)).toBe(false)
    expect(isRecord(undefined)).toBe(false)
    expect(isRecord("str")).toBe(false)
    expect(isRecord(123)).toBe(false)
    expect(isRecord([])).toBe(true)
  })

  it("isUsageDisabled checks env variable", () => {
    expect(isUsageDisabled({})).toBe(false)
    expect(isUsageDisabled({ OPENCODE_CODEX_USAGE_DISABLED: "false" })).toBe(false)
    expect(isUsageDisabled({ OPENCODE_CODEX_USAGE_DISABLED: "true" })).toBe(true)
    expect(isUsageDisabled({ OPENCODE_CODEX_USAGE_DISABLED: "TRUE" })).toBe(true)
    expect(isUsageDisabled({ OPENCODE_CODEX_USAGE_DISABLED: " true " })).toBe(true)
  })

  it("getDefaultOpenCodeDbPath returns expected path", () => {
    const path = getDefaultOpenCodeDbPath()
    expect(path).toContain("opencode.db")
  })
})

describe("loadConfig from real database", () => {
  it("loads OpenAI credentials from OpenCode database if present", () => {
    const config = loadConfig()
    if (config) {
      expect(config.source).toBe("opencode-db")
      expect(typeof config.accessToken).toBe("string")
      expect(config.accessToken.length).toBeGreaterThan(10)
    }
  })
})

describe("normalizePayload", () => {
  it("normalizes a standard ChatGPT usage payload", () => {
    const mockPayload: UsagePayload = {
      plan_type: "plus",
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: {
          used_percent: 10,
          limit_window_seconds: 18000,
          reset_after_seconds: 7200,
        },
        secondary_window: {
          used_percent: 85,
          limit_window_seconds: 604800,
          reset_after_seconds: 86400,
        },
      },
      credits: {
        has_credits: true,
        unlimited: false,
        balance: "150.00",
      },
      rate_limit_reset_credits: {
        available_count: 5,
      },
    }

    const result = normalizePayload(mockPayload)
    expect(result.plan).toBe("plus")
    expect(result.windows.length).toBe(2)

    // Sorted by windowSeconds ascending: 18000 (5h) first, then 604800 (Weekly)
    expect(result.windows[0].label).toBe("5h")
    expect(result.windows[0].usedPercent).toBe(10)
    expect(result.windows[0].resetInSec).toBe(7200)
    expect(result.windows[0].limitReached).toBe(false)

    expect(result.windows[1].label).toBe("Weekly")
    expect(result.windows[1].usedPercent).toBe(85)
    expect(result.windows[1].resetInSec).toBe(86400)
    expect(result.windows[1].limitReached).toBe(false)

    expect(result.credits).toBeDefined()
    expect(result.credits?.hasCredits).toBe(true)
    expect(result.credits?.balance).toBe("150.00")
    expect(result.resetCredits).toBe(5)
  })

  it("handles limit_reached flag correctly", () => {
    const mockPayload: UsagePayload = {
      plan_type: "team",
      rate_limit: {
        allowed: false,
        limit_reached: true,
        primary_window: {
          used_percent: 100,
          limit_window_seconds: 18000,
          reset_after_seconds: 1200,
        },
      },
    }

    const result = normalizePayload(mockPayload)
    expect(result.windows[0].limitReached).toBe(true)
    expect(result.windows[0].usedPercent).toBe(100)
  })

  it("handles additional_rate_limits", () => {
    const mockPayload: UsagePayload = {
      plan_type: "pro",
      rate_limit: {
        primary_window: {
          used_percent: 20,
          limit_window_seconds: 18000,
        },
      },
      additional_rate_limits: [
        {
          limit_name: "Code Review",
          rate_limit: {
            primary_window: {
              used_percent: 50,
              limit_window_seconds: 86400,
              reset_after_seconds: 3600,
            },
          },
        },
      ],
    }

    const result = normalizePayload(mockPayload)
    expect(result.windows.length).toBe(2)
    expect(result.windows[1].label).toBe("Code Review")
    expect(result.windows[1].usedPercent).toBe(50)
  })

  it("handles empty or missing windows gracefully", () => {
    const result = normalizePayload({})
    expect(result.windows.length).toBe(0)
    expect(result.error).toBeDefined()
  })
})

describe("fetchUsage error handling", () => {
  it("returns disabled reason when OPENCODE_CODEX_USAGE_DISABLED is true", async () => {
    const res = await fetchUsage({ disabled: true })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe("disabled")
    }
  })

  it("returns no-config when readConfig returns null", async () => {
    const res = await fetchUsage({ readConfig: () => null })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe("no-config")
    }
  })

  it("handles HTTP 401 unauthorized", async () => {
    const mockFetcher = async () =>
      new Response("Unauthorized", { status: 401, headers: { "content-type": "application/json" } })

    const res = await fetchUsage({
      readConfig: () => ({ accessToken: "test-token", source: "codex" }),
      fetchImpl: mockFetcher as any,
    })

    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe("unauthorized")
      expect(res.status).toBe(401)
    }
  })

  it("handles HTTP 429 rate limit", async () => {
    const mockFetcher = async () =>
      new Response("Too Many Requests", { status: 429, headers: { "content-type": "application/json" } })

    const res = await fetchUsage({
      readConfig: () => ({ accessToken: "test-token", source: "codex" }),
      fetchImpl: mockFetcher as any,
    })

    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.reason).toBe("rate-limited")
      expect(res.status).toBe(429)
    }
  })

  it("handles successful response", async () => {
    const mockFetcher = async () =>
      new Response(
        JSON.stringify({
          plan_type: "plus",
          rate_limit: {
            primary_window: {
              used_percent: 5,
              limit_window_seconds: 18000,
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )

    const res = await fetchUsage({
      readConfig: () => ({ accessToken: "test-token", source: "opencode-db" }),
      fetchImpl: mockFetcher as any,
    })

    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.payload.plan_type).toBe("plus")
    }
  })
})
