// Design previews (src/preview.js): only plain drawings pass, rebuilt from what is valid.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanPreview, MAX_PREVIEW } from '../src/preview.js';

const preview = (s, box = [0, -10, 300, 20]) => JSON.stringify({ v: 1, box, s });

test('a drawing comes back as it was', () => {
  const s = [
    { d: 'M0 0L150 -12.5Q160 -12.5 170 0Z', k: 'dashed', c: '#FF0000' },
    { d: 'M200 -5C210 -5 220 5 230 5', m: 1 },
  ];
  assert.deepEqual(cleanPreview(preview(s)), { v: 1, box: [0, -10, 300, 20], s: [{ ...s[0], c: '#ff0000' }, s[1]] });
});

test('an empty rocket is an empty drawing', () => {
  assert.deepEqual(cleanPreview('{"v":1,"s":[]}'), { v: 1, box: null, s: [] });
});

test('anything but path data, line styles, colours and motors is left out', () => {
  const s = [
    { d: 'M0 0L1 1"/><script>alert(1)</script>' },
    { d: 'M0 0 A 1 1 0 0 1 2 2' }, // arcs are not drawn by OpenRocket's figure
    { d: 'M0 0L10 0', k: 'url(#x)', c: 'red', m: true, onclick: 'x' },
  ];
  assert.deepEqual(cleanPreview(preview(s)).s, [{ d: 'M0 0L10 0' }]);
  assert.equal(cleanPreview(preview([{ d: '<svg onload=alert(1)>' }])), null);
});

test('malformed previews are refused', () => {
  for (const text of [null, '', 'not json', '{"v":2,"s":[]}', preview([{ d: 'M0 0L1 1' }], [0, 0, 0, 5]),
    preview([{ d: 'M0 0L1 1' }], [0, 0, 'x', 5]), preview([{ d: 'M0 0L1 1' }], [0, 0, 5]), 'x'.repeat(MAX_PREVIEW + 1)]) {
    assert.equal(cleanPreview(text), null, String(text).slice(0, 40));
  }
});
