import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { config } from './config.js';

const db = new DatabaseSync(join(config.dataDir, 'openrocket-cloud.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    picture TEXT,
    created_at INTEGER NOT NULL,
    last_login INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    owner_id TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 0,
    model TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS members (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
    added_at INTEGER NOT NULL,
    PRIMARY KEY (project_id, email)
  );
  CREATE INDEX IF NOT EXISTS members_by_email ON members(email);
  CREATE TABLE IF NOT EXISTS motors (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL REFERENCES users(id),
    filename TEXT NOT NULL,
    content TEXT NOT NULL,
    summary TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS motors_by_owner ON motors(owner_id);
  CREATE TABLE IF NOT EXISTS edits (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    user_name TEXT NOT NULL,
    at INTEGER NOT NULL,
    minor INTEGER NOT NULL DEFAULT 0,
    changes TEXT NOT NULL,
    inverse TEXT NOT NULL,
    note TEXT,
    PRIMARY KEY (project_id, version)
  );
  CREATE TABLE IF NOT EXISTS snapshots (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    model TEXT NOT NULL,
    PRIMARY KEY (project_id, version)
  );
`);

const q = {
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  upsertUser: db.prepare(`
    INSERT INTO users (id, email, name, picture, created_at, last_login) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET email = excluded.email, name = excluded.name,
      picture = excluded.picture, last_login = excluded.last_login`),
  projectsFor: db.prepare(`
    SELECT p.id, p.name, p.owner_id, p.created_at, p.updated_at, p.version, m.role,
           u.name AS owner_name, u.email AS owner_email
    FROM members m JOIN projects p ON p.id = m.project_id JOIN users u ON u.id = p.owner_id
    WHERE m.email = ? ORDER BY p.updated_at DESC`),
  project: db.prepare('SELECT id, name, owner_id, created_at, updated_at, version FROM projects WHERE id = ?'),
  projectModel: db.prepare('SELECT model, version FROM projects WHERE id = ?'),
  insertProject: db.prepare('INSERT INTO projects (id, name, owner_id, created_at, updated_at, version, model) VALUES (?, ?, ?, ?, ?, 0, ?)'),
  renameProject: db.prepare('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?'),
  saveModel: db.prepare('UPDATE projects SET model = ?, version = ?, updated_at = ? WHERE id = ?'),
  deleteProject: db.prepare('DELETE FROM projects WHERE id = ?'),
  role: db.prepare('SELECT role FROM members WHERE project_id = ? AND email = ?'),
  members: db.prepare(`
    SELECT m.email, m.role, m.added_at, u.name, u.picture FROM members m
    LEFT JOIN users u ON u.email = m.email WHERE m.project_id = ?
    ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, m.email`),
  addMember: db.prepare(`
    INSERT INTO members (project_id, email, role, added_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(project_id, email) DO UPDATE SET role = excluded.role`),
  removeMember: db.prepare('DELETE FROM members WHERE project_id = ? AND email = ?'),
  motorsOf: db.prepare('SELECT id, filename, summary, created_at FROM motors WHERE owner_id = ? ORDER BY created_at DESC'),
  motor: db.prepare('SELECT * FROM motors WHERE id = ? AND owner_id = ?'),
  insertMotor: db.prepare('INSERT INTO motors (id, owner_id, filename, content, summary, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
  deleteMotor: db.prepare('DELETE FROM motors WHERE id = ? AND owner_id = ?'),
  projectMotors: db.prepare(`
    SELECT mo.id, mo.filename, mo.content FROM motors mo
    JOIN users u ON u.id = mo.owner_id
    JOIN members m ON m.email = u.email
    WHERE m.project_id = ? ORDER BY mo.created_at`),
  insertEdit: db.prepare(`INSERT OR REPLACE INTO edits (project_id, version, user_id, user_name, at, minor, changes, inverse, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  editsBefore: db.prepare(`SELECT version, user_id, user_name, at, minor, changes, note FROM edits
    WHERE project_id = ? AND version < ? ORDER BY version DESC LIMIT ?`),
  editsFrom: db.prepare('SELECT version, user_id, minor, inverse FROM edits WHERE project_id = ? AND version >= ? ORDER BY version DESC'),
  editAt: db.prepare('SELECT version, user_id, user_name, at FROM edits WHERE project_id = ? AND version = ?'),
  pruneEdits: db.prepare('DELETE FROM edits WHERE project_id = ? AND version <= ?'),
  lastSnapshot: db.prepare('SELECT version, created_at FROM snapshots WHERE project_id = ? ORDER BY version DESC LIMIT 1'),
  insertSnapshot: db.prepare('INSERT OR REPLACE INTO snapshots (project_id, version, created_at, model) VALUES (?, ?, ?, ?)'),
  pruneSnapshots: db.prepare(`
    DELETE FROM snapshots WHERE project_id = ? AND version NOT IN
      (SELECT version FROM snapshots WHERE project_id = ? ORDER BY version DESC LIMIT ?)`),
  snapshots: db.prepare('SELECT version, created_at FROM snapshots WHERE project_id = ? ORDER BY version DESC'),
  snapshot: db.prepare('SELECT model, version, created_at FROM snapshots WHERE project_id = ? AND version = ?'),
};

export const users = {
  get: (id) => q.userById.get(id),
  byEmail: (email) => q.userByEmail.get(email.toLowerCase()),
  upsert({ id, email, name, picture }) {
    const now = Date.now();
    // One account per email: signing in another way (e.g. Google after a dev sign-in) reuses it.
    const existing = q.userByEmail.get(email.toLowerCase());
    const userId = existing?.id ?? id;
    q.upsertUser.run(userId, email.toLowerCase(), name, picture ?? existing?.picture ?? null, now, now);
    return q.userById.get(userId);
  },
};

export const projects = {
  listFor: (email) => q.projectsFor.all(email.toLowerCase()),
  get: (id) => q.project.get(id),
  model: (id) => q.projectModel.get(id),
  create({ id, name, owner, modelJson }) {
    const now = Date.now();
    db.exec('BEGIN');
    try {
      q.insertProject.run(id, name, owner.id, now, now, modelJson);
      q.addMember.run(id, owner.email, 'owner', now);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  },
  rename: (id, name) => q.renameProject.run(name, Date.now(), id),
  saveModel: (id, modelJson, version) => q.saveModel.run(modelJson, version, Date.now(), id),
  delete: (id) => q.deleteProject.run(id),
  role: (id, email) => q.role.get(id, email.toLowerCase())?.role ?? null,
  members: (id) => q.members.all(id),
  addMember: (id, email, role) => q.addMember.run(id, email.toLowerCase(), role, Date.now()),
  removeMember: (id, email) => q.removeMember.run(id, email.toLowerCase()),
};

const SNAPSHOT_EVERY_MS = 10 * 60 * 1000;
const SNAPSHOTS_KEPT = 200;

export const history = {
  /** Keeps a restorable copy at most every 10 minutes while a project is being edited. */
  maybeSnapshot(id, version, modelJson, force = false) {
    const last = q.lastSnapshot.get(id);
    if (!force && last && (last.version === version || Date.now() - last.created_at < SNAPSHOT_EVERY_MS)) return;
    q.insertSnapshot.run(id, version, Date.now(), modelJson);
    q.pruneSnapshots.run(id, id, SNAPSHOTS_KEPT);
  },
  list: (id) => q.snapshots.all(id),
  get: (id, version) => q.snapshot.get(id, version),
};

export const motors = {
  listFor: (userId) => q.motorsOf.all(userId).map((m) => ({ ...m, summary: JSON.parse(m.summary) })),
  get: (id, userId) => q.motor.get(id, userId),
  add: ({ id, owner, filename, content, summary }) =>
    q.insertMotor.run(id, owner.id, filename, content, JSON.stringify(summary), Date.now()),
  delete: (id, userId) => q.deleteMotor.run(id, userId).changes > 0,
  /** Motor files of everyone a design is shared with (so collaborators see the same motors). */
  forProject: (projectId) => q.projectMotors.all(projectId),
};

const EDITS_KEPT = 5000;

export const edits = {
  add(projectId, { version, user, at, minor, changes, inverse, note }) {
    q.insertEdit.run(projectId, version, user.id, user.name, at, minor ? 1 : 0, JSON.stringify(changes),
      JSON.stringify(inverse), note ? JSON.stringify(note) : null);
    if (version % 200 === 0) q.pruneEdits.run(projectId, version - EDITS_KEPT);
  },
  /** Newest first, older than `before`. */
  list: (projectId, before, limit) => q.editsBefore.all(projectId, before, limit),
  /** All edits from `version` on, newest first (for reverting). */
  from: (projectId, version) => q.editsFrom.all(projectId, version),
  at: (projectId, version) => q.editAt.get(projectId, version),
};
