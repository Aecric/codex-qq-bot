// Minimal QR Code encoder (byte mode, error correction M, versions 1-10): enough
// for a login URL, and the project has no runtime dependencies. The login URL
// must stay on this machine, so a remote rendering service is not an option.
const totalCodewords = [0, 26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
const eccPerBlock = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const blockCount = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const errorCorrectionLevelBits = 0; // Format-information value of level M.

const masks = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
];

function gfMultiply(a, b) {
  let product = 0;
  for (let bit = 7; bit >= 0; bit -= 1) {
    product = (product << 1) ^ ((product >>> 7) * 0x11d);
    product ^= ((b >>> bit) & 1) * a;
  }
  return product & 0xff;
}

function reedSolomonDivisor(degree) {
  const divisor = new Array(degree).fill(0);
  divisor[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      divisor[j] = gfMultiply(divisor[j], root);
      if (j + 1 < degree) divisor[j] ^= divisor[j + 1];
    }
    root = gfMultiply(root, 2);
  }
  return divisor;
}

function reedSolomonRemainder(data, divisor) {
  const remainder = new Array(divisor.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ remainder.shift();
    remainder.push(0);
    divisor.forEach((coefficient, index) => {
      remainder[index] ^= gfMultiply(coefficient, factor);
    });
  }
  return remainder;
}

function dataCapacity(version) {
  return totalCodewords[version] - eccPerBlock[version] * blockCount[version];
}

function chooseVersion(byteLength) {
  for (let version = 1; version <= 10; version += 1) {
    const lengthBits = version < 10 ? 8 : 16;
    if (4 + lengthBits + byteLength * 8 <= dataCapacity(version) * 8) return version;
  }
  throw new RangeError("Text is too long for this QR encoder");
}

function buildDataCodewords(bytes, version) {
  const bits = [];
  const push = (value, length) => {
    for (let bit = length - 1; bit >= 0; bit -= 1) bits.push((value >>> bit) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) push(byte, 8);
  const capacityBits = dataCapacity(version) * 8;
  push(0, Math.min(4, capacityBits - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) push(pad, 8);
  const codewords = [];
  for (let index = 0; index < bits.length; index += 8) {
    codewords.push(bits.slice(index, index + 8).reduce((value, bit) => (value << 1) | bit, 0));
  }
  return codewords;
}

function interleave(data, version) {
  const blocks = blockCount[version];
  const eccLength = eccPerBlock[version];
  const shortBlocks = blocks - (totalCodewords[version] % blocks);
  const shortLength = Math.floor(totalCodewords[version] / blocks) - eccLength;
  const divisor = reedSolomonDivisor(eccLength);
  const dataBlocks = [];
  const eccBlocks = [];
  let offset = 0;
  for (let index = 0; index < blocks; index += 1) {
    const length = shortLength + (index < shortBlocks ? 0 : 1);
    const block = data.slice(offset, offset + length);
    offset += length;
    dataBlocks.push(block);
    eccBlocks.push(reedSolomonRemainder(block, divisor));
  }
  const output = [];
  for (let column = 0; column <= shortLength; column += 1) {
    for (const block of dataBlocks) {
      if (column < block.length) output.push(block[column]);
    }
  }
  for (let column = 0; column < eccLength; column += 1) {
    for (const block of eccBlocks) output.push(block[column]);
  }
  return output;
}

function alignmentPositions(version) {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = Math.floor((version * 8 + 3 * count + 5) / (count * 4 - 4)) * 2;
  const positions = [6];
  for (let position = version * 4 + 10; positions.length < count; position -= step) {
    positions.splice(1, 0, position);
  }
  return positions;
}

function drawFunctionPatterns(version) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => {
    modules[y][x] = dark;
    reserved[y][x] = true;
  };
  for (let index = 0; index < size; index += 1) {
    set(6, index, index % 2 === 0);
    set(index, 6, index % 2 === 0);
  }
  const drawFinder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, distance !== 2 && distance !== 4);
      }
    }
  };
  drawFinder(3, 3);
  drawFinder(size - 4, 3);
  drawFinder(3, size - 4);
  const positions = alignmentPositions(version);
  for (const [i, cx] of positions.entries()) {
    for (const [j, cy] of positions.entries()) {
      const overlapsFinder = (i === 0 && j === 0)
        || (i === 0 && j === positions.length - 1)
        || (i === positions.length - 1 && j === 0);
      if (overlapsFinder) continue;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }
  if (version >= 7) {
    let remainder = version;
    for (let i = 0; i < 12; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
    const bits = (version << 12) | remainder;
    for (let i = 0; i < 18; i += 1) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }
  drawFormatBits(set, size, 0);
  return { size, modules, reserved, set };
}

function drawFormatBits(set, size, mask) {
  const data = (errorCorrectionLevelBits << 3) | mask;
  let remainder = data;
  for (let i = 0; i < 10; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  const bits = ((data << 10) | remainder) ^ 0x5412;
  const bit = (index) => ((bits >>> index) & 1) === 1;
  for (let i = 0; i <= 5; i += 1) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i += 1) set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i += 1) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i += 1) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true);
}

function drawCodewords(grid, codewords) {
  const { size, modules, reserved } = grid;
  let bitIndex = 0;
  const totalBits = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical += 1) {
      for (let offset = 0; offset < 2; offset += 1) {
        const x = right - offset;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vertical : vertical;
        if (reserved[y][x]) continue;
        if (bitIndex < totalBits) {
          modules[y][x] = ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) === 1;
          bitIndex += 1;
        }
      }
    }
  }
}

function applyMask({ size, modules, reserved }, mask) {
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (!reserved[y][x] && masks[mask](x, y)) modules[y][x] = !modules[y][x];
    }
  }
}

function lineRunPenalty(line) {
  let penalty = 0;
  let run = 0;
  let previous = null;
  for (const dark of line) {
    run = dark === previous ? run + 1 : 1;
    previous = dark;
    if (run === 5) penalty += 3;
    else if (run > 5) penalty += 1;
  }
  const pattern = line.map((dark) => (dark ? "1" : "0")).join("");
  for (const finderLike of ["10111010000", "00001011101"]) {
    penalty += (pattern.split(finderLike).length - 1) * 40;
  }
  return penalty;
}

function maskPenalty({ size, modules }) {
  let penalty = 0;
  let dark = 0;
  for (let y = 0; y < size; y += 1) {
    penalty += lineRunPenalty(modules[y]);
    penalty += lineRunPenalty(modules.map((row) => row[y]));
    for (let x = 0; x < size; x += 1) {
      if (modules[y][x]) dark += 1;
      if (x + 1 < size && y + 1 < size
        && modules[y][x] === modules[y][x + 1]
        && modules[y][x] === modules[y + 1][x]
        && modules[y][x] === modules[y + 1][x + 1]) {
        penalty += 3;
      }
    }
  }
  return penalty + Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
}

export function encodeQrMatrix(text) {
  const bytes = [...Buffer.from(String(text), "utf8")];
  const version = chooseVersion(bytes.length);
  const codewords = interleave(buildDataCodewords(bytes, version), version);
  const grid = drawFunctionPatterns(version);
  drawCodewords(grid, codewords);
  let bestMask = 0;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < masks.length; mask += 1) {
    applyMask(grid, mask);
    drawFormatBits(grid.set, grid.size, mask);
    const penalty = maskPenalty(grid);
    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestMask = mask;
    }
    applyMask(grid, mask);
  }
  applyMask(grid, bestMask);
  drawFormatBits(grid.set, grid.size, bestMask);
  return grid.modules;
}

// The white background and quiet zone are part of the image so that the code
// still scans in the dashboard's dark theme.
export function renderQrSvg(text, { quietZone = 4 } = {}) {
  const matrix = encodeQrMatrix(text);
  const size = matrix.length + quietZone * 2;
  const path = matrix.flatMap((row, y) => row.flatMap((dark, x) => (
    dark ? [`M${x + quietZone} ${y + quietZone}h1v1h-1z`] : []
  ))).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
