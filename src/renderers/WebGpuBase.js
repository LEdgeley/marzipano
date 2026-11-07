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

var mat4 = require('gl-matrix').mat4;
var vec3 = require('gl-matrix').vec3;
var clearOwnProperties = require('../util/clearOwnProperties');
var WebGlCommon = require('./WebGlCommon');
var hdrParams = WebGlCommon.hdrParams;
var setViewport = WebGlCommon.setViewport;

// Same depth scheme as the WebGL renderers (see WebGlCommon.setDepth).
var MAX_LAYERS = 256;
var MAX_LEVELS = 256;

var identity = mat4.create();
var zero = new Float32Array(4);

/**
 * @class WebGpuBaseRenderer
 * @implements Renderer
 * @classdesc
 *
 * Renders tiles as textured quads on a {@link WebGpuStage}, with the same
 * geometry as {@link WebGlBaseRenderer} and Ultra HDR gain-map support.
 */
function WebGpuBaseRenderer(stage) {
  this.stage = stage;
  this.projMatrix = mat4.create();
  this.viewportMatrix = mat4.create();
  this.mvp = mat4.create();
  this.translateVector = vec3.create();
  this.scaleVector = vec3.create();
  this._layer = null;

  // Per-layer values copied into every draw's uniforms.
  this._colorMatrix = mat4.create();
  this._colorOffset = new Float32Array(4);
  this._gain = new Float32Array(4);
  this._params = new Float32Array(4);
  this._opacity = 1;
  this._hdr = false;
  this._hdrOutput = 0;

  // WebGL-style viewport setter, captured for the WebGPU pass.
  var self = this;
  this._viewport = null;
  this._glShim = {
    drawingBufferWidth: 0,
    drawingBufferHeight: 0,
    viewport: function(x, y, w, h) { self._viewport = [x, y, w, h]; }
  };
}

WebGpuBaseRenderer.prototype.destroy = function() {
  clearOwnProperties(this);
};

WebGpuBaseRenderer.prototype.startLayer = function(layer, rect) {
  var stage = this.stage;
  var canvas = stage.domElement();
  var shim = this._glShim;
  shim.drawingBufferWidth = canvas.width;
  shim.drawingBufferHeight = canvas.height;
  setViewport(shim, layer, rect, this.viewportMatrix);
  var v = this._viewport;
  // WebGL viewports start at the bottom; WebGPU's at the top.
  stage._pass.setViewport(v[0], canvas.height - v[1] - v[3], v[2], v[3], 0, 1);

  var effects = layer.effects() || {};
  this._opacity = effects.opacity != null ? effects.opacity : 1;
  this._colorOffset.set(effects.colorOffset || zero);
  mat4.copy(this._colorMatrix, effects.colorMatrix || identity);

  var p = hdrParams(effects);
  this._hdr = !!p;
  if (p) {
    this._gain.set(p.gain);
    this._params.set(p.params);
    this._hdrOutput = p.output;
  }
  this._layer = layer;
};

WebGpuBaseRenderer.prototype.endLayer = function() {
  this._layer = null;
};

WebGpuBaseRenderer.prototype.renderTile = function(tile, texture, layer, layerZ) {
  var stage = this.stage;
  var slot = stage._allocSlot();
  if (slot < 0 || !texture._bindGroup) {
    return;
  }

  var projMatrix = this.projMatrix;
  var translateVector = this.translateVector;
  var scaleVector = this.scaleVector;

  translateVector[0] = tile.centerX();
  translateVector[1] = tile.centerY();
  translateVector[2] = -0.5;
  scaleVector[0] = tile.scaleX();
  scaleVector[1] = tile.scaleY();
  scaleVector[2] = 1.0;

  mat4.copy(projMatrix, layer.view().projection());
  mat4.rotateX(projMatrix, projMatrix, tile.rotX());
  mat4.rotateY(projMatrix, projMatrix, tile.rotY());
  mat4.translate(projMatrix, projMatrix, translateVector);
  mat4.scale(projMatrix, projMatrix, scaleVector);
  mat4.multiply(this.mvp, this.viewportMatrix, projMatrix);

  var depth = (((layerZ + 1) * MAX_LEVELS) - tile.z) / (MAX_LEVELS * MAX_LAYERS);
  var hdr = this._hdr && !!texture._gainTexture;

  var data = stage._uniformData;
  var o = slot * 64;
  data.set(this.mvp, o);
  data.set(this._colorMatrix, o + 16);
  data.set(this._colorOffset, o + 32);
  data.set(this._gain, o + 36);
  data.set(this._params, o + 40);
  data[o + 44] = depth;
  data[o + 45] = this._opacity;
  data[o + 46] = hdr ? 1 : 0;
  data[o + 47] = this._hdrOutput;

  var pass = stage._pass;
  pass.setBindGroup(0, stage._uniformBindGroup, [slot * 256]);
  pass.setBindGroup(1, texture._bindGroup);
  pass.draw(6);
};

module.exports = WebGpuBaseRenderer;
