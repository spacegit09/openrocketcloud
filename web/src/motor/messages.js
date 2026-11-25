// JSRM's answers when it cannot work a motor out (orcloud.bridge.MotorLab: { error, kind }), in
// the site's words. Plain JavaScript, so that test/motor-messages.test.mjs can check every message
// JSRM 3.3 has.

/** JSRM's messages about designs that cannot work, in the site's words. */
const MESSAGES = [
  [/Throat diameter should be <= than grain core diameter/, 'The nozzle throat is wider than the grain’s core. Make the core wider, or the throat narrower.'],
  [/Combu?tion chamber diameter should be >= than (grain outer|tube outer) diameter/, 'The grain is wider than the chamber. Make the chamber wider or the grain narrower.'],
  [/Combustion chamber length should be >= than Grain total length/, 'The grain is longer than the chamber. Make the chamber longer, or the grain shorter.'],
  [/Grain outer diameter should be > than grain core diameter|Core diameter should be < than outer diameter|Inner diameter should be < than outer diameter/, 'The core must be narrower than the grain.'],
  [/at least core surface or outer surface exposed/, 'Leave the core or the outer surface exposed: with both inhibited, the grain can only burn from its ends, which this shape does not model.'],
  [/Rod diameter should be < than tube inner diameter/, 'The rod must be narrower than the tube’s inside.'],
  [/Tube outer diameter should be > than tube inner diameter/, 'The tube’s outside must be wider than its inside.'],
  [/Grain length should be > (?!0$)(\d[\d.]*)/, (m) => `Each segment must be longer than ${Number(m[1]).toFixed(1)} mm (the grain’s web).`],
  [/Hole length diameter should be < than grain length/, 'The ignition hole must be shorter than the grain.'],
  [/Hole diameter should be < than outer diameter/, 'The ignition hole must be narrower than the grain.'],
  [/Slot offset should be < than grain radius/, 'The slot’s offset must be less than the grain’s radius.'],
  [/Point diameter should be < than outer diameter/, 'The star’s points must stay inside the grain: make the star diameter less than the outer diameter.'],
  [/Inner diameter should be < than point diameter/, 'The star’s inner diameter must be less than its star (point) diameter.'],
  [/Slot depth should be <= than outer diameter/, 'The slot must be less deep than the grain is wide.'],
  [/Slot width should be <= than outer diameter/, 'The slot must be narrower than the grain.'],
  [/Core offset should be inside the grain/, 'The core’s offset must keep the core inside the grain.'],
  [/^Number of segment should be > 0/, 'The number of segments must be at least 1.'],
  [/^Point count should be > 0/, 'The star needs at least one point.'],
  [/^(.+) should be > 0$/, (m) => `The ${m[1].toLowerCase()} must be more than 0.`],
  [/^(.+) should be positive$/, (m) => `The ${m[1].toLowerCase()} must not be negative.`],
];

/** The words for a reply of MotorLab's that is an error ({ error, kind }). */
export function explain(reply) {
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
