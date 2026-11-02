import assert from "node:assert/strict";
import test from "node:test";
import { encodeQrMatrix, renderQrSvg } from "../src/qr-code.js";

function readFormatMask(matrix) {
  let bits = 0;
  for (let i = 0; i <= 5; i += 1) if (matrix[i][8]) bits |= 1 << i;
  if (matrix[7][8]) bits |= 1 << 6;
  if (matrix[8][8]) bits |= 1 << 7;
  if (matrix[8][7]) bits |= 1 << 8;
  for (let i = 9; i < 15; i += 1) if (matrix[8][14 - i]) bits |= 1 << i;
  return bits ^ 0x5412;
}

test("the matrix size follows the text length", () => {
  assert.equal(encodeQrMatrix("a").length, 21);
  assert.equal(encodeQrMatrix("x".repeat(100)).length, 4 * 6 + 17);
  assert.equal(encodeQrMatrix("x".repeat(213)).length, 4 * 10 + 17);
  assert.throws(() => encodeQrMatrix("x".repeat(214)), RangeError);
});

test("finder patterns, timing and level M format bits are in place", () => {
  for (const text of ["https://txz.qq.com/p?k=abc&f=1600001615", "中文也能编码", "x".repeat(150)]) {
    const matrix = encodeQrMatrix(text);
    const size = matrix.length;
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
      for (let d = -3; d <= 3; d += 1) {
        assert.equal(matrix[cy - 3][cx + d], true);
        assert.equal(matrix[cy + d][cx - 3], true);
        assert.equal(matrix[cy][cx + d], Math.abs(d) !== 2);
      }
    }
    for (let i = 8; i < size - 8; i += 1) {
      assert.equal(matrix[6][i], i % 2 === 0);
      assert.equal(matrix[i][6], i % 2 === 0);
    }
    assert.equal(matrix[size - 8][8], true, "dark module");
    assert.equal(readFormatMask(matrix) >>> 13, 0, "error correction level M");
  }
});

test("the SVG keeps a white background and a quiet zone in any theme", () => {
  const svg = renderQrSvg("https://example.com");
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 33 33"/);
  assert.match(svg, /<rect width="33" height="33" fill="#fff"\/>/);
  assert.match(svg, /M4 4h1v1h-1z/);
});
