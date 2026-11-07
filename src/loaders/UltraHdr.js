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

var StaticAsset = require('../assets/Static');
var HdrAsset = require('../assets/Hdr');
var NetworkError = require('../NetworkError');
var global = require('../util/global');
var once = require('../util/once');
var splitUltraHdr = require('../util/ultraHdr');

/**
 * @class UltraHdrLoader
 * @classdesc
 *
 * Loads Ultra HDR JPEGs (an SDR JPEG with an embedded gain map) as
 * {@link HdrAsset}s. Files without a gain map load as plain
 * {@link StaticAsset}s, so SDR tiles keep working.
 *
 * The file is fetched as bytes, split into its two JPEGs, and each is decoded
 * with createImageBitmap and drawn (cropped, when a rect is given) into a 2D
 * canvas. Requires fetch and createImageBitmap.
 *
 * Cropping and flipping are done with a canvas rather than createImageBitmap
 * options, which are unreliable on Safari (see HtmlImageLoader). The canvas is
 * top-down; WebGL flips it on upload (UNPACK_FLIP_Y_WEBGL applies to canvases)
 * and WebGPU uses it as is.
 *
 * @param {Object} [opts] Unused; kept for compatibility.
 */
function UltraHdrLoader(opts) {
  this._opts = opts || {};
}

UltraHdrLoader.isSupported = function() {
  return !!(global.fetch && global.createImageBitmap);
};

UltraHdrLoader.prototype.loadImage = function(url, rect, done) {
  var cancelled = false;
  done = once(done);

  var controller = global.AbortController ? new global.AbortController() : null;

  // No colour conversion: the gain map holds data, and the base is sRGB.
  var decodeOpts = { premultiplyAlpha: 'none', colorSpaceConversion: 'none' };

  function decode(bytes) {
    var blob = new global.Blob([bytes], { type: 'image/jpeg' });
    return global.createImageBitmap(blob, decodeOpts).catch(function() {
      return global.createImageBitmap(blob); // browsers without the options
    });
  }

  function crop(bitmap) {
    var x = rect && rect.x || 0;
    var y = rect && rect.y || 0;
    var w = rect && rect.width || 1;
    var h = rect && rect.height || 1;
    var W = bitmap.width, H = bitmap.height;
    var sx = Math.round(x * W), sy = Math.round(y * H);
    var sw = Math.round(w * W), sh = Math.round(h * H);
    var canvas = document.createElement('canvas');
    canvas.width = sw;
    canvas.height = sh;
    canvas.getContext('2d').drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
    if (bitmap.close) {
      bitmap.close();
    }
    return canvas;
  }

  global.fetch(url, controller ? { signal: controller.signal } : undefined)
    .then(function(response) {
      if (!response.ok) {
        throw new NetworkError('Network error: ' + url);
      }
      return response.arrayBuffer();
    }, function() {
      throw new NetworkError('Network error: ' + url);
    })
    .then(function(buffer) {
      var parts = splitUltraHdr(buffer);
      if (!parts) {
        return decode(new Uint8Array(buffer)).then(crop).then(function(bitmap) {
          return new StaticAsset(bitmap);
        });
      }
      return Promise.all([decode(parts.primary), decode(parts.gainMap)])
        .then(function(bitmaps) {
          return Promise.all([crop(bitmaps[0]), crop(bitmaps[1])]);
        })
        .then(function(bitmaps) {
          return new HdrAsset(bitmaps[0], bitmaps[1]);
        });
    })
    .then(function(asset) {
      if (cancelled) {
        asset.destroy();
        return;
      }
      done(null, asset);
    }, function(err) {
      if (!cancelled) {
        done(err instanceof NetworkError ? err : new NetworkError(String(err && err.message || err) + ': ' + url));
      }
    });

  return function cancel() {
    cancelled = true;
    if (controller) {
      controller.abort();
    }
    done.apply(null, arguments);
  };
};

module.exports = UltraHdrLoader;
