// Live smoke test of a deployed app (as the developer signed in to the Base44 CLI):
//   node test/live/make-script.mjs && cat test/live/actor-check.js | base44 exec
//   node test/live/landing.mjs https://<app>.base44.app
// Writes test/live/actor-check.js: a script for `base44 exec` that checks the deployed
// DesignRoom actor and the Design access rules as the signed-in developer.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { importOrk } from '../../src/lib/ork.js';
import { toJson } from '../../../server/src/model.js';

const model = toJson(await importOrk(new Uint8Array(readFileSync(join(import.meta.dirname, '..', '..', '..', 'server', 'templates', 'new-rocket.ork')))));
const body = readFileSync(join(import.meta.dirname, 'actor-check.template.js'), 'utf8');
writeFileSync(join(import.meta.dirname, 'actor-check.js'), `const MODEL = ${JSON.stringify(model)};\n${body}`);
