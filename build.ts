import { transformFileAsync } from "@babel/core"
import tsPreset from "@babel/preset-typescript"
import babelPresetSolid from "babel-preset-solid"
import { build } from "esbuild"
import { execSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const distDir = join(process.cwd(), "dist")
mkdirSync(distDir, { recursive: true })

console.log("Compiling src/core.ts and src/index.ts with esbuild...")
await build({
  entryPoints: ["src/core.ts", "src/index.ts"],
  outdir: "dist",
  format: "esm",
  platform: "node",
  target: "es2022",
  bundle: false,
  packages: "external",
})

console.log("Compiling src/tui.tsx with babel-preset-solid...")
const babelResult = await transformFileAsync("src/tui.tsx", {
  presets: [
    [tsPreset, { isTSX: true, allExtensions: true }],
    [babelPresetSolid, { moduleName: "@opentui/solid", generate: "universal" }],
  ],
})

if (!babelResult || !babelResult.code) {
  throw new Error("Failed to compile src/tui.tsx with Babel")
}

writeFileSync(join(distDir, "tui.js"), babelResult.code, "utf8")

console.log("Generating TypeScript declaration files...")
execSync("npx tsc --emitDeclarationOnly", { stdio: "inherit" })

console.log("Build completed successfully!")
