import express from 'express';
import { randomUUID } from 'node:crypto';
import { requireUser, requireAppHeader } from './auth.js';
import { projects, users, history, motors, edits } from './db.js';
import { groupEdits } from './edits.js';
import { readMotorFile, MotorFileError } from './motors.js';
import { config } from './config.js';
import { importOrk, exportOrk, blankModel, exampleModel, listExamples, modelJson, ImportError } from './ork.js';
import { currentModel, presenceOf, forgetProject, colorFor, revertEdits, RevertError } from './collab.js';
import { fromJson } from './model.js';
import { subscribe, publish } from './events.js';
import {
  ensureSession, sessionFor, stopSession, stopProjectSessions, publicView, setRole, CapacityError, listFiles, readFile,
} from './sessions.js';

const ROLES = ['owner', 'editor', 'viewer'];
const cleanName = (s) => String(s ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 120);
const fileName = (s) => `${cleanName(s).replace(/[\\/:*?"<>|]/g, '_') || 'Rocket'}.ork`;

function sendOrk(res, name, model) {
  const { body } = exportOrk(model);
  res.set('content-type', 'application/octet-stream');
  res.set('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName(name))}`);
  res.send(body);
}

export function apiRouter() {
  const api = express.Router();
  api.use(requireUser, requireAppHeader);

  /** Loads the project and the caller's role; 404 unless they are a member. */
  const access = (minRole = 'viewer') => (req, res, next) => {
    const project = projects.get(req.params.id);
    const role = project && projects.role(project.id, req.user.email);
    if (!project || !role) return res.status(404).json({ error: 'Project not found.' });
    if (ROLES.indexOf(role) > ROLES.indexOf(minRole)) {
      return res.status(403).json({ error: minRole === 'owner' ? 'Only the owner can do that.' : 'You have view-only access.' });
    }
    req.project = project;
    req.role = role;
    next();
  };

  api.get('/me', (req, res) => {
    const { id, email, name, picture } = req.user;
    res.json({ id, email, name, picture, color: colorFor(id) });
  });

  api.get('/templates', (req, res) => res.json({ examples: listExamples() }));

  api.get('/projects', (req, res) => {
    res.json(projects.listFor(req.user.email).map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      owner: { name: p.owner_name, email: p.owner_email },
      updatedAt: p.updated_at,
      createdAt: p.created_at,
      online: presenceOf(p.id).map(({ name, color, picture }) => ({ name, color, picture })),
      members: projects.members(p.id).length,
    })));
  });

  const create = (req, res, name, model) => {
    const id = randomUUID();
    projects.create({ id, name: cleanName(name) || 'Untitled rocket', owner: req.user, modelJson: modelJson(model) });
    history.maybeSnapshot(id, 0, modelJson(model), true);
    res.status(201).json({ id });
  };

  api.post('/projects', express.json(), (req, res) => {
    const { name, example } = req.body ?? {};
    try {
      create(req, res, name || example, example ? exampleModel(String(example)) : blankModel());
    } catch (e) {
      if (e instanceof ImportError) return res.status(400).json({ error: e.message });
      throw e;
    }
  });

  api.post('/projects/import', express.raw({ type: () => true, limit: `${config.maxUploadMb}mb` }), (req, res) => {
    let name = 'Imported rocket';
    try {
      name = decodeURIComponent(req.get('x-filename') ?? name).replace(/\.(ork|xml|zip)$/i, '');
    } catch {
      // keep the default name
    }
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Empty upload.' });
    try {
      create(req, res, name, importOrk(req.body));
    } catch (e) {
      if (e instanceof ImportError) return res.status(400).json({ error: e.message });
      throw e;
    }
  });

  api.get('/projects/:id', access(), (req, res) => {
    const p = req.project;
    res.json({
      id: p.id,
      name: p.name,
      role: req.role,
      updatedAt: p.updated_at,
      version: currentModel(p.id)?.version ?? p.version,
      members: projects.members(p.id).map((m) => ({ ...m, color: users.byEmail(m.email) ? colorFor(users.byEmail(m.email).id) : null })),
      online: presenceOf(p.id),
      session: publicView(sessionFor(req.user.id, p.id)),
    });
  });

  api.patch('/projects/:id', access('editor'), express.json(), (req, res) => {
    const name = cleanName(req.body?.name);
    if (!name) return res.status(400).json({ error: 'Name required.' });
    projects.rename(req.project.id, name);
    publish(req.project.id, { type: 'renamed', name });
    res.json({ ok: true });
  });

  api.delete('/projects/:id', access('owner'), async (req, res) => {
    await stopProjectSessions(req.project.id, null, 'This design was deleted by its owner.');
    forgetProject(req.project.id);
    projects.delete(req.project.id);
    res.json({ ok: true });
  });

  api.get('/projects/:id/download', access(), (req, res) => {
    sendOrk(res, req.project.name, currentModel(req.project.id).model);
  });

  // ---- custom motors (RASP .eng / RockSim .rse), loaded into OpenRocket's motor database

  api.get('/motors', (req, res) => {
    res.json(motors.listFor(req.user.id).map((m) => ({ id: m.id, filename: m.filename, motors: m.summary, uploadedAt: m.created_at })));
  });

  api.post('/motors', express.raw({ type: () => true, limit: '1mb' }), (req, res) => {
    let filename = 'motor.eng';
    try {
      filename = decodeURIComponent(req.get('x-filename') ?? filename).split(/[\\/]/).pop().slice(0, 120);
    } catch {
      // keep the default name
    }
    try {
      const { text, motors: found } = readMotorFile(filename, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
      if (motors.listFor(req.user.id).length >= 300) return res.status(400).json({ error: 'You can keep at most 300 motor files.' });
      const id = randomUUID();
      motors.add({ id, owner: req.user, filename, content: text, summary: found });
      res.status(201).json({ id, filename, motors: found });
    } catch (e) {
      if (e instanceof MotorFileError) return res.status(400).json({ error: e.message });
      throw e;
    }
  });

  api.get('/motors/:motorId/download', (req, res) => {
    const m = motors.get(req.params.motorId, req.user.id);
    if (!m) return res.status(404).json({ error: 'Motor file not found.' });
    res.set('content-type', 'text/plain; charset=utf-8');
    res.set('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(m.filename)}`);
    res.send(m.content);
  });

  api.delete('/motors/:motorId', (req, res) => {
    if (!motors.delete(req.params.motorId, req.user.id)) return res.status(404).json({ error: 'Motor file not found.' });
    res.json({ ok: true });
  });

  // ---- sharing

  api.post('/projects/:id/members', access('owner'), express.json(), (req, res) => {
    const email = String(req.body?.email ?? '').trim().toLowerCase();
    const role = String(req.body?.role ?? 'editor');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    if (!['editor', 'viewer'].includes(role)) return res.status(400).json({ error: 'Role must be editor or viewer.' });
    if (projects.role(req.project.id, email) === 'owner') return res.status(400).json({ error: 'That is the owner.' });
    projects.addMember(req.project.id, email, role);
    const u = users.byEmail(email);
    if (u) setRole(req.project.id, u.id, role);
    res.json({ ok: true });
  });

  api.delete('/projects/:id/members/:email', access(), async (req, res) => {
    const email = String(req.params.email).toLowerCase();
    const self = email === req.user.email.toLowerCase();
    if (!self && req.role !== 'owner') return res.status(403).json({ error: 'Only the owner can remove people.' });
    if (projects.role(req.project.id, email) === 'owner') return res.status(400).json({ error: 'The owner cannot be removed.' });
    projects.removeMember(req.project.id, email);
    const u = users.byEmail(email);
    if (u) await stopProjectSessions(req.project.id, u.id, 'You no longer have access to this design.');
    res.json({ ok: true });
  });

  // ---- edit history (who changed what, with undo / restore)

  api.get('/projects/:id/edits', access(), (req, res) => {
    const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
    const rows = edits.list(req.project.id, before, 600);
    const groups = groupEdits(rows, 40);
    const last = groups.at(-1);
    const more = last && rows.some((row) => row.version < last.from && !row.minor);
    res.json({
      groups: groups.map((g) => ({ ...g, color: colorFor(g.userId) })),
      nextBefore: more ? last.from : null,
      canRevert: req.role !== 'viewer',
    });
  });

  api.post('/projects/:id/edits/revert', access('editor'), express.json(), (req, res) => {
    const { mode, from, to, userId } = req.body ?? {};
    if (!['undo', 'restore'].includes(mode) || !Number.isInteger(from)) return res.status(400).json({ error: 'Bad request.' });
    try {
      res.json(revertEdits(req.project.id, req.user, { mode, from, to: Number(to) || from, userId: String(userId ?? '') }));
    } catch (e) {
      if (e instanceof RevertError) return res.status(409).json({ error: e.message });
      throw e;
    }
  });

  // ---- history

  api.get('/projects/:id/history', access(), (req, res) => {
    res.json(history.list(req.project.id).map((h) => ({ version: h.version, createdAt: h.created_at })));
  });

  api.get('/projects/:id/history/:version/download', access(), (req, res) => {
    const snap = history.get(req.project.id, Number(req.params.version));
    if (!snap) return res.status(404).json({ error: 'Version not found.' });
    sendOrk(res, `${req.project.name} (v${snap.version})`, fromJson(JSON.parse(snap.model)));
  });

  // ---- OpenRocket session

  api.post('/projects/:id/session', access(), express.json(), async (req, res) => {
    try {
      const s = await ensureSession(req.user, req.project, req.role, req.body ?? {});
      res.json(publicView(s));
    } catch (e) {
      if (e instanceof CapacityError) return res.status(503).json({ error: e.message });
      console.error('session start failed:', e);
      res.status(500).json({ error: 'Could not start OpenRocket. Please try again.' });
    }
  });

  api.delete('/projects/:id/session', access(), async (req, res) => {
    await stopSession(sessionFor(req.user.id, req.project.id), 'You closed the session.');
    res.json({ ok: true });
  });

  // Files saved or exported from OpenRocket (CSV, PDF, RockSim, OBJ, Save As...).
  api.get('/projects/:id/files', access(), async (req, res) => {
    res.json({ files: await listFiles(sessionFor(req.user.id, req.project.id)) });
  });

  api.get('/projects/:id/files/download', access(), async (req, res) => {
    const data = await readFile(sessionFor(req.user.id, req.project.id), String(req.query.path ?? ''));
    if (!data) return res.status(404).json({ error: 'File not found.' });
    const base = String(req.query.path).split('/').pop();
    res.set('content-type', 'application/octet-stream');
    res.set('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(base)}`);
    res.send(data);
  });

  api.get('/projects/:id/events', access(), (req, res) => {
    const s = sessionFor(req.user.id, req.project.id);
    subscribe(req.project.id, req.user.id, req, res, [
      { type: 'presence', members: presenceOf(req.project.id) },
      ...(s ? [{ type: 'session', id: s.id, state: s.state }] : []),
    ]);
  });

  api.use((err, req, res, next) => {
    if (err?.type === 'entity.too.large') return res.status(413).json({ error: `Files up to ${config.maxUploadMb} MB are supported.` });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong.' });
  });

  return api;
}
