// Every message JSRM 3.3 has for a motor it cannot work out (its InvalidMotorDesignException
// messages, from its source), and MotorLab's other kinds of error, in the site's words: none may
// reach the page as JSRM's own text.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { explain } from '../src/motor/messages.js';

const JSRM_DESIGN_MESSAGES = [
  'Combustion chamber length should be >= than Grain total length',
  'Outer diameter should be > 0',
  'Number of segment should be > 0',
  'Grain length should be > 0',
  'Combution chamber diameter should be >= than grain outer diameter',
  'Inner diameter should be > 0',
  'Inner diameter should be < than outer diameter',
  'Core diameter should be positive',
  'Core diameter should be < than outer diameter',
  'Tube outer diameter should be > than tube inner diameter',
  'Tube outer diameter should be > 0',
  'Throat diameter should be <= than grain core diameter',
  'The motor should have at least core surface or outer surface exposed.',
  'Slot width should be > 0',
  'Slot width should be <= than outer diameter',
  'Slot offset should be positive',
  'Slot offset should be < than grain radius',
  'Slot depth should be > 0',
  'Slot depth should be <= than outer diameter',
  'Rod diameter should be > 0',
  'Rod diameter should be < than tube inner diameter',
  'Point diameter should be < than outer diameter',
  'Point count should be > 0',
  'Inner diameter should be < than point diameter',
  'Hole length diameter should be < than grain length',
  'Hole diameter should be < than outer diameter',
  'Grain outer diameter should be > than grain core diameter',
  'Grain length should be > 12.345',
  'Core offset should be positive',
  'Core offset should be inside the grain',
  'Combution chamber diameter should be >= than tube outer diameter',
];

test('every JSRM design message is in the site\'s words', () => {
  for (const error of JSRM_DESIGN_MESSAGES) {
    const said = explain({ error, kind: 'design' });
    assert.doesNotMatch(said, /should be|Combution|Number of segment/, `${error} -> ${said}`);
    assert.match(said, /^[A-Z].*\.$/, `${error} -> ${said}`);
  }
  assert.equal(explain({ error: 'Grain length should be > 12.345', kind: 'design' }), 'Each segment must be longer than 12.3 mm (the grain’s web).');
  assert.equal(explain({ error: 'Grain length should be > 0', kind: 'design' }), 'The grain length must be more than 0.');
  assert.equal(explain({ error: 'Point diameter should be < than outer diameter', kind: 'design' }), 'The star’s points must stay inside the grain: make the star diameter less than the outer diameter.');
});

test('MotorLab\'s other kinds of error', () => {
  assert.match(explain({ error: 'x', kind: 'pressure' }), /burn rate data/);
  assert.match(explain({ error: 'x', kind: 'class' }), /from A to V/);
  assert.equal(explain({ error: 'Missing throat.', kind: 'input' }), 'Fill in every value of the design.');
  assert.match(explain({ error: 'Dichotomic solve failed', kind: 'failed' }), /never settled/);
});
