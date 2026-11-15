import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readMotorFile, impulseClass, MotorFileError, tidyMotorText } from '../src/motors.js';

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
  const two = `${C6}\nX42 29 124 P 0.03 0.08 TeamRocket\n0.1 50\n1.5 40\n1.6 0\n`;
  const { motors } = readMotorFile('two.eng', Buffer.from(two));
  assert.deepEqual(motors.map((m) => m.designation), ['C6', 'X42']);
  assert.equal(motors[1].manufacturer, 'TeamRocket');
  assert.equal(motors[1].impulseClass, 'F');
});

test('reads a RockSim .rse file', () => {
  const rse = `<engine-database><engine-list>
    <engine code="G80T" mfg="Aerotech" dia="29." len="124." initWt="126." propWt="62.5"><data>
      <eng-data t="0" f="0"/><eng-data t="0.1" f="110"/><eng-data t="1.6" f="80"/><eng-data t="1.7" f="0"/>
    </data></engine>
  </engine-list></engine-database>`;
  const { motors } = readMotorFile('g80.rse', Buffer.from(rse));
  assert.equal(motors[0].designation, 'G80T');
  assert.equal(motors[0].impulseClass, 'G');
});

test('says why OpenRocket could not read a file', () => {
  const eng = (head, curve = '0.1 50\n1.5 40\n1.6 0') => Buffer.from(`${head}\n${curve}\n`);
  assert.throws(() => readMotorFile('a.eng', eng('X42 29 124 P 0.03 0.08 Team Rocket')), /exactly 7 values.*it has 8/);
  assert.throws(() => readMotorFile('a.eng', eng('X42 29 124 P 0.09 0.08 Team')), /propellant mass \(0.09 kg\) is more than the total mass/);
  assert.throws(() => readMotorFile('a.eng', eng('X42 29 124 P 0.03 0.08 Team', '0.1 50 1\n1.6 0')), /Line 2: .*exactly 2 values/);
  assert.throws(() => readMotorFile('a.eng', eng('X42 29 124 P 0.03 0.08 Team', '0,1 50\n1,6 0')), /Line 2: the time "0,1" is not a number/);
  assert.throws(() => readMotorFile('a.eng', eng('X42 29 124 P 0.03 0.08 Team', '0.1 50\n0.1 40\n1.6 0')), /two different thrust values at 0.1 s/);
  assert.throws(() => readMotorFile('a.eng', eng('X42 29 124 P 0.03 0.08 Team', '0.1 0\n1.6 0')), /no impulse/);
});

test('tidies what OpenRocket trips on but changes no motor', () => {
  const messy = '\uFEFF  ; indented comment\r\n   \r\nX42 29 124 P 0.03 0.08 Team ; note\r\n0.1 50 ; peak\r\n1.6 0\r\n';
  assert.equal(tidyMotorText('eng', messy), '; indented comment\n\nX42 29 124 P 0.03 0.08 Team\n0.1 50\n1.6 0\n');
  const { text, motors } = readMotorFile('a.eng', Buffer.from(messy));
  assert.equal(text, tidyMotorText('eng', messy));
  assert.equal(motors[0].manufacturer, 'Team');
  assert.equal(tidyMotorText('rse', '\uFEFF<a/>'), '<a/>');
});

// The upload check against OpenRocket itself: orcloud.bridge.MotorFileCheck (scripts/test.sh) loads
// each file of worker/bridge/test/motors with OpenRocket's motor readers after the session's tidying.
const corpus = join(import.meta.dirname, '..', '..', 'worker', 'bridge', 'test', 'motors');
const checked = join(import.meta.dirname, '..', '..', 'worker', '.cache', 'motors');
test('accepts exactly the motor files OpenRocket loads, tidied the same way', { skip: !existsSync(join(checked, 'verdicts.txt')) && 'run scripts/test.sh (MotorFileCheck) first' }, () => {
  const verdicts = new Map(readFileSync(join(checked, 'verdicts.txt'), 'utf8').trim().split('\n').map((l) => {
    const [name, verdict, detail] = l.split('\t');
    return [name, { ok: verdict === 'ok', detail }];
  }));
  const files = readdirSync(corpus).filter((f) => /\.(eng|rse)$/.test(f));
  assert.ok(files.length >= 50, 'the corpus is there');
  for (const name of files) {
    const bytes = readFileSync(join(corpus, name));
    const or = verdicts.get(name);
    assert.ok(or, `${name}: no verdict from OpenRocket`);
    let mine;
    try {
      mine = { ok: true, count: readMotorFile(name, bytes).motors.length };
    } catch (e) {
      mine = { ok: false, detail: e.message };
    }
    if (name.startsWith('strict-')) {
      assert.equal(mine.ok, false, `${name}: should be refused (OpenRocket loads it, but it is nonsense)`);
      continue;
    }
    assert.equal(mine.ok, or.ok, `${name}: OpenRocket ${or.ok ? 'loads it' : `refuses it (${or.detail})`}, the upload ${mine.ok ? 'accepts it' : `refuses it (${mine.detail})`}`);
    if (mine.ok) assert.equal(String(mine.count), or.detail, `${name}: number of motors`);
    const ext = name.endsWith('.eng') ? 'eng' : 'rse';
    assert.equal(tidyMotorText(ext, bytes.toString('utf8')), readFileSync(join(checked, `${name}.tidy`), 'utf8'), `${name}: tidied differently from the session`);
  }
});

test('rejects bad files with a helpful message', () => {
  assert.throws(() => readMotorFile('x.txt', Buffer.from(C6)), /\.eng or \.rse/);
  assert.throws(() => readMotorFile('x.eng', Buffer.from('hello world')), MotorFileError);
  assert.throws(() => readMotorFile('x.eng', Buffer.from('C6 18 70 0 0.01 0.02 Estes\n')), /needs at least 2 lines of time and thrust; it has 0/);
});

test('impulse classes', () => {
  assert.equal(impulseClass(2.5), 'A');
  assert.equal(impulseClass(2.6), 'B');
  assert.equal(impulseClass(10), 'C');
  assert.equal(impulseClass(40), 'E');
  assert.equal(impulseClass(1), '½A');
});
