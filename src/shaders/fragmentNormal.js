/*
 * Copyright 2016 Google Inc. All rights reserved.
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

module.exports = [
'#ifdef GL_FRAGMENT_PRECISION_HIGH',
'precision highp float;',
'#else',
'precision mediump float;',
'#endif',

'uniform sampler2D uSampler;',
'uniform sampler2D uGainSampler;',
'uniform float uOpacity;',
'uniform vec4 uColorOffset;',
'uniform mat4 uColorMatrix;',

// HDR (Ultra HDR gain map) reconstruction. uHdr is 1 for tiles that carry a
// gain map and whose layer has an hdr effect.
//   uGainParams = (gainMapMin, gainMapMax, 1/gamma, weight), log2 units
//   uHdrParams  = (offsetSdr, offsetHdr, exposure, headroom for HDR output)
//   uHdrOutput  = 0: tone-map to SDR; 1: extended range (1.0 = SDR white)
'uniform float uHdr;',
'uniform vec4 uGainParams;',
'uniform vec4 uHdrParams;',
'uniform float uHdrOutput;',

'varying vec2 vTextureCoord;',

'vec3 srgbToLinear(vec3 c) {',
'  vec3 lo = c / 12.92;',
'  vec3 hi = pow((c + 0.055) / 1.055, vec3(2.4));',
'  return mix(lo, hi, step(vec3(0.04045), c));',
'}',

'vec3 linearToSrgb(vec3 c) {',
'  c = max(c, vec3(0.0));',
'  vec3 lo = c * 12.92;',
'  vec3 hi = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;',
'  return mix(lo, hi, step(vec3(0.0031308), c));',
'}',

// AgX (Troy Sobotka) with a mild contrast/saturation look: the same transform
// the tool bakes into the SDR base, so exposure 1 reproduces the base image.
// Bright saturated light rolls off smoothly toward white instead of clipping.
'vec3 agxCurve(vec3 v) {',
'  vec3 v2 = v * v;',
'  vec3 v4 = v2 * v2;',
'  return 15.5 * v4 * v2 - 40.14 * v4 * v + 31.96 * v4 - 6.868 * v2 * v + 0.4298 * v2 + 0.1191 * v - 0.00232;',
'}',

'vec3 toneMap(vec3 c) {',
'  vec3 x = vec3(',
'    dot(c, vec3(0.842479062253094, 0.0423282422610123, 0.0423756549057051)),',
'    dot(c, vec3(0.0784335999999992, 0.878468636469772, 0.0784336)),',
'    dot(c, vec3(0.0792237451477643, 0.0791661274605434, 0.879142973793104)));',
'  x = clamp((log2(max(x, vec3(1e-10))) + 12.47393) / 16.499999, 0.0, 1.0);',
'  x = pow(max(agxCurve(x), vec3(0.0)), vec3(1.2));',
'  float l = dot(x, vec3(0.2126, 0.7152, 0.0722));',
'  x = vec3(l) + 1.15 * (x - vec3(l));',
'  vec3 o = vec3(',
'    dot(x, vec3(1.19687900512017, -0.0528968517574562, -0.0529716355144438)),',
'    dot(x, vec3(-0.0980208811401368, 1.15190312990417, -0.0980434501171241)),',
'    dot(x, vec3(-0.0990297440797205, -0.0989611768448433, 1.15107367264116)));',
'  return pow(clamp(o, 0.0, 1.0), vec3(2.2));',
'}',

// HDR output: unchanged up to SDR white, then a smooth per-channel roll-off
// into the display's headroom (peak / SDR white).
'vec3 rollOff(vec3 x, float headroom) {',
'  float knee = min(1.0, 0.5 * headroom);',
'  float span = max(headroom - knee, 1e-3);',
'  vec3 over = max(x - vec3(knee), vec3(0.0));',
'  return min(x, vec3(knee)) + span * (vec3(1.0) - exp(-over / span));',
'}',

'void main(void) {',
'  vec4 color = texture2D(uSampler, vTextureCoord);',
'  if (uHdr > 0.5) {',
'    vec3 sdr = srgbToLinear(color.rgb);',
'    float g = texture2D(uGainSampler, vTextureCoord).r;',
'    float logBoost = mix(uGainParams.x, uGainParams.y, pow(g, uGainParams.z));',
'    vec3 hdr = (sdr + uHdrParams.x) * exp2(logBoost * uGainParams.w) - uHdrParams.y;',
'    hdr = max(hdr, vec3(0.0)) * uHdrParams.z;',
'    vec3 display = uHdrOutput > 0.5 ? rollOff(hdr, uHdrParams.w) : toneMap(hdr);',
'    color = vec4(linearToSrgb(display), color.a);',
'  }',
'  color = color * uColorMatrix + uColorOffset;',
'  gl_FragColor = vec4(color.rgba * uOpacity);',
'}'
].join('\n');
