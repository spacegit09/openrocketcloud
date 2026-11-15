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

// The files are checked as OpenRocket 24.12 reads them (RASPMotorLoader and RockSimMotorLoader, then
// ThrustCurveMotor.Builder.build), so a file accepted here loads in OpenRocket: one it cannot read
// shows a warning while OpenRocket starts and its motors are missing. worker/bridge/test/motors holds
// edge cases that orcloud.bridge.MotorFileCheck runs through OpenRocket itself; motors.test.js
// checks that this file agrees with it on every one.

// Java's \s, which OpenRocket splits lines on (not the wider whitespace of JavaScript's \s).
const JAVA_SPACE = /[ \t\n\x0B\f\r]+/;
// What Java's Double.parseDouble reads (decimal forms).
const JAVA_DOUBLE = /^[+-]?(NaN|Infinity|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?[fFdD]?)$/;
const MAX_THRUST = 10e6; // N, ThrustCurveMotor.MAX_THRUST

/** String.split("\\s+") as OpenRocket uses it: no empty first or trailing pieces. */
function split(line) {
  const pieces = line.split(JAVA_SPACE);
  while (pieces.length && pieces[pieces.length - 1] === '') pieces.pop();
  if (pieces.length && pieces[0] === '') pieces.shift();
  return pieces;
}

function javaNumber(token, what, where) {
  const v = JAVA_DOUBLE.test(token ?? '') ? Number(token.replace(/[fFdD]$/, '')) : NaN;
  if (!Number.isFinite(v)) throw new MotorFileError(`${where}: ${what} "${token ?? ''}" is not a number.`);
  return v;
}

/** MathUtil.equals: equal within OpenRocket's relative tolerance. */
function same(a, b, eps = 1e-8) {
  const absb = Math.abs(b);
  return absb < eps / 2 ? Math.abs(a) < eps / 2 : Math.abs(a - b) < eps * absb;
}

/** AbstractMotorLoader.sortLists: a stable sort by time, moving the other lists along. */
function sortByTime(time, ...lists) {
  const order = time.map((t, i) => i).sort((a, b) => time[a] - time[b] || a - b);
  for (const list of [time, ...lists]) {
    const copy = order.map((i) => list[i]);
    list.splice(0, list.length, ...copy);
  }
}

/** AbstractMotorLoader.finalizeThrustCurve: a point at t = 0, duplicates out. */
function finalizeCurve(time, thrust) {
  if (!time.length) return;
  if (!same(time[0], 0)) {
    time.unshift(0);
    thrust.unshift(0);
  }
  if (time.length > 1 && same(time[0], 0) && same(time[1], 0)) {
    time.shift();
    thrust.shift();
  }
  for (let i = 0; i < time.length - 1; i++) {
    while (i < time.length - 1 && same(time[i], time[i + 1]) && same(thrust[i], thrust[i + 1])) {
      time.splice(i, 1);
      thrust.splice(i, 1);
    }
  }
  const n = time.length - 1;
  if (n >= 1 && same(time[n - 1], time[n])) {
    if (same(thrust[n - 1], 0)) {
      time.splice(n - 1, 1);
      thrust.splice(n - 1, 1);
    } else if (same(thrust[n], 0)) {
      time.splice(n, 1);
      thrust.splice(n, 1);
    }
  }
}

/** The curve as OpenRocket keeps it, checked as ThrustCurveMotor.Builder.build does; its impulse. */
function checkedCurve(designation, time, thrust) {
  sortByTime(time, thrust);
  finalizeCurve(time, thrust);
  const name = `Motor ${designation}`;
  if (time.length < 2) throw new MotorFileError(`${name} has no thrust curve (it needs at least 2 points).`);
  for (let i = 0; i < time.length - 1; i++) {
    if (time[i + 1] <= time[i]) {
      throw new MotorFileError(`${name}: two different thrust values at ${time[i + 1]} s; OpenRocket needs one thrust value per time.`);
    }
  }
  for (const f of thrust) {
    if (f < 0) throw new MotorFileError(`${name}: negative thrust (${f} N).`);
    if (f > MAX_THRUST) throw new MotorFileError(`${name}: thrust ${f} N is more than OpenRocket allows (10 MN).`);
  }
  let impulse = 0;
  for (let i = 1; i < time.length; i++) impulse += ((thrust[i - 1] + thrust[i]) / 2) * (time[i] - time[i - 1]);
  if (!(impulse > 0)) throw new MotorFileError(`${name}: the thrust curve has no impulse (every thrust value is 0).`);
  return impulse;
}

/**
 * Formatting OpenRocket's reader trips on but that changes no motor, tidied as the session does
 * before OpenRocket reads the file (orcloud.bridge.OrDoc.tidyMotorFile): a byte order mark, lines of
 * only spaces, spaces before a comment's ";", and comments after the values on a line. Uploads are
 * kept tidied.
 */
export function tidyMotorText(ext, text) {
  const t = text.replace(/^﻿/, '');
  if (ext !== 'eng') return t;
  return t.split(/\r\n|\r|\n/).map((line) => {
    if (/^[ \t\x0B\f]*$/.test(line)) return '';
    const lead = line.replace(/^[ \t\x0B\f]+/, '');
    if (lead.startsWith(';')) return lead;
    const at = line.indexOf(';');
    return at < 0 ? line : line.slice(0, at).replace(/[ \t\x0B\f]+$/, '');
  }).join('\n');
}

/** RASPMotorLoader, line for line. */
function parseEng(text) {
  const lines = text.split(/\r\n|\r|\n/);
  const motors = [];
  let i = 0;
  for (;;) {
    while (i < lines.length && (lines[i] === '' || lines[i][0] === ';')) i++; // comments
    if (i >= lines.length) break;
    const where = `Line ${i + 1}`;
    const head = split(lines[i]);
    if (head.length !== 7) {
      throw new MotorFileError(`${where}: a motor's first line needs exactly 7 values (name, diameter in mm, length in mm, delays, `
        + `propellant mass in kg, total mass in kg, manufacturer as one word); it has ${head.length}: "${lines[i].trim().slice(0, 60)}".`);
    }
    const [designation, diaS, lenS, , propS, totalS, manufacturer] = head;
    const dia = javaNumber(diaS, 'the diameter', where);
    const len = javaNumber(lenS, 'the length', where);
    const prop = javaNumber(propS, 'the propellant mass', where);
    const total = javaNumber(totalS, 'the total mass', where);
    if (!(dia > 0) || !(len > 0)) throw new MotorFileError(`${where}: the diameter and length must be more than 0.`);
    if (prop < 0 || !(total > 0)) throw new MotorFileError(`${where}: the masses must be more than 0.`);
    if (prop > total) throw new MotorFileError(`${where}: the propellant mass (${prop} kg) is more than the total mass (${total} kg).`);
    i++;
    const time = [];
    const thrust = [];
    for (; i < lines.length && (lines[i] === '' || lines[i][0] !== ';'); i++) {
      const point = split(lines[i]);
      if (!point.length) continue;
      if (point.length !== 2) {
        throw new MotorFileError(`Line ${i + 1}: a thrust curve line needs exactly 2 values, time (s) and thrust (N); it has ${point.length}: "${lines[i].trim().slice(0, 60)}".`);
      }
      time.push(javaNumber(point[0], 'the time', `Line ${i + 1}`));
      thrust.push(javaNumber(point[1], 'the thrust', `Line ${i + 1}`));
    }
    // RASPMotorLoader counts the points as written, before adding one at t = 0 (an .rse file can have one).
    if (time.length < 2) throw new MotorFileError(`Motor ${designation}: the thrust curve needs at least 2 lines of time and thrust; it has ${time.length}.`);
    const impulse = checkedCurve(designation, time, thrust);
    motors.push({ designation, manufacturer, diameterMm: dia, lengthMm: len, impulseNs: impulse, burnTimeS: time[time.length - 1] });
  }
  return motors;
}

/** RockSimMotorLoader: an engine's required attributes and its one data list. */
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
      const code = a.get('code');
      const where = `Motor ${code ?? '(no code)'}`;
      for (const [attr, what] of [['mfg', 'manufacturer (mfg)'], ['code', 'name (code)'], ['dia', 'diameter (dia)'], ['len', 'length (len)'],
        ['initWt', 'total mass (initWt)'], ['propWt', 'propellant mass (propWt)']]) {
        if (a.get(attr) == null) throw new MotorFileError(`${where}: the ${what} is missing.`);
      }
      const dia = javaNumber(a.get('dia'), 'the diameter', where);
      const len = javaNumber(a.get('len'), 'the length', where);
      const total = javaNumber(a.get('initWt'), 'the total mass', where);
      const prop = javaNumber(a.get('propWt'), 'the propellant mass', where);
      if (prop > total) throw new MotorFileError(`${where}: the propellant mass (${prop} g) is more than the total mass (${total} g).`);
      const data = el.elements().filter((c) => c.tag === 'data');
      if (data.length !== 1) throw new MotorFileError(`${where}: needs one <data> list of thrust points; it has ${data.length}.`);
      const time = [];
      const thrust = [];
      for (const p of data[0].elements().filter((c) => c.tag === 'eng-data')) {
        time.push(javaNumber(p.attrs.get('t'), 'a time (t)', where));
        thrust.push(javaNumber(p.attrs.get('f'), 'a thrust (f)', where));
      }
      const impulse = checkedCurve(code, time, thrust);
      motors.push({ designation: code, manufacturer: a.get('mfg'), diameterMm: dia, lengthMm: len, impulseNs: impulse, burnTimeS: time[time.length - 1] });
    }
    for (const c of el.elements()) walk(c);
  };
  walk(root);
  return motors;
}

/**
 * Validates an uploaded motor file as OpenRocket will read it; returns its text, tidied
 * (tidyMotorText), and the motors it defines.
 */
export function readMotorFile(filename, buf) {
  const ext = /\.(eng|rse)$/i.exec(filename)?.[1]?.toLowerCase();
  if (!ext) throw new MotorFileError('Motor files must end in .eng or .rse.');
  if (!buf.length) throw new MotorFileError('The file is empty.');
  if (buf.length > MAX_BYTES) throw new MotorFileError('Motor files can be at most 512 KB.');
  const text = tidyMotorText(ext, buf.toString('utf8'));
  const motors = ext === 'eng' ? parseEng(text) : parseRse(text);
  if (!motors.length) throw new MotorFileError('No motors found in the file.');
  return { ext, text, motors: motors.map((m) => ({ ...m, impulseClass: impulseClass(m.impulseNs) })) };
}

/** File name used inside OpenRocket's motor folder (unique, safe, keeps the extension). */
export const sessionFileName = (motor) =>
  `${motor.id.slice(0, 8)}-${motor.filename.replace(/[^A-Za-z0-9._-]/g, '_')}`;
