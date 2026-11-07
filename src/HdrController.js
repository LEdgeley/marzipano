/*
 * Copyright 2026 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
'use strict';

var eventEmitter = require('minimal-event-emitter');
var global = require('./util/global');
var now = require('./util/now');
var splitUltraHdr = require('./util/ultraHdr');

var FACE_ORDER = 'bdflru';
var FACE_ROTATION = {
  f: { x: 0, y: 0 },
  b: { x: 0, y: Math.PI },
  l: { x: 0, y: Math.PI / 2 },
  r: { x: 0, y: -Math.PI / 2 },
  u: { x: Math.PI / 2, y: 0 },
  d: { x: -Math.PI / 2, y: 0 }
};

var defaults = {
  // Auto exposure: 'auto' means on for SDR output and off for HDR output.
  autoExposure: 'auto',
  // How far exposure follows the view's average brightness away from the
  // panorama's (0 = fixed exposure, 1 = every view averages the same). Partial
  // adaptation keeps dark areas dark and bright areas bright, as in a dim room.
  strength: 0.5,
  // The brightest 5% of the view is kept at or below this (scene-linear,
  // 1.0 = SDR white), so looking into a light reveals its structure.
  highlightLimit: 6,
  // Exposure limits, relative to the panorama's base exposure.
  minExposure: 1 / 64,
  maxExposure: 2.8,
  // Adaptation time constants in seconds (darkening is faster, as in vision).
  adaptDown: 0.25,
  adaptUp: 0.6,
  // Meter grid and centre weighting (Gaussian sigma, fraction of half-size).
  gridX: 16,
  gridY: 10,
  centerWeight: 0.6,
  // HDR headroom (peak / SDR white) to assume on HDR displays.
  headroom: 4,
  // Manual exposure compensation in stops, applied on top of everything.
  compensation: 0
};

/**
 * @class HdrController
 * @classdesc
 *
 * Drives the `hdr` effect of HDR scenes (scenes whose tiles are Ultra HDR
 * JPEGs) for a {@link Viewer}.
 *
 * - On an HDR display, with a {@link WebGpuStage} presenting in extended
 *   range, the gain map is applied as the Ultra HDR spec describes: weighted
 *   by how much of the map's capacity the display's headroom can show. Values
 *   above 1.0 come out brighter than SDR white.
 * - Otherwise the HDR is reconstructed in full and tone-mapped to SDR, with an
 *   exposure that adapts smoothly to where the viewer looks and how far they
 *   zoom in: the luminance of the visible part of the panorama is metered
 *   from the HDR preview image.
 *
 * @param {Viewer} viewer
 * @param {Object} [opts] See the defaults at the top of this file.
 */
function HdrController(viewer, opts) {
  var self = this;
  this._viewer = viewer;
  this._opts = {};
  for (var key in defaults) {
    this._opts[key] = opts && opts[key] != null ? opts[key] : defaults[key];
  }
  this._scenes = [];
  this._raf = null;
  this._lastTime = null;

  this._tick = function() {
    self._raf = null;
    self._update();
  };
  this._schedule = function() {
    if (self._raf == null) {
      self._raf = global.requestAnimationFrame(self._tick);
    }
  };
  this._handleSceneChange = function() {
    var entry = self._entryFor(viewer.scene());
    if (entry) {
      entry.snap = true; // start a newly shown scene at its metered exposure
    }
    self._schedule();
  };

  viewer.addEventListener('sceneChange', this._handleSceneChange);
  this._stage = viewer.stage();
  this._stage.addEventListener('hdrChange', this._schedule);
}

eventEmitter(HdrController);

/**
 * Whether the viewer is presenting in HDR (extended range) right now.
 * @return {boolean}
 */
HdrController.prototype.hdrOutput = function() {
  return !!(this._stage.hdrActive && this._stage.hdrActive());
};

/**
 * Registers an HDR scene.
 *
 * @param {Scene} scene
 * @param {Object} hdr Gain-map metadata (gainMapMin, gainMapMax, gamma,
 *     offsetSdr, offsetHdr, hdrCapacityMin, hdrCapacityMax).
 * @param {string} [previewUrl] Ultra HDR cube-map preview (faces stacked in
 *     'bdflru' order) used for exposure metering.
 */
HdrController.prototype.attach = function(scene, hdr, previewUrl) {
  var self = this;
  var entry = {
    scene: scene,
    hdr: hdr,
    meter: null,
    exposure: 1,
    target: 1,
    snap: true
  };
  entry.onViewChange = this._schedule;
  scene.view().addEventListener('change', entry.onViewChange);
  this._scenes.push(entry);
  if (previewUrl) {
    loadMeter(previewUrl, hdr).then(function(meter) {
      entry.meter = meter;
      entry.snap = true;
      self._schedule();
    }, function(err) {
      self.emit('error', err);
    });
  }
  this._apply(entry);
  this._schedule();
};

HdrController.prototype.detach = function(scene) {
  var entry = this._entryFor(scene);
  if (!entry) {
    return;
  }
  scene.view().removeEventListener('change', entry.onViewChange);
  this._scenes.splice(this._scenes.indexOf(entry), 1);
};

HdrController.prototype.destroy = function() {
  var self = this;
  this._scenes.slice().forEach(function(e) { self.detach(e.scene); });
  this._viewer.removeEventListener('sceneChange', this._handleSceneChange);
  this._stage.removeEventListener('hdrChange', this._schedule);
  if (this._raf != null) {
    global.cancelAnimationFrame(this._raf);
  }
};

/**
 * Sets options at runtime (for example compensation or autoExposure).
 */
HdrController.prototype.setOptions = function(opts) {
  for (var key in opts) {
    if (key in defaults) {
      this._opts[key] = opts[key];
    }
  }
  this._schedule();
};

/**
 * The current exposure (relative to the base exposure) of a scene.
 */
HdrController.prototype.exposure = function(scene) {
  var entry = this._entryFor(scene || this._viewer.scene());
  return entry ? entry.exposure : 1;
};

HdrController.prototype._entryFor = function(scene) {
  for (var i = 0; i < this._scenes.length; i++) {
    if (this._scenes[i].scene === scene) {
      return this._scenes[i];
    }
  }
  return null;
};

HdrController.prototype._autoExposureOn = function() {
  var a = this._opts.autoExposure;
  if (a === 'auto') {
    return !this.hdrOutput();
  }
  return !!a;
};

HdrController.prototype._update = function() {
  var t = now();
  var dt = this._lastTime == null ? 0 : Math.min(0.1, (t - this._lastTime) / 1000);
  this._lastTime = t;

  var entry = this._entryFor(this._viewer.scene());
  if (!entry) {
    this._lastTime = null;
    return;
  }

  var target = 1;
  if (this._autoExposureOn() && entry.meter) {
    var stats = meterView(entry.meter, entry.scene.view(), this._opts);
    if (stats) {
      var o = this._opts;
      // Follow the average part of the way...
      var t = o.strength * (entry.meter.meanLog - stats.meanLog);
      // ...but never so bright that the view's highlights blow out.
      t = Math.min(t, Math.log2(o.highlightLimit) - stats.highLog);
      target = Math.pow(2, t);
      target = Math.min(o.maxExposure, Math.max(o.minExposure, target));
    }
  }
  entry.target = target;

  var current = Math.log2(entry.exposure);
  var goal = Math.log2(target);
  if (entry.snap || dt === 0 && current === goal) {
    current = goal;
    entry.snap = false;
  } else {
    var tau = goal < current ? this._opts.adaptDown : this._opts.adaptUp;
    current += (goal - current) * (1 - Math.exp(-dt / tau));
  }
  entry.exposure = Math.pow(2, current);
  this._apply(entry);
  this.emit('exposureChange', entry.exposure, entry.scene);

  if (Math.abs(goal - current) > 0.005) {
    this._schedule(); // still adapting
  } else {
    this._lastTime = null;
  }
};

HdrController.prototype._apply = function(entry) {
  var hdr = entry.hdr;
  var opts = this._opts;
  var hdrOut = this.hdrOutput();
  var comp = Math.pow(2, opts.compensation || 0);
  var exposure = entry.exposure * comp;
  var effect = {
    gainMapMin: hdr.gainMapMin,
    gainMapMax: hdr.gainMapMax,
    gamma: hdr.gamma,
    offsetSdr: hdr.offsetSdr,
    offsetHdr: hdr.offsetHdr
  };
  if (hdrOut) {
    // Rebuild the full HDR and roll highlights off into the display's
    // headroom. (The spec's alternative, blending base and HDR by a weight,
    // would show the hue-preserving base's flattened highlights.)
    effect.weight = 1;
    effect.headroom = Math.max(1, opts.headroom);
    effect.exposure = this._autoExposureOn() ? exposure : comp;
    effect.output = 'hdr';
  } else {
    effect.weight = 1;
    effect.exposure = exposure;
    effect.output = 'sdr';
  }
  entry.scene.listLayers().forEach(function(layer) {
    var effects = {};
    var old = layer.effects() || {};
    for (var k in old) { effects[k] = old[k]; }
    effects.hdr = effect;
    layer.setEffects(effects);
  });
};

// ---- Metering ---------------------------------------------------------------

// Decodes the Ultra HDR preview into per-texel log2 luminance (full HDR).
function loadMeter(url, hdr) {
  return global.fetch(url).then(function(r) {
    if (!r.ok) {
      throw new Error('Could not load HDR preview: ' + url);
    }
    return r.arrayBuffer();
  }).then(function(buffer) {
    var parts = splitUltraHdr(buffer);
    var whole = new Uint8Array(buffer);
    var opts = { premultiplyAlpha: 'none', colorSpaceConversion: 'none' };
    return Promise.all([
      global.createImageBitmap(new global.Blob([parts ? parts.primary : whole]), opts),
      parts ? global.createImageBitmap(new global.Blob([parts.gainMap]), opts) : null
    ]);
  }).then(function(bitmaps) {
    var base = pixels(bitmaps[0]);
    var gain = bitmaps[1] ? pixels(bitmaps[1], bitmaps[0].width, bitmaps[0].height) : null;
    var w = bitmaps[0].width, h = bitmaps[0].height;
    var lum = new Float32Array(w * h);
    var weight = new Float32Array(w * w);
    for (var wy = 0; wy < w; wy++) {
      for (var wx = 0; wx < w; wx++) {
        var fa = (wx + 0.5) / w * 2 - 1, fb = (wy + 0.5) / w * 2 - 1;
        weight[wy * w + wx] = Math.pow(1 + fa * fa + fb * fb, -1.5); // texel solid angle
      }
    }
    var sum = 0, wsum = 0;
    var lin = new Float32Array(256);
    for (var i = 0; i < 256; i++) {
      var c = i / 255;
      lin[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }
    var gMin = hdr.gainMapMin || 0, gMax = hdr.gainMapMax || 0;
    var invGamma = 1 / (hdr.gamma || 1);
    var kS = hdr.offsetSdr != null ? hdr.offsetSdr : 1 / 64;
    var kH = hdr.offsetHdr != null ? hdr.offsetHdr : 1 / 64;
    for (var p = 0; p < w * h; p++) {
      var r = lin[base[p * 4]], g = lin[base[p * 4 + 1]], b = lin[base[p * 4 + 2]];
      var boost = 1;
      if (gain) {
        var norm = Math.pow(gain[p * 4] / 255, invGamma);
        boost = Math.pow(2, gMin + (gMax - gMin) * norm);
      }
      var L = 0.2126 * ((r + kS) * boost - kH) + 0.7152 * ((g + kS) * boost - kH) +
              0.0722 * ((b + kS) * boost - kH);
      lum[p] = Math.log2(Math.max(L, 1e-5));
      var sw = weight[(Math.floor(p / w) % w) * w + (p % w)];
      sum += sw * lum[p];
      wsum += sw;
    }
    bitmaps.forEach(function(bm) { if (bm) { bm.close(); } });
    return { size: w, lum: lum, meanLog: sum / wsum };
  });
}

function pixels(bitmap, width, height) {
  width = width || bitmap.width;
  height = height || bitmap.height;
  var canvas = global.OffscreenCanvas ? new global.OffscreenCanvas(width, height) : document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  var ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height).data;
}

// Centre-weighted mean log2 luminance of the visible view, and the log2
// luminance its brightest 5% (by weight) reaches.
var samples = [];
function meterView(meter, view, opts) {
  var size = view.size();
  if (!size || !size.width || !size.height) {
    return null;
  }
  var gx = opts.gridX, gy = opts.gridY;
  var sigma2 = 2 * opts.centerWeight * opts.centerWeight;
  var sum = 0, wsum = 0;
  var coords = {};
  samples.length = 0;
  for (var j = 0; j < gy; j++) {
    var ny = (j + 0.5) / gy * 2 - 1;
    for (var i = 0; i < gx; i++) {
      var nx = (i + 0.5) / gx * 2 - 1;
      var c = view.screenToCoordinates({ x: (nx + 1) / 2 * size.width, y: (ny + 1) / 2 * size.height }, coords);
      if (!c) {
        continue;
      }
      var w = Math.exp(-(nx * nx + ny * ny) / sigma2);
      var v = sampleLog(meter, c.yaw, c.pitch);
      sum += w * v;
      wsum += w;
      samples.push({ v: v, w: w });
    }
  }
  if (!(wsum > 0)) {
    return null;
  }
  samples.sort(function(a, b) { return b.v - a.v; });
  var acc = 0, highLog = samples[0].v;
  for (var k = 0; k < samples.length; k++) {
    acc += samples[k].w;
    if (acc >= 0.05 * wsum) { highLog = samples[k].v; break; }
  }
  return { meanLog: sum / wsum, highLog: highLog };
}

// Log luminance in the preview cube map in the direction (yaw, pitch).
function sampleLog(meter, yaw, pitch) {
  var cp = Math.cos(pitch);
  var x = Math.sin(yaw) * cp, y = -Math.sin(pitch), z = -Math.cos(yaw) * cp;
  var ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  var face;
  if (ax >= ay && ax >= az) {
    face = x > 0 ? 'r' : 'l';
  } else if (ay >= az) {
    face = y > 0 ? 'u' : 'd';
  } else {
    face = z < 0 ? 'f' : 'b';
  }
  // Undo the face rotation (rotateX(rx) then rotateY(ry)).
  var rot = FACE_ROTATION[face];
  var c1 = Math.cos(-rot.y), s1 = Math.sin(-rot.y);
  var x1 = z * s1 + x * c1, z1 = z * c1 - x * s1;
  var c2 = Math.cos(-rot.x), s2 = Math.sin(-rot.x);
  var y2 = y * c2 - z1 * s2, z2 = y * s2 + z1 * c2;
  var a = x1 / -z2, b = y2 / -z2;
  var n = meter.size;
  var col = Math.min(n - 1, Math.max(0, Math.floor((a + 1) / 2 * n)));
  var row = Math.min(n - 1, Math.max(0, Math.floor((1 - b) / 2 * n)));
  row += FACE_ORDER.indexOf(face) * n;
  return meter.lum[row * n + col];
}

HdrController._sampleLog = sampleLog;

/**
 * Creates a {@link Viewer} on the best stage for HDR content: a
 * {@link WebGpuStage} with extended-range output when WebGPU and an HDR
 * display are available (or `stage: 'webgpu'` is forced), otherwise the usual
 * WebGL stage, which tone-maps HDR scenes to SDR.
 *
 * @param {Element} domElement
 * @param {Object} [viewerOpts] Options for the {@link Viewer}.
 * @param {Object} [opts]
 * @param {string} [opts.stage='auto'] 'auto', 'webgpu' or 'webgl'.
 * @return {Promise<Viewer>}
 */
HdrController.createViewer = function(domElement, viewerOpts, opts) {
  var Viewer = require('./Viewer');
  var WebGpuStage = require('./stages/WebGpu');
  var choice = opts && opts.stage || 'auto';
  viewerOpts = viewerOpts || {};
  var wantGpu = choice === 'webgpu' || (choice === 'auto' && WebGpuStage.displaySupportsHdr());
  var devicePromise = wantGpu ? WebGpuStage.requestDevice() : Promise.resolve(null);
  return devicePromise.then(function(device) {
    var stageOpts = {};
    for (var k in viewerOpts.stage || {}) { stageOpts[k] = viewerOpts.stage[k]; }
    if (device) {
      stageOpts.device = device;
    }
    var o = {};
    for (var key in viewerOpts) { o[key] = viewerOpts[key]; }
    o.stage = stageOpts;
    try {
      return new Viewer(domElement, o);
    } catch (e) {
      if (!device) {
        throw e;
      }
      delete stageOpts.device; // WebGPU canvas failed: fall back to WebGL
      return new Viewer(domElement, o);
    }
  });
};

module.exports = HdrController;
