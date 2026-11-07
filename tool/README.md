# Local Marzipano Tool

A local, self-hosted take on the [Marzipano Tool](https://www.marzipano.net/tool/).
It turns panoramas into Marzipano cube tiles in your browser and exports a
viewer app laid out the same way as the hosted tool's exports. The exported app
bundles **this repository's** Marzipano build, so tours use your fork.

All processing happens in the browser. Nothing is uploaded.

## Run it

```bash
npm install
npm run tool
```

Then open <http://localhost:8080/tool/>. The script rebuilds `build/marzipano.js`
from `src/` each time it starts, so edits to the library show up in the
preview and in exports. Options: `--port 9000`, and `--no-build` to reuse an
existing build.

## Using it

1. **Add panoramas.** Use the button or drop files anywhere on the page.
   - Equirectangular images must be 2:1: JPEG, PNG, WebP, AVIF, or TIFF.
   - TIFF is decoded by the tool itself (`js/tiff.js`), because browsers can't
     decode it. It reads the file strip by strip, so full-size stitcher output
     such as PTGui's works. Supported: 8/16-bit RGB(A) or greyscale; none,
     PackBits, LZW or Deflate compression; strips or tiles; BigTIFF.
     Floating-point (32-bit) TIFF is not supported; use EXR for HDR.
   - **HDR:** OpenEXR (`.exr`) and Radiance (`.hdr`) panoramas become Ultra HDR
     tiles that keep their dynamic range. They show in HDR on HDR displays
     (WebGPU) and with auto exposure on SDR displays. See [HDR.md](HDR.md).
   - JPEG/PNG are decoded by the browser and are limited by its canvas size
     (about 16k × 8k is safe in Chrome). Use TIFF for anything larger.
   - Colour profiles are not converted, so supply sRGB images (PTGui's
     default).
   - Cube maps: six square faces named `name_f`, `name_b`, `name_l`, `name_r`,
     `name_u`, `name_d` (any image extension).
2. Rename scenes in the list, reorder them with ↑ / ↓, remove them with ✕.
3. In the preview:
   - **Set initial view** stores the current yaw, pitch and FOV.
   - **+ Info hotspot** / **+ Link hotspot** add a hotspot at the crosshair.
     Drag a hotspot to move it. Click it to edit the title and text, change the
     link target, rotate the arrow, or delete it.
4. Settings: drag or QTVR mouse mode, autorotate, view control buttons,
   fullscreen button, JPEG quality. Quality applies to panoramas added after
   you change it.
5. **Export ZIP**, or **Export to folder…** (Chrome or Edge only). Export to
   folder writes straight into a directory and has no 4 GB ZIP limit.

**Save project** writes a small JSON file with names, views, hotspots and
settings. Tiles are not saved. To resume later, **Load project** and add the
same image files again: scenes are matched by file name.

**Load project** also accepts an exported tour, so you can rebuild a project
from output: pick its `app-files/data.js`, or the exported ZIP (stored or
deflated). This works for tours from the hosted Marzipano Tool as well. You can
also drop the file onto the page, with or without the panoramas. The tour name,
settings, scene order and names, initial views, and link and info hotspots all
come back. Tiles are not reused; the panoramas are processed again.

Scenes are matched to the panoramas you add in this order:

1. By the `sourceFile` that exports from this tool record for each scene. The
   viewer ignores this field.
2. For older or hosted-tool tours, which don't record it, by scene name
   against the file name without its extension, ignoring case. A scene keeps
   its file's name unless you rename it, so unrenamed scenes match by
   themselves.
3. Scenes still unmatched are listed under **Project**. Use **Choose file…** to
   pick the panorama for each one. That's needed for scenes renamed before the
   export.

### Performance

Measured in Chrome:

| Input | Time | Levels | Tiles | Tile data |
| --- | --- | --- | --- | --- |
| 16384 × 8192 JPEG | 16 s | 512–4096 | 510 | ~11 MB |
| 26928 × 13464 PackBits TIFF (1.46 GB) | 28 s | 512–8192 | 2046 | 43 MB |

Panoramas are processed one at a time, in a worker. A large TIFF needs about
1.1 GB of memory while it is being processed. The finished tiles are kept in
the page until you export.

## Output

```
README.txt  LICENSE.txt
app-files/
  index.html            generated scene list
  index.js  style.css   viewer (from demos/sample-tour, adapted)
  data.js               var APP_DATA = { scenes, name, settings }
  img/                  UI icons
  vendor/marzipano.js   this repo's build
  vendor/reset.min.css
  tiles/<index>-<slug>/preview.jpg
  tiles/<index>-<slug>/<z>/<face>/<y>/<x>.jpg
```

To view an export, serve `app-files/` over HTTP (for example
`python -m http.server --directory app-files`). Browsers block the tiles when
the page is opened from `file://`.

## How it matches the hosted tool

These details were read from the hosted tool's behaviour and code, and the
implementation here was written separately to produce the same output:

- Face size is `width / 4` for equirectangular input, or the face width for cubes.
- Levels use 512 px tiles at 512, 1024, 2048... up to the face size. One more
  level is added when the face is more than 25% larger than the largest level.
  A 256 px `fallbackOnly` preview level goes first.
- `preview.jpg` is 256 × 1536: six faces stacked in `bdflru` order. Tile `z`
  counts that preview level as 0, so the first real level is `z = 1`.
- `faceSize` in `data.js` is `min(faceSize, largest level)`.
- JPEG quality defaults to 85.
- Scene ids are `<index>-<slug(name)>`. The slug replaces spaces with `-`,
  drops anything other than `A-Z a-z 0-9 - _`, and lowercases.
- Cube faces use the same orientation as `src/geometries/Cube.js`, and the
  equirectangular mapping is the one in `src/shaders/fragmentEquirect.js`.

Differences: there are no `screenfull`/`bowser` dependencies (the viewer uses
the native Fullscreen API), there is no IE tooltip fallback, there is project
save/load (including from an exported tour), folder export is available, and
each scene in `data.js` has an extra `sourceFile` field.

## Files

- `index.html`, `css/tool.css`, `js/app.js`: editor UI, preview, hotspots, export.
- `js/process.worker.js`: decode → cube faces → tile pyramid → JPEG, one panorama per worker.
- `js/tiff.js`: streaming TIFF decoder used by the worker.
- `js/zip.js`: a small stored (uncompressed) ZIP writer.
- `template/`: files copied into every export.
- `../scripts/tool.js`: builds Marzipano and serves `tool/`, `build/` and `demos/` on 127.0.0.1.
