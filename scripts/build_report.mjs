#!/usr/bin/env node

import { constants as fsConstants } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function parseArgs(argv) {
  const result = { force: false, port: 43177 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--audit') result.audit = argv[++index];
    else if (arg === '--output') result.output = argv[++index];
    else if (arg === '--port') result.port = Number(argv[++index]);
    else if (arg === '--force') result.force = true;
    else if (arg === '--help' || arg === '-h') result.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function usage() {
  return [
    'Usage: node build_report.mjs --audit /path/audit.json --output /path/report [options]',
    '',
    'Options:',
    '  --port N      Default localhost bridge port (default: 43177)',
    '  --force       Replace this tool\'s generated files if they already exist',
    '  --help        Show this help',
  ].join('\n');
}

function isWithin(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function validateAudit(audit) {
  if (!audit || audit.schemaVersion !== 1) throw new Error('Unsupported or missing audit schemaVersion.');
  if (!audit.volume || !Array.isArray(audit.candidates)) throw new Error('Audit must contain volume and candidates.');
  const ids = new Set();
  const paths = new Set();
  const allowed = {
    rebuildability: new Set(['easy', 'conditional', 'no']),
    impact: new Set(['low', 'medium', 'high']),
    confidence: new Set(['low', 'medium', 'high']),
    estimateClass: new Set(['conservative', 'review']),
  };
  for (const item of audit.candidates) {
    if (!item || typeof item.id !== 'string' || typeof item.path !== 'string' || !path.isAbsolute(item.path)) {
      throw new Error('Every candidate needs a string ID and absolute path.');
    }
    if (!Number.isFinite(item.sizeBytes) || item.sizeBytes <= 0) throw new Error(`Invalid size for ${item.id}.`);
    if (!Number.isInteger(item.priority) || item.priority < 1 || item.priority > 5) throw new Error(`Invalid priority for ${item.id}.`);
    for (const [field, values] of Object.entries(allowed)) {
      if (item[field] !== undefined && !values.has(item[field])) throw new Error(`Invalid ${field} for ${item.id}.`);
    }
    if (ids.has(item.id)) throw new Error(`Duplicate candidate ID: ${item.id}`);
    if (paths.has(item.path)) throw new Error(`Duplicate candidate path: ${item.path}`);
    ids.add(item.id);
    paths.add(item.path);
  }
  for (let left = 0; left < audit.candidates.length; left += 1) {
    for (let right = left + 1; right < audit.candidates.length; right += 1) {
      const a = audit.candidates[left].path;
      const b = audit.candidates[right].path;
      if (isWithin(a, b) || isWithin(b, a)) throw new Error(`Nested candidates are not allowed: ${a} <> ${b}`);
    }
  }
  if (audit.summary?.conservativeBytes !== undefined || audit.summary?.reviewBytes !== undefined) {
    const total = audit.candidates.reduce((sum, item) => sum + item.sizeBytes, 0);
    const split = Number(audit.summary.conservativeBytes || 0) + Number(audit.summary.reviewBytes || 0);
    if (!Number.isFinite(split) || Math.abs(split - total) > audit.candidates.length) {
      throw new Error('Conservative and review byte totals do not reconcile with candidates.');
    }
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(`${usage()}\n`);
  process.exit(0);
}
if (!args.audit || !args.output) throw new Error(`--audit and --output are required\n\n${usage()}`);
if (!Number.isInteger(args.port) || args.port < 1024 || args.port > 65535) throw new Error('--port must be an integer from 1024 to 65535');

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const skillDirectory = path.dirname(sourceDirectory);
const templatePath = path.join(skillDirectory, 'assets/report-template.html');
const bridgePath = path.join(sourceDirectory, 'finder_bridge.mjs');
const auditPath = path.resolve(args.audit);
const outputDirectory = path.resolve(args.output);
const indexPath = path.join(outputDirectory, 'index.html');
const generatedBridgePath = path.join(outputDirectory, 'finder-bridge.mjs');
const launcherPath = path.join(outputDirectory, 'launch.command');

if (!args.force) {
  for (const target of [indexPath, generatedBridgePath, launcherPath]) {
    try {
      await stat(target);
      throw new Error(`${target} already exists. Choose a new output directory or pass --force.`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

const audit = JSON.parse(await readFile(auditPath, 'utf8'));
validateAudit(audit);
const template = await readFile(templatePath, 'utf8');
if (!template.includes('__AUDIT_DATA__')) throw new Error('Report template is missing the audit data placeholder.');

const embedded = JSON.stringify(audit).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
const html = template.replace('__AUDIT_DATA__', embedded);
const launcher = `#!/bin/zsh
set -eu
SCRIPT_DIR="\${0:A:h}"
cd "$SCRIPT_DIR"
export AUDIT_PORT="\${AUDIT_PORT:-${args.port}}"
node finder-bridge.mjs &
BRIDGE_PID=$!
trap 'kill "$BRIDGE_PID" 2>/dev/null || true' EXIT INT TERM
sleep 0.7
/usr/bin/open "http://127.0.0.1:$AUDIT_PORT/"
wait "$BRIDGE_PID"
`;

await mkdir(outputDirectory, { recursive: true });
await writeFile(indexPath, html, { encoding: 'utf8', flag: args.force ? 'w' : 'wx' });
await copyFile(bridgePath, generatedBridgePath, args.force ? 0 : fsConstants.COPYFILE_EXCL);
await writeFile(launcherPath, launcher, { encoding: 'utf8', flag: args.force ? 'w' : 'wx' });
await chmod(launcherPath, 0o755);

process.stdout.write(`Report written to ${outputDirectory}\n`);
process.stdout.write(`Open index.html for read-only browsing, or run launch.command for Finder Reveal.\n`);
