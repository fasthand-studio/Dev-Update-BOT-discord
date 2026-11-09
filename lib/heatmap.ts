import { PNG } from "pngjs";

type DayCount = { date: string; count: number }; // YYYY-MM-DD UTC

const LEVELS: [number, number, number][] = [
  [235, 237, 240], // 0
  [155, 233, 168], // 1
  [64, 196, 99],   // 2
  [48, 161, 78],   // 3
  [33, 110, 57],   // 4
];

function level(count: number, max: number): number {
  if (count <= 0 || max <= 0) return 0;
  const r = count / max;
  if (r <= 0.25) return 1;
  if (r <= 0.5) return 2;
  if (r <= 0.75) return 3;
  return 4;
}

function setPixel(png: PNG, x: number, y: number, rgb: [number, number, number], a = 255) {
  if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
  const idx = (png.width * y + x) << 2;
  png.data[idx] = rgb[0];
  png.data[idx + 1] = rgb[1];
  png.data[idx + 2] = rgb[2];
  png.data[idx + 3] = a;
}

function fillRect(png: PNG, x: number, y: number, w: number, h: number, rgb: [number, number, number]) {
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) setPixel(png, xx, yy, rgb);
}

// Minimal 3x5 font for digits/letters used in labels (very small set). To keep deps zero, render a simple legend without text or with basic pixels.
// We'll draw cells + a legend bar; Discord users can interpret. Avoid complex text rendering.
export function renderContributionHeatmap(days: DayCount[], weeks = 26): Buffer {
  const byDate = new Map(days.map((d) => [d.date, d.count]));
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  // End on last Saturday to align columns like GitHub (Sun-Sat rows).
  const end = new Date(today);
  end.setUTCDate(end.getUTCDate() + (6 - end.getUTCDay()));
  const totalDays = weeks * 7;
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (totalDays - 1));

  const counts: number[] = [];
  const cursor = new Date(start);
  for (let i = 0; i < totalDays; i++) {
    const key = cursor.toISOString().slice(0, 10);
    counts.push(byDate.get(key) ?? 0);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  const max = Math.max(0, ...counts);

  const cell = 11;
  const gap = 2;
  const pad = 12;
  const legendH = 24;
  const width = pad * 2 + weeks * (cell + gap) - gap;
  const height = pad + 7 * (cell + gap) - gap + legendH + pad;
  const png = new PNG({ width, height });
  fillRect(png, 0, 0, width, height, [255, 255, 255]);

  for (let w = 0; w < weeks; w++) {
    for (let d = 0; d < 7; d++) {
      const idx = w * 7 + d;
      const c = counts[idx] ?? 0;
      const rgb = LEVELS[level(c, max)];
      const x = pad + w * (cell + gap);
      const y = pad + d * (cell + gap);
      fillRect(png, x, y, cell, cell, rgb);
    }
  }

  // Legend
  const ly = height - pad - 10;
  let lx = pad;
  for (const rgb of LEVELS) {
    fillRect(png, lx, ly, 10, 10, rgb);
    lx += 12;
  }
  return PNG.sync.write(png);
}
