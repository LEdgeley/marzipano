# HDR panoramas (Ultra HDR tiles)

This branch adds end-to-end HDR support. The tool imports OpenEXR and Radiance
panoramas and turns them into tiles that keep their HDR range. The viewer then
shows them in true HDR on HDR displays, and on SDR displays it tone-maps them,
with an exposure that adapts to where you look.

## Tile format: Ultra HDR JPEGs

Each tile, and the cube-map preview, is an **Ultra HDR JPEG**: an SDR JPEG
with an embedded gain map (Adobe/Google `hdrgm` 1.0). It is the same format
phones write, not a new one:

- The primary image is a normal SDR JPEG. Any viewer, including unmodified
  Marzipano, shows it as usual.
- An XMP `Container:Directory` and an MPF index point to the second JPEG, the
  gain map. Its XMP holds `GainMapMin/Max`, `Gamma`, `OffsetSDR/HDR` and
  `HDRCapacityMin/Max`.
- Reconstruction (per channel, linear): `HDR = (SDR + offsetSdr) ·
  2^(lerp(min, max, gain^(1/gamma)) · weight) − offsetHdr`.

The gain-map parameters are also stored per scene in `data.js` (`scene.hdr`),
so the viewer doesn't parse XMP for each tile. Tiles stay `.jpg`, so the paths
are the same as for SDR tours.

**Why the viewer splits the files itself:** browsers decode Ultra HDR in
`<img>`, but WebGL and WebGPU texture uploads only see the SDR base. So the
loader (`src/loaders/UltraHdr.js`) fetches each tile's bytes, finds the gain
map through MPF (`src/util/ultraHdr.js`) and decodes both JPEGs to textures.

### How the tool encodes HDR

1. The decoder (`tool/js/hdrdecode.js`) streams the EXR/HDR into an RGB9E5
   packed buffer: 4 bytes per pixel, error ≤ 0.2% of the brightest channel.
   That is 1.45 GB for a 26928×13464 panorama. It also collects a
   solid-angle-weighted histogram of luminance, and the peak.
2. **Base exposure** is anchored on the highlights. The luminance that 99% of
   the sphere lies below maps to 1.5, where 1.0 is SDR white. That is lit
   surfaces, not the light sources, which cover about 0.01% of the sphere.
   - Anchoring on the average (the first version) put the theatre's black
     drapes at mid grey and washed everything out.
   - For high-key scenes, exposure is also capped so the average doesn't go
     above middle grey.
3. Each cube face is projected in float, then resampled to the level sizes
   with an area filter that streams row by row, to keep memory down.
4. For each tile:
   - **SDR base:** hue-preserving. Each pixel is the HDR multiplied by one
     factor: `s = min(T(Y)/Y, 1/max(r,g,b))`, where T is AgX's brightness
     curve for neutral greys. The base therefore has the HDR's exact
     chromaticity, with AgX's toe and shoulder in brightness.
   - **Gain map:** single-channel: `log2((Y_hdr + k)/(Y_base + k))`, with
     k = 1/1024 and gamma 0.5. It is computed from the quantised base, so
     8-bit rounding is corrected too.
5. The viewer rebuilds the HDR and tone-maps it with the full AgX transform
   (per channel, with a mild look: contrast power 1.2, saturation 1.15). That
   is what renders the stage wash, gobos and black drapes correctly.

### How the encoding got here

1. **Version 1** used a chromaticity-preserving Reinhard curve, and the same
   curve in the viewer. That curve scales a whole pixel down when a channel
   would clip. In saturated light (the purple stage wash) it maps every
   brightness above the clip point to the same colour, so the gobo patterns
   and floor texture vanished. The fix was to tone-map with **AgX** in the
   viewer, which fades very bright saturated colour smoothly toward white and
   has a real toe for blacks.
2. **Version 2** also baked full AgX into the base and used an RGB gain map.
   That failed on the rear-stage LED backlights:
   - AgX desaturates a bright blue LED face toward white, lifting red from
     about 0.05 to 1.0.
   - Rebuilding the HDR then needs per-channel gains spread over 5+ stops.
     Red fell below the map's floor, and JPEG's 4:2:0, coarsely quantised
     chroma smeared the gains of neighbouring emitters.
   - Red was rebuilt about 3 stops low (2.1 stops at the 95th percentile even
     at JPEG quality 100), so the lamp faces looked dark in the middle.
3. **Version 3 (current)** keeps AgX in the viewer but makes the base
   hue-preserving. A single-channel gain map then rebuilds every colour, and
   grey JPEG holds it without chroma loss.

Measured through the real JPEG round trip on a 512×512 tile centred on a
backlight:

- Luminance error: 0.03 stops median and 0.10 stops at the 95th percentile
  over the whole tile; 0.04 and 0.15 stops on the lamp face itself.
- Rendered through AgX, the lamp face matches the float source at −1 EV and
  at −4 EV.
- The remaining per-channel error is confined to channels that are tiny next
  to the others, such as red on a blue LED, which is ordinary JPEG chroma blur
  in the base and not visible.

Only the SDR base differs from what the viewer shows: a tile viewed outside
Marzipano, in SDR, has flatter saturated highlights. In HDR, Ultra HDR
viewers rebuild the HDR in full.

The per-pixel curve and log2 run through lookup tables indexed on the
float's bits.

**About the lamps' colour:** the EXR's blue channel on the LED faces tops out
at about 7.5 on many emitters. The LEDs clipped blue even in the darkest
bracket, so the merge capped blue while red and green kept rising. At low
exposure the faces therefore look cyan-tinted. That's in the source data,
and the viewer shows it faithfully. Adding a darker bracket when shooting
lit fixtures would capture them properly.

## Rendering

| Display | Stage | What happens |
| --- | --- | --- |
| HDR display with WebGPU (Chromium 129+) | `WebGpuStage`: `rgba16float` canvas, `toneMapping: {mode: 'extended'}` | Full HDR is reconstructed. Values up to SDR white are shown as they are; above that, each channel rolls off smoothly into `headroom` × SDR white. |
| Everything else | `WebGlStage` (unchanged default) | Full HDR is reconstructed, multiplied by an auto exposure, and tone-mapped with AgX. |

- **Why WebGPU:** HDR canvas output on the web only works through WebGPU's
  extended tone mapping. WebGL's equivalent (`drawingBufferToneMapping`) is
  still an unshipped proposal.
- **HDR stage:** `WebGpuStage` is a full stage implementation, with tiles,
  depth-ordered fallbacks, blending and viewport clamping. It follows the
  `(dynamic-range: high)` media query, so moving the window between screens
  switches between HDR and SDR output.
- **Choosing a stage:** `HdrController.createViewer()` picks the stage.
  `?stage=webgl|webgpu` forces one in the tool and in exported tours.

### Auto exposure (SDR)

`HdrController` decodes the HDR preview on the CPU (256 px per face) into log
luminance. On every view change it samples a 16×10 grid of rays across the
viewport, with Gaussian centre weighting. Then:

The target exposure (log2, relative to the base) is:

```
t = min( strength · (panoramaMeanLog − viewMeanLog),
         log2(highlightLimit) − viewTop5%Log )
```

- **Partial adaptation** (`strength` 0.5): a dark area gets somewhat brighter
  but stays dark, and a bright one stays bright, as in a dim room. The first
  version adapted fully, so the black drapes ended up mid grey.
- **Highlight protection** (`highlightLimit` 6): the brightest 5% of the view is
  held inside AgX's shoulder, so looking into a lamp darkens the view and
  shows the lamp's structure.
- `t` is clamped to −6…+1.5 EV.
- Exposure eases toward the target in log space. Darkening takes 0.25 s and
  brightening 0.6 s, roughly like an eye adapting.

Zooming changes the metered area, so exposure follows zoom as well as
direction.

Measured on the theatre panorama:

- Wide view: −0.5 EV.
- Zoom onto the stage lights: −1.3 EV, reached in about 1 s.
- The black side curtain: +2.0 EV, reached in about 3 s.

Options: `strength`, `highlightLimit`, `minExposure`, `maxExposure`, `adaptDown`, `adaptUp`,
`centerWeight`, `compensation` (EV), `headroom`, and `autoExposure`
(`'auto'` = on for SDR and off for HDR output).

## Library API added

- `ImageUrlSource(..., { ultraHdr: true })`: loads tiles as `HdrAsset`s.
- `HdrAsset`, `UltraHdrLoader`, `splitUltraHdr(bytes)`.
- `WebGpuStage` (`new Viewer(el, { stage: { device, hdr: 'auto' } })`) and
  `WebGpuStage.requestDevice()`.
- Layer effect `hdr: { gainMapMin, gainMapMax, gamma, offsetSdr, offsetHdr,
  exposure, weight, headroom, output: 'sdr' | 'hdr' }`.
- `HdrController(viewer, opts)`, with `.attach(scene, hdrMeta, previewUrl)`
  and `HdrController.createViewer(el, viewerOpts, { stage })`.

## Results on the A1 theatre EXR

- **Input:** 26928×13464 PIZ half-float EXR, 963 MB, about 10.4 stops from the
  average to the peak.
- **Processing:** 96 s in Chrome, producing 2046 tiles over levels 512–8192.
  Tiles are encoded six at a time.
- **Size:** 103 MB of tiles, against 43 MB for the SDR TIFF of the same scene
  (about 2.4×). The luminance gain map carries more image detail than the
  RGB one did. Lowering its quality, or storing it at half resolution as
  libultrahdr does by default, would shrink it, at some cost to small
  sources like the LED faces.

## Limits and open questions

- **HDR output is unverified on real HDR hardware.** I tested on an SDR
  display: Chromium 152 accepts the extended configuration, and the HDR path
  renders and weights the gain map correctly, but I haven't seen the actual
  brightness.
- **Display headroom isn't exposed to the web.** The default assumption is 4×
  (2 stops); set `HdrController` `headroom` for your target displays.
- **WebGPU stage:** cube and flat geometry only (no equirect), and no
  `takeSnapshot`.
- **Shadow precision:** the base is 8-bit with a global tone curve, so deep
  shadows have about SDR-JPEG precision. When auto exposure lifts them by
  2–3 EV, banding is possible on smooth gradients. The theatre curtain looked
  fine. A locally tone-mapped base would fix it at the cost of a busier gain
  map.
- **Fallback base:** the SDR base is hue-preserving, so non-HDR viewers see
  saturated highlights flatter than Marzipano renders them.
- **Lens flare:** the halos around the lamps are in the EXR itself (camera
  flare in the brackets). Tone mapping can't remove them, only stop them
  being exaggerated.
- **Inputs:** HDR cube-face input isn't supported (equirectangular only). EXR
  input must be single-part scanline files with none, RLE, ZIPS, ZIP or PIZ
  compression.
- **Container metadata:** XMP plus MPF (Ultra HDR v1) is written; ISO 21496-1
  binary metadata isn't. I haven't validated the files against libultrahdr's
  tools.
- **Testing aid:** `?timerframes` (tool only) drives animation from a timer, so
  hidden or headless tabs keep rendering and adapting.
