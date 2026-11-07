import { expect, test } from 'bun:test';
import { PDF_LIMITS, pageGeometry } from './pdf-limits';

test('a fitted page and zoom retain aspect ratio within the canvas pixel bound', () => {
  const fit = pageGeometry(600, 900, 300, 1, 2);
  expect(fit.width).toBe(300);
  expect(fit.height).toBe(450);
  expect(fit.pixelsWide).toBe(600);
  expect(fit.pixelsHigh).toBe(900);
  const zoom = pageGeometry(600, 900, 900, 2, 4);
  expect(zoom.width).toBe(1800);
  expect(zoom.pixelsWide * zoom.pixelsHigh).toBeLessThanOrEqual(PDF_LIMITS.canvasPixels);
  expect(zoom.pixelsWide).toBeGreaterThan(zoom.width);
  expect(pageGeometry(600, 900, 300, 1, 8).ratio).toBe(2);
  const thin = pageGeometry(1, 100, 100, 1, 1);
  expect(thin.pixelsHigh).toBe(PDF_LIMITS.canvasSide);
});

test('invalid, extreme and nonfinite page dimensions are refused before canvas allocation', () => {
  for (const [width, height] of [
    [0, 100],
    [100, -1],
    [Number.NaN, 100],
    [100, Number.POSITIVE_INFINITY],
    [1, 1e9],
  ] as const) {
    expect(() => pageGeometry(width, height, 320, 1, 1)).toThrow();
  }
  for (const scale of [0, -1, PDF_LIMITS.zoomMax + 1, Number.NaN]) {
    expect(() => pageGeometry(600, 900, 320, scale, 1)).toThrow();
  }
  for (const available of [0, -1, Number.NaN]) {
    expect(() => pageGeometry(600, 900, available, 1, 1)).toThrow();
  }
  for (const ratio of [0, -1, Number.POSITIVE_INFINITY]) {
    expect(() => pageGeometry(600, 900, 320, 1, ratio)).toThrow();
  }
});
