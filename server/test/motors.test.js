import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readMotorFile, impulseClass, MotorFileError } from '../src/motors.js';

const C6 = `; Estes C6 (sample RASP data)
C6 18 70 0-3-5-7 0.0108 0.0231 Estes
0.031 0.946
0.092 4.826
0.139 9.936
0.192 14.09
0.209 11.446
0.231 7.381
0.248 6.151
0.292 5.489
0.37 4.921
0.475 4.448
0.671 4.258
0.85 4.448
1.063 4.353
1.468 4.353
1.821 4.448
1.847 1.325
1.86 0.0
;`;

test('reads a RASP .eng file', () => {
  const { motors } = readMotorFile('Estes_C6.eng', Buffer.from(C6));
  assert.equal(motors.length, 1);
  const m = motors[0];
  assert.equal(m.designation, 'C6');
  assert.equal(m.manufacturer, 'Estes');
  assert.equal(m.diameterMm, 18);
  assert.equal(m.impulseClass, 'C');
  assert.ok(m.impulseNs > 5 && m.impulseNs <= 10, `impulse ${m.impulseNs}`);
});

test('reads several motors from one .eng file', () => {
  const two = `${C6}\nX42 29 124 P 0.03 0.08 Team Rocket\n0.1 50\n1.5 40\n1.6 0\n`;
  const { motors } = readMotorFile('two.eng', Buffer.from(two));
  assert.deepEqual(motors.map((m) => m.designation), ['C6', 'X42']);
  assert.equal(motors[1].manufacturer, 'Team Rocket');
  assert.equal(motors[1].impulseClass, 'F');
});

test('reads a RockSim .rse file', () => {
  const rse = `<engine-database><engine-list>
    <engine code="G80T" mfg="Aerotech" dia="29." len="124." Itot="137.8" burn-time="1.7"><data><eng-data t="0" f="0"/></data></engine>
  </engine-list></engine-database>`;
  const { motors } = readMotorFile('g80.rse', Buffer.from(rse));
  assert.equal(motors[0].designation, 'G80T');
  assert.equal(motors[0].impulseClass, 'G');
});

test('rejects bad files with a helpful message', () => {
  assert.throws(() => readMotorFile('x.txt', Buffer.from(C6)), /\.eng or \.rse/);
  assert.throws(() => readMotorFile('x.eng', Buffer.from('hello world')), MotorFileError);
  assert.throws(() => readMotorFile('x.eng', Buffer.from('C6 18 70 0 0.01 0.02 Estes\n')), /no thrust curve/);
});

test('impulse classes', () => {
  assert.equal(impulseClass(2.5), 'A');
  assert.equal(impulseClass(2.6), 'B');
  assert.equal(impulseClass(10), 'C');
  assert.equal(impulseClass(40), 'E');
  assert.equal(impulseClass(1), '½A');
});
