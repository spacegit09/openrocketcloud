// The motor designer's calculator: JSRM 3.3, the Java version of Richard Nakka's SRM spreadsheet
// that METEOR runs, in this page through CheerpJ (orcloud.bridge.MotorMain and MotorLab, in
// worker/bridge/web), the way the launch planner runs OpenRocket. It starts once, then answers.
import { prefetchJar, prepareJava } from '../java.js';
import { MOTOR_CLASSPATH } from '../lib/jars.js';
import { explain } from './messages.js';
import { motorRequest } from './natives.js';

let running = null;

/** Starts the calculator once (CheerpJ, then MotorMain); later calls share it. */
export function startCalculator() {
  running ??= (async () => {
    // Our two jars (1.8 MB) downloaded meanwhile, whole and in parallel, by the service worker:
    // Java finds them waiting when it gets to them, rather than reading them a piece at a time.
    for (const jar of MOTOR_CLASSPATH.split(':')) prefetchJar(jar.replace(/^\/app/, ''));
    // The parts of the Java runtime the motor designer reads (test/motor-preload.mjs), fetched all at
    // once as CheerpJ starts rather than one after another as Java asks for them: from far away,
    // each would be a round trip of its own.
    await prepareJava('motor', { preload: '/or/motor-preload.json' });
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

/**
 * The grain's burning area, end surface and volume at 50 steps of its web (MotorLab.areas); with
 * the chamber, after JSRM's checks of the design.
 */
export const grainAreas = (grain, chamber) => ask('areas', chamber ? { grain, chamber } : { grain });
