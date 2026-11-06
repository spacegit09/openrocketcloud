// Edit history bookkeeping, shared by the servers and the pages (web/scripts/prebuild.mjs copies it
// into the Base44 site and its DesignRoom actor; the self-hosted server serves it as /history.js):
// what each undo, redo and restore took back, so the history shows which changes are no longer in
// effect, and offers to redo them instead of undoing them again.

/**
 * The note stored with a revert. mode "restore": everything from version `from` on. mode "undo":
 * `userId`'s edits in versions [from, to]; `rows` (newest first) are the edits it reverts and
 * `first` the edit at `from`. Undoing an undo is a redo, and undoing a redo an undo again; both
 * keep naming the original change.
 */
export function revertNote(mode, first, rows, { from, to, userId }, skipped = 0) {
  if (mode === 'restore') return { kind: 'restore', name: first.user_name, at: first.at, from, skipped };
  const range = { from, to, userId, skipped };
  let target = null;
  try {
    target = rows.length === 1 && rows[0].note ? JSON.parse(rows[0].note) : null;
  } catch {
    // an unreadable note: treat it as an ordinary edit
  }
  switch (target?.kind) {
    case 'undo': return { kind: 'redo', name: target.name, at: target.at, of: target.of, ...range };
    case 'redo': return { kind: 'undo', name: target.name, at: target.at, of: target.of, ...range };
    case 'restore': return { kind: 'undo', name: first.user_name, at: first.at, of: 'restore', ...range };
    default: return { kind: 'undo', name: first.user_name, at: first.at, ...range };
  }
}

/** The activity line for a revert ("Mina undid an edit"). */
export function revertText(note) {
  return { restore: 'restored an earlier version', redo: 'redid an edit' }[note.kind] ?? 'undid an edit';
}

const REVERTS = new Set(['undo', 'redo', 'restore']);

/**
 * Marks the history's groups (newest first, as the history lists them) that a later undo, redo or
 * restore took back and that were not put back since: `g.undone` = { kind, by, at, skipped, redo },
 * the revert's kind, who made it and when, how many of its changes it kept (changed again in the
 * meantime), and the request that puts them back (`{ from, to, userId }` for mode "undo"; null
 * after a restore, which is put back by undoing the restore itself). A revert that was itself taken
 * back takes nothing back.
 *
 * `active` carries the reverts in effect from one page of the history to the next, older one:
 * start with [] and pass the same array for each page.
 */
export function markUndone(groups, active) {
  for (const g of groups) {
    for (const a of active) {
      if (a.done || !takesBack(a, g)) continue;
      g.undone ??= { kind: a.kind, by: a.by, at: a.at, skipped: a.skipped, redo: a.redo };
      // Notes from before reverts recorded their range name the oldest edit they reached back to.
      if (a.legacy && g.userName === a.name && g.oldestAt === a.noteAt) a.done = true;
    }
    const n = g.note;
    if (!n || g.undone || !REVERTS.has(n.kind)) continue;
    const legacy = !Number.isInteger(n.from);
    active.push({
      kind: n.kind, by: g.userName, at: g.at, skipped: n.skipped ?? 0, legacy, name: n.name, noteAt: n.at,
      from: n.from, to: n.kind === 'restore' ? g.from - 1 : n.to, userId: n.userId,
      redo: n.kind === 'restore' ? null : { from: g.from, to: g.to, userId: g.userId },
    });
  }
  return groups;
}

function takesBack(a, g) {
  if (a.kind === 'restore') return a.legacy || (g.to >= a.from && g.from <= a.to); // a legacy one: back to its edit
  if (a.legacy) return g.userName === a.name && g.oldestAt === a.noteAt;
  return g.userId === a.userId && g.to >= a.from && g.from <= a.to;
}
