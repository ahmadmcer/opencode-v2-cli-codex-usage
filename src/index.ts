export interface PluginDefinition {
  id: string
  setup: (context: unknown) => Promise<void> | void
}

export function define(plugin: PluginDefinition): PluginDefinition {
  return plugin
}

export const Plugin = { define }

export default define({
  id: "opencode-v2-cli-codex-usage",
  setup() {
    // OpenCode V2 CLI automatically discovers and mounts the `./tui` entrypoint
    // when this package is enabled in opencode.jsonc, cli.json, or plugin discovery paths.
  },
})
