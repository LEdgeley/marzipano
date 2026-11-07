'use strict';

// Converts one panorama into Marzipano cube tiles.
//
// In:  { kind: 'equirect', file }                       2:1 equirectangular image
//      { kind: 'cube', files: { f, r, b, l, u, d } }    six square cube faces
//      plus { quality } (JPEG quality, 0-1)
// Out: { type: 'levels', levels, faceSize }
//      { type: 'tile', z, face, x, y, blob }   z counts the preview level as 0
//      { type: 'preview', blob }               256px faces stacked in 'bdflru' order
//      { type: 'progress', done, total, stage }
//      { type: 'done' } | { type: 'error', message }

importScripts('tiff.js', 'hdrdecode.js', 'hdrtile.js');

var TILE_SIZE = 512;
var PREVIEW_SIZE = 256;
var PREVIEW_FACE_ORDER = 'bdflru';
var FACES = ['f', 'r', 'b', 'l', 'u', 'd'];
var ENCODE_BATCH = 8;

// Orientation of each face relative to the front face, matching
// src/geometries/Cube.js (rotate about X, then about Y).
var FACE_ROTATION = {
  f: { x: 0, y: 0 },
  b: { x: 0, y: Math.PI },
  l: { x: 0, y: Math.PI / 2 },
  r: { x: 0, y: -Math.PI / 2 },
  u: { x: Math.PI / 2, y: 0 },
  d: { x: -Math.PI / 2, y: 0 }
};

// Same level choice as the Marzipano Tool: 512px tiles, doubling sizes up to
// the face size, plus one more level when the face is more than 25% larger
// than the biggest level so far.
function computeLevels(faceSize) {
  var levels = [];
  var e;
  function size(i) { return TILE_SIZE * Math.pow(2, i); }
  for (e = 0; size(e) <= faceSize; e++) {
    levels.push({ tileSize: TILE_SIZE, size: size(e) });
  }
  if (size(e - 1) * 1.25 < faceSize) {
    levels.push({ tileSize: TILE_SIZE, size: size(e) });
  }
  if (!levels.length) {
    levels.push({ tileSize: TILE_SIZE, size: TILE_SIZE });
  }
  return levels;
}

async function isTiff(file) {
  if (/.tiff?$/i.test(file.name || '') || file.type === 'image/tiff') {
    return true;
  }
  var b = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  return (b[0] === 0x49 && b[1] === 0x49 && (b[2] === 42 || b[2] === 43)) ||
    (b[0] === 0x4D && b[1] === 0x4D && (b[3] === 42 || b[3] === 43));
}

// Returns raw pixels { width, height, channels, data }.
async function decodePixels(file, onProgress) {
  if (await isTiff(file)) {
    return TiffDecoder.decode(file, onProgress);
  }
  var bitmap;
  try {
    bitmap = await createImageBitmap(file, { colorSpaceConversion: 'none' });
  } catch (e) {
    throw new Error('The browser could not decode ' + (file.name || 'this image') +
      ' (it may be too large for the browser; TIFF has no such limit).');
  }
  var canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  var ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  var data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  var result = { width: canvas.width, height: canvas.height, channels: 4, data: data };
  canvas.width = canvas.height = 1; // free the decode canvas
  return result;
}

function pixelsToCanvas(px) {
  var c = makeCanvas(px.width, px.height);
  var rgba;
  if (px.channels === 4) {
    rgba = px.data;
  } else {
    rgba = new Uint8ClampedArray(px.width * px.height * 4);
    for (var i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
      rgba[i] = px.data[j]; rgba[i + 1] = px.data[j + 1]; rgba[i + 2] = px.data[j + 2]; rgba[i + 3] = 255;
    }
  }
  c.ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length), px.width, px.height), 0, 0);
  return c.canvas;
}

// Projects the equirectangular image onto one cube face (bilinear sampling).
function equirectToFace(src, srcW, srcH, ch, face, n) {
  var out = new Uint8ClampedArray(n * n * 4);
  var rot = FACE_ROTATION[face];
  var cx = Math.cos(rot.x), sx = Math.sin(rot.x);
  var cy = Math.cos(rot.y), sy = Math.sin(rot.y);
  var invPi = 1 / Math.PI;
  var o = 0;
  for (var j = 0; j < n; j++) {
    var b = 1 - 2 * (j + 0.5) / n;
    for (var i = 0; i < n; i++) {
      var a = 2 * (i + 0.5) / n - 1;
      // Point on the front face (z = -1), then rotate into place.
      var x = a, y = b, z = -1;
      var y1 = y * cx - z * sx;
      var z1 = y * sx + z * cx;
      var x2 = z1 * sy + x * cy;
      var z2 = z1 * cy - x * sy;
      var len = Math.sqrt(x2 * x2 + y1 * y1 + z2 * z2);
      var theta = Math.atan2(x2, -z2);
      var phi = Math.acos(y1 / len);

      var u = (0.5 + 0.5 * theta * invPi) * srcW - 0.5;
      var v = phi * invPi * srcH - 0.5;

      var u0 = Math.floor(u), v0 = Math.floor(v);
      var fu = u - u0, fv = v - v0;
      var u1 = u0 + 1, v1 = v0 + 1;
      u0 = ((u0 % srcW) + srcW) % srcW;
      u1 = ((u1 % srcW) + srcW) % srcW;
      if (v0 < 0) { v0 = 0; }
      if (v1 < 0) { v1 = 0; }
      if (v0 >= srcH) { v0 = srcH - 1; }
      if (v1 >= srcH) { v1 = srcH - 1; }

      var p00 = (v0 * srcW + u0) * ch, p10 = (v0 * srcW + u1) * ch;
      var p01 = (v1 * srcW + u0) * ch, p11 = (v1 * srcW + u1) * ch;
      var w00 = (1 - fu) * (1 - fv), w10 = fu * (1 - fv);
      var w01 = (1 - fu) * fv, w11 = fu * fv;
      out[o] = src[p00] * w00 + src[p10] * w10 + src[p01] * w01 + src[p11] * w11;
      out[o + 1] = src[p00 + 1] * w00 + src[p10 + 1] * w10 + src[p01 + 1] * w01 + src[p11 + 1] * w11;
      out[o + 2] = src[p00 + 2] * w00 + src[p10 + 2] * w10 + src[p01 + 2] * w01 + src[p11 + 2] * w11;
      out[o + 3] = 255;
      o += 4;
    }
  }
  return out;
}

function makeCanvas(w, h) {
  var c = new OffscreenCanvas(w, h);
  var ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return { canvas: c, ctx: ctx };
}

// Halves repeatedly before the final resize so large reductions stay sharp
// and alias-free (a single drawImage can skip source pixels).
function resize(srcCanvas, size) {
  var cur = srcCanvas;
  while (cur.width / 2 >= size * 1.0001 && cur.width / 2 >= 1) {
    var half = makeCanvas(Math.round(cur.width / 2), Math.round(cur.height / 2));
    half.ctx.drawImage(cur, 0, 0, half.canvas.width, half.canvas.height);
    cur = half.canvas;
  }
  if (cur.width === size) {
    return cur;
  }
  var out = makeCanvas(size, size);
  out.ctx.drawImage(cur, 0, 0, size, size);
  return out.canvas;
}

function encode(canvas, quality) {
  return canvas.convertToBlob({ type: 'image/jpeg', quality: quality });
}

async function tileFace(faceCanvas, face, levels, quality, progress) {
  for (var li = 0; li < levels.length; li++) {
    var level = levels[li];
    var levelCanvas = resize(faceCanvas, level.size);
    var count = level.size / level.tileSize;
    var jobs = [];
    for (var y = 0; y < count; y++) {
      for (var x = 0; x < count; x++) {
        jobs.push({ x: x, y: y });
      }
    }
    for (var k = 0; k < jobs.length; k += ENCODE_BATCH) {
      var batch = jobs.slice(k, k + ENCODE_BATCH);
      var blobs = await Promise.all(batch.map(function(job) {
        var t = makeCanvas(level.tileSize, level.tileSize);
        t.ctx.drawImage(levelCanvas,
          job.x * level.tileSize, job.y * level.tileSize, level.tileSize, level.tileSize,
          0, 0, level.tileSize, level.tileSize);
        return encode(t.canvas, quality);
      }));
      batch.forEach(function(job, idx) {
        // z + 1 because level 0 in data.js is the 256px preview level.
        self.postMessage({ type: 'tile', z: li + 1, face: face, x: job.x, y: job.y, blob: blobs[idx] });
      });
      progress(batch.length);
    }
  }
}

function countTiles(levels) {
  return levels.reduce(function(sum, l) {
    var n = l.size / l.tileSize;
    return sum + n * n;
  }, 0) * 6;
}

async function run(msg) {
  var quality = typeof msg.quality === 'number' ? msg.quality : 0.85;
  var previewCanvas = makeCanvas(PREVIEW_SIZE, PREVIEW_SIZE * 6);
  var levels, faceSize, total, done = 0;
  function progress(n, stage) {
    done += n;
    self.postMessage({ type: 'progress', done: done, total: total, stage: stage || 'tiling' });
  }

  function decodeProgress(fraction) {
    self.postMessage({ type: 'progress', done: fraction, total: 1, stage: 'decoding' });
  }
  decodeProgress(0);

  var getFaceCanvas;
  if (msg.kind === 'equirect') {
    var img = await decodePixels(msg.file, decodeProgress);
    self.postMessage({ type: 'size', width: img.width, height: img.height });
    if (Math.abs(img.width - 2 * img.height) > 2) {
      throw new Error('Equirectangular images must be 2:1, got ' + img.width + 'x' + img.height + '.');
    }
    faceSize = Math.ceil(img.width / 4);
    getFaceCanvas = function(face) {
      var data = equirectToFace(img.data, img.width, img.height, img.channels, face, faceSize);
      var c = makeCanvas(faceSize, faceSize);
      c.ctx.putImageData(new ImageData(data, faceSize, faceSize), 0, 0);
      return Promise.resolve(c.canvas);
    };
  } else if (msg.kind === 'cube') {
    var first = await decodePixels(msg.files.f, decodeProgress);
    self.postMessage({ type: 'size', width: first.width, height: first.height });
    faceSize = first.width;
    var cached = { f: first };
    getFaceCanvas = async function(face) {
      var im = cached[face] || await decodePixels(msg.files[face]);
      delete cached[face];
      if (im.width !== im.height) {
        throw new Error('Cube face "' + face + '" is not square: ' + im.width + 'x' + im.height + '.');
      }
      if (im.width !== faceSize) {
        throw new Error('Cube faces have different sizes (' + faceSize + ' vs ' + im.width + ').');
      }
      return pixelsToCanvas(im);
    };
  } else {
    throw new Error('Unknown panorama kind: ' + msg.kind);
  }

  levels = computeLevels(faceSize);
  total = countTiles(levels) + 6;
  self.postMessage({ type: 'levels', levels: levels, faceSize: faceSize });

  for (var i = 0; i < FACES.length; i++) {
    var face = FACES[i];
    self.postMessage({ type: 'progress', done: done, total: total, stage: 'projecting face ' + face });
    var faceCanvas = await getFaceCanvas(face);
    var p = resize(faceCanvas, PREVIEW_SIZE);
    previewCanvas.ctx.drawImage(p, 0, PREVIEW_FACE_ORDER.indexOf(face) * PREVIEW_SIZE);
    progress(1, 'tiling face ' + face);
    await tileFace(faceCanvas, face, levels, quality, function(n) { progress(n, 'tiling face ' + face); });
    faceCanvas.width = faceCanvas.height = 1;
  }

  var previewBlob = await encode(previewCanvas.canvas, quality);
  self.postMessage({ type: 'preview', blob: previewBlob });
  self.postMessage({ type: 'done' });
}

// ---- HDR (OpenEXR / Radiance) -> Ultra HDR tiles ---------------------------

var GAIN_QUALITY = 0.95;
var MIDDLE_GREY = 0.18;
var HIGHLIGHT_ANCHOR = 1.5;
var HDR_ENCODE_BATCH = 6;

async function encodeUltraHdr(px, size, params, quality) {
  var count = size * size;
  var base = new Uint8ClampedArray(count * 4);
  var gain = new Uint8ClampedArray(count * 4);
  HdrTile.splitBaseGain(px, count, params, base, gain);
  // Two canvases so both encodes run at once.
  var cb = makeCanvas(size, size), cg = makeCanvas(size, size);
  cb.ctx.putImageData(new ImageData(base, size, size), 0, 0);
  cg.ctx.putImageData(new ImageData(gain, size, size), 0, 0);
  var blobs = await Promise.all([encode(cb.canvas, quality), encode(cg.canvas, GAIN_QUALITY)]);
  var baseBlob = blobs[0], gainBlob = blobs[1];
  var bytes = HdrTile.assembleUltraHdr(
    new Uint8Array(await baseBlob.arrayBuffer()),
    new Uint8Array(await gainBlob.arrayBuffer()),
    params);
  return new Blob([bytes], { type: 'image/jpeg' });
}

// Like encodeUltraHdr but for a non-square strip (the 256 x 1536 preview).
async function encodeUltraHdrStrip(px, width, height, params, quality) {
  var count = width * height;
  var base = new Uint8ClampedArray(count * 4);
  var gain = new Uint8ClampedArray(count * 4);
  HdrTile.splitBaseGain(px, count, params, base, gain);
  var c = new OffscreenCanvas(width, height);
  var ctx = c.getContext('2d');
  ctx.putImageData(new ImageData(base, width, height), 0, 0);
  var baseBlob = await encode(c, quality);
  ctx.putImageData(new ImageData(gain, width, height), 0, 0);
  var gainBlob = await encode(c, GAIN_QUALITY);
  var bytes = HdrTile.assembleUltraHdr(
    new Uint8Array(await baseBlob.arrayBuffer()),
    new Uint8Array(await gainBlob.arrayBuffer()),
    params);
  return new Blob([bytes], { type: 'image/jpeg' });
}

async function runHdr(msg, format) {
  var quality = typeof msg.quality === 'number' ? msg.quality : 0.85;
  var file = msg.file;
  var total = 1, done = 0;
  function post(stage) {
    self.postMessage({ type: 'progress', done: done, total: total, stage: stage });
  }

  // 1. Decode into a packed source, collecting luminance statistics.
  var builder = null;
  var decodeFn = format === 'exr' ? HdrDecode.decodeExr : HdrDecode.decodeRadiance;
  var size = format === 'exr' ? await HdrDecode.readExrSize(file) : null;
  if (size) {
    if (Math.abs(size.width - 2 * size.height) > 2) {
      throw new Error('Equirectangular images must be 2:1, got ' + size.width + 'x' + size.height + '.');
    }
    self.postMessage({ type: 'size', width: size.width, height: size.height });
    builder = new HdrTile.SourceBuilder(size.width, size.height);
  }
  var info = await decodeFn(file, function(y, n, rgb) {
    if (!builder) {
      var w = rgb.length / n / 3;
      builder = new HdrTile.SourceBuilder(w, Math.round(w / 2));
    }
    if (y + n <= builder.height) { builder.addRows(y, n, rgb); }
  }, function(fraction) {
    self.postMessage({ type: 'progress', done: fraction, total: 1, stage: 'decoding HDR' });
  });
  if (!size) {
    if (Math.abs(info.width - 2 * info.height) > 2) {
      throw new Error('Equirectangular images must be 2:1, got ' + info.width + 'x' + info.height + '.');
    }
    self.postMessage({ type: 'size', width: info.width, height: info.height });
  }

  // 2. Base exposure is anchored on the highlights: the luminance that 99% of
  //    the sphere lies below (lit surfaces, not light sources) maps to
  //    HIGHLIGHT_ANCHOR. Anchoring on the average instead makes low-key
  //    scenes, like a theatre with black drapes, look washed out.
  var logAverage = builder.logAverage();
  var p99 = builder.percentile(0.99);
  var exposure = HIGHLIGHT_ANCHOR / Math.max(p99, 1e-9);
  // Never brighten the average past middle grey (high-key scenes).
  exposure = Math.min(exposure, MIDDLE_GREY / Math.max(logAverage, 1e-9));
  var params = HdrTile.makeParams(builder.maxChannel * exposure);
  var hdrInfo = {
    format: 'ultrahdr',
    gainMapMin: params.gainMapMin,
    gainMapMax: params.gainMapMax,
    gamma: params.gamma,
    offsetSdr: params.offsetSdr,
    offsetHdr: params.offsetHdr,
    hdrCapacityMin: params.hdrCapacityMin,
    hdrCapacityMax: params.hdrCapacityMax,
    baseRendition: params.baseRendition,
    baseExposure: exposure,
    sourceLogAverage: logAverage,
    sourceP99: p99,
    sourceMax: builder.maxChannel
  };
  self.postMessage({ type: 'hdr', hdr: hdrInfo });

  var faceSize = Math.ceil(builder.width / 4);
  var levels = computeLevels(faceSize);
  total = countTiles(levels) + 6;
  self.postMessage({ type: 'levels', levels: levels, faceSize: faceSize });

  var preview = new Float32Array(PREVIEW_SIZE * PREVIEW_SIZE * 6 * 3);
  var desc = levels.map(function(l, i) { return { level: l, z: i + 1 }; }).reverse();

  for (var f = 0; f < FACES.length; f++) {
    var face = FACES[f];
    post('projecting face ' + face);
    var facePx = HdrTile.projectFace(builder, face, faceSize, exposure);
    done++;

    var levelPx = null, levelSize = 0;
    for (var d = 0; d < desc.length; d++) {
      var lv = desc[d].level, z = desc[d].z;
      var S = lv.size, T = lv.tileSize, count = S / T;
      var upsample = S > faceSize;
      if (!upsample) {
        if (!levelPx) {
          post('resampling face ' + face);
          levelPx = HdrTile.downsample(facePx, faceSize, S);
          facePx = null; // largest level that fits is done with the face
        } else if (levelSize !== S) {
          levelPx = HdrTile.downsample(levelPx, levelSize, S);
        }
        levelSize = S;
      }
      // Encode tiles in small batches: JPEG encoding is asynchronous, so the
      // next tiles are split while earlier ones encode.
      var pending = [];
      var flush = async function() {
        var results = await Promise.all(pending.map(function(p) { return p.promise; }));
        pending.forEach(function(p, i) {
          self.postMessage({ type: 'tile', z: p.z, face: face, x: p.x, y: p.y, blob: results[i] });
          done++;
        });
        pending = [];
        post('tiling face ' + face);
      };
      for (var ty = 0; ty < count; ty++) {
        for (var tx = 0; tx < count; tx++) {
          var tile = upsample
            ? HdrTile.upsampleTile(facePx, faceSize, S, T, tx, ty)
            : HdrTile.cropTile(levelPx, S, T, tx, ty);
          pending.push({ z: z, x: tx, y: ty, promise: encodeUltraHdr(tile, T, params, quality) });
          if (pending.length >= HDR_ENCODE_BATCH) { await flush(); }
        }
      }
      if (pending.length) { await flush(); }
    }
    // Preview face from the smallest level.
    var small = levelPx
      ? HdrTile.downsample(levelPx, levelSize, PREVIEW_SIZE)
      : HdrTile.downsample(facePx, faceSize, PREVIEW_SIZE);
    preview.set(small, PREVIEW_FACE_ORDER.indexOf(face) * PREVIEW_SIZE * PREVIEW_SIZE * 3);
  }

  var previewBlob = await encodeUltraHdrStrip(preview, PREVIEW_SIZE, PREVIEW_SIZE * 6, params, quality);
  self.postMessage({ type: 'preview', blob: previewBlob });
  self.postMessage({ type: 'done' });
}

async function dispatch(msg) {
  if (msg.kind === 'equirect') {
    var format = await HdrDecode.sniff(msg.file);
    if (format) {
      return runHdr(msg, format);
    }
  } else if (msg.kind === 'cube') {
    for (var key in msg.files) {
      if (await HdrDecode.sniff(msg.files[key])) {
        throw new Error('HDR cube faces are not supported yet; use an equirectangular EXR or HDR.');
      }
    }
  }
  return run(msg);
}

self.onmessage = function(e) {
  dispatch(e.data).catch(function(err) {
    self.postMessage({ type: 'error', message: (err && err.message) || String(err) });
  });
};
