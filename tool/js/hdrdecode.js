'use strict';

// Streaming decoders for HDR panoramas: OpenEXR (.exr) and Radiance (.hdr).
//
// Both read the File in pieces and hand back linear RGB float scanlines
// through onRows(y, count, rgb), where rgb is a Float32Array of
// count * width * 3 values. Nothing holds the whole image in memory, so the
// caller can pack the pixels compactly (see packRgb9e5 in the worker).
//
// OpenEXR: single-part scanline images, half or float channels, compression
// NONE, RLE, ZIPS, ZIP or PIZ. Takes R, G, B (or Y) channels, optionally
// with a layer prefix such as "beauty.R". Tiled, deep, multi-part and the
// lossy PXR24/B44/DWA codecs are not supported.
//
// Radiance: RGBE, flat or new-style run-length encoded, -Y H +X W layout.

var HdrDecode = (function() {

  // ---- Half floats ---------------------------------------------------------

  var HALF_TO_FLOAT = (function() {
    var table = new Float32Array(65536);
    for (var h = 0; h < 65536; h++) {
      var s = (h & 0x8000) ? -1 : 1;
      var e = (h >> 10) & 0x1F;
      var m = h & 0x3FF;
      var v;
      if (e === 0) {
        v = m * Math.pow(2, -24);
      } else if (e === 31) {
        v = m ? NaN : Infinity;
      } else {
        v = (1 + m / 1024) * Math.pow(2, e - 15);
      }
      table[h] = s * v;
    }
    return table;
  })();

  function readSlice(file, offset, length) {
    return file.slice(offset, offset + length).arrayBuffer();
  }

  // ---- EXR header ----------------------------------------------------------

  var COMPRESSION = ['NONE', 'RLE', 'ZIPS', 'ZIP', 'PIZ', 'PXR24', 'B44', 'B44A', 'DWAA', 'DWAB', 'HTJ2K'];
  var LINES_PER_BLOCK = { NONE: 1, RLE: 1, ZIPS: 1, ZIP: 16, PIZ: 32 };

  async function readExrHeader(file) {
    var size = Math.min(file.size, 1 << 20);
    var buf = new Uint8Array(await readSlice(file, 0, size));
    var dv = new DataView(buf.buffer);
    if (dv.getUint32(0, true) !== 20000630) {
      throw new Error('Not an OpenEXR file');
    }
    var flags = dv.getUint32(4, true);
    if (flags & 0x200) { throw new Error('Tiled EXR files are not supported; export scanline EXR.'); }
    if (flags & 0x800) { throw new Error('Deep EXR files are not supported.'); }
    if (flags & 0x1000) { throw new Error('Multi-part EXR files are not supported.'); }

    var p = 8;
    function cstr() {
      var start = p;
      while (buf[p] !== 0) { p++; }
      var s = new TextDecoder().decode(buf.subarray(start, p));
      p++;
      return s;
    }
    var header = {};
    for (;;) {
      var name = cstr();
      if (!name) { break; }
      var type = cstr();
      var len = dv.getUint32(p, true);
      p += 4;
      var start = p;
      if (type === 'chlist') {
        var channels = [];
        var q = start;
        while (buf[q] !== 0) {
          var ns = q;
          while (buf[q] !== 0) { q++; }
          var cname = new TextDecoder().decode(buf.subarray(ns, q));
          q++;
          channels.push({
            name: cname,
            pixelType: dv.getInt32(q, true), // 0 uint, 1 half, 2 float
            xSampling: dv.getInt32(q + 8, true),
            ySampling: dv.getInt32(q + 12, true)
          });
          q += 16;
        }
        header.channels = channels;
      } else if (type === 'compression') {
        header.compression = COMPRESSION[buf[start]] || ('#' + buf[start]);
      } else if (type === 'box2i') {
        header[name] = {
          xMin: dv.getInt32(start, true), yMin: dv.getInt32(start + 4, true),
          xMax: dv.getInt32(start + 8, true), yMax: dv.getInt32(start + 12, true)
        };
      } else if (type === 'lineOrder') {
        header.lineOrder = buf[start];
      } else if (type === 'chromaticities') {
        header.chromaticities = [];
        for (var c = 0; c < 8; c++) { header.chromaticities.push(dv.getFloat32(start + c * 4, true)); }
      }
      p = start + len;
    }
    header.offsetTableStart = p;
    return header;
  }

  // ---- Byte-level codecs (RLE, ZIP) ----------------------------------------

  function unRle(src, expected) {
    var out = new Uint8Array(expected);
    var i = 0, o = 0;
    while (i < src.length && o < expected) {
      var n = src[i++];
      if (n > 127) { n -= 256; }
      if (n < 0) {
        var count = -n;
        out.set(src.subarray(i, i + count), o);
        i += count;
        o += count;
      } else {
        out.fill(src[i++], o, o + n + 1);
        o += n + 1;
      }
    }
    return out;
  }

  // Undo the predictor and byte interleaving shared by RLE and ZIP.
  function unpredictInterleave(t) {
    var n = t.length;
    for (var i = 1; i < n; i++) {
      t[i] = (t[i - 1] + t[i] - 128) & 0xFF;
    }
    var out = new Uint8Array(n);
    var half = (n + 1) >> 1;
    for (var k = 0, o = 0; o < n; k++) {
      out[o++] = t[k];
      if (o < n) { out[o++] = t[half + k]; }
    }
    return out;
  }

  async function inflate(src) {
    var stream = new Blob([src]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // ---- PIZ (wavelet + Huffman), after OpenEXR's ImfPizCompressor -----------

  var HUF_ENCBITS = 16;
  var HUF_DECBITS = 14;
  var HUF_ENCSIZE = (1 << HUF_ENCBITS) + 1;
  var HUF_DECSIZE = 1 << HUF_DECBITS;
  var HUF_DECMASK = HUF_DECSIZE - 1;
  var SHORT_ZEROCODE_RUN = 59;
  var LONG_ZEROCODE_RUN = 63;
  var SHORTEST_LONG_RUN = 2 + LONG_ZEROCODE_RUN - SHORT_ZEROCODE_RUN;
  var USHORT_RANGE = 1 << 16;
  var BITMAP_SIZE = USHORT_RANGE >> 3;

  // Bit reader over a byte array (MSB first) for the encoding-table header.
  function BitReader(bytes, pos) {
    this.bytes = bytes;
    this.pos = pos;
    this.c = 0;
    this.lc = 0;
  }
  BitReader.prototype.get = function(n) {
    while (this.lc < n) {
      this.c = ((this.c << 8) | this.bytes[this.pos++]) >>> 0;
      this.lc += 8;
    }
    this.lc -= n;
    var v = (this.c >>> this.lc) & ((1 << n) - 1);
    this.c &= (1 << this.lc) - 1;
    return v;
  };

  // Returns { codes: Float64Array (code value), lens: Uint8Array } indexed by symbol.
  function hufUnpackEncTable(bytes, pos, im, iM) {
    var lens = new Uint8Array(HUF_ENCSIZE);
    var br = new BitReader(bytes, pos);
    for (; im <= iM; im++) {
      var l = lens[im] = br.get(6);
      if (l === LONG_ZEROCODE_RUN) {
        var zerun = br.get(8) + SHORTEST_LONG_RUN;
        if (im + zerun > iM + 1) { throw new Error('EXR PIZ: corrupt Huffman table'); }
        while (zerun--) { lens[im++] = 0; }
        im--;
      } else if (l >= SHORT_ZEROCODE_RUN) {
        var run = l - SHORT_ZEROCODE_RUN + 2;
        if (im + run > iM + 1) { throw new Error('EXR PIZ: corrupt Huffman table'); }
        while (run--) { lens[im++] = 0; }
        im--;
      }
    }
    // Canonical code assignment (hufCanonicalCodeTable).
    var n = new Float64Array(59);
    for (var i = 0; i < HUF_ENCSIZE; i++) { n[lens[i]] += 1; }
    var c = 0;
    for (var len = 58; len > 0; len--) {
      var nc = Math.floor((c + n[len]) / 2);
      n[len] = c;
      c = nc;
    }
    var codes = new Float64Array(HUF_ENCSIZE);
    for (var s = 0; s < HUF_ENCSIZE; s++) {
      if (lens[s] > 0) { codes[s] = n[lens[s]]++; }
    }
    return { codes: codes, lens: lens, end: br.pos };
  }

  function hufBuildDecTable(table, im, iM) {
    var decLen = new Uint8Array(HUF_DECSIZE);
    var decLit = new Int32Array(HUF_DECSIZE);
    var decLong = new Array(HUF_DECSIZE); // lists of symbols with long codes
    for (; im <= iM; im++) {
      var l = table.lens[im];
      if (!l) { continue; }
      var c = table.codes[im];
      if (c >= Math.pow(2, l)) { throw new Error('EXR PIZ: invalid Huffman code'); }
      if (l > HUF_DECBITS) {
        var idx = Math.floor(c / Math.pow(2, l - HUF_DECBITS));
        if (decLen[idx]) { throw new Error('EXR PIZ: invalid Huffman table'); }
        (decLong[idx] = decLong[idx] || []).push(im);
      } else {
        var base = c * (1 << (HUF_DECBITS - l));
        for (var k = 0; k < (1 << (HUF_DECBITS - l)); k++) {
          if (decLen[base + k] || decLong[base + k]) { throw new Error('EXR PIZ: invalid Huffman table'); }
          decLen[base + k] = l;
          decLit[base + k] = im;
        }
      }
    }
    return { len: decLen, lit: decLit, long: decLong };
  }

  function hufDecode(table, dec, bytes, pos, nBits, rlc, out) {
    var c = 0, lc = 0;
    var o = 0, no = out.length;
    var end = pos + ((nBits + 7) >> 3);
    function emit(sym) {
      if (sym === rlc) {
        if (lc < 8) { c = ((c << 8) | bytes[pos++]) >>> 0; lc += 8; }
        lc -= 8;
        var cs = (c >>> lc) & 0xFF;
        c &= (1 << lc) - 1;
        if (o + cs > no || o === 0) { throw new Error('EXR PIZ: corrupt run'); }
        var s = out[o - 1];
        while (cs-- > 0) { out[o++] = s; }
      } else if (o < no) {
        out[o++] = sym;
      } else {
        throw new Error('EXR PIZ: too much data');
      }
    }
    while (pos < end) {
      c = ((c << 8) | bytes[pos++]) >>> 0;
      lc += 8;
      while (lc >= HUF_DECBITS) {
        var idx = (c >>> (lc - HUF_DECBITS)) & HUF_DECMASK;
        var l = dec.len[idx];
        if (l) {
          lc -= l;
          c &= (1 << lc) - 1;
          emit(dec.lit[idx]);
        } else {
          var list = dec.long[idx];
          if (!list) { throw new Error('EXR PIZ: bad code'); }
          // Long codes: widen the bit buffer with plain arithmetic.
          var found = false;
          for (var j = 0; j < list.length; j++) {
            var sym = list[j];
            var len = table.lens[sym];
            var big = c, blc = lc, bpos = pos;
            while (blc < len && bpos < end) { big = big * 256 + bytes[bpos++]; blc += 8; }
            if (blc >= len) {
              var shift = Math.pow(2, blc - len);
              if (Math.floor(big / shift) === table.codes[sym]) {
                lc = blc - len;
                c = big % shift;
                pos = bpos;
                emit(sym);
                found = true;
                break;
              }
            }
          }
          if (!found) { throw new Error('EXR PIZ: bad long code'); }
        }
      }
    }
    var extra = (8 - nBits) & 7;
    c >>>= extra;
    lc -= extra;
    while (lc > 0) {
      var idx2 = (c << (HUF_DECBITS - lc)) & HUF_DECMASK;
      var l2 = dec.len[idx2];
      if (!l2) { throw new Error('EXR PIZ: bad trailing code'); }
      lc -= l2;
      c &= (1 << lc) - 1;
      emit(dec.lit[idx2]);
    }
    if (o !== no) { throw new Error('EXR PIZ: short data'); }
  }

  function hufUncompress(bytes, pos, nCompressed, out) {
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var im = dv.getUint32(pos, true);
    var iM = dv.getUint32(pos + 4, true);
    var nBits = dv.getUint32(pos + 12, true);
    if (im >= HUF_ENCSIZE || iM >= HUF_ENCSIZE) { throw new Error('EXR PIZ: bad Huffman header'); }
    var table = hufUnpackEncTable(bytes, pos + 20, im, iM);
    if (nBits > 8 * (nCompressed - (table.end - pos))) { throw new Error('EXR PIZ: truncated'); }
    var dec = hufBuildDecTable(table, im, iM);
    hufDecode(table, dec, bytes, table.end, nBits, iM, out);
  }

  // Inverse 2D Haar-like wavelet (ImfWav wav2Decode).
  function wav2Decode(buf, start, nx, ox, ny, oy, mx) {
    var w14 = mx < (1 << 14);
    var n = nx > ny ? ny : nx;
    var p = 1;
    while (p <= n) { p <<= 1; }
    p >>= 1;
    var p2 = p;
    p >>= 1;
    var a = 0, b = 0;
    function dec14(l, h) {
      var ls = (l << 16) >> 16;
      var hs = (h << 16) >> 16;
      var ai = ls + (hs & 1) + (hs >> 1);
      a = ai & 0xFFFF;
      b = (ai - hs) & 0xFFFF;
    }
    function dec16(l, h) {
      var bb = (l - (h >> 1)) & 0xFFFF;
      a = (h + bb - 0x8000) & 0xFFFF;
      b = bb;
    }
    var decode = w14 ? dec14 : dec16;
    while (p >= 1) {
      var py = start;
      var ey = start + oy * (ny - p2);
      var oy1 = oy * p, oy2 = oy * p2, ox1 = ox * p, ox2 = ox * p2;
      var px, ex;
      for (; py <= ey; py += oy2) {
        px = py;
        ex = py + ox * (nx - p2);
        for (; px <= ex; px += ox2) {
          var p01 = px + ox1, p10 = px + oy1, p11 = p10 + ox1;
          decode(buf[px], buf[p10]);
          var i00 = a, i10 = b;
          decode(buf[p01], buf[p11]);
          var i01 = a, i11 = b;
          decode(i00, i01);
          buf[px] = a; buf[p01] = b;
          decode(i10, i11);
          buf[p10] = a; buf[p11] = b;
        }
        if (nx & p) {
          var q10 = px + oy1;
          decode(buf[px], buf[q10]);
          buf[px] = a; buf[q10] = b;
        }
      }
      if (ny & p) {
        px = py;
        ex = py + ox * (nx - p2);
        for (; px <= ex; px += ox2) {
          var q01 = px + ox1;
          decode(buf[px], buf[q01]);
          buf[px] = a; buf[q01] = b;
        }
      }
      p2 = p;
      p >>= 1;
    }
  }

  // Returns the block's pixels as little-endian bytes in standard layout.
  function unPiz(bytes, channels, width, lines) {
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var pos = 0;
    var minNonZero = dv.getUint16(pos, true);
    var maxNonZero = dv.getUint16(pos + 2, true);
    pos += 4;
    if (maxNonZero >= BITMAP_SIZE) { throw new Error('EXR PIZ: bad bitmap'); }
    var bitmap = new Uint8Array(BITMAP_SIZE);
    if (minNonZero <= maxNonZero) {
      bitmap.set(bytes.subarray(pos, pos + maxNonZero - minNonZero + 1), minNonZero);
      pos += maxNonZero - minNonZero + 1;
    }
    var lut = new Uint16Array(USHORT_RANGE);
    var k = 0;
    for (var i = 0; i < USHORT_RANGE; i++) {
      if (i === 0 || (bitmap[i >> 3] & (1 << (i & 7)))) { lut[k++] = i; }
    }
    var maxValue = k - 1;
    var length = dv.getInt32(pos, true);
    pos += 4;

    var total = 0;
    var cds = channels.map(function(ch) {
      var size = ch.pixelType === 1 ? 1 : 2;
      var cd = { start: total, nx: width, ny: lines, size: size };
      total += width * lines * size;
      return cd;
    });
    var tmp = new Uint16Array(total);
    hufUncompress(bytes, pos, length, tmp);
    cds.forEach(function(cd) {
      for (var j = 0; j < cd.size; j++) {
        wav2Decode(tmp, cd.start + j, cd.nx, cd.size, cd.ny, cd.nx * cd.size, maxValue);
      }
    });
    for (var t = 0; t < total; t++) { tmp[t] = lut[tmp[t]]; }

    // Interleave back to per-line, per-channel order.
    var out = new Uint16Array(total);
    var o = 0;
    var cursor = cds.map(function(cd) { return cd.start; });
    for (var y = 0; y < lines; y++) {
      for (var c = 0; c < cds.length; c++) {
        var n = cds[c].nx * cds[c].size;
        out.set(tmp.subarray(cursor[c], cursor[c] + n), o);
        o += n;
        cursor[c] += n;
      }
    }
    return new Uint8Array(out.buffer);
  }

  // ---- EXR pixel extraction --------------------------------------------------

  function pickChannels(channels) {
    function find(letter) {
      for (var i = 0; i < channels.length; i++) {
        var n = channels[i].name;
        if (n === letter || n.slice(-2) === '.' + letter) { return i; }
      }
      return -1;
    }
    var r = find('R'), g = find('G'), b = find('B'), y = find('Y');
    if (r >= 0 && g >= 0 && b >= 0) { return [r, g, b]; }
    if (y >= 0) { return [y, y, y]; }
    throw new Error('EXR has no R, G, B or Y channels (found: ' +
      channels.map(function(c) { return c.name; }).join(', ') + ')');
  }

  async function decodeExr(file, onRows, onProgress) {
    var h = await readExrHeader(file);
    var dw = h.dataWindow;
    var width = dw.xMax - dw.xMin + 1;
    var height = dw.yMax - dw.yMin + 1;
    var compression = h.compression;
    var linesPerBlock = LINES_PER_BLOCK[compression];
    if (!linesPerBlock) {
      throw new Error('EXR compression ' + compression + ' is not supported (use PIZ, ZIP, ZIPS, RLE or none).');
    }
    h.channels.forEach(function(ch) {
      if (ch.xSampling !== 1 || ch.ySampling !== 1) { throw new Error('Subsampled EXR channels are not supported.'); }
    });
    var pick = pickChannels(h.channels);
    var bytesPerPixel = 0;
    var chanOffset = h.channels.map(function(ch) {
      var off = bytesPerPixel;
      bytesPerPixel += ch.pixelType === 1 ? 2 : 4;
      return off;
    });
    var lineBytes = bytesPerPixel * width;
    var blocks = Math.ceil(height / linesPerBlock);

    var table = new DataView(await readSlice(file, h.offsetTableStart, blocks * 8));
    var offsets = [];
    for (var i = 0; i < blocks; i++) {
      offsets.push(table.getUint32(i * 8, true) + table.getUint32(i * 8 + 4, true) * 4294967296);
    }

    // Read in batches of consecutive blocks to keep File reads large.
    var BATCH = 8;
    for (var b0 = 0; b0 < blocks; b0 += BATCH) {
      var b1 = Math.min(blocks, b0 + BATCH);
      var from = offsets[b0];
      var to = b1 < blocks ? offsets[b1] : file.size;
      if (to < from) { to = file.size; } // out-of-order offsets: read to the end
      var chunk = new Uint8Array(await readSlice(file, from, to - from));
      var cdv = new DataView(chunk.buffer);
      for (var bi = b0; bi < b1; bi++) {
        var at = offsets[bi] - from;
        if (at < 0 || at + 8 > chunk.length) {
          chunk = new Uint8Array(await readSlice(file, offsets[bi], Math.min(file.size - offsets[bi], 64 << 20)));
          cdv = new DataView(chunk.buffer);
          from = offsets[bi];
          at = 0;
        }
        var y = cdv.getInt32(at, true) - dw.yMin;
        var packed = cdv.getInt32(at + 4, true);
        var data = chunk.subarray(at + 8, at + 8 + packed);
        var lines = Math.min(linesPerBlock, height - y);
        var expected = lines * lineBytes;
        var raw;
        if (packed === expected) {
          raw = data;
        } else if (compression === 'PIZ') {
          raw = unPiz(data, h.channels, width, lines);
        } else if (compression === 'ZIP' || compression === 'ZIPS') {
          raw = unpredictInterleave(await inflate(data));
        } else if (compression === 'RLE') {
          raw = unpredictInterleave(unRle(data, expected));
        } else {
          raw = data;
        }
        var rdv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
        var rgb = new Float32Array(lines * width * 3);
        for (var ly = 0; ly < lines; ly++) {
          var lineStart = ly * lineBytes;
          for (var c = 0; c < 3; c++) {
            var ch = h.channels[pick[c]];
            var base = lineStart + chanOffset[pick[c]] * width;
            var o = ly * width * 3 + c;
            if (ch.pixelType === 1) {
              for (var x = 0; x < width; x++, o += 3) {
                rgb[o] = HALF_TO_FLOAT[rdv.getUint16(base + x * 2, true)];
              }
            } else if (ch.pixelType === 2) {
              for (var x2 = 0; x2 < width; x2++, o += 3) {
                rgb[o] = rdv.getFloat32(base + x2 * 4, true);
              }
            } else {
              for (var x3 = 0; x3 < width; x3++, o += 3) {
                rgb[o] = rdv.getUint32(base + x3 * 4, true);
              }
            }
          }
        }
        onRows(y, lines, rgb);
      }
      if (onProgress) { onProgress(b1 / blocks); }
    }
    return { width: width, height: height };
  }

  // ---- Radiance RGBE --------------------------------------------------------

  async function decodeRadiance(file, onRows, onProgress) {
    var head = new Uint8Array(await readSlice(file, 0, Math.min(file.size, 65536)));
    var text = '';
    var p = 0;
    var lines = [];
    while (p < head.length) {
      var start = p;
      while (p < head.length && head[p] !== 10) { p++; }
      var line = new TextDecoder('latin1').decode(head.subarray(start, p));
      p++;
      lines.push(line);
      if (/^[-+][YX] \d+ [-+][YX] \d+/.test(line)) { break; }
    }
    if (!/^#\?(RADIANCE|RGBE)/.test(lines[0] || '')) {
      throw new Error('Not a Radiance HDR file');
    }
    var exposure = 1;
    lines.forEach(function(l) {
      var m = l.match(/^EXPOSURE=\s*([0-9.eE+-]+)/);
      if (m) { exposure *= parseFloat(m[1]); }
      if (/^FORMAT=/.test(l) && !/32-bit_rle_rgbe/.test(l)) {
        throw new Error('Only RGBE Radiance files are supported (not XYZE).');
      }
    });
    text = lines[lines.length - 1];
    var dims = text.match(/^-Y (\d+) \+X (\d+)/);
    if (!dims) { throw new Error('Unsupported Radiance orientation: ' + text); }
    var height = +dims[1], width = +dims[2];
    var dataStart = p;

    // RGBE mantissas are scaled by 2^(e-136); EXPOSURE is undone.
    var scale = new Float32Array(256);
    for (var e = 1; e < 256; e++) { scale[e] = Math.pow(2, e - 136) / exposure; }

    var BATCH_ROWS = 64;
    var pos = dataStart;
    var buf = new Uint8Array(0), bufStart = dataStart;
    async function ensure(n) {
      if (pos + n <= bufStart + buf.length) { return; }
      var keep = buf.subarray(pos - bufStart);
      var more = new Uint8Array(await readSlice(file, bufStart + buf.length, Math.max(n, 16 << 20)));
      var merged = new Uint8Array(keep.length + more.length);
      merged.set(keep);
      merged.set(more, keep.length);
      buf = merged;
      bufStart = pos;
    }
    var scan = new Uint8Array(width * 4);
    for (var y0 = 0; y0 < height; y0 += BATCH_ROWS) {
      var rows = Math.min(BATCH_ROWS, height - y0);
      var rgb = new Float32Array(rows * width * 3);
      for (var r = 0; r < rows; r++) {
        await ensure(width * 4 + 4);
        var b = pos - bufStart;
        if (width >= 8 && width < 32768 && buf[b] === 2 && buf[b + 1] === 2 && ((buf[b + 2] << 8) | buf[b + 3]) === width) {
          pos += 4;
          for (var ch = 0; ch < 4; ch++) {
            var x = 0;
            while (x < width) {
              await ensure(130);
              var bb = pos - bufStart;
              var count = buf[bb];
              if (count > 128) {
                count -= 128;
                var val = buf[bb + 1];
                for (var k = 0; k < count; k++) { scan[(x++) * 4 + ch] = val; }
                pos += 2;
              } else {
                for (var k2 = 0; k2 < count; k2++) { scan[(x++) * 4 + ch] = buf[bb + 1 + k2]; }
                pos += 1 + count;
              }
            }
          }
        } else {
          scan.set(buf.subarray(b, b + width * 4));
          pos += width * 4;
        }
        var o = r * width * 3;
        for (var px = 0; px < width; px++, o += 3) {
          var s = scale[scan[px * 4 + 3]];
          rgb[o] = (scan[px * 4] + 0.5) * s;
          rgb[o + 1] = (scan[px * 4 + 1] + 0.5) * s;
          rgb[o + 2] = (scan[px * 4 + 2] + 0.5) * s;
        }
      }
      onRows(y0, rows, rgb);
      if (onProgress) { onProgress((y0 + rows) / height); }
    }
    return { width: width, height: height };
  }

  async function sniff(file) {
    var b = new Uint8Array(await readSlice(file, 0, 16));
    if (b[0] === 0x76 && b[1] === 0x2F && b[2] === 0x31 && b[3] === 0x01) { return 'exr'; }
    var s = String.fromCharCode.apply(null, b.subarray(0, 10));
    if (/^#\?(RADIANCE|RGBE)/.test(s)) { return 'radiance'; }
    return null;
  }

  async function readExrSize(file) {
    var h = await readExrHeader(file);
    return { width: h.dataWindow.xMax - h.dataWindow.xMin + 1, height: h.dataWindow.yMax - h.dataWindow.yMin + 1 };
  }

  return {
    sniff: sniff,
    decodeExr: decodeExr,
    decodeRadiance: decodeRadiance,
    readExrHeader: readExrHeader,
    readExrSize: readExrSize,
    _test: { unPiz: unPiz, wav2Decode: wav2Decode, unpredictInterleave: unpredictInterleave, unRle: unRle }
  };
})();
