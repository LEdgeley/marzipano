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

var Stage = require('./Stage');
var HtmlImageLoader = require('../loaders/HtmlImage');
var UltraHdrLoader = require('../loaders/UltraHdr');
var inherits = require('../util/inherits');
var pixelRatio = require('../util/pixelRatio');
var global = require('../util/global');
var setAbsolute = require('../util/dom').setAbsolute;
var setFullSize = require('../util/dom').setFullSize;
var clearOwnProperties = require('../util/clearOwnProperties');

// Bytes per draw in the uniform buffer (WebGPU requires 256-byte alignment
// for dynamic offsets).
var UNIFORM_SLOT = 256;
var UNIFORM_FLOATS = UNIFORM_SLOT / 4;
var INITIAL_SLOTS = 1024;

var HDR_QUERY = '(dynamic-range: high)';

var shaderSource = [
  'struct U {',
  '  mvp: mat4x4f,',
  '  colorMatrix: mat4x4f,',
  '  colorOffset: vec4f,',
  '  gain: vec4f,',   // gainMapMin, gainMapMax, 1/gamma, weight
  '  params: vec4f,', // offsetSdr, offsetHdr, exposure, headroom
  '  misc: vec4f,',   // depth, opacity, hdr, hdrOutput
  '};',
  '@group(0) @binding(0) var<uniform> u: U;',
  '@group(1) @binding(0) var samp: sampler;',
  '@group(1) @binding(1) var baseTex: texture_2d<f32>;',
  '@group(1) @binding(2) var gainTex: texture_2d<f32>;',
  'struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };',
  '@vertex fn vs(@builtin(vertex_index) i: u32) -> VOut {',
  '  var P = array<vec2f, 6>(vec2f(-0.5, -0.5), vec2f(0.5, -0.5), vec2f(0.5, 0.5),',
  '                          vec2f(-0.5, -0.5), vec2f(0.5, 0.5), vec2f(-0.5, 0.5));',
  '  let p = P[i];',
  '  var o: VOut;',
  '  var pos = u.mvp * vec4f(p, 0.0, 1.0);',
  '  pos.z = u.misc.x * pos.w;',
  '  o.pos = pos;',
  // Textures are stored top-down, unlike the flipped WebGL ones.
  '  o.uv = vec2f(p.x + 0.5, 0.5 - p.y);',
  '  return o;',
  '}',
  'fn srgbToLinear(c: vec3f) -> vec3f {',
  '  return select(pow((c + 0.055) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045));',
  '}',
  // Extended sRGB: the same curve continues above 1.0 for HDR output.
  'fn linearToSrgb(x: vec3f) -> vec3f {',
  '  let c = max(x, vec3f(0.0));',
  '  return select(1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055, c * 12.92, c <= vec3f(0.0031308));',
  '}',
  // AgX with a mild look; must match tool/js/hdrtile.js and fragmentNormal.js.
  'fn agxCurve(v: vec3f) -> vec3f {',
  '  let v2 = v * v;',
  '  let v4 = v2 * v2;',
  '  return 15.5 * v4 * v2 - 40.14 * v4 * v + 31.96 * v4 - 6.868 * v2 * v + 0.4298 * v2 + 0.1191 * v - 0.00232;',
  '}',
  'fn toneMap(c: vec3f) -> vec3f {',
  '  var x = vec3f(',
  '    dot(c, vec3f(0.842479062253094, 0.0423282422610123, 0.0423756549057051)),',
  '    dot(c, vec3f(0.0784335999999992, 0.878468636469772, 0.0784336)),',
  '    dot(c, vec3f(0.0792237451477643, 0.0791661274605434, 0.879142973793104)));',
  '  x = clamp((log2(max(x, vec3f(1e-10))) + 12.47393) / 16.499999, vec3f(0.0), vec3f(1.0));',
  '  x = pow(max(agxCurve(x), vec3f(0.0)), vec3f(1.2));',
  '  let l = dot(x, vec3f(0.2126, 0.7152, 0.0722));',
  '  x = vec3f(l) + 1.15 * (x - vec3f(l));',
  '  let o = vec3f(',
  '    dot(x, vec3f(1.19687900512017, -0.0528968517574562, -0.0529716355144438)),',
  '    dot(x, vec3f(-0.0980208811401368, 1.15190312990417, -0.0980434501171241)),',
  '    dot(x, vec3f(-0.0990297440797205, -0.0989611768448433, 1.15107367264116)));',
  '  return pow(clamp(o, vec3f(0.0), vec3f(1.0)), vec3f(2.2));',
  '}',
  'fn rollOff(x: vec3f, headroom: f32) -> vec3f {',
  '  let knee = min(1.0, 0.5 * headroom);',
  '  let span = max(headroom - knee, 1e-3);',
  '  let over = max(x - vec3f(knee), vec3f(0.0));',
  '  return min(x, vec3f(knee)) + span * (vec3f(1.0) - exp(-over / span));',
  '}',
  '@fragment fn fs(input: VOut) -> @location(0) vec4f {',
  '  var color = textureSample(baseTex, samp, input.uv);',
  '  let g = textureSample(gainTex, samp, input.uv).r;',
  '  if (u.misc.z > 0.5) {',
  '    let sdr = srgbToLinear(color.rgb);',
  '    let logBoost = mix(u.gain.x, u.gain.y, pow(g, u.gain.z));',
  '    var hdr = (sdr + u.params.x) * exp2(logBoost * u.gain.w) - u.params.y;',
  '    hdr = max(hdr, vec3f(0.0)) * u.params.z;',
  '    var display = rollOff(hdr, u.params.w);',
  '    if (u.misc.w < 0.5) { display = toneMap(hdr); }',
  '    color = vec4f(linearToSrgb(display), color.a);',
  '  }',
  '  color = color * u.colorMatrix + u.colorOffset;',
  '  return color * u.misc.y;',
  '}'
].join('\n');


/**
 * @class WebGpuStage
 * @extends Stage
 * @classdesc
 *
 * A {@link Stage} implementation using WebGPU, able to output HDR.
 *
 * The canvas uses an `rgba16float` drawing buffer. When HDR output is on, it
 * is configured with extended tone mapping, so values above 1.0 (SDR white)
 * are shown brighter than white on HDR displays. This is how HDR canvas
 * output works in Chromium-based browsers; WebGL cannot do it.
 *
 * WebGPU devices are obtained asynchronously, so create the device first with
 * {@link WebGpuStage.requestDevice} and pass it in. Only cube and flat
 * geometries are supported.
 *
 * @param {Object} opts
 * @param {GPUDevice} opts.device
 * @param {boolean|string} [opts.hdr='auto'] Extended (HDR) output: true,
 *     false, or 'auto' to follow the `(dynamic-range: high)` media query.
 *
 * Also see the available {@link Stage} options.
 */
function WebGpuStage(opts) {
  opts = opts || {};
  if (!opts.device) {
    throw new Error('WebGpuStage needs a GPUDevice (see WebGpuStage.requestDevice)');
  }

  var self = this;

  this.constructor.super_.call(this, opts);

  this._device = opts.device;
  this._format = 'rgba16float';
  this._hdrOption = opts.hdr == null ? 'auto' : opts.hdr;
  this._hdrActive = false;

  this._loader = new HtmlImageLoader(this, { flipY: false });
  this._ultraHdrLoader = UltraHdrLoader.isSupported() ? new UltraHdrLoader() : null;

  this._domElement = document.createElement('canvas');
  setAbsolute(this._domElement);
  setFullSize(this._domElement);

  this._context = this._domElement.getContext('webgpu');
  if (!this._context) {
    throw new Error('Could not get WebGPU canvas context');
  }

  this._createResources();
  this._configure();

  // Follow the display when HDR is 'auto' (e.g. window moved between screens).
  this._mediaQuery = null;
  this._handleMediaChange = function() {
    self._configure();
    self._emitRenderInvalid();
  };
  if (this._hdrOption === 'auto' && global.matchMedia) {
    this._mediaQuery = global.matchMedia(HDR_QUERY);
    if (this._mediaQuery.addEventListener) {
      this._mediaQuery.addEventListener('change', this._handleMediaChange);
    } else if (this._mediaQuery.addListener) {
      this._mediaQuery.addListener(this._handleMediaChange);
    }
  }

  this._device.lost.then(function(info) {
    self.emit('webgpudevicelost', info);
  });

  this._rendererInstances = [];
  this._pass = null;
  this._encoder = null;
  this._usedSlots = 0;
}

inherits(WebGpuStage, Stage);


/**
 * Requests a WebGPU device, resolving to null when WebGPU is unavailable.
 * @return {Promise<?GPUDevice>}
 */
WebGpuStage.requestDevice = function() {
  var gpu = global.navigator && global.navigator.gpu;
  if (!gpu) {
    return Promise.resolve(null);
  }
  return gpu.requestAdapter().then(function(adapter) {
    return adapter ? adapter.requestDevice() : null;
  }).catch(function() {
    return null;
  });
};


/**
 * Whether the current display reports HDR support.
 * @return {boolean}
 */
WebGpuStage.displaySupportsHdr = function() {
  return !!(global.matchMedia && global.matchMedia(HDR_QUERY).matches);
};


WebGpuStage.prototype._wantHdr = function() {
  if (this._hdrOption === 'auto') {
    return WebGpuStage.displaySupportsHdr();
  }
  return !!this._hdrOption;
};


WebGpuStage.prototype._configure = function() {
  var wantHdr = this._wantHdr();
  this._context.configure({
    device: this._device,
    format: this._format,
    alphaMode: 'premultiplied',
    colorSpace: 'srgb',
    toneMapping: { mode: wantHdr ? 'extended' : 'standard' }
  });
  var active = false;
  if (wantHdr && this._context.getConfiguration) {
    var config = this._context.getConfiguration();
    active = !!(config && config.toneMapping && config.toneMapping.mode === 'extended');
  }
  var changed = active !== this._hdrActive;
  this._hdrActive = active;
  if (changed) {
    this.emit('hdrChange', active);
  }
};


/**
 * Whether the canvas is currently presenting in extended (HDR) range.
 * @return {boolean}
 */
WebGpuStage.prototype.hdrActive = function() {
  return this._hdrActive;
};


WebGpuStage.prototype._createResources = function() {
  var device = this._device;

  this._sampler = device.createSampler({
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge'
  });

  this._uniformLayout = device.createBindGroupLayout({
    entries: [{
      binding: 0,
      visibility: global.GPUShaderStage.VERTEX | global.GPUShaderStage.FRAGMENT,
      buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: UNIFORM_SLOT }
    }]
  });

  this._textureLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: global.GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 1, visibility: global.GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 2, visibility: global.GPUShaderStage.FRAGMENT, texture: {} }
    ]
  });

  var module = device.createShaderModule({ code: shaderSource });

  this._pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [this._uniformLayout, this._textureLayout] }),
    vertex: { module: module, entryPoint: 'vs' },
    fragment: {
      module: module,
      entryPoint: 'fs',
      targets: [{
        format: this._format,
        blend: {
          color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
          alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }
        }
      }]
    },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' }
  });

  // 1x1 placeholder used as the gain map of textures that have none.
  this._blankGain = device.createTexture({
    size: [1, 1],
    format: 'r8unorm',
    usage: global.GPUTextureUsage.TEXTURE_BINDING | global.GPUTextureUsage.COPY_DST
  });
  device.queue.writeTexture({ texture: this._blankGain }, new Uint8Array([0]), { bytesPerRow: 1 }, [1, 1]);

  this._allocUniforms(INITIAL_SLOTS);
  this._depthTexture = null;
};


WebGpuStage.prototype._allocUniforms = function(slots) {
  if (this._uniformBuffer) {
    this._uniformBuffer.destroy();
  }
  this._slots = slots;
  this._uniformData = new Float32Array(slots * UNIFORM_FLOATS);
  this._uniformBuffer = this._device.createBuffer({
    size: slots * UNIFORM_SLOT,
    usage: global.GPUBufferUsage.UNIFORM | global.GPUBufferUsage.COPY_DST
  });
  this._uniformBindGroup = this._device.createBindGroup({
    layout: this._uniformLayout,
    entries: [{ binding: 0, resource: { buffer: this._uniformBuffer, size: UNIFORM_SLOT } }]
  });
};


WebGpuStage.prototype.destroy = function() {
  if (this._mediaQuery) {
    if (this._mediaQuery.removeEventListener) {
      this._mediaQuery.removeEventListener('change', this._handleMediaChange);
    } else if (this._mediaQuery.removeListener) {
      this._mediaQuery.removeListener(this._handleMediaChange);
    }
  }
  if (this._depthTexture) {
    this._depthTexture.destroy();
  }
  this._uniformBuffer.destroy();
  this._blankGain.destroy();
  this._context.unconfigure();
  this.constructor.super_.prototype.destroy.call(this);
};


WebGpuStage.prototype.domElement = function() {
  return this._domElement;
};


WebGpuStage.prototype.device = function() {
  return this._device;
};


WebGpuStage.prototype.setSizeForType = function() {
  var ratio = pixelRatio();
  this._domElement.width = Math.max(1, Math.round(ratio * this._width));
  this._domElement.height = Math.max(1, Math.round(ratio * this._height));
};


WebGpuStage.prototype.loadImage = function(url, rect, done) {
  return this._loader.loadImage(url, rect, done);
};


WebGpuStage.prototype.loadUltraHdrImage = function(url, rect, done) {
  if (!this._ultraHdrLoader) {
    return this._loader.loadImage(url, rect, done);
  }
  return this._ultraHdrLoader.loadImage(url, rect, done);
};


WebGpuStage.prototype.maxTextureSize = function() {
  return this._device.limits.maxTextureDimension2D;
};


WebGpuStage.prototype.validateLayer = function(layer) {
  var tileSize = layer.geometry().maxTileSize();
  var maxTextureSize = this.maxTextureSize();
  if (tileSize > maxTextureSize) {
    throw new Error('Layer has level with tile size larger than maximum texture size (' + tileSize + ' vs. ' + maxTextureSize + ')');
  }
};


WebGpuStage.prototype.createRenderer = function(Renderer) {
  var instances = this._rendererInstances;
  for (var i = 0; i < instances.length; i++) {
    if (instances[i] instanceof Renderer) {
      return instances[i];
    }
  }
  var renderer = new Renderer(this);
  instances.push(renderer);
  return renderer;
};


WebGpuStage.prototype.destroyRenderer = function(renderer) {
  var instances = this._rendererInstances;
  if (this._renderers.indexOf(renderer) < 0) {
    renderer.destroy();
    var index = instances.indexOf(renderer);
    if (index >= 0) {
      instances.splice(index, 1);
    }
  }
};


WebGpuStage.prototype.startFrame = function() {
  var canvas = this._domElement;
  var w = canvas.width, h = canvas.height;

  if (!this._depthTexture || this._depthTexture.width !== w || this._depthTexture.height !== h) {
    if (this._depthTexture) {
      this._depthTexture.destroy();
    }
    this._depthTexture = this._device.createTexture({
      size: [w, h],
      format: 'depth24plus',
      usage: global.GPUTextureUsage.RENDER_ATTACHMENT
    });
  }

  // Grow the uniform buffer if the previous frame ran out of slots.
  if (this._needSlots && this._needSlots > this._slots) {
    var slots = this._slots;
    while (slots < this._needSlots) { slots *= 2; }
    this._allocUniforms(slots);
  }
  this._needSlots = 0;
  this._usedSlots = 0;

  this._encoder = this._device.createCommandEncoder();
  this._pass = this._encoder.beginRenderPass({
    colorAttachments: [{
      view: this._context.getCurrentTexture().createView(),
      clearValue: { r: 0, g: 0, b: 0, a: 0 },
      loadOp: 'clear',
      storeOp: 'store'
    }],
    depthStencilAttachment: {
      view: this._depthTexture.createView(),
      depthClearValue: 1.0,
      depthLoadOp: 'clear',
      depthStoreOp: 'discard'
    }
  });
  this._pass.setPipeline(this._pipeline);
};


/**
 * Reserves uniform space for one draw. Returns the slot index, or -1 when the
 * buffer is full (the draw is skipped and the buffer grows next frame).
 */
WebGpuStage.prototype._allocSlot = function() {
  if (this._usedSlots >= this._slots) {
    this._needSlots = this._usedSlots + 1;
    this._usedSlots++;
    this._emitRenderInvalid();
    return -1;
  }
  return this._usedSlots++;
};


WebGpuStage.prototype.endFrame = function() {
  var used = Math.min(this._usedSlots, this._slots);
  this._pass.end();
  if (used > 0) {
    this._device.queue.writeBuffer(this._uniformBuffer, 0, this._uniformData.buffer, 0, used * UNIFORM_SLOT);
  }
  this._device.queue.submit([this._encoder.finish()]);
  this._pass = null;
  this._encoder = null;
};


WebGpuStage.prototype.takeSnapshot = function() {
  throw new Error('WebGpuStage does not support snapshots');
};


WebGpuStage.type = WebGpuStage.prototype.type = 'webgpu';


function WebGpuTexture(stage, tile, asset) {
  this._stage = stage;
  this._device = stage._device;
  this._texture = null;
  this._gainTexture = null;
  this._bindGroup = null;
  this._timestamp = null;
  this._width = this._height = null;
  this.refresh(tile, asset);
}


function copyImage(device, source, texture, width, height, premultiplied) {
  device.queue.copyExternalImageToTexture(
    { source: source, flipY: false },
    { texture: texture, premultipliedAlpha: premultiplied },
    [width, height]);
}


WebGpuTexture.prototype.refresh = function(tile, asset) {
  var timestamp = asset.timestamp();
  if (timestamp === this._timestamp) {
    return;
  }

  var device = this._device;
  var stage = this._stage;
  var usage = global.GPUTextureUsage.TEXTURE_BINDING | global.GPUTextureUsage.COPY_DST |
    global.GPUTextureUsage.RENDER_ATTACHMENT;

  var element = asset.element();
  var width = asset.width();
  var height = asset.height();
  var maxSize = stage.maxTextureSize();
  if (width > maxSize || height > maxSize) {
    throw new Error('Texture larger than max size (' + width + 'x' + height + ' vs. ' + maxSize + ')');
  }

  var rebind = false;
  if (width !== this._width || height !== this._height || !this._texture) {
    if (this._texture) {
      this._texture.destroy();
    }
    this._texture = device.createTexture({ size: [width, height], format: 'rgba8unorm', usage: usage });
    rebind = true;
  }
  copyImage(device, element, this._texture, width, height, true);

  var gainElement = asset.gainElement ? asset.gainElement() : null;
  if (gainElement) {
    var gw = gainElement.width || gainElement.naturalWidth;
    var gh = gainElement.height || gainElement.naturalHeight;
    if (!this._gainTexture || this._gainTexture.width !== gw || this._gainTexture.height !== gh) {
      if (this._gainTexture) {
        this._gainTexture.destroy();
      }
      this._gainTexture = device.createTexture({ size: [gw, gh], format: 'r8unorm', usage: usage });
      rebind = true;
    }
    copyImage(device, gainElement, this._gainTexture, gw, gh, false);
  } else if (this._gainTexture) {
    this._gainTexture.destroy();
    this._gainTexture = null;
    rebind = true;
  }

  if (rebind || !this._bindGroup) {
    this._bindGroup = device.createBindGroup({
      layout: stage._textureLayout,
      entries: [
        { binding: 0, resource: stage._sampler },
        { binding: 1, resource: this._texture.createView() },
        { binding: 2, resource: (this._gainTexture || stage._blankGain).createView() }
      ]
    });
  }

  this._timestamp = timestamp;
  this._width = width;
  this._height = height;
};


WebGpuTexture.prototype.destroy = function() {
  if (this._texture) {
    this._texture.destroy();
  }
  if (this._gainTexture) {
    this._gainTexture.destroy();
  }
  clearOwnProperties(this);
};


WebGpuStage.TextureClass = WebGpuStage.prototype.TextureClass = WebGpuTexture;


module.exports = WebGpuStage;
