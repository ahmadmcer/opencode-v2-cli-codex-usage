import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import {
  fetchUsage,
  normalizePayload,
  type Credits,
  type NormalizedWindow,
  type UsageFailure,
} from "./core.js"

type PluginContext = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0]

const DASHBOARD_URL = "https://chatgpt.com/codex/settings/usage"
const REFRESH_INTERVAL_MS = 60_000
const TICK_INTERVAL_MS = 1_000

interface FetchState {
  status: "loading" | "ok" | "error" | "no-config" | "disabled"
  plan?: string
  windows: NormalizedWindow[]
  credits?: Credits
  resetCredits?: number
  message?: string
  lastFetch: number
}

function failureMessage(reason: UsageFailure, status?: number): string {
  switch (reason) {
    case "disabled":
      return "Disabled by OPENCODE_CODEX_USAGE_DISABLED"
    case "no-config":
      return "Sign in with OpenAI in OpenCode (/connect)"
    case "unauthorized":
      return "Token expired or unauthorized"
    case "rate-limited":
      return "Rate limited (HTTP 429)"
    case "http-error":
      return `HTTP ${status ?? "error"}`
    case "unexpected-response":
      return "Unexpected API response"
    case "timeout":
      return "Usage request timed out"
    case "request-failed":
      return "Usage request failed"
  }
}

function fmtReset(resetSec: number): string {
  if (!resetSec || resetSec <= 0) return ""
  const days = Math.floor(resetSec / 86400)
  const hours = Math.floor((resetSec % 86400) / 3600)
  const mins = Math.floor((resetSec % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${mins}m`
  return `${mins}m`
}

function fmtPct(pct: number): string {
  return `${Math.round(pct)}%`
}

function fmtCredits(balance: string): string {
  const amount = Number(balance)
  return Number.isFinite(amount) ? `$${amount.toFixed(2)}` : balance
}

function remainingPercent(usedPercent: number): number {
  return Math.max(0, Math.min(100, 100 - usedPercent))
}

export function CodexUsageSidebar(props: { context: PluginContext; sessionID?: string }) {
  const { context } = props
  const theme = context.theme

  // Persistent collapse state stored across sessions and hot reloads
  const [viewState, setViewState] = context.storage.store("view", {
    initial: { collapsed: true },
  })

  const [dataState, setDataState] = createSignal<FetchState>({
    status: "loading",
    windows: [],
    lastFetch: 0,
  })

  // Live timer tick for real-time countdown calculation
  const [now, setNow] = createSignal(Date.now())

  let inflight = false

  async function loadUsage() {
    if (inflight) return
    inflight = true

    setDataState((prev) => ({
      ...prev,
      status: prev.status === "ok" && prev.windows.length > 0 ? "ok" : "loading",
      message: undefined,
    }))

    try {
      const result = await fetchUsage()
      if (!result.ok) {
        const status =
          result.reason === "disabled"
            ? "disabled"
            : result.reason === "no-config"
              ? "no-config"
              : "error"
        setDataState((prev) => ({
          ...prev,
          status,
          message: failureMessage(result.reason, result.status),
          lastFetch: Date.now(),
        }))
        return
      }

      const normalized = normalizePayload(result.payload)
      if (normalized.windows.length === 0) {
        setDataState((prev) => ({
          ...prev,
          status: "error",
          message: normalized.error ?? "Usage windows missing",
          lastFetch: Date.now(),
        }))
        return
      }

      setDataState({
        status: "ok",
        lastFetch: Date.now(),
        ...normalized,
      })
    } catch {
      setDataState((prev) => ({
        ...prev,
        status: "error",
        message: "Request failed",
        lastFetch: Date.now(),
      }))
    } finally {
      inflight = false
    }
  }

  // 1-second ticker for live countdowns
  const ticker = setInterval(() => {
    setNow(Date.now())
  }, TICK_INTERVAL_MS)

  // 60-second background polling
  const poller = setInterval(() => {
    loadUsage()
  }, REFRESH_INTERVAL_MS)

  // Initial fetch on mount
  createEffect(() => {
    loadUsage()
  })

  onCleanup(() => {
    clearInterval(ticker)
    clearInterval(poller)
  })

  function toggleCollapse() {
    setViewState((draft: { collapsed: boolean }) => {
      draft.collapsed = !draft.collapsed
    }).catch((err: unknown) => {
      console.error("Failed to persist collapse state", err)
    })
    // If expanding and data is stale, refresh immediately
    if (viewState.collapsed && Date.now() - dataState().lastFetch > 10_000) {
      loadUsage()
    }
  }

  function getLiveResetSeconds(win: NormalizedWindow): number {
    const elapsed = Math.floor((now() - dataState().lastFetch) / 1000)
    return Math.max(0, win.resetInSec - elapsed)
  }

  function summaryText(): string {
    const current = dataState()
    const first = current.windows[0]
    if (current.status === "ok" && first) {
      return `(${first.label} ${remainingPercent(first.usedPercent).toFixed(1)}% left)`
    }
    if (current.status === "no-config") return "(not signed in)"
    if (current.status === "disabled") return "(disabled)"
    if (current.status === "error") return `(${current.message ?? "error"})`
    return "(...)"
  }

  function creditsDisplay(credits: Credits): string {
    if (credits.unlimited) return "unlimited"
    if (!credits.hasCredits) return "none"
    return fmtCredits(credits.balance)
  }

  return (
    <box flexDirection="column" gap={0}>
      {/* Header Row */}
      <box
        flexDirection="row"
        gap={1}
        onMouseUp={toggleCollapse}
      >
        <text fg={theme.text.base}>{viewState.collapsed ? "▶" : "▼"}</text>
        <text fg={theme.text.base}>
          <b>Codex Usage</b>
        </text>
        <Show when={viewState.collapsed}>
          <text fg={theme.text.muted}>
            <span style={{ fg: theme.text.muted }}>{` ${summaryText()}`}</span>
          </text>
        </Show>
      </box>

      {/* Expanded Content Body */}
      <Show when={!viewState.collapsed}>
        <box flexDirection="column" gap={0} paddingLeft={2}>
          <Show when={dataState().status === "ok"}>
            {/* Plan */}
            <box flexDirection="row" justifyContent="space-between">
              <text fg={theme.text.base}>Plan</text>
              <text fg={theme.text.muted}>
                {(dataState().plan ?? "UNKNOWN").toUpperCase()}
              </text>
            </box>

            {/* Rate Limit Windows */}
            <For each={dataState().windows}>
              {(win) => {
                const resetText = () => fmtReset(getLiveResetSeconds(win))
                const remaining = () => remainingPercent(win.usedPercent)
                return (
                  <box flexDirection="row" justifyContent="space-between">
                    <text fg={theme.text.base}>{win.label}</text>
                    <text fg={theme.text.muted}>
                      {fmtPct(remaining())}
                      <Show when={resetText()}>
                        <span style={{ fg: theme.text.muted }}>{` (${resetText()})`}</span>
                      </Show>
                      <Show when={win.limitReached}>
                        <span style={{ fg: theme.text.feedback.error.base }}>
                          {" exhausted"}
                        </span>
                      </Show>
                    </text>
                  </box>
                )
              }}
            </For>

            {/* Credits */}
            <Show when={dataState().credits}>
              {(creds) => (
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme.text.base}>Credits</text>
                  <text fg={theme.text.muted}>{creditsDisplay(creds())}</text>
                </box>
              )}
            </Show>

            {/* Resets */}
            <Show when={dataState().resetCredits !== undefined}>
              <box flexDirection="row" justifyContent="space-between">
                <text fg={theme.text.base}>Resets</text>
                <text fg={theme.text.muted}>
                  {`${dataState().resetCredits} available`}
                </text>
              </box>
            </Show>
          </Show>

          {/* Not signed in */}
          <Show when={dataState().status === "no-config"}>
            <text fg={theme.text.muted}>
              Sign in with OpenAI in OpenCode (/connect)
            </text>
          </Show>

          {/* Disabled */}
          <Show when={dataState().status === "disabled"}>
            <text fg={theme.text.muted}>
              Disabled by OPENCODE_CODEX_USAGE_DISABLED
            </text>
          </Show>

          {/* Error */}
          <Show when={dataState().status === "error"}>
            <text fg={theme.text.feedback.error.base}>
              {dataState().message ?? "Error fetching usage"}
            </text>
            <text fg={theme.text.muted}>{DASHBOARD_URL}</text>
          </Show>

          {/* Loading */}
          <Show
            when={
              dataState().status === "loading" &&
              dataState().windows.length === 0
            }
          >
            <text fg={theme.text.muted}>Loading...</text>
          </Show>
        </box>
      </Show>
    </box>
  )
}

const plugin = Plugin.define({
  id: "opencode-v2-cli-codex-usage",
  setup(context) {
    const unregister = context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) => (
        <CodexUsageSidebar context={context} sessionID={sessionID} />
      ),
    })
    return () => unregister()
  },
})

export default plugin
