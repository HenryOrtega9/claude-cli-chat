import esbuild from "esbuild";
import process from "node:process";
import builtins from "builtin-modules";
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const watch = process.argv.includes("--watch");
const appMode = process.argv.includes("--app");
const iosMode = process.argv.includes("--ios");

/*
 * --production only affects the --app build: it is what electron-builder packs.
 * The plugin build derives its own minify/sourcemap from --watch and must keep
 * emitting the exact bytes it does today, so this flag never reaches it.
 */
const production = process.argv.includes("--production");

const VAULT_PLUGIN_DIR = "/Users/henryortega/Library/Mobile Documents/iCloud~md~obsidian/Documents/Henry Ortega's Second Brain/.obsidian/plugins/claude-cli-chat";

if (!appMode && !iosMode) {
  if (!existsSync(VAULT_PLUGIN_DIR)) {
    mkdirSync(VAULT_PLUGIN_DIR, { recursive: true });
  }
}

const copyStaticAssets = () => {
  copyFileSync("apps/obsidian/manifest.json", join(VAULT_PLUGIN_DIR, "manifest.json"));
  if (existsSync("apps/obsidian/styles.css")) {
    copyFileSync("apps/obsidian/styles.css", join(VAULT_PLUGIN_DIR, "styles.css"));
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
const APP_DIST = "apps/electron/dist";

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
  entryPoints: ["apps/electron/src/main.ts"],
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
  entryPoints: ["apps/electron/src/renderer.ts"],
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

/*
 * --ios builds the browser bundle the iOS app loads from vaultgw://app/. Unlike
 * the two builds above there is no node here at all: the engine lives in the
 * gateway daemon on the Mac and the page talks to it over HTTP/WebSocket. The
 * shared view layer only stays loadable in that world if nothing in its import
 * graph reaches for a node builtin, electron, or obsidian — forbidNodeImports
 * below turns any regression into a build error naming the importer, which is
 * the whole point of having this target land before the client is written.
 */
const IOS_WEB_DIR = "apps/ios/Web";
const IOS_ENTRY = "apps/ios-web/src/renderer.ts";

const FORBIDDEN_NODE_BUILTINS =
  /^(node:)?(fs|fs\/promises|child_process|path|os|http|https|net|readline|stream|zlib|url|crypto|util|events)$/;

const forbidNodeImports = {
  name: "forbid-node",
  setup(build) {
    build.onResolve({ filter: FORBIDDEN_NODE_BUILTINS }, (args) => ({
      errors: [
        {
          text:
            `The iOS web bundle must not import "${args.path}" ` +
            `(imported from ${args.importer}). There is no node in a WKWebView — route it ` +
            `through a PluginHost capability (src/platform/host.ts) or the gateway daemon.`,
        },
      ],
    }));
    build.onResolve({ filter: /^(electron|obsidian)$/ }, (args) => ({
      errors: [
        {
          text:
            `The iOS web bundle must not import "${args.path}" ` +
            `(imported from ${args.importer}). Route host access through src/platform/ instead.`,
        },
      ],
    }));
  },
};

const iosRendererOptions = {
  entryPoints: [IOS_ENTRY],
  bundle: true,
  outfile: join(IOS_WEB_DIR, "renderer.js"),
  format: "iife",
  platform: "browser",
  target: "es2022",
  logLevel: "info",
  treeShaking: true,
  sourcemap: production ? false : "inline",
  minify: production,
  plugins: [forbidNodeImports],
};

/* index.html plus the three stylesheets the page links, copied flat next to
   renderer.js because the native scheme handler serves the folder verbatim.
   Load order matters and matches index.html: styles.css (shared plugin CSS),
   desktop.css (the theme tokens it consumes), ios.css (touch + glass). */
const copyIosAssets = () => {
  copyFileSync("apps/ios-web/index.html", join(IOS_WEB_DIR, "index.html"));
  copyFileSync("apps/obsidian/styles.css", join(IOS_WEB_DIR, "styles.css"));
  copyFileSync("apps/electron/desktop.css", join(IOS_WEB_DIR, "desktop.css"));
  copyFileSync("apps/ios-web/ios.css", join(IOS_WEB_DIR, "ios.css"));
};

if (iosMode) {
  mkdirSync(IOS_WEB_DIR, { recursive: true });

  if (!existsSync(IOS_ENTRY)) {
    console.error(`Missing iOS entry: ${IOS_ENTRY}`);
    process.exit(1);
  }

  if (watch) {
    const ctx = await esbuild.context({
      ...iosRendererOptions,
      plugins: [
        ...iosRendererOptions.plugins,
        {
          name: "copy-ios-assets",
          setup(build) {
            build.onEnd(() => copyIosAssets());
          },
        },
      ],
    });
    await ctx.watch();
    console.log(`Watching iOS web... output: ${IOS_WEB_DIR}`);
  } else {
    await esbuild.build(iosRendererOptions);
    copyIosAssets();
    console.log(`Built iOS web (${production ? "production" : "development"}). output: ${IOS_WEB_DIR}`);
  }
} else if (appMode) {
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
