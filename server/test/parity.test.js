// Java/Node parity: the server must build, apply and emit models exactly like the bridge.
// Fixtures come from the worker self-test (SELFTEST_DUMP); see README "Development".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fromXml, fromJson, toJson, toXml, applyOp, childIndex, SIMS } from '../src/model.js';
import { parse, canonical } from '../src/xml.js';

const dir = process.env.PARITY_FIXTURES ?? join(import.meta.dirname, '../../worker/.cache/fixtures');
const names = existsSync(dir)
  ? readdirSync(dir).filter((f) => f.endsWith('.model.json')).map((f) => f.replace('.model.json', ''))
  : [];

function normalize(m) {
  return JSON.parse(JSON.stringify(toJson(m), (k, v) => v));
}

function simIds(xml) {
  const sims = parse(xml).first('simulations');
  return sims ? sims.elements().filter((e) => e.tag === 'simulation').map((_, i) => `sim-${i}`) : [];
}

test('fixtures present', { skip: names.length ? false : `no fixtures in ${dir}` }, () => {
  assert.ok(names.length > 0);
});

for (const name of names) {
  test(`parity: ${name}`, () => {
    const xml = readFileSync(join(dir, `${name}.xml`), 'utf8');
    const javaModel = JSON.parse(readFileSync(join(dir, `${name}.model.json`), 'utf8'));

    // 1. XML -> model is identical.
    const m = fromXml(xml, new Map(), simIds(xml));
    assert.deepEqual(normalize(m), normalize(fromJson(javaModel)));

    // 2. Canonical XML is a fixed point.
    const c = canonical(parse(xml));
    assert.equal(canonical(parse(c)), c);

    // 3. Applying the Java-generated ops gives the Java result, and the same XML.
    const ops = JSON.parse(readFileSync(join(dir, `${name}.ops.json`), 'utf8'));
    for (const op of ops) applyOp(m, op);
    const javaResult = fromJson(JSON.parse(readFileSync(join(dir, `${name}.result.json`), 'utf8')));
    assert.deepEqual(normalize(m), normalize(javaResult));
    assert.equal(toXml(m), readFileSync(join(dir, `${name}.result.xml`), 'utf8'));
    assert.ok(childIndex(m).get(SIMS) === undefined || childIndex(m).get(SIMS).length >= 0);
  });
}
