import { test } from 'node:test';
import assert from 'node:assert/strict';
import { revertNote, markUndone } from '../src/history.js';

// History groups as the server lists them, newest first.
const edit = (v, user, at = v * 1000) => ({ userId: user, userName: user, at, oldestAt: at, from: v, to: v, note: null, changes: [] });
const revert = (v, user, note) => ({ ...edit(v, user), note });
const states = (groups) => groups.map((g) => g.undone ? `${g.from}:${g.undone.kind} by ${g.undone.by}` : `${g.from}:in effect`);

test('a revert notes what it took back; undoing an undo is a redo', () => {
  const kim = { version: 3, user_id: 'kim', user_name: 'Kim', at: 3000, note: null };
  const range = { from: 3, to: 4, userId: 'kim' };
  assert.deepEqual(revertNote('undo', kim, [kim], range, 1), { kind: 'undo', name: 'Kim', at: 3000, from: 3, to: 4, userId: 'kim', skipped: 1 });
  const undo = { version: 5, user_id: 'mina', user_name: 'Mina', at: 5000, note: JSON.stringify(revertNote('undo', kim, [kim], range)) };
  const redo = revertNote('undo', undo, [undo], { from: 5, to: 5, userId: 'mina' });
  assert.equal(redo.kind, 'redo');
  assert.equal(redo.name, 'Kim'); // still names the original change
  const again = { version: 6, user_id: 'kim', user_name: 'Kim', at: 6000, note: JSON.stringify(redo) };
  assert.equal(revertNote('undo', again, [again], { from: 6, to: 6, userId: 'kim' }).kind, 'undo');
  const restore = { version: 7, user_id: 'mina', user_name: 'Mina', at: 7000, note: JSON.stringify(revertNote('restore', kim, [], { from: 3 })) };
  assert.deepEqual(JSON.parse(restore.note), { kind: 'restore', name: 'Kim', at: 3000, from: 3, skipped: 0 });
  assert.deepEqual(revertNote('undo', restore, [restore], { from: 7, to: 7, userId: 'mina' }),
    { kind: 'undo', name: 'Mina', at: 7000, of: 'restore', from: 7, to: 7, userId: 'mina', skipped: 0 });
});

test('undone changes are marked and offer the redo; a redo puts them back', () => {
  const undone = markUndone([
    revert(4, 'mina', { kind: 'undo', name: 'kim', at: 2000, from: 2, to: 3, userId: 'kim', skipped: 0 }),
    edit(3, 'amy'),
    { ...edit(3, 'kim'), from: 2, oldestAt: 2000 },
    edit(1, 'kim'),
  ], []);
  assert.deepEqual(states(undone), ['4:in effect', '3:in effect', '2:undo by mina', '1:in effect']);
  assert.deepEqual(undone[2].undone.redo, { from: 4, to: 4, userId: 'mina' }); // undo the undo

  const redone = markUndone([
    revert(5, 'kim', { kind: 'redo', name: 'kim', at: 2000, from: 4, to: 4, userId: 'mina', skipped: 0 }),
    revert(4, 'mina', { kind: 'undo', name: 'kim', at: 2000, from: 2, to: 3, userId: 'kim', skipped: 0 }),
    { ...edit(3, 'kim'), from: 2, oldestAt: 2000 },
  ], []);
  assert.deepEqual(states(redone), ['5:in effect', '4:redo by kim', '2:in effect']);
});

test('a restore takes back everything after its point, until it is undone', () => {
  const restore = revert(5, 'mina', { kind: 'restore', name: 'amy', at: 2000, from: 2, skipped: 0 });
  assert.deepEqual(states(markUndone([restore, edit(4, 'kim'), edit(3, 'mina'), edit(2, 'amy'), edit(1, 'amy')], [])),
    ['5:in effect', '4:restore by mina', '3:restore by mina', '2:restore by mina', '1:in effect']);
  const undoRestore = revert(6, 'kim', { kind: 'undo', name: 'mina', at: 5000, of: 'restore', from: 5, to: 5, userId: 'mina', skipped: 0 });
  const after = markUndone([undoRestore, restore, edit(4, 'kim'), edit(2, 'amy')], []);
  assert.deepEqual(states(after), ['6:in effect', '5:undo by kim', '4:in effect', '2:in effect']);
  assert.equal(after[1].undone.redo.from, 6); // "Redo this restore"
});

test('reverts carry over to older pages; notes without a range are matched by their edit', () => {
  const active = [];
  markUndone([revert(9, 'mina', { kind: 'undo', name: 'kim', at: 2000, from: 2, to: 2, userId: 'kim', skipped: 2 })], active);
  const older = markUndone([edit(3, 'kim'), edit(2, 'kim')], active);
  assert.deepEqual(states(older), ['3:in effect', '2:undo by mina']);
  assert.equal(older[1].undone.skipped, 2); // partly undone

  // Written before reverts recorded their range: { kind, name, at } of the oldest edit reverted.
  const legacy = markUndone([
    revert(8, 'mina', { kind: 'undo', name: 'kim', at: 3000 }),
    revert(7, 'amy', { kind: 'restore', name: 'amy', at: 5000 }),
    edit(6, 'kim'), edit(5, 'amy'), edit(4, 'amy'), edit(3, 'kim'), edit(2, 'kim'),
  ], []);
  assert.deepEqual(states(legacy), ['8:in effect', '7:in effect', '6:restore by amy', '5:restore by amy', '4:in effect', '3:undo by mina', '2:in effect']);
});
