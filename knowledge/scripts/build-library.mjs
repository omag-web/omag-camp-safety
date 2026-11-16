#!/usr/bin/env node
// Builds Ranger's statute library on this computer and writes backend/data/library.json
// (the copy that ships with each deploy).
//
//   node knowledge/scripts/build-library.mjs
//
// Day to day, the library is rebuilt in AWS from the admin panel (Statute library →
// Rebuild now) using the sources edited there. This script uses knowledge/sources.json.
// Needs network access to oklegislature.gov and ecfr.gov, and `pdftotext` (poppler-utils).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildLibrary } from './build.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(root, 'backend', 'data', 'library.json');
const SOURCES = process.argv[2] || join(root, 'knowledge', 'sources.json');

const cfg = JSON.parse(await readFile(SOURCES, 'utf8'));
const { library } = await buildLibrary(cfg);
await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(library));
console.log(`Wrote ${OUT}`);
