#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import {
  copyIfExists,
  ensureDir,
  getArgValue,
} from './lib/ops-utils.mjs';

const root = process.cwd();

function usage() {
  console.log('Usage: node scripts/cribclaw-restore.mjs --from <backup-dir>');
}

function main() {
  const from = getArgValue(process.argv, '--from');
  if (!from) {
    usage();
    process.exit(1);
  }
  const backupDir = path.resolve(from);
  if (!fs.existsSync(backupDir)) {
    console.error(`Backup path not found: ${backupDir}`);
    process.exit(1);
  }

  const safetyTs = new Date().toISOString().replace(/[:.]/g, '-');
  const safetyDir = path.join(root, 'archive', 'restore-safety', `pre-restore-${safetyTs}`);
  ensureDir(safetyDir);

  // Safety snapshot of current critical runtime state before restore.
  const safetyTargets = [
    ['.env', '.env'],
    ['store/messages.db', 'store/messages.db'],
    ['store/messages.db-wal', 'store/messages.db-wal'],
    ['store/messages.db-shm', 'store/messages.db-shm'],
    ['groups', 'groups'],
    ['data/sessions', 'data/sessions'],
  ];
  for (const [srcRel, destRel] of safetyTargets) {
    const src = path.join(root, srcRel);
    const dest = path.join(safetyDir, destRel);
    ensureDir(path.dirname(dest));
    copyIfExists(src, dest);
  }

  const restoreTargets = [
    '.env',
    'store/messages.db',
    'store/messages.db-wal',
    'store/messages.db-shm',
    'store/exports',
    'store/reports',
    'groups',
    'data/sessions',
  ];

  let restored = 0;
  for (const rel of restoreTargets) {
    const src = path.join(backupDir, rel);
    const dest = path.join(root, rel);
    if (!fs.existsSync(src)) continue;
    ensureDir(path.dirname(dest));
    copyIfExists(src, dest);
    restored += 1;
  }

  console.log(`Restore complete from: ${backupDir}`);
  console.log(`Safety snapshot: ${safetyDir}`);
  console.log(`Restored targets: ${restored}`);
}

main();
