// Custom motor files (RASP .eng and RockSim .rse), as OpenRocket's motor database reads them.
// Only validated and summarised here; OpenRocket itself parses them in each session.
import { parse } from './xml.js';

export class MotorFileError extends Error {}

const MAX_BYTES = 512 * 1024;

/** NAR impulse class letter for a total impulse in N·s (A = 1.26–2.5 N·s, doubling per letter). */
export function impulseClass(ns) {
  if (!(ns > 0)) return '?';
  if (ns <= 0.3125) return '⅛A';
  if (ns <= 0.625) return '¼A';
  if (ns <= 1.25) return '½A';
  const n = Math.ceil(Math.log2(ns / 2.5 - 1e-9));
  return n <= 0 ? 'A' : n < 26 ? String.fromCharCode(65 + n) : '?';
}

function parseEng(text) {
  const motors = [];
  let cur = null;
  const finish = () => {
    if (!cur) return;
    if (cur.points.length < 2) throw new MotorFileError(`Motor ${cur.designation} has no thrust curve.`);
    let impulse = 0;
    for (let i = 1; i < cur.points.length; i++) {
      const [t0, f0] = cur.points[i - 1];
      const [t1, f1] = cur.points[i];
      if (t1 < t0) throw new MotorFileError(`Motor ${cur.designation}: thrust curve times must increase.`);
      impulse += ((f0 + f1) / 2) * (t1 - t0);
    }
    // RASP curves start at t=0 implicitly
    impulse += (cur.points[0][1] / 2) * cur.points[0][0];
    motors.push({
      designation: cur.designation,
      manufacturer: cur.manufacturer,
      diameterMm: cur.diameterMm,
      lengthMm: cur.lengthMm,
      impulseNs: impulse,
      burnTimeS: cur.points[cur.points.length - 1][0],
    });
    cur = null;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/;.*/, '').trim();
    if (!line) continue;
    const tok = line.split(/\s+/);
    const first = Number(tok[0]);
    if (cur && tok.length >= 2 && Number.isFinite(first) && Number.isFinite(Number(tok[1]))) {
      cur.points.push([first, Number(tok[1])]);
      continue;
    }
    finish();
    if (tok.length < 7) {
      throw new MotorFileError(`Not a valid .eng header: "${raw.trim().slice(0, 60)}". Expected: name diameter length delays propellant-mass total-mass manufacturer`);
    }
    const [designation, dia, len, , prop, total] = tok;
    const nums = [dia, len, prop, total].map(Number);
    if (nums.some((n) => !Number.isFinite(n) || n < 0)) {
      throw new MotorFileError(`Motor ${designation}: diameter, length and masses must be numbers.`);
    }
    cur = { designation, manufacturer: tok.slice(6).join(' '), diameterMm: nums[0], lengthMm: nums[1], points: [] };
  }
  finish();
  return motors;
}

function parseRse(text) {
  let root;
  try {
    root = parse(text);
  } catch (e) {
    throw new MotorFileError(`Not a valid .rse file (${e.message}).`);
  }
  const motors = [];
  const walk = (el) => {
    if (el.tag === 'engine') {
      const a = el.attrs;
      motors.push({
        designation: a.get('code') ?? '?',
        manufacturer: a.get('mfg') ?? '',
        diameterMm: Number(a.get('dia')) || 0,
        lengthMm: Number(a.get('len')) || 0,
        impulseNs: Number(a.get('Itot')) || 0,
        burnTimeS: Number(a.get('burn-time')) || 0,
      });
    }
    for (const c of el.elements()) walk(c);
  };
  walk(root);
  return motors;
}

/** Validates an uploaded motor file; returns the motors it defines. */
export function readMotorFile(filename, buf) {
  const ext = /\.(eng|rse)$/i.exec(filename)?.[1]?.toLowerCase();
  if (!ext) throw new MotorFileError('Motor files must end in .eng or .rse.');
  if (!buf.length) throw new MotorFileError('The file is empty.');
  if (buf.length > MAX_BYTES) throw new MotorFileError('Motor files can be at most 512 KB.');
  const text = buf.toString('utf8');
  const motors = ext === 'eng' ? parseEng(text) : parseRse(text);
  if (!motors.length) throw new MotorFileError('No motors found in the file.');
  return { ext, text, motors: motors.map((m) => ({ ...m, impulseClass: impulseClass(m.impulseNs) })) };
}

/** File name used inside OpenRocket's motor folder (unique, safe, keeps the extension). */
export const sessionFileName = (motor) =>
  `${motor.id.slice(0, 8)}-${motor.filename.replace(/[^A-Za-z0-9._-]/g, '_')}`;
