// Design templates on disk for the Node server; file reading/writing lives in orkfile.js.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { importOrk, ImportError } from './orkfile.js';

export { importOrk, exportOrk, ImportError, modelJson } from './orkfile.js';

// ------------------------------------------------------------------ templates

export function blankModel() {
  const xml = readFileSync(join(config.templatesDir, 'new-rocket.ork'));
  return importOrk(xml);
}

const examplesDir = () => join(config.templatesDir, 'examples');

export function listExamples() {
  if (!existsSync(examplesDir())) return [];
  return readdirSync(examplesDir()).filter((f) => f.endsWith('.ork')).sort().map((f) => f.replace(/\.ork$/, ''));
}

export function exampleModel(name) {
  if (!listExamples().includes(name)) throw new ImportError('Unknown example.');
  return importOrk(readFileSync(join(examplesDir(), `${name}.ork`)));
}

