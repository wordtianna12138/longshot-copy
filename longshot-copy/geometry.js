// All placements use CSS pixels. Rounding happens only at the output canvas.
export function outputSize(width, height, deviceScale = 1) {
  if (![width, height, deviceScale].every(n => Number.isFinite(n) && n > 0)) {
    throw new Error('页面尺寸无效。');
  }
  const scale = Math.min(deviceScale, 32760 / width, 32760 / height,
    Math.sqrt(40_000_000 / (width * height)));
  return { width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)), scale,
    reduced: scale < deviceScale - 0.001 };
}

export function nextOffset(current, visible, total) {
  const end = Math.max(0, total - visible);
  if (current >= end - 0.001) return null;
  // The overlap protects seams when a browser rounds scroll offsets.
  return Math.min(end, current + Math.max(1, visible - Math.min(64, visible * 0.1)));
}

export function placement(tile, scale) {
  const x = Math.round(tile.x * scale), y = Math.round(tile.y * scale);
  return { x, y, width: Math.round((tile.x + tile.width) * scale) - x,
    height: Math.round((tile.y + tile.height) * scale) - y };
}
