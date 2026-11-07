// A small GRIB2 reader for NOAA GFS subsets from NOMADS's grib filter: latitude/longitude grids
// (template 3.0), analysis or forecast products (4.0 and 4.1, as in the ensemble), simple packing
// (5.0, which the filter writes), no bitmap. Plain JavaScript so the backend function (Deno) and
// the tests (Node) share it.

const PARAMS = { '0:0:0': 'TMP', '0:2:2': 'UGRD', '0:2:3': 'VGRD', '0:3:0': 'PRES', '0:3:5': 'HGT' };
const LEVELS = { 1: 'surface', 100: 'isobaric', 103: 'aboveGround' };

/** A sign-and-magnitude integer, as GRIB2 writes signed numbers. */
function signed(v, bits) {
  const sign = 2 ** (bits - 1);
  return v >= sign ? -(v - sign) : v;
}

/**
 * The fields in a GRIB2 file: { param ('UGRD', 'VGRD', 'HGT', 'TMP', 'PRES' or 'd:c:n'), level
 * ('surface', 'isobaric' in Pa, 'aboveGround' in m, or the level type number), value, ref (the
 * reference time, a Date), hours (forecast hours after it), grid: { ni, nj, lat1, lon1, di, dj }
 * (latitude decreasing or increasing from lat1 by dj per row, longitude from lon1 by di per
 * column, in degrees), values: Float64Array (row by row) }.
 */
export function readGrib2(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const u32 = (o) => dv.getUint32(o);
  const fields = [];
  let i = 0;
  while (i + 16 <= b.length) {
    if (b[i] !== 0x47 || b[i + 1] !== 0x52 || b[i + 2] !== 0x49 || b[i + 3] !== 0x42) throw new Error('Not a GRIB2 file.');
    if (b[i + 7] !== 2) throw new Error(`GRIB edition ${b[i + 7]} is not supported.`);
    const discipline = b[i + 6];
    const total = Number(dv.getBigUint64(i + 8));
    const end = i + total;
    let ref = null;
    let grid = null;
    let product = null;
    let packing = null;
    let j = i + 16;
    while (j < end - 4) {
      const len = u32(j);
      const sec = b[j + 4];
      if (sec === 1) {
        ref = new Date(Date.UTC(dv.getUint16(j + 12), b[j + 14] - 1, b[j + 15], b[j + 16], b[j + 17], b[j + 18]));
      } else if (sec === 3) {
        const tpl = dv.getUint16(j + 12);
        if (tpl !== 0) throw new Error(`Grid template 3.${tpl} is not supported.`);
        const scan = b[j + 71];
        let lon1 = signed(u32(j + 50), 32) / 1e6;
        if (lon1 > 180) lon1 -= 360;
        const lat1 = signed(u32(j + 46), 32) / 1e6;
        const di = u32(j + 63) / 1e6;
        const dj = u32(j + 67) / 1e6;
        grid = {
          ni: u32(j + 30), nj: u32(j + 34), lat1, lon1,
          di: scan & 0x80 ? -di : di,
          dj: scan & 0x40 ? dj : -dj, // GFS scans north to south
        };
      } else if (sec === 4) {
        const tpl = dv.getUint16(j + 7);
        if (tpl !== 0 && tpl !== 1) throw new Error(`Product template 4.${tpl} is not supported.`);
        const unit = b[j + 17];
        const time = u32(j + 18);
        const scale = signed(b[j + 23], 8);
        product = {
          param: PARAMS[`${discipline}:${b[j + 9]}:${b[j + 10]}`] ?? `${discipline}:${b[j + 9]}:${b[j + 10]}`,
          level: LEVELS[b[j + 22]] ?? b[j + 22],
          value: u32(j + 24) / 10 ** scale,
          hours: unit === 1 ? time : unit === 0 ? time / 60 : unit === 2 ? time * 24 : NaN,
          member: tpl === 1 ? b[j + 35] : null,
        };
      } else if (sec === 5) {
        const tpl = dv.getUint16(j + 9);
        if (tpl !== 0) throw new Error(`Data template 5.${tpl} is not supported.`);
        packing = {
          count: u32(j + 5),
          r: dv.getFloat32(j + 11),
          e: signed(dv.getUint16(j + 15), 16),
          d: signed(dv.getUint16(j + 17), 16),
          bits: b[j + 19],
        };
      } else if (sec === 6) {
        if (b[j + 5] !== 255) throw new Error('GRIB2 bitmaps are not supported.');
      } else if (sec === 7) {
        if (!grid || !product || !packing) throw new Error('Incomplete GRIB2 message.');
        fields.push({ ...product, ref, grid, values: unpack(b, j + 5, packing) });
      }
      j += len;
    }
    i = end;
  }
  return fields;
}

function unpack(b, start, { count, r, e, d, bits }) {
  const out = new Float64Array(count);
  const scale = 2 ** e;
  const dec = 10 ** -d;
  if (bits === 0) return out.fill(r * dec);
  let pos = start * 8;
  for (let k = 0; k < count; k++) {
    let x = 0;
    for (let n = 0; n < bits; n++, pos++) x = x * 2 + ((b[pos >> 3] >> (7 - (pos & 7))) & 1);
    out[k] = (r + x * scale) * dec;
  }
  return out;
}

/** A field's value at a point, interpolated between the four grid points around it. */
export function valueAt(field, lat, lon) {
  const { ni, nj, lat1, lon1, di, dj } = field.grid;
  let x = (lon - lon1) / di;
  if (x < -1e-9) x = (lon + 360 - lon1) / di;
  const y = (lat - lat1) / dj;
  if (x < -1e-9 || y < -1e-9 || x > ni - 1 + 1e-9 || y > nj - 1 + 1e-9) throw new Error('The point is outside the downloaded area.');
  const i0 = Math.min(Math.floor(x), ni - 2 < 0 ? 0 : ni - 2);
  const j0 = Math.min(Math.floor(y), nj - 2 < 0 ? 0 : nj - 2);
  const i1 = Math.min(i0 + 1, ni - 1);
  const j1 = Math.min(j0 + 1, nj - 1);
  const fx = Math.min(1, Math.max(0, x - i0));
  const fy = Math.min(1, Math.max(0, y - j0));
  const v = (ii, jj) => field.values[jj * ni + ii];
  return (v(i0, j0) * (1 - fx) + v(i1, j0) * fx) * (1 - fy) + (v(i0, j1) * (1 - fx) + v(i1, j1) * fx) * fy;
}

/**
 * The wind and air at a launch site from GFS fields: { ground: the model's ground height (m above
 * sea level, or `ground` when the file has none), levels: [{ agl (m above the model's ground), u, v (m/s, towards east and north), t
 * (K, or null), p (Pa, or null) }] from the ground up }. Pressure levels below the highest level
 * given above ground (the model fills them in under the terrain) are left out.
 */
export function profileAt(fields, lat, lon, { ground: knownGround = null } = {}) {
  const at = (param, level, value) => {
    const f = fields.find((x) => x.param === param && x.level === level && (value === undefined || x.value === value));
    return f ? valueAt(f, lat, lon) : null;
  };
  // Ensemble files leave out the model's ground height: the caller gives one (GFS's).
  const ground = at('HGT', 'surface') ?? knownGround;
  if (ground === null) throw new Error('The forecast has no ground height.');
  const levels = [];
  for (const f of fields) {
    if (f.param !== 'UGRD') continue;
    if (f.level === 'aboveGround') {
      levels.push({ agl: f.value, u: valueAt(f, lat, lon), v: at('VGRD', 'aboveGround', f.value), t: at('TMP', 'aboveGround', f.value), p: null });
    } else if (f.level === 'isobaric') {
      const h = at('HGT', 'isobaric', f.value);
      if (h !== null) levels.push({ agl: h - ground, u: valueAt(f, lat, lon), v: at('VGRD', 'isobaric', f.value), t: at('TMP', 'isobaric', f.value), p: f.value });
    }
  }
  const topAgl = Math.max(0, ...levels.filter((l) => l.p === null).map((l) => l.agl));
  return {
    ground,
    levels: levels.filter((l) => l.v !== null && (l.p === null || l.agl > topAgl)).sort((a, b) => a.agl - b.agl),
  };
}
