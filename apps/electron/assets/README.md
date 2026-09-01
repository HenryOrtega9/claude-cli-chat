# app/assets

Menu-bar (tray) icon and application icon for the standalone shell, plus the
vectors they are generated from. Committed rather than built on the fly: the
repo has no rasterizer dependency to spend a build step on, and electron-builder
wants a finished `.icns` at pack time.

## Tray icon

- `claude-asterisk-template.svg` — the Claude asterisk from
  `src/view/Welcome.ts` (`CLAUDE_ASTERISK_DATA_URI`, base64-decoded), with the
  brand fill `#D97757` swapped for `#000000`. macOS template images are drawn
  from their alpha channel alone, so the source color only has to be opaque;
  black keeps the SVG legible on its own.
- `trayTemplate.png` — 16x16, the 1x menu-bar representation.
- `trayTemplate@2x.png` — 32x32, the Retina representation.
  `nativeImage.createFromPath()` picks this up automatically from the `@2x`
  filename convention, so `app/src/main.ts` names only the 1x path.

The `Template` suffix is Electron's marker for a macOS template image (the app
also calls `setTemplateImage(true)` explicitly). That is what makes the glyph
invert correctly between light and dark menu bars and turn white while the tray
menu is open.

## Application icon

- `icon.svg` — the 1024x1024 Dock/Finder icon: the same asterisk in brand
  `#D97757` on a bone `#F0EEE6` plate. The plate follows Apple's icon grid (824
  square, 185.4 corner radius, centered in a 1024 canvas) so the icon lines up
  with system icons in the Dock; the glyph is 64% of the plate width, which is
  the smallest size at which the twelve spokes still separate at 16x16.
- `icon.icns` — what `electron-builder.yml` points `mac.icon` at. Ten
  representations (16 through 512, each at 1x and 2x); electron-builder rejects
  an `.icns` without at least 512x512.

## How they were produced

Tray icon: ImageMagick 7 (`brew install imagemagick`), from the repo root.
App icon: `sips` + `iconutil`, both stock macOS — the icon is a plain fill over
a rounded rect, so it needs no compositing tool.

```sh
# Source vector: the plugin's own asterisk, recolored black.
node -e 'const s=require("fs").readFileSync("src/view/Welcome.ts","utf8");
  const m=s.match(/CLAUDE_ASTERISK_DATA_URI =\s*\n?\s*"data:image\/svg\+xml;base64,([A-Za-z0-9+\/=]+)"/);
  process.stdout.write(Buffer.from(m[1],"base64").toString("utf8"));' \
  | sed 's/fill="#D97757"/fill="#000000"/' > app/assets/claude-asterisk-template.svg

# 1x. The alpha level stretch is load-bearing: twelve thin spokes at 15px land
# as uniform grey mush otherwise, and a template image has only alpha to work
# with. Rendered at 15px inside a 16px canvas so the glyph is not flush against
# the menu-bar edges.
magick -background none app/assets/claude-asterisk-template.svg \
  -resize 15x15 -channel A -level 25%,75% +channel \
  -gravity center -extent 16x16 PNG32:app/assets/trayTemplate.png

# 2x. Rendered from the vector at the larger size (never upscaled from the 1x),
# and left unsharpened — 30px is enough resolution for the spokes to separate.
magick -background none app/assets/claude-asterisk-template.svg \
  -resize 30x30 -gravity center -extent 32x32 PNG32:app/assets/trayTemplate@2x.png
```

ImageMagick's internal MSVG renderer handles this path (no `librsvg` delegate
required). To regenerate after a brand-art change, rerun both commands and
eyeball the 1x at 8x zoom — it is the representation that degrades first.

```sh
# icon.svg: the same asterisk path, unrecolored, dropped onto the plate. The
# nested transform maps the source viewBox (145 x 148, origin offset by
# -75.96,-223.53) into the 1024 canvas at 64% of the plate width.
node -e 'const fs=require("fs");
  const s=fs.readFileSync("src/view/Welcome.ts","utf8");
  const m=s.match(/CLAUDE_ASTERISK_DATA_URI =\s*\n?\s*"data:image\/svg\+xml;base64,([A-Za-z0-9+\/=]+)"/);
  const d=Buffer.from(m[1],"base64").toString("utf8").match(/d="([^"]+)"/)[1];
  fs.writeFileSync("app/assets/icon.svg", `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect x="100" y="100" width="824" height="824" rx="185.4" ry="185.4" fill="#F0EEE6"/>
  <g transform="translate(248.32,242.865) scale(3.636966) translate(-75.96,-223.53)">
    <path fill="#D97757" d="${d}"/>
  </g>
</svg>
`);'

# Each representation is rendered from the vector at its own size — sips reads
# SVG directly, so nothing is ever upscaled from a smaller PNG.
mkdir -p /tmp/icon.iconset
for pair in 16:icon_16x16 32:icon_16x16@2x 32:icon_32x32 64:icon_32x32@2x \
            128:icon_128x128 256:icon_128x128@2x 256:icon_256x256 \
            512:icon_256x256@2x 512:icon_512x512 1024:icon_512x512@2x; do
  px=${pair%%:*}; name=${pair##*:}
  sips -s format png -z "$px" "$px" app/assets/icon.svg \
    --out "/tmp/icon.iconset/$name.png" >/dev/null
done
iconutil -c icns /tmp/icon.iconset -o app/assets/icon.icns
```

The `.iconset` directory is scratch — only `icon.svg` and `icon.icns` are
committed.
