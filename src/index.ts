import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "opencode-v2-cli-codex-usage",
  setup() {
    // OpenCode V2 CLI automatically discovers and mounts the `./tui` entrypoint
    // when this package is enabled in opencode.jsonc or cli.json.
  },
})
