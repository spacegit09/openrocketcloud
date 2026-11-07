// Ground heights for the launch planner, from the Terrain Tiles on AWS Open Data (elevation in
// "terrarium" PNG tiles; free for any use with attribution; sources include SRTM, GMTED2010,
// ETOPO1 and national elevation models). Used for the launch site's height above sea level and for
// where flights meet the ground.

const TILE_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
export const TERRAIN_CREDIT = 'Terrain: Terrain Tiles (AWS Open Data; SRTM, GMTED2010, ETOPO1 and others)';
const R = 6371000;
const tiles = new Map();

function tileXY(lat, lon, z) {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const rad = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
  return [x, y];
}

async function tile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (!tiles.has(key)) {
    tiles.set(key, (async () => {
      const res = await fetch(TILE_URL(z, x, y));
      if (!res.ok) throw new Error('Could not load terrain heights.');
      const bitmap = await createImageBitmap(await res.blob());
      const canvas = new OffscreenCanvas(256, 256);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0);
      const px = ctx.getImageData(0, 0, 256, 256).data;
      const h = new Float32Array(256 * 256);
      for (let k = 0; k < h.length; k++) h[k] = px[k * 4] * 256 + px[k * 4 + 1] + px[k * 4 + 2] / 256 - 32768;
      return h;
    })());
  }
  return tiles.get(key);
}

async function heightAt(lat, lon, z) {
  const [fx, fy] = tileXY(lat, lon, z);
  const n = 2 ** z;
  const px = fx * 256 - 0.5;
  const py = fy * 256 - 0.5;
  const sample = async (gx, gy) => {
    const tx = ((Math.floor(gx / 256) % n) + n) % n;
    const ty = Math.min(n - 1, Math.max(0, Math.floor(gy / 256)));
    const h = await tile(z, tx, ty);
    const ix = ((gx % 256) + 256) % 256;
    const iy = Math.min(255, Math.max(0, gy - ty * 256));
    return h[iy * 256 + ix];
  };
  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const ax = px - x0;
  const ay = py - y0;
  const [a, b, c, d] = await Promise.all([sample(x0, y0), sample(x0 + 1, y0), sample(x0, y0 + 1), sample(x0 + 1, y0 + 1)]);
  return (a * (1 - ax) + b * ax) * (1 - ay) + (c * (1 - ax) + d * ax) * ay;
}

/** Latitude and longitude (degrees) of a point east and north (m) of a site. */
export function offset(lat, lon, east, north) {
  return [lat + ((north / R) * 180) / Math.PI, lon + ((east / (R * Math.cos((lat * Math.PI) / 180))) * 180) / Math.PI];
}

/** The ground's height above sea level at a place (m). */
export async function elevation(lat, lon) {
  return heightAt(lat, lon, 13);
}

/**
 * Ground heights around a site, relative to it, for the engine: { x0, y0, dx, nx, ny, heights }
 * covering `radius` m in every direction (see groundFunction in montecarlo.js), and `site`, the
 * site's own height above sea level.
 */
export async function groundGrid(lat, lon, radius, size = 96) {
  const circumference = 2 * Math.PI * R * Math.cos((lat * Math.PI) / 180);
  // About two grid cells per tile pixel, from zoom 8 (600 m pixels) to 13 (19 m pixels).
  const z = Math.max(8, Math.min(13, Math.round(Math.log2(circumference / 256 / ((2 * radius) / size / 2)))));
  const site = await heightAt(lat, lon, z);
  const dx = (2 * radius) / (size - 1);
  const heights = new Float32Array(size * size);
  const jobs = [];
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const [la, lo] = offset(lat, lon, -radius + i * dx, -radius + j * dx);
      jobs.push(heightAt(la, lo, z).then((h) => (heights[j * size + i] = h - site)));
    }
  }
  await Promise.all(jobs);
  return { x0: -radius, y0: -radius, dx, nx: size, ny: size, heights, site };
}
