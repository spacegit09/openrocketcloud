import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fromXml, toXml, applyOp } from '../src/model.js';
import { describeOp, inverseOf, planRevert, groupEdits, formatValue, isMinorOp } from '../src/edits.js';

const XML = `<openrocket version="1.10" creator="test"><rocket><name>R</name><id>r1</id><subcomponents>
<stage><name>Sustainer</name><id>s1</id><subcomponents>
<nosecone><name>Nose cone</name><id>n1</id><length>0.1</length><shape>ogive</shape></nosecone>
<bodytube><name>Body tube</name><id>b1</id><length>0.3</length><subcomponents>
<parachute><name>Chute</name><id>p1</id><cd>0.8</cd></parachute></subcomponents></bodytube>
</subcomponents></stage></subcomponents></rocket><simulations><simulation status="uptodate"><name>Sim 1</name></simulation></simulations></openrocket>`;

const model = () => fromXml(XML, new Map(), ['sim1']);

/** Applies a batch like the server does and returns its stored inverse (newest op last undone first). */
function apply(m, ops) {
  const inverses = [];
  for (const op of ops) {
    const inv = inverseOf(m, op);
    if (applyOp(m, op)) inverses.push(inv);
  }
  return inverses.reverse().flat();
}

const revert = (m, inverse, mode) => {
  const { ops, skipped } = planRevert(m, inverse, mode);
  for (const op of ops) applyOp(m, op);
  return skipped;
};

test('describes property edits in readable units', () => {
  const m = model();
  const [c] = describeOp(m, { op: 'set', id: 'n1', v: { length: '<length>0.14</length>' } });
  assert.deepEqual({ target: c.target, prop: c.prop, from: c.from, to: c.to }, { target: 'Nose cone “Nose cone”', prop: 'Length', from: '10 cm', to: '14 cm' });
  assert.equal(formatValue('shape', '<shape>haack</shape>'), 'Haack');
  assert.equal(formatValue('componentmass', '<componentmass>0.0123</componentmass>'), '12.3 g');
  assert.equal(formatValue('aftradius', '<aftradius>auto 0.0125</aftradius>'), 'automatic (1.25 cm)');
  assert.equal(describeOp(m, { op: 'del', id: 'p1' })[0].target, 'Parachute “Chute”');
});

test('simulation status/results updates are minor', () => {
  const m = model();
  assert.equal(isMinorOp(m, { op: 'set', id: 'sim1', v: { '@': ' status="outdated"', flightdata: '<flightdata/>' } }), true);
  assert.equal(isMinorOp(m, { op: 'set', id: 'sim1', v: { name: '<name>X</name>' } }), false);
  assert.equal(isMinorOp(m, { op: 'set', id: 'n1', v: { length: '<length>1</length>' } }), false);
});

test('restore reverts sets, deletes, moves and adds exactly', () => {
  const m = model();
  const original = toXml(m);
  const v1 = apply(m, [{ op: 'set', id: 'n1', v: { length: '<length>0.2</length>', comment: '<comment>hi</comment>' } }]);
  const v2 = apply(m, [{ op: 'del', id: 'b1' }, { op: 'move', id: 'n1', p: 's1', o: 9 }]);
  const v3 = apply(m, [{ op: 'put', id: 'm1', t: 'masscomponent', p: 's1', o: 5, k: ['name'], v: { '@': '', name: '<name>Payload</name>' } }]);
  assert.notEqual(toXml(m), original);
  // Stored rows are read newest first; each row keeps its own order.
  assert.equal(revert(m, [...v3, ...v2, ...v1], 'restore'), 0);
  assert.equal(toXml(m), original);
});

test('undo skips properties someone changed again later', () => {
  const m = model();
  const first = apply(m, [{ op: 'set', id: 'n1', v: { length: '<length>0.2</length>', shape: '<shape>conical</shape>' } }]);
  apply(m, [{ op: 'set', id: 'n1', v: { length: '<length>0.3</length>' } }]); // someone else, later
  const skipped = revert(m, first, 'undo');
  assert.equal(skipped, 1);
  assert.equal(m.objs.get('n1').v.get('length'), '<length>0.3</length>'); // later edit kept
  assert.equal(m.objs.get('n1').v.get('shape'), '<shape>ogive</shape>'); // own edit undone
});

test('undo of a group reverts repeated edits to the same property', () => {
  const m = model();
  const a = apply(m, [{ op: 'set', id: 'n1', v: { length: '<length>0.2</length>' } }]);
  const b = apply(m, [{ op: 'set', id: 'n1', v: { length: '<length>0.25</length>' } }]);
  assert.equal(revert(m, [...b, ...a], 'undo'), 0);
  assert.equal(m.objs.get('n1').v.get('length'), '<length>0.1</length>');
});

test('history groups quick consecutive edits by one person', () => {
  const row = (version, user, at, changes, minor = 0) => ({ version, user_id: user, user_name: user, at, minor, changes: JSON.stringify(changes), note: null });
  const set = (from, to) => [{ id: 'n1', kind: 'set', target: 'Nose cone', prop: 'Length', key: 'length', from, to }];
  const groups = groupEdits([
    row(5, 'bob', 100_000, set('12 cm', '14 cm')),
    row(4, 'bob', 90_000, [], 1), // automatic simulation re-run: hidden, does not split
    row(3, 'bob', 80_000, set('10 cm', '12 cm')),
    row(2, 'amy', 70_000, set('9 cm', '10 cm')),
  ], 10);
  assert.equal(groups.length, 2);
  assert.deepEqual([groups[0].from, groups[0].to], [3, 5]);
  assert.deepEqual([groups[0].changes[0].from, groups[0].changes[0].to], ['10 cm', '14 cm']);
  assert.equal(groups[1].userId, 'amy');
});
