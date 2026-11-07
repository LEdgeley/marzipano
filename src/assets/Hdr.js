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

var StaticAsset = require('./Static');
var inherits = require('../util/inherits');

/**
 * @class HdrAsset
 * @extends StaticAsset
 * @classdesc
 *
 * An asset made of an SDR base image and a gain map, as found in an Ultra HDR
 * JPEG. Renderers reconstruct HDR pixels from the pair using the gain-map
 * parameters given in the layer's `hdr` effect.
 *
 * @param {HTMLImageElement|HTMLCanvasElement|ImageBitmap} base
 * @param {HTMLImageElement|HTMLCanvasElement|ImageBitmap} gainMap
 */
function HdrAsset(base, gainMap) {
  this.constructor.super_.call(this, base);
  this._gainMap = gainMap;
}

inherits(HdrAsset, StaticAsset);

/**
 * Returns the gain-map pixel source.
 * @return {HTMLImageElement|HTMLCanvasElement|ImageBitmap}
 */
HdrAsset.prototype.gainElement = function() {
  return this._gainMap;
};

HdrAsset.prototype.destroy = function() {
  if (this._gainMap && this._gainMap.close) {
    this._gainMap.close();
  }
  var element = this.element();
  if (element && element.close) {
    element.close();
  }
  this.constructor.super_.prototype.destroy.call(this);
};

module.exports = HdrAsset;
