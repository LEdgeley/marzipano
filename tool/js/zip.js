'use strict';

// Minimal ZIP writer (stored, no compression: tiles are already JPEG).
// Builds the archive as a Blob made of parts so large tours do not need one
// contiguous buffer. Supports archives up to 4 GB / 65535 entries.
(function(global) {

  var CRC_TABLE = (function() {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) {
        c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function dosDateTime(d) {
    var time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    var date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time: time, date: date };
  }

  function ZipWriter() {
    this._parts = [];
    this._central = [];
    this._offset = 0;
    this._count = 0;
    this._dt = dosDateTime(new Date());
  }

  // data: Blob, ArrayBuffer, Uint8Array or string.
  ZipWriter.prototype.add = async function(name, data) {
    var bytes;
    if (typeof data === 'string') {
      bytes = new TextEncoder().encode(data);
    } else if (data instanceof Blob) {
      bytes = new Uint8Array(await data.arrayBuffer());
    } else if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
    } else {
      bytes = data;
    }
    var nameBytes = new TextEncoder().encode(name);
    var crc = crc32(bytes);
    var size = bytes.length;

    var local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);       // version needed
    local.setUint16(6, 0x0800, true);   // UTF-8 names
    local.setUint16(8, 0, true);        // stored
    local.setUint16(10, this._dt.time, true);
    local.setUint16(12, this._dt.date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);

    var central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, 0x0800, true);
    central.setUint16(10, 0, true);
    central.setUint16(12, this._dt.time, true);
    central.setUint16(14, this._dt.date, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, size, true);
    central.setUint32(24, size, true);
    central.setUint16(28, nameBytes.length, true);
    central.setUint32(42, this._offset, true);

    this._parts.push(local.buffer, nameBytes, new Blob([bytes]));
    this._central.push(central.buffer, nameBytes);
    this._offset += 30 + nameBytes.length + size;
    this._count++;
    if (this._offset > 0xFFFFFFFF || this._count > 0xFFFF) {
      throw new Error('Tour is too large for a ZIP file; use "Export to folder" instead.');
    }
  };

  ZipWriter.prototype.finish = function() {
    var centralSize = 0;
    this._central.forEach(function(p) { centralSize += p.byteLength; });
    var end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, this._count, true);
    end.setUint16(10, this._count, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, this._offset, true);
    return new Blob(this._parts.concat(this._central, [end.buffer]), { type: 'application/zip' });
  };

  global.ZipWriter = ZipWriter;

})(window);
