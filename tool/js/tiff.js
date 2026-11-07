'use strict';

// Streaming TIFF decoder for the processing worker. Browsers cannot decode
// TIFF, and stitchers such as PTGui write their full-size output as TIFF.
//
// Reads the File strip by strip (or tile by tile) and returns 8-bit RGB pixels
// in one Uint8Array, without loading the whole file into memory. It also
// avoids canvas size limits, so it handles images larger than a canvas allows.
//
// Supported: classic TIFF and BigTIFF, either byte order; strips or tiles;
// no compression, PackBits, LZW or Deflate, with or without the horizontal
// predictor; 8- or 16-bit unsigned integer samples; RGB(A) or greyscale,
// chunky (interleaved) or planar.

var TiffDecoder = (function() {

  var TAGS = {
    width: 256, height: 257, bitsPerSample: 258, compression: 259,
    photometric: 262, stripOffsets: 273, samplesPerPixel: 277, rowsPerStrip: 278,
    stripByteCounts: 279, planarConfig: 284, predictor: 317, tileWidth: 322,
    tileLength: 323, tileOffsets: 324, tileByteCounts: 325, sampleFormat: 339
  };

  var TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8, 17: 8, 18: 8 };

  function readBytes(file, offset, length) {
    return file.slice(offset, offset + length).arrayBuffer();
  }

  function getUint64(dv, off, le) {
    var lo = dv.getUint32(off + (le ? 0 : 4), le);
    var hi = dv.getUint32(off + (le ? 4 : 0), le);
    return hi * 4294967296 + lo;
  }

  function readValue(dv, off, type, le) {
    switch (type) {
      case 1: case 2: case 6: case 7: return dv.getUint8(off);
      case 3: case 8: return dv.getUint16(off, le);
      case 4: case 9: case 13: return dv.getUint32(off, le);
      case 16: case 17: case 18: return getUint64(dv, off, le);
      case 5: return dv.getUint32(off, le) / dv.getUint32(off + 4, le);
      default: return 0;
    }
  }

  async function readIfd(file) {
    var head = new DataView(await readBytes(file, 0, 16));
    var bo = String.fromCharCode(head.getUint8(0), head.getUint8(1));
    if (bo !== 'II' && bo !== 'MM') {
      throw new Error('Not a TIFF file');
    }
    var le = bo === 'II';
    var magic = head.getUint16(2, le);
    var big = magic === 43;
    if (magic !== 42 && !big) {
      throw new Error('Not a TIFF file');
    }
    var ifdOffset = big ? getUint64(head, 8, le) : head.getUint32(4, le);
    var countSize = big ? 8 : 2;
    var entrySize = big ? 20 : 12;
    var inlineSize = big ? 8 : 4;

    var countDv = new DataView(await readBytes(file, ifdOffset, countSize));
    var count = big ? getUint64(countDv, 0, le) : countDv.getUint16(0, le);
    var dv = new DataView(await readBytes(file, ifdOffset + countSize, count * entrySize));

    var tags = {};
    for (var i = 0; i < count; i++) {
      var e = i * entrySize;
      var tag = dv.getUint16(e, le);
      var type = dv.getUint16(e + 2, le);
      var n = big ? getUint64(dv, e + 4, le) : dv.getUint32(e + 4, le);
      var size = (TYPE_SIZE[type] || 1) * n;
      var valueDv, valueOff;
      if (size <= inlineSize) {
        valueDv = dv;
        valueOff = e + (big ? 12 : 8);
      } else {
        var ptr = big ? getUint64(dv, e + 12, le) : dv.getUint32(e + 8, le);
        // Only read out-of-line values for tags we use (skip ICC, XMP, ...).
        var wanted = false;
        for (var k in TAGS) { if (TAGS[k] === tag) { wanted = true; } }
        if (!wanted) { continue; }
        valueDv = new DataView(await readBytes(file, ptr, size));
        valueOff = 0;
      }
      var values = new Array(n);
      for (var j = 0; j < n; j++) {
        values[j] = readValue(valueDv, valueOff + j * (TYPE_SIZE[type] || 1), type, le);
      }
      tags[tag] = values;
    }
    return { tags: tags, le: le };
  }

  function first(tags, tag, def) {
    return tags[tag] ? tags[tag][0] : def;
  }

  function unpackBits(src, expected) {
    var out = new Uint8Array(expected);
    var i = 0, o = 0;
    while (i < src.length && o < expected) {
      var n = src[i++];
      if (n > 127) { n -= 256; }
      if (n >= 0) {
        var len = n + 1;
        out.set(src.subarray(i, i + len), o);
        i += len;
        o += len;
      } else if (n !== -128) {
        var rep = 1 - n;
        out.fill(src[i++], o, o + rep);
        o += rep;
      }
    }
    return out;
  }

  // TIFF LZW (MSB-first codes, with the "early change" quirk).
  function unLzw(src, expected) {
    var out = new Uint8Array(expected);
    var o = 0;
    var dictStart = new Int32Array(4096);
    var dictLen = new Int32Array(4096);
    var bitPos = 0;
    var codeLen = 9;
    var next = 258;
    var prevStart = -1, prevLen = 0;
    var totalBits = src.length * 8;
    function read() {
      if (bitPos + codeLen > totalBits) { return 257; }
      var byte = bitPos >> 3;
      var v = (src[byte] << 16) | ((src[byte + 1] || 0) << 8) | (src[byte + 2] || 0);
      v = (v >> (24 - (bitPos & 7) - codeLen)) & ((1 << codeLen) - 1);
      bitPos += codeLen;
      return v;
    }
    while (o < expected) {
      var code = read();
      if (code === 257) { break; }
      if (code === 256) {
        codeLen = 9;
        next = 258;
        code = read();
        if (code === 257) { break; }
        out[o] = code;
        prevStart = o;
        prevLen = 1;
        o++;
        continue;
      }
      var start = o;
      if (code < 256) {
        out[o++] = code;
      } else if (code < next) {
        out.copyWithin(o, dictStart[code], dictStart[code] + dictLen[code]);
        o += dictLen[code];
      } else {
        // KwKwK case: previous string plus its own first byte.
        out.copyWithin(o, prevStart, prevStart + prevLen);
        o += prevLen;
        out[o++] = out[prevStart];
      }
      if (prevStart >= 0 && next < 4096) {
        dictStart[next] = prevStart;
        dictLen[next] = prevLen + 1;
        next++;
      }
      prevStart = start;
      prevLen = o - start;
      if (next + 1 >= (1 << codeLen) && codeLen < 12) { codeLen++; }
    }
    return out;
  }

  async function inflate(src) {
    var stream = new Blob([src]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function decompress(compression, src, expected) {
    switch (compression) {
      case 1: return src;
      case 32773: return unpackBits(src, expected);
      case 5: return unLzw(src, expected);
      case 8: case 32946: return inflate(src);
      default: throw new Error('Unsupported TIFF compression (' + compression + '). Save as uncompressed, LZW, Deflate/ZIP or PackBits TIFF, or JPEG.');
    }
  }

  // Horizontal differencing predictor, applied per row of samples.
  function undoPredictor(data, width, rows, samples, bits, le) {
    if (bits === 8) {
      for (var r = 0; r < rows; r++) {
        var base = r * width * samples;
        for (var i = samples; i < width * samples; i++) {
          data[base + i] = (data[base + i] + data[base + i - samples]) & 0xFF;
        }
      }
    } else {
      var dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      for (var r2 = 0; r2 < rows; r2++) {
        var base2 = r2 * width * samples * 2;
        for (var j = samples; j < width * samples; j++) {
          var p = base2 + j * 2;
          dv.setUint16(p, (dv.getUint16(p, le) + dv.getUint16(p - samples * 2, le)) & 0xFFFF, le);
        }
      }
    }
  }

  async function decode(file, onProgress) {
    var ifd = await readIfd(file);
    var t = ifd.tags, le = ifd.le;
    var width = first(t, TAGS.width), height = first(t, TAGS.height);
    var bits = first(t, TAGS.bitsPerSample, 1);
    var spp = first(t, TAGS.samplesPerPixel, 1);
    var compression = first(t, TAGS.compression, 1);
    var photometric = first(t, TAGS.photometric, 2);
    var planar = first(t, TAGS.planarConfig, 1);
    var predictor = first(t, TAGS.predictor, 1);
    var sampleFormat = first(t, TAGS.sampleFormat, 1);

    if (bits !== 8 && bits !== 16) {
      throw new Error('Unsupported TIFF bit depth: ' + bits + ' (8 or 16 bits per channel only).');
    }
    if (sampleFormat !== 1) {
      throw new Error('Floating-point/HDR TIFFs are not supported; export an 8- or 16-bit LDR TIFF.');
    }
    if (photometric !== 1 && photometric !== 2) {
      throw new Error('Unsupported TIFF colour type (photometric ' + photometric + '); RGB or greyscale only.');
    }
    if (predictor !== 1 && predictor !== 2) {
      throw new Error('Unsupported TIFF predictor: ' + predictor);
    }
    var colour = photometric === 2 ? 3 : 1;
    if (spp < colour) {
      throw new Error('TIFF has too few channels.');
    }

    var tiled = !!t[TAGS.tileOffsets];
    var offsets = tiled ? t[TAGS.tileOffsets] : t[TAGS.stripOffsets];
    var counts = tiled ? t[TAGS.tileByteCounts] : t[TAGS.stripByteCounts];
    var blockW = tiled ? first(t, TAGS.tileWidth) : width;
    var blockH = tiled ? first(t, TAGS.tileLength) : Math.min(first(t, TAGS.rowsPerStrip, height), height);
    var across = Math.ceil(width / blockW);
    var down = Math.ceil(height / blockH);
    var perPlane = across * down;
    var bytesPerSample = bits / 8;
    // Samples stored per pixel in one block: all of them (chunky) or one (planar).
    var blockSpp = planar === 2 ? 1 : spp;
    var planes = planar === 2 ? colour : 1;

    var out = new Uint8Array(width * height * 3);
    var hiByte = le ? 1 : 0; // most significant byte of a 16-bit sample

    for (var plane = 0; plane < planes; plane++) {
      for (var b = 0; b < perPlane; b++) {
        var index = plane * perPlane + b;
        var bx = (b % across) * blockW;
        var by = Math.floor(b / across) * blockH;
        var rows = tiled ? blockH : Math.min(blockH, height - by);
        var expected = blockW * rows * blockSpp * bytesPerSample;
        var raw = new Uint8Array(await readBytes(file, offsets[index], counts[index]));
        var data = await decompress(compression, raw, expected);
        if (predictor === 2) {
          undoPredictor(data, blockW, rows, blockSpp, bits, le);
        }
        var w = Math.min(blockW, width - bx);
        var h = Math.min(rows, height - by);
        for (var y = 0; y < h; y++) {
          var srcRow = y * blockW * blockSpp * bytesPerSample;
          var dstRow = ((by + y) * width + bx) * 3;
          for (var x = 0; x < w; x++) {
            var s = srcRow + x * blockSpp * bytesPerSample;
            var d = dstRow + x * 3;
            if (planar === 2) {
              out[d + plane] = bits === 8 ? data[s] : data[s + hiByte];
            } else if (colour === 3) {
              if (bits === 8) {
                out[d] = data[s]; out[d + 1] = data[s + 1]; out[d + 2] = data[s + 2];
              } else {
                out[d] = data[s + hiByte]; out[d + 1] = data[s + 2 + hiByte]; out[d + 2] = data[s + 4 + hiByte];
              }
            } else {
              var g = bits === 8 ? data[s] : data[s + hiByte];
              out[d] = out[d + 1] = out[d + 2] = g;
            }
          }
        }
        if (planar === 2 && colour === 1) {
          // Greyscale planar: replicate the single plane into G and B.
          for (var yy = 0; yy < h; yy++) {
            for (var xx = 0; xx < w; xx++) {
              var dd = ((by + yy) * width + bx + xx) * 3;
              out[dd + 1] = out[dd + 2] = out[dd];
            }
          }
        }
        if (onProgress) { onProgress((index + 1) / (perPlane * planes)); }
      }
    }
    return { width: width, height: height, channels: 3, data: out };
  }

  return { decode: decode };
})();
