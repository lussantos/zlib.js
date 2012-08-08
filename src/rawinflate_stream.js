/**
 * JavaScript Inflate Library
 *
 * The MIT License
 *
 * Copyright (c) 2012 imaya
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */


goog.provide('Zlib.RawInflateStream');

goog.require('Zlib.Huffman');

//-----------------------------------------------------------------------------

/** @define {boolean} export symbols. */
var ZLIB_RAW_INFLATE_STREAM_EXPORT = false;

/** @define {number} buffer block size. */
var ZLIB_STREAM_BUFFER_BLOCK_SIZE = 0x8000; // [ 0x8000 >= ZLIB_BUFFER_BLOCK_SIZE ]

//-----------------------------------------------------------------------------

goog.scope(function() {

var buildHuffmanTable = Zlib.Huffman.buildHuffmanTable;

/**
 * @param {!(Uint8Array|Array.<number>)} input input buffer.
 * @param {number} ip input buffer pointer.
 * @param {number=} opt_blocksize buffer block size.
 * @constructor
 */
Zlib.RawInflateStream = function(input, ip, opt_blocksize) {
  /** @type {!(Array|Uint8Array)} inflated buffer */
  this.buffer;
  /** @type {!Array.<(Array|Uint8Array)>} */
  this.blocks = [];
  /** @type {number} block size. */
  this.blockSize = opt_blocksize ? opt_blocksize : ZLIB_STREAM_BUFFER_BLOCK_SIZE;
  /** @type {!number} total output buffer pointer. */
  this.totalpos = 0;
  /** @type {!number} input buffer pointer. */
  this.ip = ip === void 0 ? 0 : ip;
  /** @type {!number} bit stream reader buffer. */
  this.bitsbuf = 0;
  /** @type {!number} bit stream reader buffer size. */
  this.bitsbuflen = 0;
  /** @type {!(Array|Uint8Array)} input buffer. */
  this.input = USE_TYPEDARRAY ? new Uint8Array(input) : input;
  /** @type {!(Uint8Array|Array)} output buffer. */
  this.output = new (USE_TYPEDARRAY ? Uint8Array : Array)(this.blockSize);
  /** @type {!number} output buffer pointer. */
  this.op = 0;
  /** @type {boolean} is final block flag. */
  this.bfinal = false;
  /** @type {number} uncompressed block length. */
  this.blockLength;
  /** @type {boolean} resize flag for memory size optimization. */
  this.resize = false;
  /** @type {Array} */
  this.litlenTable;
  /** @type {Array} */
  this.distTable;
  /** @type {number} */
  this.sp = 0; // stream pointer
  /** @type {Zlib.RawInflateStream.Status} */
  this.status = Zlib.RawInflateStream.Status.INITIALIZED;
};

/**
 * @enum {number}
 */
Zlib.RawInflateStream.BlockType = {
  UNCOMPRESSED: 0,
  FIXED: 1,
  DYNAMIC: 2
};

/**
 * @enum {number}
 */
Zlib.RawInflateStream.Status = {
  INITIALIZED: 0,
  BLOCK_HEADER_START: 1,
  BLOCK_HEADER_END: 2,
  BLOCK_BODY_START: 3,
  BLOCK_BODY_END: 4,
  DECODE_BLOCK_START: 5,
  DECODE_BLOCK_END: 6
};

/**
 * decompress.
 * @return {!(Uint8Array|Array)} inflated buffer.
 */
Zlib.RawInflateStream.prototype.decompress = function(newInput, ip) {
  /** @type {boolean} */
  var stop = false;

  if (newInput !== void 0) {
    this.input = newInput;
  }

  if (ip !== void 0) {
    this.ip = ip;
  }

  // decompress
  while (!stop) {
    switch (this.status) {
      // block header
      case Zlib.RawInflateStream.Status.INITIALIZED:
      case Zlib.RawInflateStream.Status.BLOCK_HEADER_START:
        if (this.readBlockHeader() < 0) {
          stop = true;
        }
        break;
      // block body
      case Zlib.RawInflateStream.Status.BLOCK_HEADER_END: /* FALLTHROUGH */
      case Zlib.RawInflateStream.Status.BLOCK_BODY_START:
        switch(this.currentBlockType) {
          case Zlib.RawInflateStream.BlockType.UNCOMPRESSED:
            if (this.readUncompressedBlockHeader() < 0) {
              stop = true;
            }
            break;
          case Zlib.RawInflateStream.BlockType.FIXED:
            if (this.parseFixedHuffmanBlock() < 0) {
              stop = true;
            }
            break;
          case Zlib.RawInflateStream.BlockType.DYNAMIC:
            if (this.parseDynamicHuffmanBlock() < 0) {
              stop = true;
            }
            break;
        }
        break;
      // decode data
      case Zlib.RawInflateStream.Status.BLOCK_BODY_END:
      case Zlib.RawInflateStream.Status.DECODE_BLOCK_START:
        switch(this.currentBlockType) {
          case Zlib.RawInflateStream.BlockType.UNCOMPRESSED:
            if (this.parseUncompressedBlock() < 0) {
              stop = true;
            }
            break;
          case Zlib.RawInflateStream.BlockType.FIXED: /* FALLTHROUGH */
          case Zlib.RawInflateStream.BlockType.DYNAMIC:
            if (this.decodeHuffman() < 0) {
              stop = true;
            }
            break;
        }
        break;
      case Zlib.RawInflateStream.Status.DECODE_BLOCK_END:
        if (this.bfinal) {
          stop = true;
        } else {
          this.status = Zlib.RawInflateStream.Status.INITIALIZED;
        }
        break;
    }
  }

  return this.concatBuffer();
};

/**
 * @const {number} max backward length for LZ77.
 */
Zlib.RawInflateStream.MaxBackwardLength = 32768;

/**
 * @const {number} max copy length for LZ77.
 */
Zlib.RawInflateStream.MaxCopyLength = 258;

/**
 * huffman order
 * @const {!(Array.<number>|Uint8Array)}
 */
Zlib.RawInflateStream.Order = (function(table) {
  return USE_TYPEDARRAY ? new Uint16Array(table) : table;
})([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);

/**
 * huffman length code table.
 * @const {!(Array.<number>|Uint16Array)}
 */
Zlib.RawInflateStream.LengthCodeTable = (function(table) {
  return USE_TYPEDARRAY ? new Uint16Array(table) : table;
})([
  0x0003, 0x0004, 0x0005, 0x0006, 0x0007, 0x0008, 0x0009, 0x000a, 0x000b,
  0x000d, 0x000f, 0x0011, 0x0013, 0x0017, 0x001b, 0x001f, 0x0023, 0x002b,
  0x0033, 0x003b, 0x0043, 0x0053, 0x0063, 0x0073, 0x0083, 0x00a3, 0x00c3,
  0x00e3, 0x0102, 0x0102, 0x0102
]);

/**
 * huffman length extra-bits table.
 * @const {!(Array.<number>|Uint8Array)}
 */
Zlib.RawInflateStream.LengthExtraTable = (function(table) {
  return USE_TYPEDARRAY ? new Uint8Array(table) : table;
})([
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5,
  5, 5, 0, 0, 0
]);

/**
 * huffman dist code table.
 * @const {!(Array.<number>|Uint16Array)}
 */
Zlib.RawInflateStream.DistCodeTable = (function(table) {
  return USE_TYPEDARRAY ? new Uint16Array(table) : table;
})([
  0x0001, 0x0002, 0x0003, 0x0004, 0x0005, 0x0007, 0x0009, 0x000d, 0x0011,
  0x0019, 0x0021, 0x0031, 0x0041, 0x0061, 0x0081, 0x00c1, 0x0101, 0x0181,
  0x0201, 0x0301, 0x0401, 0x0601, 0x0801, 0x0c01, 0x1001, 0x1801, 0x2001,
  0x3001, 0x4001, 0x6001
]);

/**
 * huffman dist extra-bits table.
 * @const {!(Array.<number>|Uint8Array)}
 */
Zlib.RawInflateStream.DistExtraTable = (function(table) {
  return USE_TYPEDARRAY ? new Uint8Array(table) : table;
})([
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11,
  11, 12, 12, 13, 13
]);

/**
 * fixed huffman length code table
 * @const {!Array}
 */
Zlib.RawInflateStream.FixedLiteralLengthTable = (function(table) {
  return table;
})((function() {
  var lengths = new (USE_TYPEDARRAY ? Uint8Array : Array)(288);
  var i, il;

  for (i = 0, il = lengths.length; i < il; ++i) {
    lengths[i] =
      (i <= 143) ? 8 :
      (i <= 255) ? 9 :
      (i <= 279) ? 7 :
      8;
  }

  return buildHuffmanTable(lengths);
})());

/**
 * fixed huffman distance code table
 * @const {!Array}
 */
Zlib.RawInflateStream.FixedDistanceTable = (function(table) {
  return table;
})((function() {
  var lengths = new (USE_TYPEDARRAY ? Uint8Array : Array)(30);
  var i, il;

  for (i = 0, il = lengths.length; i < il; ++i) {
    lengths[i] = 5;
  }

  return buildHuffmanTable(lengths);
})());

/**
 * parse deflated block.
 */
Zlib.RawInflateStream.prototype.readBlockHeader = function() {
  /** @type {number} header */
  var hdr;

  this.status = Zlib.RawInflateStream.Status.BLOCK_HEADER_START;

  try {
    this.save();
    hdr = this.readBits(3)
  } catch(e) {
    this.restore();
    return -1;
  }

  // BFINAL
  if (hdr & 0x1) {
    this.bfinal = true;
  }

  // BTYPE
  hdr >>>= 1;
  switch (hdr) {
    case 0: // uncompressed
      this.currentBlockType = Zlib.RawInflateStream.BlockType.UNCOMPRESSED;
      break;
    case 1: // fixed huffman
      this.currentBlockType = Zlib.RawInflateStream.BlockType.FIXED;
      break;
    case 2: // dynamic huffman
      this.currentBlockType = Zlib.RawInflateStream.BlockType.DYNAMIC;
      break;
    default: // reserved or other
      throw new Error('unknown BTYPE: ' + hdr);
  }

  this.status = Zlib.RawInflateStream.Status.BLOCK_HEADER_END;
};

/**
 * read inflate bits
 * @param {number} length bits length.
 * @return {number} read bits.
 */
Zlib.RawInflateStream.prototype.readBits = function(length) {
  var bitsbuf = this.bitsbuf;
  var bitsbuflen = this.bitsbuflen;
  var input = this.input;
  var ip = this.ip;

  /** @type {number} input and output byte. */
  var octet;

  // not enough buffer
  while (bitsbuflen < length) {
    // input byte
    octet = input[ip++];
    if (octet === void 0) {
      throw new Error('not enough input');
    }

    // concat octet
    bitsbuf |= octet << bitsbuflen;
    bitsbuflen += 8;
  }

  // output byte
  octet = bitsbuf & /* MASK */ ((1 << length) - 1);
  bitsbuf >>>= length;
  bitsbuflen -= length;

  this.bitsbuf = bitsbuf;
  this.bitsbuflen = bitsbuflen;
  this.ip = ip;

  return octet;
};

/**
 * read huffman code using table
 * @param {Array} table huffman code table.
 * @return {number} huffman code.
 */
Zlib.RawInflateStream.prototype.readCodeByTable = function(table) {
  var bitsbuf = this.bitsbuf;
  var bitsbuflen = this.bitsbuflen;
  var input = this.input;
  var ip = this.ip;

  /** @type {!(Array|Uint8Array)} huffman code table */
  var codeTable = table[0];
  /** @type {number} */
  var maxCodeLength = table[1];
  /** @type {number} input byte */
  var octet;
  /** @type {number} code */
  var code;
  /** @type {number} code length & code (16bit, 16bit) */
  var codeWithLength;
  /** @type {number} code bits length */
  var codeLength;

  // not enough buffer
  while (bitsbuflen < maxCodeLength) {
    octet = input[ip++];
    if (octet === void 0) {
      throw new Error('not enough input');
    }
    bitsbuf |= octet << bitsbuflen;
    bitsbuflen += 8;
  }

  // read max length
  codeWithLength = codeTable[bitsbuf & ((1 << maxCodeLength) - 1)];
  codeLength = codeWithLength >>> 16;

  this.bitsbuf = bitsbuf >> codeLength;
  this.bitsbuflen = bitsbuflen - codeLength;
  this.ip = ip;

  return codeWithLength & 0xffff;
};

/**
 * read uncompressed block header
 */
Zlib.RawInflateStream.prototype.readUncompressedBlockHeader = function() {
  /** @type {number} input byte. */
  var octet;
  /** @type {number} block length */
  var len;
  /** @type {number} number for check block length */
  var nlen;

  var input = this.input;
  var ip = this.ip;

  this.status = Zlib.RawInflateStream.Status.BLOCK_BODY_START;

  // len (1st)
  octet = input[ip++];
  if (octet === void 0) {
    return -1;
  }
  len = octet;

  // len (2nd)
  octet = input[ip++];
  if (octet === void 0) {
    return -1;
  }
  len |= octet << 8;

  // nlen (1st)
  octet = input[ip++];
  if (octet === void 0) {
    return -1;
  }
  nlen = octet;

  // nlen (2nd)
  octet = input[ip++];
  if (octet === void 0) {
    return -1;
  }
  nlen |= octet << 8;

  // check len & nlen
  if (len === ~nlen) {
    throw new Error('invalid uncompressed block header: length verify');
  }

  // skip buffered header bits
  this.bitsbuf = 0;
  this.bitsbuflen = 0;

  this.ip = ip;
  this.blockLength = len;
  this.status = Zlib.RawInflateStream.Status.BLOCK_BODY_END;
}

/**
 * parse uncompressed block.
 */
Zlib.RawInflateStream.prototype.parseUncompressedBlock = function() {
  var input = this.input;
  var ip = this.ip;
  var output = this.output;
  var op = this.op;
  var len = this.blockLength;

  this.status = Zlib.RawInflateStream.Status.DECODE_BLOCK_START;

  // copy
  // XXX: とりあえず素直にコピー
  while (len--) {
    if (op === output.length) {
      output = this.expandBuffer();
    }

    // not enough input buffer
    if (input[ip] === void 0) {
      this.ip = ip;
      this.op = op;
      this.blockLength = len + 1; // コピーしてないので戻す
      return -1;
    }

    output[op++] = input[ip++];
  }

  if (len < 0) {
    this.status = Zlib.RawInflateStream.Status.DECODE_BLOCK_END;
  }

  this.ip = ip;
  this.op = op;

  return 0;
};

/**
 * parse fixed huffman block.
 */
Zlib.RawInflateStream.prototype.parseFixedHuffmanBlock = function() {
  this.status = Zlib.RawInflateStream.Status.BLOCK_BODY_START;

  this.litlenTable = Zlib.RawInflateStream.FixedLiteralLengthTable;
  this.distTable = Zlib.RawInflateStream.FixedDistanceTable;

  this.status = Zlib.RawInflateStream.Status.BLOCK_BODY_END;

  return 0;
};

Zlib.RawInflateStream.prototype.save = function() {
  this.ip_ = this.ip;
  this.bitsbuflen_ = this.bitsbuflen;
  this.bitsbuf_ = this.bitsbuf;
};

Zlib.RawInflateStream.prototype.restore = function() {
  this.ip = this.ip_;
  this.bitsbuflen = this.bitsbuflen_;
  this.bitsbuf = this.bitsbuf_;
}

/**
 * parse dynamic huffman block.
 */
Zlib.RawInflateStream.prototype.parseDynamicHuffmanBlock = function() {
  /** @type {number} number of literal and length codes. */
  var hlit;
  /** @type {number} number of distance codes. */
  var hdist;
  /** @type {number} number of code lengths. */
  var hclen;
  /** @type {!(Uint8Array|Array)} code lengths. */
  var codeLengths =
    new (USE_TYPEDARRAY ? Uint8Array : Array)(Zlib.RawInflateStream.Order.length);
  /** @type {!Array} code lengths table. */
  var codeLengthsTable;
  /** @type {!(Uint32Array|Array)} literal and length code lengths. */
  var litlenLengths;
  /** @type {!(Uint32Array|Array)} distance code lengths. */
  var distLengths;
  /** @type {number} loop counter. */
  var i = 0;
  /** @type {number} loop counter. */
  var j = 0;

  this.status = Zlib.RawInflateStream.Status.BLOCK_BODY_START;

  try {
    this.save();
    hlit = this.readBits(5) + 257;
    hdist = this.readBits(5) + 1;
    hclen = this.readBits(4) + 4;
    parseDynamicHuffmanBlockImpl.call(this);
  } catch(e) {
    this.restore();
    return -1;
  }

  function parseDynamicHuffmanBlockImpl() {
    // decode code lengths
    for (i = 0; i < hclen; ++i) {
      codeLengths[Zlib.RawInflateStream.Order[i]] = this.readBits(3);
    }
    codeLengthsTable = buildHuffmanTable(codeLengths);

    // decode function
    function decode(num, table, lengths) {
      var code;
      var prev;
      var repeat;
      var i = 0;

      for (i = 0; i < num;) {
        code = this.readCodeByTable(table);
        switch (code) {
          case 16:
            repeat = 3 + this.readBits(2);
            while (repeat--) { lengths[i++] = prev; }
            break;
          case 17:
            repeat = 3 + this.readBits(3);
            while (repeat--) { lengths[i++] = 0; }
            prev = 0;
            break;
          case 18:
            repeat = 11 + this.readBits(7);
            while (repeat--) { lengths[i++] = 0; }
            prev = 0;
            break;
          default:
            lengths[i++] = code;
            prev = code;
            break;
        }
      }

      return lengths;
    }

    // literal and length code
    litlenLengths = new (USE_TYPEDARRAY ? Uint8Array : Array)(hlit);

    // distance code
    distLengths = new (USE_TYPEDARRAY ? Uint8Array : Array)(hdist);

    this.litlenTable = buildHuffmanTable(decode.call(this, hlit, codeLengthsTable, litlenLengths));
    this.distTable = buildHuffmanTable(decode.call(this, hdist, codeLengthsTable, distLengths));
  }

  this.status = Zlib.RawInflateStream.Status.BLOCK_BODY_END;

  return 0;
};

/**
 * decode huffman code (dynamic)
 * @return {(number|undefined)} -1 is error.
 */
Zlib.RawInflateStream.prototype.decodeHuffman = function() {
  var output = this.output;
  var op = this.op;

  /** @type {number} huffman code. */
  var code;
  /** @type {number} table index. */
  var ti;
  /** @type {number} huffman code distination. */
  var codeDist;
  /** @type {number} huffman code length. */
  var codeLength;
  /** @type {number} buffer position. */
  var bpos;
  /** @type {number} pre-copy counter. */
  var preCopy;

  var litlen = this.litlenTable;
  var dist = this.distTable;

  this.status = Zlib.RawInflateStream.Status.DECODE_BLOCK_START;

  while (true) {
    try {
      this.save();
      code = this.readCodeByTable(litlen);
    } catch(e) {
      this.restore();
      return -1;
    }

    if (code === 256) {
      break;
    }

    // literal
    if (code < 256) {
      if (this.op === output.length) {
        output = this.expandBuffer();
      }
      output[this.op++] = code;

      continue;
    }

    // length code
    ti = code - 257;
    codeLength = Zlib.RawInflateStream.LengthCodeTable[ti];
    if (Zlib.RawInflateStream.LengthExtraTable[ti] > 0) {
      try {
        codeLength += this.readBits(Zlib.RawInflateStream.LengthExtraTable[ti]);
      } catch(e) {
        this.restore();
        return -1;
      }
    }

    // dist code
    try {
      code = this.readCodeByTable(dist);
    } catch(e) {
      this.restore();
      return -1;
    }
    codeDist = Zlib.RawInflateStream.DistCodeTable[code];
    if (Zlib.RawInflateStream.DistExtraTable[code] > 0) {
      try {
        codeDist += this.readBits(Zlib.RawInflateStream.DistExtraTable[code]);
      } catch(e) {
        this.restore();
        return -1;
      }
    }

    // lz77 decode
    if (this.op + codeLength >= output.length) {
      output = this.expandBuffer();
    }

    op = this.op;
    while (codeLength--) {
      output[op] = output[(op++) - codeDist];
    }
    this.op = op;

    // break
    if (this.ip === this.input.length) {
      return -1;
    }
  }

  while (this.bitsbuflen >= 8) {
    this.bitsbuflen -= 8;
    this.ip--;
  }

  this.status = Zlib.RawInflateStream.Status.DECODE_BLOCK_END;
};

/**
 * expand output buffer. (dynamic)
 * @param {Object=} opt_param option parameters.
 * @return {!(Array|Uint8Array)} output buffer pointer.
 */
Zlib.RawInflateStream.prototype.expandBuffer = function(opt_param) {
  /** @type {!(Array|Uint8Array)} store buffer. */
  var buffer;
  /** @type {number} expantion ratio. */
  var ratio = (this.input.length / this.ip + 1) | 0;
  /** @type {number} maximum number of huffman code. */
  var maxHuffCode;
  /** @type {number} new output buffer size. */
  var newSize;
  /** @type {number} max inflate size. */
  var maxInflateSize;

  var input = this.input;
  var output = this.output;

  if (opt_param) {
    if (typeof opt_param.fixRatio === 'number') {
      ratio = opt_param.fixRatio;
    }
    if (typeof opt_param.addRatio === 'number') {
      ratio += opt_param.addRatio;
    }
  }

  // calculate new buffer size
  if (ratio < 2) {
    maxHuffCode =
      (input.length - this.ip) / this.litlenTable[2];
    maxInflateSize = (maxHuffCode / 2 * 258) | 0;
    newSize = maxInflateSize < output.length ?
      output.length + maxInflateSize :
      output.length << 1;
  } else {
    newSize = output.length * ratio;
  }

  // buffer expantion
  if (USE_TYPEDARRAY) {
    buffer = new Uint8Array(newSize);
    buffer.set(output);
  } else {
    buffer = output;
  }

  this.output = buffer;

  return this.output;
};

/**
 * concat output buffer. (dynamic)
 * @return {!(Array|Uint8Array)} output buffer.
 */
Zlib.RawInflateStream.prototype.concatBuffer = function() {
  /** @type {Array|Uint8Array} output buffer. */
  var buffer;

  var resize = this.resize;

  var op = this.op;

  if (resize) {
    if (USE_TYPEDARRAY) {
      buffer = new Uint8Array(op);
      buffer.set(this.output.subarray(this.sp, op));
    } else {
      buffer = this.output.slice(this.sp, op);
    }
  } else {
    buffer =
      USE_TYPEDARRAY ? this.output.subarray(this.sp, op) : this.output.slice(this.sp, op);
  }


  this.buffer = buffer;
  this.sp = op;

  return this.buffer;
};

//*****************************************************************************
// export
//*****************************************************************************
if (ZLIB_RAW_INFLATE_STREAM_EXPORT) {
  goog.exportSymbol('Zlib.RawInflateStream', Zlib.RawInflateStream);
  goog.exportSymbol(
    'Zlib.RawInflateStream.prototype.decompress',
    Zlib.RawInflateStream.prototype.decompress
  );
}


// end of scope
});

/* vim:set expandtab ts=2 sw=2 tw=80: */