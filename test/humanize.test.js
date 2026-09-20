import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPath, sampleDuration } from '../src/checkin/humanize.js';

test('sampleDuration 始终落在请求区间内', () => {
  for (let i = 0; i < 500; i += 1) {
    const value = sampleDuration(100, 500);
    assert.ok(value >= 100 && value <= 500, `unexpected duration ${value}`);
  }
  assert.equal(sampleDuration(0, 0), 0);
});

test('buildPath 生成起终点近似正确的平滑轨迹', () => {
  const from = { x: 100, y: 100 };
  const to = { x: 900, y: 600 };
  const points = buildPath(from, to);
  assert.ok(points.length >= 12 && points.length <= 60);
  assert.ok(Math.abs(points.at(-1).x - to.x) < 5);
  assert.ok(Math.abs(points.at(-1).y - to.y) < 5);
});
