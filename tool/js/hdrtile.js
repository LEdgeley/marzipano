'use strict';

// HDR helpers for the processing worker:
//  - RGB9E5 packing, so a 27k equirectangular HDR fits in 4 bytes per pixel;
//  - projection of the packed equirectangular onto float cube faces;
//  - area-filtered resampling of float faces to the tile pyramid sizes;
//  - splitting float pixels into an SDR base and a gain map, and wrapping the
//    two JPEGs as one Ultra HDR (Adobe/Google gain map, hdrgm 1.0) JPEG.
//
// All pixel values here are linear Rec.709/sRGB, already multiplied by the
// panorama's base exposure so that 1.0 is SDR white and 0.18 is mid grey.

var HdrTile = (function() {

  // ---- RGB9E5 ---------------------------------------------------------------

  var E5_SCALE = new Float32Array(32);
  for (var i = 0; i < 32; i++) { E5_SCALE[i] = Math.pow(2, i - 15 - 9); }
  var MAX_9E5 = 511 / 512 * Math.pow(2, 16);
  var f32 = new Float32Array(1);
  var i32 = new Int32Array(f32.buffer);

  function pack9e5(r, g, b) {
    if (!(r > 0)) { r = 0; } else if (r > MAX_9E5) { r = MAX_9E5; }
    if (!(g > 0)) { g = 0; } else if (g > MAX_9E5) { g = MAX_9E5; }
    if (!(b > 0)) { b = 0; } else if (b > MAX_9E5) { b = MAX_9E5; }
    var m = r > g ? (r > b ? r : b) : (g > b ? g : b);
    if (m < 1e-9) { return 0; }
    f32[0] = m;
    var e = ((i32[0] >>> 23) & 255) - 127; // floor(log2(m))
    if (e < -16) { e = -16; }
    var exp = e + 16; // biased shared exponent so that m < 2^(exp-15)
    var scale = E5_SCALE[exp];
    if (Math.round(m / scale) >= 512) { exp++; scale *= 2; }
    if (exp > 31) { exp = 31; scale = E5_SCALE[31]; }
    var rm = Math.round(r / scale), gm = Math.round(g / scale), bm = Math.round(b / scale);
    if (rm > 511) { rm = 511; }
    if (gm > 511) { gm = 511; }
    if (bm > 511) { bm = 511; }
    return (rm | (gm << 9) | (bm << 18) | (exp << 27)) >>> 0;
  }

  var HIST_LO = -30, HIST_PER_STOP = 10, HIST_BINS = 500;

  // Collects packed source rows and simple statistics while decoding.
  function SourceBuilder(width, height) {
    this.width = width;
    this.height = height;
    this.data = new Uint32Array(width * height);
    this.logSum = 0;
    this.weightSum = 0;
    this.maxChannel = 0;
    // Solid-angle weighted histogram of log2 luminance, 0.1 stop bins.
    this.hist = new Float64Array(HIST_BINS);
  }
  SourceBuilder.prototype.addRows = function(y0, n, rgb) {
    var w = this.width, data = this.data;
    var maxC = this.maxChannel;
    for (var r = 0; r < n; r++) {
      var y = y0 + r;
      var o = (y * w) * 3 - (y0 * w) * 3;
      var d = y * w;
      // Solid-angle weight for the luminance average (rows near the poles
      // cover less of the sphere). Sample every 4th pixel for speed.
      var lat = ((y + 0.5) / this.height - 0.5) * Math.PI;
      var weight = Math.cos(lat);
      for (var x = 0; x < w; x++, o += 3) {
        var R = rgb[o], G = rgb[o + 1], B = rgb[o + 2];
        if (!(R >= 0)) { R = 0; }
        if (!(G >= 0)) { G = 0; }
        if (!(B >= 0)) { B = 0; }
        if (R === Infinity || G === Infinity || B === Infinity) { R = G = B = MAX_9E5; }
        data[d + x] = pack9e5(R, G, B);
        var m = R > G ? (R > B ? R : B) : (G > B ? G : B);
        if (m > maxC) { maxC = m; }
        if ((x & 3) === 0) {
          var L = 0.2126 * R + 0.7152 * G + 0.0722 * B;
          var lg = Math.log2(L > 1e-9 ? L : 1e-9);
          this.logSum += weight * lg;
          this.weightSum += weight;
          var bin = Math.floor((lg - HIST_LO) * HIST_PER_STOP);
          this.hist[bin < 0 ? 0 : bin >= HIST_BINS ? HIST_BINS - 1 : bin] += weight;
        }
      }
    }
    this.maxChannel = maxC;
  };
  // Luminance below which a fraction p of the sphere lies.
  SourceBuilder.prototype.percentile = function(p) {
    var total = 0, i;
    for (i = 0; i < HIST_BINS; i++) { total += this.hist[i]; }
    var acc = 0;
    for (i = 0; i < HIST_BINS; i++) {
      acc += this.hist[i];
      if (acc >= p * total) { return Math.pow(2, HIST_LO + (i + 0.5) / HIST_PER_STOP); }
    }
    return Math.pow(2, HIST_LO + HIST_BINS / HIST_PER_STOP);
  };
  SourceBuilder.prototype.logAverage = function() {
    return Math.pow(2, this.logSum / Math.max(this.weightSum, 1e-9));
  };

  // ---- Projection -------------------------------------------------------------

  var FACE_ROTATION = {
    f: { x: 0, y: 0 },
    b: { x: 0, y: Math.PI },
    l: { x: 0, y: Math.PI / 2 },
    r: { x: 0, y: -Math.PI / 2 },
    u: { x: Math.PI / 2, y: 0 },
    d: { x: -Math.PI / 2, y: 0 }
  };

  // Projects the packed equirectangular onto one face as float RGB, scaled by
  // `exposure`. Same geometry as equirectToFace in process.worker.js.
  function projectFace(src, face, n, exposure) {
    var data = src.data, srcW = src.width, srcH = src.height;
    var out = new Float32Array(n * n * 3);
    var rot = FACE_ROTATION[face];
    var cx = Math.cos(rot.x), sx = Math.sin(rot.x);
    var cy = Math.cos(rot.y), sy = Math.sin(rot.y);
    var invPi = 1 / Math.PI;
    var S = E5_SCALE;
    var o = 0;
    for (var j = 0; j < n; j++) {
      var b = 1 - 2 * (j + 0.5) / n;
      for (var i = 0; i < n; i++) {
        var a = 2 * (i + 0.5) / n - 1;
        var y1 = b * cx + sx;
        var z1 = b * sx - cx;
        var x2 = z1 * sy + a * cy;
        var z2 = z1 * cy - a * sy;
        var len = Math.sqrt(x2 * x2 + y1 * y1 + z2 * z2);
        var u = (0.5 + 0.5 * Math.atan2(x2, -z2) * invPi) * srcW - 0.5;
        var v = Math.acos(y1 / len) * invPi * srcH - 0.5;
        var u0 = Math.floor(u), v0 = Math.floor(v);
        var fu = u - u0, fv = v - v0;
        var u1 = u0 + 1, v1 = v0 + 1;
        if (u0 < 0) { u0 += srcW; } else if (u0 >= srcW) { u0 -= srcW; }
        if (u1 < 0) { u1 += srcW; } else if (u1 >= srcW) { u1 -= srcW; }
        if (v0 < 0) { v0 = 0; } else if (v0 >= srcH) { v0 = srcH - 1; }
        if (v1 < 0) { v1 = 0; } else if (v1 >= srcH) { v1 = srcH - 1; }
        var w00 = (1 - fu) * (1 - fv) * exposure, w10 = fu * (1 - fv) * exposure;
        var w01 = (1 - fu) * fv * exposure, w11 = fu * fv * exposure;
        var p, s, R = 0, G = 0, B = 0;
        p = data[v0 * srcW + u0]; s = S[p >>> 27] * w00;
        R += (p & 511) * s; G += ((p >>> 9) & 511) * s; B += ((p >>> 18) & 511) * s;
        p = data[v0 * srcW + u1]; s = S[p >>> 27] * w10;
        R += (p & 511) * s; G += ((p >>> 9) & 511) * s; B += ((p >>> 18) & 511) * s;
        p = data[v1 * srcW + u0]; s = S[p >>> 27] * w01;
        R += (p & 511) * s; G += ((p >>> 9) & 511) * s; B += ((p >>> 18) & 511) * s;
        p = data[v1 * srcW + u1]; s = S[p >>> 27] * w11;
        R += (p & 511) * s; G += ((p >>> 9) & 511) * s; B += ((p >>> 18) & 511) * s;
        out[o] = R; out[o + 1] = G; out[o + 2] = B;
        o += 3;
      }
    }
    return out;
  }

  // Float faces from six LDR/HDR cube faces are built by the caller.

  // ---- Resampling -------------------------------------------------------------

  // Area (box) filter weights for resampling n source samples to m outputs.
  function areaWeights(n, m) {
    var ratio = n / m;
    var list = [];
    for (var k = 0; k < m; k++) {
      var start = k * ratio, end = (k + 1) * ratio;
      var i0 = Math.floor(start), i1 = Math.min(n - 1, Math.ceil(end) - 1);
      var idx = [], wts = [];
      for (var i = i0; i <= i1; i++) {
        var w = Math.min(end, i + 1) - Math.max(start, i);
        if (w > 1e-9) { idx.push(i); wts.push(w / ratio); }
      }
      list.push({ idx: idx, wts: wts });
    }
    return list;
  }

  // Downsamples an n×n float RGB face to m×m (m <= n) with an area filter,
  // streaming one output row at a time.
  function downsample(src, n, m) {
    if (m === n) { return src; }
    var out = new Float32Array(m * m * 3);
    var hw = areaWeights(n, m);
    var vw = hw; // square
    var cache = new Map(); // source row -> horizontally resampled row
    for (var j = 0; j < m; j++) {
      var row = new Float32Array(m * 3);
      var v = vw[j];
      for (var t = 0; t < v.idx.length; t++) {
        var sr = v.idx[t];
        var h = cache.get(sr);
        if (!h) {
          h = new Float32Array(m * 3);
          var base = sr * n * 3;
          for (var k = 0; k < m; k++) {
            var e = hw[k], R = 0, G = 0, B = 0;
            for (var q = 0; q < e.idx.length; q++) {
              var p = base + e.idx[q] * 3, w = e.wts[q];
              R += src[p] * w; G += src[p + 1] * w; B += src[p + 2] * w;
            }
            h[k * 3] = R; h[k * 3 + 1] = G; h[k * 3 + 2] = B;
          }
          cache.set(sr, h);
        }
        var wv = v.wts[t];
        for (var c = 0; c < m * 3; c++) { row[c] += h[c] * wv; }
      }
      out.set(row, j * m * 3);
      // Rows are visited in order; drop the ones no later output needs.
      var first = v.idx[0];
      cache.forEach(function(_, key) { if (key < first) { cache.delete(key); } });
    }
    return out;
  }

  // Bilinear sample of a tile from a level that is larger than the face.
  function upsampleTile(src, n, size, tileSize, tx, ty) {
    var out = new Float32Array(tileSize * tileSize * 3);
    var scale = n / size;
    var o = 0;
    for (var j = 0; j < tileSize; j++) {
      var sy = (ty * tileSize + j + 0.5) * scale - 0.5;
      var y0 = Math.floor(sy), fy = sy - y0;
      var y1 = Math.min(n - 1, y0 + 1);
      if (y0 < 0) { y0 = 0; }
      for (var i = 0; i < tileSize; i++) {
        var sx = (tx * tileSize + i + 0.5) * scale - 0.5;
        var x0 = Math.floor(sx), fx = sx - x0;
        var x1 = Math.min(n - 1, x0 + 1);
        if (x0 < 0) { x0 = 0; }
        var p00 = (y0 * n + x0) * 3, p10 = (y0 * n + x1) * 3, p01 = (y1 * n + x0) * 3, p11 = (y1 * n + x1) * 3;
        for (var c = 0; c < 3; c++) {
          out[o++] = (src[p00 + c] * (1 - fx) + src[p10 + c] * fx) * (1 - fy) +
                     (src[p01 + c] * (1 - fx) + src[p11 + c] * fx) * fy;
        }
      }
    }
    return out;
  }

  function cropTile(src, size, tileSize, tx, ty) {
    var out = new Float32Array(tileSize * tileSize * 3);
    for (var j = 0; j < tileSize; j++) {
      var start = ((ty * tileSize + j) * size + tx * tileSize) * 3;
      out.set(src.subarray(start, start + tileSize * 3), j * tileSize * 3);
    }
    return out;
  }

  // ---- Base + gain map ----------------------------------------------------------
  //
  // The SDR base is an AgX rendering (Troy Sobotka's AgX, as in Blender) with
  // a mild contrast/saturation look. The viewer uses exactly the same
  // transform, so at exposure 1 it reproduces the base. AgX compresses bright
  // saturated light smoothly toward white instead of clipping it, which keeps
  // detail such as gobo patterns in coloured stage light.
  //
  // The viewer tone-maps the rebuilt HDR with the full AgX transform. The
  // base only borrows AgX's brightness curve (see splitBaseGain).

  var AGX_INSET = [
    0.842479062253094, 0.0423282422610123, 0.0423756549057051,
    0.0784335999999992, 0.878468636469772, 0.0784336,
    0.0792237451477643, 0.0791661274605434, 0.879142973793104
  ];
  var AGX_OUTSET = [
    1.19687900512017, -0.0528968517574562, -0.0529716355144438,
    -0.0980208811401368, 1.15190312990417, -0.0980434501171241,
    -0.0990297440797205, -0.0989611768448433, 1.15107367264116
  ];
  var AGX_MIN_EV = -12.47393, AGX_MAX_EV = 4.026069;
  var LOOK_POWER = 1.2, LOOK_SAT = 1.15;

  function agxCurve(v) {
    var v2 = v * v, v4 = v2 * v2;
    return 15.5 * v4 * v2 - 40.14 * v4 * v + 31.96 * v4 - 6.868 * v2 * v + 0.4298 * v2 + 0.1191 * v - 0.00232;
  }

  // Per-channel part (log encode, curve, look power), tabulated over the
  // normalised log range.
  var CURVE_N = 4096;
  var CURVE_LUT = new Float32Array(CURVE_N + 1);
  for (var ci = 0; ci <= CURVE_N; ci++) {
    var cv = agxCurve(ci / CURVE_N);
    CURVE_LUT[ci] = Math.pow(cv > 0 ? cv : 0, LOOK_POWER);
  }
  var LOG_SCALE = CURVE_N / (AGX_MAX_EV - AGX_MIN_EV);

  // Fast log2 for positive floats: exponent bits plus a mantissa table with
  // linear interpolation (error < 1e-6), several times faster than Math.log2.
  var LOG_MANT_BITS = 10;
  var LOG_MANT = new Float64Array((1 << LOG_MANT_BITS) + 1);
  for (var li2 = 0; li2 <= (1 << LOG_MANT_BITS); li2++) {
    LOG_MANT[li2] = Math.log2(1 + li2 / (1 << LOG_MANT_BITS));
  }
  var lf32 = new Float32Array(1);
  var li32 = new Int32Array(lf32.buffer);
  var MANT_SHIFT = 23 - LOG_MANT_BITS;
  var MANT_FRAC = 1 / (1 << MANT_SHIFT);
  function fastLog2(x) {
    lf32[0] = x;
    var bits = li32[0];
    var m = bits & 0x7FFFFF;
    var idx = m >> MANT_SHIFT;
    var f = (m & ((1 << MANT_SHIFT) - 1)) * MANT_FRAC;
    return ((bits >> 23) & 255) - 127 + LOG_MANT[idx] + (LOG_MANT[idx + 1] - LOG_MANT[idx]) * f;
  }
  var AGX_MIN_X = Math.pow(2, AGX_MIN_EV);
  function curve(x) {
    if (!(x > AGX_MIN_X)) { return CURVE_LUT[0]; } // below the AgX range
    var t = (fastLog2(x) - AGX_MIN_EV) * LOG_SCALE;
    if (t >= CURVE_N) { return CURVE_LUT[CURVE_N]; }
    var i = t | 0, f = t - i;
    return CURVE_LUT[i] + (CURVE_LUT[i + 1] - CURVE_LUT[i]) * f;
  }

  // AgX output is display-encoded with a 2.2 gamma; convert to sRGB bytes.
  var OUT_N = 4096;
  var OUT_LUT = new Uint8Array(OUT_N + 1);
  for (var oi = 0; oi <= OUT_N; oi++) {
    var lin = Math.pow(oi / OUT_N, 2.2);
    var e = lin <= 0.0031308 ? 12.92 * lin : 1.055 * Math.pow(lin, 1 / 2.4) - 0.055;
    OUT_LUT[oi] = Math.round(e * 255);
  }
  var SRGB_TO_LINEAR = new Float32Array(256);
  for (var si = 0; si < 256; si++) {
    var sv = si / 255;
    SRGB_TO_LINEAR[si] = sv <= 0.04045 ? sv / 12.92 : Math.pow((sv + 0.055) / 1.055, 2.4);
  }
  var LOG_BASE_K = new Float64Array(256); // log2(linear(base byte) + k), k = 1/64
  for (var bi = 0; bi < 256; bi++) { LOG_BASE_K[bi] = Math.log2(SRGB_TO_LINEAR[bi] + 1 / 64); }
  // Tables indexed by a float32's top bits (8 exponent + BIT_MANT mantissa
  // bits), linearly interpolated on the rest: f(x) for x in [2^LO_EXP, 2^HI_EXP).
  var BIT_MANT = 9, BIT_SHIFT = 23 - BIT_MANT, BIT_FRAC = 1 / (1 << BIT_SHIFT);
  var LO_EXP = -16, HI_EXP = 20;
  var BIT_BASE = (LO_EXP + 127) << BIT_MANT;
  var BIT_COUNT = (HI_EXP - LO_EXP) << BIT_MANT;
  function bitTable(fn) {
    var t = new Float64Array(BIT_COUNT + 1);
    for (var j = 0; j <= BIT_COUNT; j++) {
      li32[0] = (j + BIT_BASE) << BIT_SHIFT;
      t[j] = fn(lf32[0]);
    }
    return t;
  }
  var CURVE_BITS = bitTable(curve);
  var LOGK_BITS = bitTable(function(x) { return Math.log2(x + 1 / 64); });
  var CURVE_FLOOR = curve(0), LOGK_FLOOR = Math.log2(1 / 64);
  var CURVE_TOP = curve(Math.pow(2, HI_EXP)), LOGK_TOP = HI_EXP;

  function outByte(d) {
    if (!(d > 0)) { return 0; }
    if (d >= 1) { return 255; }
    return OUT_LUT[Math.round(d * OUT_N)];
  }

  // Gain-map parameters (hdrgm terms, log2 units) for a panorama whose
  // brightest channel, after the base exposure, is maxChannel.
  //
  // The base is a hue-preserving rendition (the HDR scaled by one factor per
  // pixel), so a single-channel gain map rebuilds every colour exactly. An RGB
  // gain map was tried and dropped: next to an AgX base, saturated lights
  // need per-channel gains spanning 5+ stops, which JPEG's subsampled,
  // coarsely quantised chroma cannot hold, so tiny LED emitters rebuilt with
  // the wrong colour and brightness.
  var GAIN_OFFSET = 1 / 1024;
  function makeParams(maxChannel) {
    var gainMax = Math.min(16, Math.log2(Math.max(maxChannel, 4)) + 0.5);
    return {
      gainMapMin: 0,
      gainMapMax: gainMax,
      gamma: 0.5,
      offsetSdr: GAIN_OFFSET,
      offsetHdr: GAIN_OFFSET,
      hdrCapacityMin: 0,
      hdrCapacityMax: gainMax,
      baseRendition: 'agx-luminance'
    };
  }

  // Luminance response of the AgX look on a neutral input, linear in/out.
  function agxGrey(L) {
    var I = AGX_INSET, O = AGX_OUTSET;
    var a = curve((I[0] + I[1] + I[2]) * L);
    var b = curve((I[3] + I[4] + I[5]) * L);
    var c = curve((I[6] + I[7] + I[8]) * L);
    var l = 0.2126 * a + 0.7152 * b + 0.0722 * c;
    a = l + LOOK_SAT * (a - l); b = l + LOOK_SAT * (b - l); c = l + LOOK_SAT * (c - l);
    var r = Math.pow(Math.max(0, Math.min(1, O[0] * a + O[1] * b + O[2] * c)), 2.2);
    var g = Math.pow(Math.max(0, Math.min(1, O[3] * a + O[4] * b + O[5] * c)), 2.2);
    var bl = Math.pow(Math.max(0, Math.min(1, O[6] * a + O[7] * b + O[8] * c)), 2.2);
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  }
  // Per-pixel scale s(L) = T(L) / L, never above 1.
  var SCALE_BITS = bitTable(function(L) { return Math.min(1, agxGrey(L) / L); });
  var SCALE_FLOOR = Math.min(1, agxGrey(Math.pow(2, LO_EXP)) / Math.pow(2, LO_EXP));
  var SCALE_TOP = agxGrey(Math.pow(2, HI_EXP)) / Math.pow(2, HI_EXP);
  var LOGO_BITS = bitTable(function(x) { return Math.log2(x + GAIN_OFFSET); });
  var LOGO_FLOOR = Math.log2(GAIN_OFFSET), LOGO_TOP = HI_EXP;
  // Linear [0, 1] to sRGB bytes, fine near black.
  var SRGB_BITS = bitTable(function(v) {
    v = Math.min(1, v);
    return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
  });

  function lookup(table, x, floor, top) {
    lf32[0] = x;
    var bits = li32[0];
    var j = (bits >> BIT_SHIFT) - BIT_BASE;
    if (j < 0) { return floor; }
    if (j >= BIT_COUNT) { return top; }
    var f = (bits & ((1 << BIT_SHIFT) - 1)) * BIT_FRAC;
    return table[j] + (table[j + 1] - table[j]) * f;
  }

  function srgbByte(v) {
    if (!(v > 0)) { return 0; }
    if (v >= 1) { return 255; }
    return Math.round(lookup(SRGB_BITS, v, 0, 255));
  }

  // Splits float RGB pixels into a hue-preserving sRGB base and a
  // single-channel gain map (RGBA bytes each).
  //   base  = hdr * s, s = min(T(Y) / Y, 1 / max(r, g, b)), T = AgX grey curve
  //   gain  = log2((Y_hdr + k) / (Y_base + k)), Y_base from the quantised base
  function splitBaseGain(px, count, params, base, gain) {
    if (params.offsetSdr !== GAIN_OFFSET || params.offsetHdr !== GAIN_OFFSET) {
      throw new Error('splitBaseGain expects offsets of 1/1024');
    }
    var gRange = params.gainMapMax - params.gainMapMin, gMin = params.gainMapMin;
    var gamma = params.gamma;
    var S2L = SRGB_TO_LINEAR;
    for (var i = 0, o = 0, q = 0; i < count; i++, o += 3, q += 4) {
      var R = px[o], G = px[o + 1], B = px[o + 2];
      if (!(R > 0)) { R = 0; }
      if (!(G > 0)) { G = 0; }
      if (!(B > 0)) { B = 0; }
      var L = 0.2126 * R + 0.7152 * G + 0.0722 * B;
      var s = L > 0 ? lookup(SCALE_BITS, L, SCALE_FLOOR, SCALE_TOP) : 1;
      var m = R > G ? (R > B ? R : B) : (G > B ? G : B);
      if (m * s > 1) { s = 1 / m; }
      var r8 = srgbByte(R * s), g8 = srgbByte(G * s), b8 = srgbByte(B * s);
      base[q] = r8; base[q + 1] = g8; base[q + 2] = b8; base[q + 3] = 255;
      var Lb = 0.2126 * S2L[r8] + 0.7152 * S2L[g8] + 0.0722 * S2L[b8];
      var lg = lookup(LOGO_BITS, L, LOGO_FLOOR, LOGO_TOP) - lookup(LOGO_BITS, Lb, LOGO_FLOOR, LOGO_TOP);
      var norm = (lg - gMin) / gRange;
      if (norm < 0) { norm = 0; } else if (norm > 1) { norm = 1; }
      var e = Math.round(Math.sqrt(norm) * 255); // gamma 0.5
      if (gamma !== 0.5) { e = Math.round(Math.pow(norm, gamma) * 255); }
      gain[q] = gain[q + 1] = gain[q + 2] = e;
      gain[q + 3] = 255;
    }
  }

  // ---- Ultra HDR container --------------------------------------------------

  var XMP_NS = 'http://ns.adobe.com/xap/1.0/\0';

  function num(v) { return (Math.round(v * 1e6) / 1e6).toString(); }

  function app1Xmp(xml) {
    var body = new TextEncoder().encode(XMP_NS + xml);
    var seg = new Uint8Array(4 + body.length);
    seg[0] = 0xFF; seg[1] = 0xE1;
    seg[2] = (body.length + 2) >> 8; seg[3] = (body.length + 2) & 0xFF;
    seg.set(body, 4);
    return seg;
  }

  function primaryXmp(gainLength) {
    return '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Marzipano Tool">' +
      '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
      '<rdf:Description rdf:about="" ' +
      'xmlns:Container="http://ns.google.com/photos/1.0/container/" ' +
      'xmlns:Item="http://ns.google.com/photos/1.0/container/item/" ' +
      'xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" hdrgm:Version="1.0">' +
      '<Container:Directory><rdf:Seq>' +
      '<rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="Primary" Item:Mime="image/jpeg"/></rdf:li>' +
      '<rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="GainMap" Item:Mime="image/jpeg" Item:Length="' + gainLength + '"/></rdf:li>' +
      '</rdf:Seq></Container:Directory>' +
      '</rdf:Description></rdf:RDF></x:xmpmeta>';
  }

  function gainXmp(p) {
    return '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Marzipano Tool">' +
      '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
      '<rdf:Description rdf:about="" xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/" ' +
      'hdrgm:Version="1.0" hdrgm:GainMapMin="' + num(p.gainMapMin) + '" hdrgm:GainMapMax="' + num(p.gainMapMax) + '" ' +
      'hdrgm:Gamma="' + num(p.gamma) + '" hdrgm:OffsetSDR="' + num(p.offsetSdr) + '" hdrgm:OffsetHDR="' + num(p.offsetHdr) + '" ' +
      'hdrgm:HDRCapacityMin="' + num(p.hdrCapacityMin) + '" hdrgm:HDRCapacityMax="' + num(p.hdrCapacityMax) + '" ' +
      'hdrgm:BaseRenditionIsHDR="False"/>' +
      '</rdf:RDF></x:xmpmeta>';
  }

  // Inserts segments after SOI and any APP0 (JFIF) segment.
  function insertSegments(jpeg, segments) {
    var at = 2;
    if (jpeg[2] === 0xFF && jpeg[3] === 0xE0) {
      at = 4 + ((jpeg[4] << 8) | jpeg[5]);
    }
    var extra = 0;
    segments.forEach(function(s) { extra += s.length; });
    var out = new Uint8Array(jpeg.length + extra);
    out.set(jpeg.subarray(0, at), 0);
    var o = at;
    segments.forEach(function(s) { out.set(s, o); o += s.length; });
    out.set(jpeg.subarray(at), o);
    return { bytes: out, insertedAt: at };
  }

  // MPF APP2 segment listing the primary image and the gain map.
  var MPF_SEGMENT_LENGTH = 90;
  function app2Mpf(primarySize, gainSize, gainOffset) {
    var seg = new Uint8Array(MPF_SEGMENT_LENGTH);
    var dv = new DataView(seg.buffer);
    seg[0] = 0xFF; seg[1] = 0xE2;
    dv.setUint16(2, MPF_SEGMENT_LENGTH - 2);
    seg.set([0x4D, 0x50, 0x46, 0x00], 4); // "MPF\0"
    var t = 8; // TIFF header start (big-endian)
    seg.set([0x4D, 0x4D, 0x00, 0x2A], t);
    dv.setUint32(t + 4, 8);
    var ifd = t + 8;
    dv.setUint16(ifd, 3);
    // MPFVersion
    dv.setUint16(ifd + 2, 0xB000); dv.setUint16(ifd + 4, 7); dv.setUint32(ifd + 6, 4);
    seg.set([0x30, 0x31, 0x30, 0x30], ifd + 10);
    // NumberOfImages
    dv.setUint16(ifd + 14, 0xB001); dv.setUint16(ifd + 16, 4); dv.setUint32(ifd + 18, 1); dv.setUint32(ifd + 22, 2);
    // MPEntry
    dv.setUint16(ifd + 26, 0xB002); dv.setUint16(ifd + 28, 7); dv.setUint32(ifd + 30, 32); dv.setUint32(ifd + 34, 50);
    dv.setUint32(ifd + 38, 0); // next IFD
    var e = t + 50;
    dv.setUint32(e, 0x00030000); dv.setUint32(e + 4, primarySize); dv.setUint32(e + 8, 0);
    dv.setUint32(e + 16, 0x00000000); dv.setUint32(e + 20, gainSize); dv.setUint32(e + 24, gainOffset);
    return seg;
  }

  // Combines SDR base and gain-map JPEG bytes into one Ultra HDR JPEG.
  function assembleUltraHdr(baseJpeg, gainJpeg, params) {
    var gain = insertSegments(gainJpeg, [app1Xmp(gainXmp(params))]).bytes;
    var xmp = app1Xmp(primaryXmp(gain.length));
    // Size of the primary once both segments are inserted.
    var primarySize = baseJpeg.length + xmp.length + MPF_SEGMENT_LENGTH;
    var at = 2;
    if (baseJpeg[2] === 0xFF && baseJpeg[3] === 0xE0) { at = 4 + ((baseJpeg[4] << 8) | baseJpeg[5]); }
    var tiffStart = at + xmp.length + 8; // after the MPF marker, length and "MPF\0"
    var mpf = app2Mpf(primarySize, gain.length, primarySize - tiffStart);
    var primary = insertSegments(baseJpeg, [xmp, mpf]).bytes;
    var out = new Uint8Array(primary.length + gain.length);
    out.set(primary, 0);
    out.set(gain, primary.length);
    return out;
  }

  return {
    SourceBuilder: SourceBuilder,
    projectFace: projectFace,
    downsample: downsample,
    upsampleTile: upsampleTile,
    cropTile: cropTile,
    makeParams: makeParams,
    splitBaseGain: splitBaseGain,
    assembleUltraHdr: assembleUltraHdr,
    pack9e5: pack9e5,
    E5_SCALE: E5_SCALE
  };
})();
