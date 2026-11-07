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

// Locates the gain map inside an Ultra HDR (JPEG + gain map) file.
//
// Browsers decode Ultra HDR images for display, but WebGL and WebGPU texture
// uploads only see the SDR base image. To reconstruct HDR we split the file
// into its primary (SDR) and gain-map JPEGs ourselves.
//
// The gain map is found through the MPF (Multi-Picture Format) index in the
// primary image; if that is missing, through the Item:Length of the GainMap
// item in the XMP container directory.

function readSegments(bytes, fn) {
  if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) {
    return;
  }
  var p = 2;
  while (p + 4 <= bytes.length) {
    if (bytes[p] !== 0xFF) {
      return;
    }
    var marker = bytes[p + 1];
    if (marker === 0xD9 || marker === 0xDA) {
      return; // end of image or start of scan
    }
    if (marker >= 0xD0 && marker <= 0xD7 || marker === 0x01) {
      p += 2;
      continue;
    }
    var len = (bytes[p + 2] << 8) | bytes[p + 3];
    if (fn(marker, p + 4, len - 2) === false) {
      return;
    }
    p += 2 + len;
  }
}

function startsWith(bytes, at, str) {
  for (var i = 0; i < str.length; i++) {
    if (bytes[at + i] !== str.charCodeAt(i)) {
      return false;
    }
  }
  return true;
}

function fromMpf(bytes, at, len) {
  var tiff = at + 4;
  var little = bytes[tiff] === 0x49;
  var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  var ifd = tiff + dv.getUint32(tiff + 4, little);
  var count = dv.getUint16(ifd, little);
  var entriesOffset = -1, entriesCount = 0;
  for (var i = 0; i < count; i++) {
    var e = ifd + 2 + i * 12;
    if (dv.getUint16(e, little) === 0xB002) {
      entriesCount = dv.getUint32(e + 4, little) / 16;
      entriesOffset = tiff + dv.getUint32(e + 8, little);
    }
  }
  if (entriesOffset < 0 || entriesCount < 2 || entriesOffset + entriesCount * 16 > at + len) {
    return null;
  }
  // The gain map is the second image in Ultra HDR files.
  var size = dv.getUint32(entriesOffset + 16 + 4, little);
  var offset = dv.getUint32(entriesOffset + 16 + 8, little);
  var start = tiff + offset;
  if (!size || start + size > bytes.length) {
    return null;
  }
  return { start: start, end: start + size };
}

function fromXmp(bytes, at, len) {
  var text = '';
  var chunk = bytes.subarray(at, at + len);
  for (var i = 0; i < chunk.length; i++) {
    text += String.fromCharCode(chunk[i]);
  }
  var m = text.match(/Item:Semantic="GainMap"[^>]*?Item:Length="(\d+)"/) ||
          text.match(/Item:Length="(\d+)"[^>]*?Item:Semantic="GainMap"/);
  if (!m) {
    return null;
  }
  var length = parseInt(m[1], 10);
  return { start: bytes.length - length, end: bytes.length };
}

/**
 * Splits an Ultra HDR JPEG.
 *
 * @param {ArrayBuffer|Uint8Array} data
 * @return {?{primary: Uint8Array, gainMap: Uint8Array}} null if the file has
 *     no gain map.
 */
function splitUltraHdr(data) {
  var bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  var range = null;
  var xmpRange = null;
  readSegments(bytes, function(marker, at, len) {
    if (marker === 0xE2 && startsWith(bytes, at, 'MPF\0')) {
      range = fromMpf(bytes, at, len);
      if (range) {
        return false;
      }
    } else if (marker === 0xE1 && startsWith(bytes, at, 'http://ns.adobe.com/xap/1.0/\0') && !xmpRange) {
      xmpRange = fromXmp(bytes, at, len);
    }
  });
  range = range || xmpRange;
  if (!range || range.start <= 2 || bytes[range.start] !== 0xFF || bytes[range.start + 1] !== 0xD8) {
    return null;
  }
  return {
    primary: bytes.subarray(0, range.start),
    gainMap: bytes.subarray(range.start, range.end)
  };
}

module.exports = splitUltraHdr;
