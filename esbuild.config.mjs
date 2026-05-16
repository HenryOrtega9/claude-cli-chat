import esbuild from "esbuild";
import process from "node:process";
import builtins from "builtin-modules";
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const watch = process.argv.includes("--watch");

const VAULT_PLUGIN_DIR = "/Users/henryortega/Library/Mobile Documents/iCloud~md~obsidian/Documents/Henry Ortega's Second Brain/.obsidian/plugins/claude-cli-chat";

if (!existsSync(VAULT_PLUGIN_DIR)) {
  mkdirSync(VAULT_PLUGIN_DIR, { recursive: true });
}

const copyStaticAssets = () => {
  copyFileSync("manifest.json", join(VAULT_PLUGIN_DIR, "manifest.json"));
  if (existsSync("styles.css")) {
    copyFileSync("styles.css", join(VAULT_PLUGIN_DIR, "styles.css"));
  }
};

const buildOptions = {
  entryPoints: ["src/main.ts"],
  bundle: true,
  outfile: join(VAULT_PLUGIN_DIR, "main.js"),
  format: "cjs",
  platform: "node",
  target: "es2022",
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtins],
  logLevel: "info",
  treeShaking: true,
  sourcemap: watch ? "inline" : false,
  minify: !watch,
};

if (watch) {
  const ctx = await esbuild.context({
    ...buildOptions,
    plugins: [
      {
        name: "copy-static",
        setup(build) {
          build.onEnd(() => copyStaticAssets());
        },
      },
    ],
  });
  await ctx.watch();
  console.log(`Watching... output: ${VAULT_PLUGIN_DIR}`);
} else {
  await esbuild.build(buildOptions);
  copyStaticAssets();
  console.log(`Built. output: ${VAULT_PLUGIN_DIR}`);
}
