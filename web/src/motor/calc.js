// The motor designer's calculator: JSRM 3.3, the Java version of Richard Nakka's SRM spreadsheet
// that METEOR runs, in this page through CheerpJ (orcloud.bridge.MotorMain and MotorLab, in
// worker/bridge/web), the way the launch planner runs OpenRocket. It starts once, then answers.
import { prepareJava } from '../java.js';
import { MOTOR_CLASSPATH } from '../lib/jars.js';
import { motorRequest } from './natives.js';

let running = null;

/** Starts the calculator once (CheerpJ, then MotorMain); later calls share it. */
export function startCalculator() {
  running ??= (async () => {
    // The motor designer needs none of OpenRocket's start-up files.
    await prepareJava('motor', { preload: null });
    // A display for Java's graphics classes, which JSRM's grain shapes use (java.awt.geom); the
    // launch planner found CheerpJ more dependable with one, even when Java shows nothing.
    const display = document.createElement('div');
    display.style.cssText = 'position:fixed;left:-10px;top:-10px;width:1px;height:1px;overflow:hidden';
    document.body.append(display);
    window.cheerpjCreateDisplay(1, 1, display);
    window.cheerpjRunMain('orcloud.bridge.MotorMain', MOTOR_CLASSPATH); // runs until the page closes
  })();
  return running;
}

/** JSRM's messages about designs that cannot work, in the site's words. */
const MESSAGES = [
  [/Throat diameter should be <= than grain core diameter/, 'The nozzle throat is wider than the grain’s core. Make the core wider, or the throat narrower.'],
  [/Combu?tion chamber diameter should be >= than (grain outer|tube outer) diameter/, 'The grain is wider than the chamber. Make the chamber wider or the grain narrower.'],
  [/Combustion chamber length should be >= than Grain total length/, 'The grain is longer than the chamber. Make the chamber longer, or the grain shorter.'],
  [/Grain outer diameter should be > than grain core diameter|Core diameter should be < than outer diameter|Inner diameter should be < than outer diameter/, 'The core must be narrower than the grain.'],
  [/at least core surface or outer surface exposed/, 'Leave the core or the outer surface exposed: with both inhibited, the grain can only burn from its ends, which this shape does not model.'],
  [/Rod diameter should be < than tube inner diameter/, 'The rod must be narrower than the tube’s inside.'],
  [/Tube outer diameter should be > than tube inner diameter/, 'The tube’s outside must be wider than its inside.'],
  [/Grain length should be > (\d[\d.]*)/, (m) => `Each segment must be longer than ${Number(m[1]).toFixed(1)} mm (the grain’s web).`],
  [/Hole length diameter should be < than grain length/, 'The ignition hole must be shorter than the grain.'],
  [/Hole diameter should be < than outer diameter/, 'The ignition hole must be narrower than the grain.'],
  [/Slot offset should be < than grain radius/, 'The slot’s offset must be less than the grain’s radius.'],
  [/Core offset should be inside the grain/, 'The core’s offset must keep the core inside the grain.'],
  [/should be > 0|should be positive|Number of segment/, (m, text) => `${text.replace(/should be/, 'must be').replace(/ than /, ' ')}.`],
];

function explain(reply) {
  const text = String(reply.error ?? '');
  if (reply.kind === 'pressure') {
    return 'The chamber pressure goes beyond what the propellant’s burn rate data covers. Use a bigger throat, a smaller target pressure or less burning area.';
  }
  if (reply.kind === 'class') return 'This motor’s total impulse is outside the classes from A to V.';
  if (reply.kind === 'design') {
    for (const [re, say] of MESSAGES) {
      const m = re.exec(text);
      if (m) return typeof say === 'function' ? say(m, text) : say;
    }
    return text || 'This design cannot work.';
  }
  if (reply.kind === 'input') return 'Fill in every value of the design.';
  return 'The calculation did not work out for this design: its pressure never settled. Check the throat and the grain.';
}

async function ask(op, motor) {
  await startCalculator();
  const reply = JSON.parse(await motorRequest({ op, motor }));
  if (reply?.error != null) {
    const err = new Error(explain(reply));
    err.kind = reply.kind;
    throw err;
  }
  return reply;
}

/** The whole calculation (MotorLab.simulate): { summary, nozzle, lines }. */
export const simulate = (motor) => ask('simulate', motor);

/** The grain's burning area, end surface and volume at 50 steps of its web (MotorLab.areas). */
export const grainAreas = (grain) => ask('areas', { grain });
