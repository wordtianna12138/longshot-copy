import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outputSize, nextOffset, placement } from '../longshot-copy/geometry.js';

test('普通图片保留高清像素', () => {
  assert.deepEqual(outputSize(1200, 4000, 2), { width: 2400, height: 8000, scale: 2, reduced: false });
});
test('超长图片等比缩小，保留整页高度', () => {
  const s = outputSize(1440, 80000, 2);
  assert.ok(s.reduced); assert.ok(s.height <= 32760);
  assert.ok(s.width * s.height <= 40_000_000);
  assert.ok(Math.abs(s.width / s.height - 1440 / 80000) < 0.001);
});
test('拒绝无效尺寸', () => {
  for (const n of [0, -1, Infinity, NaN]) assert.throws(() => outputSize(1200, n));
});
test('各种页面高度均覆盖最后一行且没有空隙', () => {
  for (const view of [263, 600, 719.5, 1080]) for (const total of [300, 601, 720, 1441, 5079, 10000]) {
    let current = 0, covered = view, steps = 0;
    while (true) {
      const next = nextOffset(current, view, total);
      if (next === null) break;
      assert.ok(next > current); assert.ok(next <= covered);
      current = next; covered = current + view;
      assert.ok(++steps < 200);
    }
    assert.ok(covered >= total); assert.equal(current, Math.max(0, total - view));
  }
});
test('拼接坐标共享边界，避免缩放后的像素裂缝', () => {
  const a = placement({ x: 0, y: 0, width: 301, height: 719.5 }, 0.873);
  const b = placement({ x: 0, y: 719.5, width: 301, height: 200 }, 0.873);
  assert.equal(a.y + a.height, b.y);
});
