import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readZip } from '../src/zip.js';
import { importOrk, exportOrk } from '../src/ork.js';
import { toXml, ATT } from '../src/model.js';

const template = readFileSync(join(import.meta.dirname, '../templates/new-rocket.ork'));

test('blank template imports', () => {
  const m = importOrk(template);
  assert.ok([...m.objs.values()].some((o) => o.t === 'rocket'));
  assert.ok([...m.objs.values()].some((o) => o.t === 'stage'));
});

test('export with decals puts rocket.ork first (OpenRocket reads only the first entry)', () => {
  const m = importOrk(template);
  m.objs.set('att:decals/a.png', { t: ATT, p: 'doc', o: 1000, k: ['data'], v: new Map([['@', ''], ['data', Buffer.from('png').toString('base64')]]) });
  const { body, zip } = exportOrk(m);
  assert.equal(zip, true);
  const entries = readZip(body);
  assert.equal(entries[0].name, 'rocket.ork');
  assert.equal(entries[0].data.toString('utf8'), toXml(m));
  assert.equal(entries[1].data.toString(), 'png');
  // and it round-trips
  const again = importOrk(body);
  assert.equal(toXml(again), toXml(m));
  assert.equal(again.objs.get('att:decals/a.png').v.get('data'), Buffer.from('png').toString('base64'));
});

test('rejects non-OpenRocket files', () => {
  assert.throws(() => importOrk(Buffer.from('<RockSimDocument/>')), /RockSim/);
  assert.throws(() => importOrk(Buffer.from('hello')), /not an OpenRocket design/);
});
