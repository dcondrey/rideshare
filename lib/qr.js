// @ts-check
/**
 * QR Code encoder (ISO/IEC 18004), byte mode, error-correction level M,
 * versions 1–20. Enough for an OpenID4VC offer or request URI (up to 666
 * bytes at version 20), which a phone wallet scans across devices.
 *
 * Output is a module matrix and an SVG rendering that uses presentation
 * attributes only, so it renders under the CSP's `style-src 'self'`.
 *
 * tests/vectors/qr.json pins matrices produced by an independent encoder, so a
 * mistake in the tables or masking below fails a test rather than a scan.
 */

// [ecCodewordsPerBlock, group1Blocks, group1DataCodewords, group2Blocks, group2DataCodewords]
// for level M, indexed by version.
/** @type {Record<number, [number, number, number, number, number]>} */
const BLOCKS_M = {
  1: [10, 1, 16, 0, 0],
  2: [16, 1, 28, 0, 0],
  3: [26, 1, 44, 0, 0],
  4: [18, 2, 32, 0, 0],
  5: [24, 2, 43, 0, 0],
  6: [16, 4, 27, 0, 0],
  7: [18, 4, 31, 0, 0],
  8: [22, 2, 38, 2, 39],
  9: [22, 3, 36, 2, 37],
  10: [26, 4, 43, 1, 44],
  11: [30, 1, 50, 4, 51],
  12: [22, 6, 36, 2, 37],
  13: [22, 8, 37, 1, 38],
  14: [24, 4, 40, 5, 41],
  15: [24, 5, 41, 5, 42],
  16: [28, 7, 45, 3, 46],
  17: [28, 10, 46, 1, 47],
  18: [26, 9, 43, 4, 44],
  19: [26, 3, 44, 11, 45],
  20: [26, 3, 41, 13, 42],
};

/** @type {Record<number, number[]>} */
const ALIGNMENT = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
  11: [6, 30, 54],
  12: [6, 32, 58],
  13: [6, 34, 62],
  14: [6, 26, 46, 66],
  15: [6, 26, 48, 70],
  16: [6, 26, 50, 74],
  17: [6, 30, 54, 78],
  18: [6, 30, 56, 82],
  19: [6, 30, 58, 86],
  20: [6, 34, 62, 90],
};

const MAX_VERSION = 20;

// ── GF(256) arithmetic, primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 ──────
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

/** @param {number} a @param {number} b */
function gfMul(a, b) {
  return a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];
}

/** Generator polynomial of the given degree, highest-order coefficient first. */
function generator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** Reed–Solomon remainder: the error-correction codewords for one block. */
function ecCodewords(data, degree) {
  const gen = generator(degree);
  const res = [...data, ...new Array(degree).fill(0)];
  for (let i = 0; i < data.length; i++) {
    const coef = res[i];
    if (coef === 0) continue;
    for (let j = 0; j < gen.length; j++) res[i + j] ^= gfMul(gen[j], coef);
  }
  return res.slice(data.length);
}

// ── Data encoding ───────────────────────────────────────────────────────────
/** @param {number} version */
function dataCapacity(version) {
  const [, b1, d1, b2, d2] = BLOCKS_M[version];
  return b1 * d1 + b2 * d2;
}

/** Smallest version whose byte-mode capacity holds `n` bytes. */
function pickVersion(n) {
  for (let v = 1; v <= MAX_VERSION; v++) {
    const countBits = v < 10 ? 8 : 16;
    if (4 + countBits + 8 * n <= dataCapacity(v) * 8) return v;
  }
  throw new Error(`QR payload of ${n} bytes exceeds version ${MAX_VERSION} at level M`);
}

/** @param {Uint8Array} bytes @param {number} version */
function encodeData(bytes, version) {
  /** @type {number[]} */
  const bits = [];
  const put = (value, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  put(0b0100, 4);
  put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  const capacityBits = dataCapacity(version) * 8;
  put(0, Math.min(4, capacityBits - bits.length));
  while (bits.length % 8) bits.push(0);
  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
    codewords.push(v);
  }
  for (let pad = 0; codewords.length < dataCapacity(version); pad ^= 1) {
    codewords.push(pad ? 0x11 : 0xec);
  }
  return codewords;
}

/** Split into blocks, add EC, and interleave. */
function finalCodewords(data, version) {
  const [ecLen, b1, d1, b2, d2] = BLOCKS_M[version];
  /** @type {number[][]} */
  const blocks = [];
  let at = 0;
  for (let i = 0; i < b1 + b2; i++) {
    const len = i < b1 ? d1 : d2;
    blocks.push(data.slice(at, at + len));
    at += len;
  }
  const ecs = blocks.map((b) => ecCodewords(b, ecLen));
  const out = [];
  for (let i = 0; i < Math.max(d1, d2); i++)
    for (const b of blocks) if (i < b.length) out.push(b[i]);
  for (let i = 0; i < ecLen; i++) for (const e of ecs) out.push(e[i]);
  return out;
}

// ── Matrix construction ─────────────────────────────────────────────────────
/** @param {number} version */
function emptyMatrix(version) {
  const size = 17 + 4 * version;
  /** @type {(0|1)[][]} */
  const modules = Array.from({ length: size }, () => new Array(size).fill(0));
  /** @type {boolean[][]} */
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (r, c, dark) => {
    modules[r][c] = dark ? 1 : 0;
    reserved[r][c] = true;
  };

  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = r0 + r;
        const cc = c0 + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
        set(rr, cc, ring !== 2 && ring !== 4);
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  for (let i = 8; i < size - 8; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }

  const pos = ALIGNMENT[version];
  const last = pos[pos.length - 1];
  for (const r of pos) {
    for (const c of pos) {
      // The three corners that would overlap a finder pattern are skipped;
      // the rest cross the timing lines and overwrite them, as specified.
      if ((r === 6 && c === 6) || (r === 6 && c === last) || (r === last && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    }
  }

  // Format-information areas and the always-dark module.
  for (let i = 0; i < 9; i++) {
    if (!reserved[8][i]) set(8, i, false);
    if (!reserved[i][8]) set(i, 8, false);
  }
  for (let i = 0; i < 8; i++) {
    set(8, size - 1 - i, false);
    set(size - 1 - i, 8, false);
  }
  set(size - 8, 8, true);

  if (version >= 7) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        set(i, size - 11 + j, false);
        set(size - 11 + j, i, false);
      }
    }
  }
  return { size, modules, reserved };
}

/** Zigzag placement of the codeword bits into unreserved modules. */
function placeData(m, codewords) {
  const bits = [];
  for (const cw of codewords) for (let i = 7; i >= 0; i--) bits.push((cw >>> i) & 1);
  let idx = 0;
  let upward = true;
  for (let col = m.size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5; // skip the vertical timing column
    for (let i = 0; i < m.size; i++) {
      const row = upward ? m.size - 1 - i : i;
      for (const c of [col, col - 1]) {
        if (m.reserved[row][c]) continue;
        m.modules[row][c] = idx < bits.length ? /** @type {0|1} */ (bits[idx]) : 0;
        idx++;
      }
    }
    upward = !upward;
  }
}

/** @type {((r: number, c: number) => boolean)[]} */
const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** BCH remainder of `value` (already shifted) by `poly`. */
function bchRemainder(value, poly) {
  const polyLen = 32 - Math.clz32(poly);
  let v = value;
  while (32 - Math.clz32(v) >= polyLen) v ^= poly << (32 - Math.clz32(v) - polyLen);
  return v;
}

/** Write the 15-bit format information for level M and `mask`. */
function placeFormat(m, mask) {
  const data = (0b00 << 3) | mask; // level M = 00
  const bits = ((data << 10) | bchRemainder(data << 10, 0x537)) ^ 0x5412;
  const bit = (i) => /** @type {0|1} */ ((bits >>> i) & 1);
  const n = m.size;
  for (let i = 0; i <= 5; i++) m.modules[8][i] = bit(14 - i);
  m.modules[8][7] = bit(8);
  m.modules[8][8] = bit(7);
  m.modules[7][8] = bit(6);
  for (let i = 9; i <= 14; i++) m.modules[14 - i][8] = bit(14 - i);
  // Second copy: bits 14..8 up column 8 from the bottom, bits 7..0 along row 8
  // to the right edge.
  for (let i = 0; i <= 6; i++) m.modules[n - 1 - i][8] = bit(14 - i);
  for (let i = 0; i <= 7; i++) m.modules[8][n - 1 - i] = bit(i);
  m.modules[n - 8][8] = 1;
}

/** Write the 18-bit version information (versions 7 and up). */
function placeVersion(m, version) {
  if (version < 7) return;
  const bits = (version << 12) | bchRemainder(version << 12, 0x1f25);
  for (let i = 0; i < 18; i++) {
    const dark = /** @type {0|1} */ ((bits >>> i) & 1);
    const r = Math.floor(i / 3);
    const c = m.size - 11 + (i % 3);
    m.modules[r][c] = dark;
    m.modules[c][r] = dark;
  }
}

/** ISO 18004 penalty score (rules N1–N4) of a finished matrix. */
function penalty(modules) {
  const n = modules.length;
  let score = 0;
  const lineRuns = (get) => {
    for (let i = 0; i < n; i++) {
      let run = 1;
      for (let j = 1; j < n; j++) {
        if (get(i, j) === get(i, j - 1)) run++;
        else {
          if (run >= 5) score += run - 2;
          run = 1;
        }
      }
      if (run >= 5) score += run - 2;
    }
  };
  lineRuns((i, j) => modules[i][j]);
  lineRuns((i, j) => modules[j][i]);

  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const v = modules[r][c];
      if (v === modules[r][c + 1] && v === modules[r + 1][c] && v === modules[r + 1][c + 1]) {
        score += 3;
      }
    }
  }

  const patterns = [
    [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0],
    [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1],
  ];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j + 11 <= n; j++) {
      for (const p of patterns) {
        let row = true;
        let col = true;
        for (let k = 0; k < 11; k++) {
          if (modules[i][j + k] !== p[k]) row = false;
          if (modules[j + k][i] !== p[k]) col = false;
        }
        if (row) score += 40;
        if (col) score += 40;
      }
    }
  }

  let dark = 0;
  for (const row of modules) for (const v of row) dark += v;
  const percent = (dark * 100) / (n * n);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

/**
 * Encode `text` (UTF-8) as a QR code. Picks the smallest version and the mask
 * with the lowest penalty, as the standard specifies.
 * @param {string} text
 * @param {{ mask?: number }} [opts] force a mask (tests compare against vectors)
 * @returns {{ version: number, mask: number, size: number, modules: (0|1)[][] }}
 */
export function encodeQr(text, opts = {}) {
  const bytes = new TextEncoder().encode(text);
  const version = pickVersion(bytes.length);
  const codewords = finalCodewords(encodeData(bytes, version), version);

  let best = null;
  const masks = opts.mask === undefined ? [0, 1, 2, 3, 4, 5, 6, 7] : [opts.mask];
  for (const mask of masks) {
    const m = emptyMatrix(version);
    placeData(m, codewords);
    const fn = MASKS[mask];
    for (let r = 0; r < m.size; r++) {
      for (let c = 0; c < m.size; c++) {
        if (!m.reserved[r][c] && fn(r, c)) m.modules[r][c] ^= 1;
      }
    }
    placeFormat(m, mask);
    placeVersion(m, version);
    const score = penalty(m.modules);
    if (!best || score < best.score) best = { score, mask, m };
  }
  if (!best) throw new Error("unreachable: no mask evaluated");
  return { version, mask: best.mask, size: best.m.size, modules: best.m.modules };
}

/**
 * Render as SVG: one path of dark squares on a light background, with a
 * four-module quiet zone. Scales with its container.
 * @param {string} text
 * @param {{ label?: string }} [opts] accessible name for the image
 */
export function qrSvg(text, opts = {}) {
  const { size, modules } = encodeQr(text);
  const margin = 4;
  const total = size + margin * 2;
  let d = "";
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r][c]) d += `M${c + margin} ${r + margin}h1v1h-1z`;
    }
  }
  const label = (opts.label || "QR code").replace(/[<>&"]/g, "");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" ` +
    `role="img" aria-label="${label}" shape-rendering="crispEdges">` +
    `<rect width="${total}" height="${total}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`
  );
}
