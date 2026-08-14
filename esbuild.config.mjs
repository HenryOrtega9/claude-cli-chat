import esbuild from "esbuild";
import process from "node:process";
import builtins from "builtin-modules";
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const watch = process.argv.includes("--watch");
const appMode = process.argv.includes("--app");

/*
 * --production only affects the --app build: it is what electron-builder packs.
 * The plugin build derives its own minify/sourcemap from --watch and must keep
 * emitting the exact bytes it does today, so this flag never reaches it.
 */
const production = process.argv.includes("--production");

const VAULT_PLUGIN_DIR = "/Users/henryortega/Library/Mobile Documents/iCloud~md~obsidian/Documents/Henry Ortega's Second Brain/.obsidian/plugins/claude-cli-chat";

if (!appMode) {
  if (!existsSync(VAULT_PLUGIN_DIR)) {
    mkdirSync(VAULT_PLUGIN_DIR, { recursive: true });
  }
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

/*
 * --app builds the standalone Electron shell instead of the Obsidian plugin.
 * The two builds share nothing but this file: the plugin's entry, output path,
 * and options above must stay byte-for-byte what they were.
 */
const APP_DIST = "app/dist";

/*
 * The shell hosts the SAME shared code as the plugin, which is only decoupled
 * from Obsidian if nothing in the app bundle reaches for it. esbuild would
 * happily resolve "obsidian" (it is a devDependency) and inline a stub-shaped
 * module, so the violation would surface at runtime as a blank panel. Fail the
 * build at resolve time instead, naming the importer.
 */
const forbidObsidianImports = {
  name: "forbid-obsidian",
  setup(build) {
    build.onResolve({ filter: /^obsidian$/ }, (args) => ({
      errors: [
        {
          text:
            `The desktop app bundle must not import "obsidian" ` +
            `(imported from ${args.importer}). Route host access through src/platform/ instead.`,
        },
      ],
    }));
  },
};

const appMainOptions = {
  entryPoints: ["app/src/main.ts"],
  bundle: true,
  outfile: join(APP_DIST, "main.js"),
  format: "cjs",
  platform: "node",
  target: "es2022",
  external: ["electron", ...builtins],
  logLevel: "info",
  treeShaking: true,
  sourcemap: production ? false : "inline",
  minify: production,
};

const appRendererOptions = {
  entryPoints: ["app/src/renderer.ts"],
  bundle: true,
  outfile: join(APP_DIST, "renderer.js"),
  format: "cjs",
  /*
   * nodeIntegration is on in the panel window, so the renderer is a CJS module
   * with real `require` — node builtins and electron stay external exactly as
   * they do in the plugin build.
   */
  platform: "node",
  target: "es2022",
  external: ["electron", ...builtins],
  logLevel: "info",
  treeShaking: true,
  sourcemap: production ? false : "inline",
  minify: production,
  plugins: [forbidObsidianImports],
};

if (appMode) {
  mkdirSync(APP_DIST, { recursive: true });

  /*
   * Agent-parallel builds: the renderer entry may not exist yet. Skip it with a
   * warning rather than failing the whole app build.
   */
  const targets = [appMainOptions];
  if (existsSync(appRendererOptions.entryPoints[0])) {
    targets.push(appRendererOptions);
  } else {
    console.warn(`Skipping renderer: ${appRendererOptions.entryPoints[0]} does not exist yet.`);
  }

  if (watch) {
    for (const options of targets) {
      const ctx = await esbuild.context(options);
      await ctx.watch();
    }
    console.log(`Watching app... output: ${APP_DIST}`);
  } else {
    await Promise.all(targets.map((options) => esbuild.build(options)));
    console.log(`Built app (${production ? "production" : "development"}). output: ${APP_DIST}`);
  }
} else if (watch) {
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
