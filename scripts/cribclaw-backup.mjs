#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import {
  copyIfExists,
  ensureDir,
  getArgValue,
} from './lib/ops-utils.mjs';

const root = process.cwd();
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const defaultOut = path.join(root, 'archive', 'runtime-backups', `backup-${timestamp}`);

function main() {
  const outDir = path.resolve(getArgValue(process.argv, '--out') || defaultOut);
  ensureDir(outDir);

  const copied = [];
  const targets = [
    ['.env', '.env'],
    ['store/messages.db', 'store/messages.db'],
    ['store/messages.db-wal', 'store/messages.db-wal'],
    ['store/messages.db-shm', 'store/messages.db-shm'],
    ['store/exports', 'store/exports'],
    ['store/reports', 'store/reports'],
    ['groups', 'groups'],
    ['data/sessions', 'data/sessions'],
  ];

  for (const [srcRel, destRel] of targets) {
    const src = path.join(root, srcRel);
    const dest = path.join(outDir, destRel);
    ensureDir(path.dirname(dest));
    if (copyIfExists(src, dest)) {
      copied.push(srcRel);
    }
  }

  const manifest = {
    createdAt: new Date().toISOString(),
    sourceRoot: root,
    backupPath: outDir,
    copied,
  };
  fs.writeFileSync(
    path.join(outDir, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf8',
  );

  console.log(`Backup created: ${outDir}`);
  console.log(`Copied: ${copied.length} target(s)`);
}

main();
