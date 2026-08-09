#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, lstat, mkdir, opendir, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

function parseArgs(argv) {
  const result = { quick: false, ordinaryMinMb: 32, force: false, usedLegacyMin: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--quick') result.quick = true;
    else if (arg === '--output') result.output = argv[++index];
    else if (arg === '--ordinary-min-mb') result.ordinaryMinMb = Number(argv[++index]);
    else if (arg === '--min-mb') {
      result.ordinaryMinMb = Number(argv[++index]);
      result.usedLegacyMin = true;
    }
    else if (arg === '--force') result.force = true;
    else if (arg === '--help' || arg === '-h') result.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function usage() {
  return [
    'Usage: node scan_macos_storage.mjs --output /absolute/path/audit.json [options]',
    '',
    'Options:',
    '  --quick       Skip recursive project and large app-data discovery',
    '  --ordinary-min-mb N',
    '                 Ordinary cache/artifact threshold in MiB (default: 32)',
    '                 Incomplete downloads use 1 MiB; installers use 100 MiB;',
    '                 large app data uses at least 350 MiB; fonts use 500 MiB',
    '  --min-mb N    Deprecated compatibility alias for --ordinary-min-mb',
    '  --force       Replace an existing audit JSON at the exact output path',
    '  --help        Show this help',
  ].join('\n');
}

function run(command, args, timeout = 120_000) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout,
    maxBuffer: 8 * MiB,
  });
  return {
    ok: result.status === 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error?.message,
  };
}

function stableId(itemPath) {
  return createHash('sha256').update(itemPath).digest('hex').slice(0, 16);
}

function isWithin(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function parseVersion(name) {
  const match = name.match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/);
  if (!match) return null;
  return match.slice(1).map((part) => Number(part || 0));
}

function compareVersions(a, b) {
  const av = parseVersion(a);
  const bv = parseVersion(b);
  for (let index = 0; index < 3; index += 1) {
    if (av[index] !== bv[index]) return av[index] - bv[index];
  }
  return a.localeCompare(b);
}

function classificationDefaults(group, priority) {
  const defaults = {
    rebuildability: priority <= 3 ? 'easy' : priority === 4 ? 'conditional' : 'no',
    impact: priority <= 2 ? 'low' : priority === 3 ? 'medium' : 'high',
    confidence: priority <= 3 ? 'high' : priority === 4 ? 'medium' : 'low',
    estimateClass: 'review',
    recommendedHandling: '先在 Finder 檢查內容與來源，再決定後續處理方式',
  };

  if (group === 'package-caches' || (group === 'runtime-caches' && priority <= 2)) {
    return {
      ...defaults,
      rebuildability: 'easy',
      impact: 'low',
      confidence: 'high',
      estimateClass: 'conservative',
      recommendedHandling: '先關閉相關工具；優先使用對應工具的官方快取管理方式',
    };
  }
  if (group === 'downloads' && priority === 1) {
    return {
      ...defaults,
      rebuildability: 'easy',
      impact: 'low',
      confidence: 'high',
      estimateClass: 'conservative',
      recommendedHandling: '確認下載已中止或不再需要，再於 Finder 中人工處理',
    };
  }
  if (group === 'app-caches') {
    return {
      ...defaults,
      rebuildability: 'easy',
      impact: 'medium',
      confidence: 'high',
      recommendedHandling: '先關閉對應 App；優先使用 App 內建的快取或下載管理功能',
    };
  }
  if (group === 'old-plugins') {
    return {
      ...defaults,
      rebuildability: 'conditional',
      impact: 'medium',
      confidence: 'medium',
      recommendedHandling: '確認目前工具沒有鎖定舊版本，再從外掛管理器處理',
    };
  }
  if (group === 'dev-artifacts') {
    return {
      ...defaults,
      rebuildability: 'easy',
      impact: 'medium',
      confidence: 'high',
      recommendedHandling: '先確認 lockfile、原始碼與建置工具完整，並停止相關開發程序',
    };
  }
  if (group === 'app-data' || group === 'manual' || group === 'anomalies') {
    return {
      ...defaults,
      rebuildability: group === 'manual' ? 'no' : 'conditional',
      impact: 'high',
      confidence: group === 'anomalies' ? 'medium' : 'low',
      recommendedHandling: '只在 Finder 或對應 App 中檢查；不要直接處理整個父資料夾',
    };
  }
  return defaults;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(`${usage()}\n`);
  process.exit(0);
}
if (!args.output) throw new Error(`--output is required\n\n${usage()}`);
if (!Number.isFinite(args.ordinaryMinMb) || args.ordinaryMinMb < 1) throw new Error('--ordinary-min-mb must be at least 1');
if (process.platform !== 'darwin') throw new Error('This scanner supports macOS only.');

const outputPath = path.resolve(args.output);
const home = os.homedir();
const minimumBytes = args.ordinaryMinMb * MiB;
const candidates = [];
const unreadable = [];
const unreadableSeen = new Set();
let unreadableTotal = 0;
const warnings = [];
const measured = new Map();
if (args.usedLegacyMin) warnings.push('--min-mb is a compatibility alias; use --ordinary-min-mb to make its limited scope explicit.');

function noteUnreadable(itemPath, error) {
  const message = String(error?.code || error?.message || error);
  if (message === 'ENOENT' || /No such file/i.test(message)) return;
  const key = `${itemPath}\u0000${message}`;
  if (unreadableSeen.has(key)) return;
  unreadableSeen.add(key);
  unreadableTotal += 1;
  if (unreadable.length < 40) unreadable.push({ path: itemPath, error: message });
}

function allocatedFileBytes(info) {
  if (!info?.isFile()) return null;
  if (Number.isFinite(info.blocks)) return Math.max(0, Number(info.blocks) * 512);
  return info.size;
}

async function exists(itemPath) {
  try {
    await access(itemPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

if (!args.force && await exists(outputPath)) {
  throw new Error(`${outputPath} already exists. Choose a new output path or pass --force.`);
}

async function listDirectories(root, recordFailure = false) {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink());
  } catch (error) {
    if (recordFailure && error.code !== 'ENOENT') noteUnreadable(root, error);
    return [];
  }
}

async function measure(itemPath, timeout = 120_000) {
  if (measured.has(itemPath)) return measured.get(itemPath);
  let value = 0;
  try {
    const info = await lstat(itemPath);
    if (info.isSymbolicLink()) return 0;
    if (info.isFile()) value = info.size;
    else {
      const result = run('/usr/bin/du', ['-sk', itemPath], timeout);
      const match = result.stdout.match(/^\s*(\d+)/);
      if (match) value = Number(match[1]) * 1024;
      else if (!result.ok) noteUnreadable(itemPath, result.error || result.stderr.trim() || 'du failed');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') noteUnreadable(itemPath, error);
  }
  if (value > 0) measured.set(itemPath, value);
  return value;
}

async function addCandidate({
  label,
  group,
  priority,
  itemPath,
  reason,
  sizeBytes,
  matchedRule = 'ordinary-size-threshold',
  thresholdBytes = minimumBytes,
  rebuildability,
  impact,
  confidence,
  estimateClass,
  recommendedHandling,
  logicalSizeBytes,
}) {
  const resolved = path.resolve(itemPath);
  if (resolved === outputPath || isWithin(outputPath, resolved)) return false;
  if (!(await exists(resolved))) return false;

  const nested = candidates.some((candidate) => isWithin(resolved, candidate.path));
  const containsExisting = candidates.some((candidate) => isWithin(candidate.path, resolved));
  if (nested || containsExisting) return false;

  const defaults = classificationDefaults(group, priority);
  let modifiedAt = null;
  let itemKind = 'unknown';
  let info = null;
  try {
    info = await lstat(resolved);
    modifiedAt = info.mtime.toISOString();
    itemKind = info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other';
  } catch (error) {
    noteUnreadable(resolved, error);
  }
  let bytes = sizeBytes ?? (await measure(resolved));
  if (info?.isFile()) {
    logicalSizeBytes = logicalSizeBytes ?? info.size;
    bytes = allocatedFileBytes(info);
  }
  if (!Number.isFinite(bytes) || bytes <= 0) return false;
  candidates.push({
    id: stableId(resolved),
    label,
    group,
    priority,
    sizeBytes: Math.round(bytes),
    path: resolved,
    reason,
    matchedRule,
    thresholdBytes,
    rebuildability: rebuildability || defaults.rebuildability,
    impact: impact || defaults.impact,
    confidence: confidence || defaults.confidence,
    estimateClass: estimateClass || defaults.estimateClass,
    recommendedHandling: recommendedHandling || defaults.recommendedHandling,
    modifiedAt,
    itemKind,
    logicalSizeBytes: logicalSizeBytes ?? null,
  });
  return true;
}

function diskUsage() {
  const preferred = '/System/Volumes/Data';
  const target = run('/bin/df', ['-kP', preferred]).ok ? preferred : '/';
  const result = run('/bin/df', ['-kP', target]);
  const lines = result.stdout.trim().split('\n');
  const fields = lines.at(-1)?.trim().split(/\s+/) || [];
  if (!result.ok || fields.length < 6) {
    warnings.push(`Could not parse disk usage for ${target}.`);
    return { mount: target, totalBytes: 0, usedBytes: 0, freeBytes: 0 };
  }
  return {
    mount: fields.slice(5).join(' '),
    totalBytes: Number(fields[1]) * 1024,
    usedBytes: Number(fields[2]) * 1024,
    freeBytes: Number(fields[3]) * 1024,
  };
}

async function scanKnownPackageCaches() {
  const known = [
    ['.npm/_cacache', 'npm 下載快取', 'package-caches', 2, 'npm 可重新下載的套件內容'],
    ['.npm/_npx', 'npx 暫存環境', 'package-caches', 1, 'npx 臨時建立的執行環境'],
    ['.bun/install/cache', 'Bun 套件快取', 'package-caches', 2, 'Bun 可重新下載的套件內容'],
    ['.yarn/cache', 'Yarn 套件快取', 'package-caches', 2, 'Yarn 可重新下載的套件內容'],
    ['.pnpm-store', 'pnpm 套件儲存區', 'package-caches', 2, 'pnpm 共用套件內容；清理後需重新下載'],
    ['.cargo/registry/cache', 'Cargo registry 快取', 'package-caches', 2, 'Rust 套件下載快取'],
    ['.cargo/git/checkouts', 'Cargo Git checkouts', 'package-caches', 3, 'Cargo 建立的來源 checkout'],
    ['anaconda3/pkgs', 'Anaconda 套件快取', 'package-caches', 2, 'Conda 已下載的套件封存與解壓內容'],
    ['miniconda3/pkgs', 'Miniconda 套件快取', 'package-caches', 2, 'Conda 已下載的套件封存與解壓內容'],
    ['.conda/pkgs', 'Conda 使用者套件快取', 'package-caches', 2, 'Conda 可重新取得的套件內容'],
    ['.codex/tmp', 'Codex 暫存資料', 'runtime-caches', 1, 'Codex 執行時暫存內容'],
  ];

  for (const [relative, label, group, priority, reason] of known) {
    const itemPath = path.join(home, relative);
    const sizeBytes = await measure(itemPath);
    if (sizeBytes >= minimumBytes) await addCandidate({ label, group, priority, itemPath, reason, sizeBytes });
  }
}

async function scanCacheRoot(root, group, reason) {
  for (const entry of await listDirectories(root, true)) {
    if (entry.name === 'Caches' || entry.name.startsWith('com.apple.')) continue;
    const itemPath = path.join(root, entry.name);
    const sizeBytes = await measure(itemPath);
    if (sizeBytes < minimumBytes) continue;
    await addCandidate({
      label: `${entry.name} 快取`,
      group,
      priority: 2,
      itemPath,
      reason,
      sizeBytes,
    });
  }
}

async function scanVersionedPlugins(root, depth = 5) {
  if (depth < 0 || !(await exists(root))) return;
  const entries = await listDirectories(root);
  const versions = entries.map((entry) => entry.name).filter(parseVersion).sort(compareVersions);

  if (versions.length > 1) {
    const current = versions.at(-1);
    for (const oldVersion of versions.slice(0, -1)) {
      const itemPath = path.join(root, oldVersion);
      const sizeBytes = await measure(itemPath);
      if (sizeBytes >= minimumBytes) {
        await addCandidate({
          label: `${path.basename(path.dirname(root))}/${path.basename(root)} ${oldVersion}`,
          group: 'old-plugins',
          priority: 1,
          itemPath,
          reason: `同層已有較新版本 ${current}；仍需確認目前工具未鎖定舊版`,
          sizeBytes,
        });
      }
    }
  }

  for (const entry of entries) {
    if (versions.includes(entry.name) && entry.name !== versions.at(-1)) continue;
    await scanVersionedPlugins(path.join(root, entry.name), depth - 1);
  }
}

async function scanDownloads() {
  const root = path.join(home, 'Downloads');
  const incompleteExtensions = new Set(['.crdownload', '.download', '.part']);
  const largeExtensions = new Set(['.dmg', '.pkg', '.zip', '.xip', '.iso']);

  async function visit(directory, depth) {
    if (depth < 0) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      noteUnreadable(directory, error);
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const itemPath = path.join(directory, entry.name);
      const extension = path.extname(entry.name).toLowerCase();
      if (entry.isDirectory()) {
        if (extension === '.app') {
          const sizeBytes = await measure(itemPath);
          if (sizeBytes >= 100 * MiB) await addCandidate({
            label: `Downloads 內的 ${entry.name}`,
            group: 'downloads',
            priority: 4,
            itemPath,
            reason: '下載資料夾中的大型 App；先確認是否仍需安裝或封存',
            sizeBytes,
            matchedRule: 'large-downloaded-app',
            thresholdBytes: 100 * MiB,
          });
        } else {
          await visit(itemPath, depth - 1);
        }
      } else if (entry.isFile()) {
        let info;
        try { info = await stat(itemPath); } catch { continue; }
        if (incompleteExtensions.has(extension) && info.size >= MiB) {
          await addCandidate({
            label: `未完成下載：${entry.name}`,
            group: 'downloads',
            priority: 1,
            itemPath,
            reason: '瀏覽器或下載工具留下的未完成檔案',
            sizeBytes: info.size,
            matchedRule: 'incomplete-download-extension',
            thresholdBytes: MiB,
          });
        } else if (largeExtensions.has(extension) && info.size >= 100 * MiB) {
          await addCandidate({
            label: `大型下載：${entry.name}`,
            group: 'downloads',
            priority: 4,
            itemPath,
            reason: '大型安裝檔或封存檔；確認不再需要後才處理',
            sizeBytes: info.size,
            matchedRule: 'large-downloaded-installer-or-archive',
            thresholdBytes: 100 * MiB,
          });
        }
      }
    }
  }
  await visit(root, 3);
}

async function scanLargeAnomalies(quick) {
  const fullRoots = [
    [path.join(home, 'Library/Logs'), 6, 'app'],
    [path.join(home, 'Library/Application Support'), 6, 'app'],
    [path.join(home, 'Library/Containers'), 7, 'app'],
    [path.join(home, 'Library/Group Containers'), 7, 'app'],
    [path.join(home, '.codex'), 6, 'tool'],
    [path.join(home, '.claude'), 6, 'tool'],
    [path.join(home, 'Downloads'), 4, 'personal'],
    [path.join(home, 'Desktop'), 6, 'personal'],
    [path.join(home, 'Documents'), 7, 'personal'],
  ];
  const quickRoots = fullRoots.filter(([root]) => [
    path.join(home, 'Downloads'),
    path.join(home, 'Library/Logs'),
    path.join(home, '.codex'),
    path.join(home, '.claude'),
  ].includes(root)).map(([root, depth, context]) => [root, Math.min(depth, 4), context]);
  const roots = quick ? quickRoots : fullRoots;
  const skipNames = new Set([
    '.git', 'node_modules', 'CloudStorage', 'Mobile Documents', 'Mail', 'Messages',
    'Safari', '.Trash', 'Photos Library.photoslibrary', 'Music Library.musiclibrary',
  ]);
  const mediaExtensions = new Set(['.mp4', '.mov', '.mkv', '.avi', '.m4v', '.webm']);
  const archiveExtensions = new Set(['.dmg', '.pkg', '.zip', '.xip', '.iso', '.tar', '.gz', '.7z']);
  const directorySignal = /(^|[._ -])(cache|caches|downloads?|offline|videos?|media|temp|tmp)([._ -]|$)/i;
  const outputDirectory = path.dirname(outputPath);
  const entryLimitPerRoot = quick ? 30_000 : 60_000;
  const duCallLimitPerRoot = quick ? 8 : 16;
  const duWallBudgetMsPerRoot = quick ? 30_000 : 60_000;
  let rootVisitedEntries = 0;
  let rootCapped = false;
  let rootDuCalls = 0;
  let rootDuCapped = false;
  let rootStartedAt = 0;
  const cappedRoots = [];
  const duCappedRoots = [];

  function coveredByCandidate(itemPath) {
    return candidates.some((candidate) => isWithin(itemPath, candidate.path));
  }

  function containsCandidate(itemPath) {
    return candidates.some((candidate) => isWithin(candidate.path, itemPath));
  }

  async function visit(directory, remainingDepth, context, rootDepth = true) {
    if (remainingDepth < 0 || rootCapped || isWithin(directory, outputDirectory) || coveredByCandidate(directory)) return;
    const baseName = path.basename(directory);

    const signalDirectory = !rootDepth && directorySignal.test(baseName) && !containsCandidate(directory);
    const duBudgetAvailable = rootDuCalls < duCallLimitPerRoot && Date.now() - rootStartedAt < duWallBudgetMsPerRoot;
    if (signalDirectory && duBudgetAvailable) {
      rootDuCalls += 1;
      const sizeBytes = await measure(directory, quick ? 10_000 : 20_000);
      if (sizeBytes >= 2 * GiB) {
        const added = await addCandidate({
          label: `疑似大型離線／媒體／快取目錄：${baseName}`,
          group: context === 'app' ? 'app-data' : 'anomalies',
          priority: 4,
          itemPath: directory,
          reason: '資料夾名稱與容量顯示可能是離線內容、媒體或大型暫存；只根據中繼資料判斷，未讀取檔案內容',
          sizeBytes,
          matchedRule: 'large-offline-media-or-cache-directory',
          thresholdBytes: 2 * GiB,
          rebuildability: 'conditional',
          impact: 'high',
          confidence: 'medium',
          estimateClass: 'review',
          recommendedHandling: context === 'app'
            ? '優先從對應 App 的下載／離線內容管理介面檢查，不要處理整個 App Container'
            : '在 Finder 中確認內容與來源；個人媒體不應自動處理',
        });
        if (added) return;
      }
    } else if (signalDirectory) {
      rootDuCapped = true;
    }

    let directoryHandle;
    try {
      directoryHandle = await opendir(directory);
    } catch (error) {
      noteUnreadable(directory, error);
      return;
    }
    try {
      for await (const entry of directoryHandle) {
        rootVisitedEntries += 1;
        if (rootVisitedEntries > entryLimitPerRoot) {
          rootCapped = true;
          break;
        }
        if (entry.isSymbolicLink()) continue;
        const itemPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (skipNames.has(entry.name) || entry.name.endsWith('.app') || entry.name.endsWith('.photoslibrary')) continue;
          if (entry.name.startsWith('.') && !['.cache'].includes(entry.name)) continue;
          await visit(itemPath, remainingDepth - 1, context, false);
          continue;
        }
        if (!entry.isFile() || coveredByCandidate(itemPath)) continue;

        let info;
        try { info = await stat(itemPath); } catch { continue; }
        const extension = path.extname(entry.name).toLowerCase();
        const lowerName = entry.name.toLowerCase();
        const allocatedBytes = allocatedFileBytes(info);

        if ((extension === '.log' || lowerName.endsWith('.log.0')) && info.size >= 256 * MiB && allocatedBytes >= 64 * MiB) {
          await addCandidate({
            label: `異常大型 Log：${entry.name}`,
            group: 'anomalies',
            priority: 2,
            itemPath,
            reason: '單一 Log 明顯偏大；可能是持續寫入、未輪替或錯誤重試造成，未讀取日誌內容',
            sizeBytes: info.size,
            matchedRule: 'oversized-log-file',
            thresholdBytes: 256 * MiB,
            rebuildability: 'easy',
            impact: 'medium',
            confidence: 'high',
            estimateClass: 'review',
            recommendedHandling: '先找出並關閉寫入它的程序，再使用該 App 或工具的日誌管理方式處理',
          });
        } else if (['.tmp', '.temp', '.part', '.download', '.crdownload'].includes(extension) && info.size >= 256 * MiB && allocatedBytes >= 64 * MiB) {
          await addCandidate({
            label: `大型暫存／未完成檔：${entry.name}`,
            group: 'anomalies',
            priority: 2,
            itemPath,
            reason: '副檔名顯示為暫存或未完成內容；仍需確認沒有程序正在使用',
            sizeBytes: info.size,
            matchedRule: 'oversized-temporary-file',
            thresholdBytes: 256 * MiB,
            rebuildability: 'easy',
            impact: 'medium',
            confidence: 'high',
            estimateClass: 'review',
            recommendedHandling: '先關閉相關 App 並確認下載或工作已中止，再於 Finder 檢查',
          });
        } else if (context === 'app' && mediaExtensions.has(extension) && info.size >= GiB && allocatedBytes >= 256 * MiB) {
          await addCandidate({
            label: `App 資料中的大型媒體：${entry.name}`,
            group: 'app-data',
            priority: 4,
            itemPath,
            reason: 'App 支援目錄中的大型媒體檔，可能是離線下載或使用者內容；只讀取容量與路徑',
            sizeBytes: info.size,
            matchedRule: 'large-media-inside-app-data',
            thresholdBytes: GiB,
            rebuildability: 'conditional',
            impact: 'high',
            confidence: 'medium',
            estimateClass: 'review',
            recommendedHandling: '優先從對應 App 的離線下載管理功能確認，不要直接處理父資料夾',
          });
        } else if (archiveExtensions.has(extension) && info.size >= GiB && allocatedBytes >= 256 * MiB) {
          await addCandidate({
            label: `大型安裝／封存檔：${entry.name}`,
            group: 'anomalies',
            priority: 4,
            itemPath,
            reason: '大型安裝或封存檔；可能仍是備份或工作交付物，只列入人工檢查',
            sizeBytes: info.size,
            matchedRule: 'large-installer-or-archive-anywhere',
            thresholdBytes: GiB,
            rebuildability: 'conditional',
            impact: 'high',
            confidence: 'medium',
            estimateClass: 'review',
          });
        } else if (info.size >= 5 * GiB && allocatedBytes >= 512 * MiB) {
          await addCandidate({
            label: `超大型單檔：${entry.name}`,
            group: 'manual',
            priority: 5,
            itemPath,
            reason: '單一檔案超過 5 GiB；可能是重要個人資料、模型、資料庫或虛擬磁碟，只做容量異常提示',
            sizeBytes: info.size,
            matchedRule: 'very-large-single-file',
            thresholdBytes: 5 * GiB,
            rebuildability: 'no',
            impact: 'high',
            confidence: 'low',
            estimateClass: 'review',
            recommendedHandling: '只在 Finder 中辨識用途；不要因容量大就認定可移除',
          });
        }
      }
    } catch (error) {
      noteUnreadable(directory, error);
    }
  }

  for (const [root, depth, context] of roots) {
    rootVisitedEntries = 0;
    rootCapped = false;
    rootDuCalls = 0;
    rootDuCapped = false;
    rootStartedAt = Date.now();
    if (await exists(root)) await visit(root, depth, context, true);
    if (rootCapped) cappedRoots.push(root);
    if (rootDuCapped) duCappedRoots.push(root);
  }
  if (cappedRoots.length) warnings.push(`Large-anomaly metadata scan reached the ${entryLimitPerRoot}-entry per-root limit for: ${cappedRoots.join(', ')}. Those roots are partial.`);
  if (duCappedRoots.length) warnings.push(`Large-anomaly directory-size probing reached its per-root du budget for: ${duCappedRoots.join(', ')}. Signal-named directories in those roots are partial.`);
}

async function scanDeveloperArtifacts() {
  const roots = ['Desktop', 'Documents', 'Developer', 'Projects', 'Code', 'Workspace', 'Workspaces']
    .map((name) => path.join(home, name));
  const artifactNames = new Set(['node_modules', '.next', '.nuxt', '.svelte-kit', 'dist', 'build', 'target', 'DerivedData']);
  const skipNames = new Set(['Library', 'Applications', 'Pictures', 'Photos Library.photoslibrary', 'Music', 'Movies', '.Trash', 'CloudStorage', 'Mobile Documents']);

  async function visit(directory, depth) {
    if (depth < 0 || isWithin(directory, path.dirname(outputPath))) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || skipNames.has(entry.name)) continue;
      const itemPath = path.join(directory, entry.name);
      if (artifactNames.has(entry.name)) {
        const sizeBytes = await measure(itemPath);
        if (sizeBytes >= minimumBytes) await addCandidate({
          label: `${path.basename(directory)} / ${entry.name}`,
          group: 'dev-artifacts',
          priority: 3,
          itemPath,
          reason: '通常可由專案依賴或建置流程重建；先確認專案仍可正常還原',
          sizeBytes,
        });
        continue;
      }
      if (entry.name === '.git') {
        const sizeBytes = await measure(itemPath);
        if (sizeBytes >= 2 * GiB) await addCandidate({
          label: `${path.basename(directory)} 的大型 Git 資料`,
          group: 'git',
          priority: 4,
          itemPath,
          reason: 'Git 物件異常龐大；應在該 repository 內檢查歷史與 refs，不可直接刪除資料夾',
          sizeBytes,
          matchedRule: 'large-git-metadata',
          thresholdBytes: 2 * GiB,
        });
        continue;
      }
      if (entry.name.startsWith('.')) continue;
      await visit(itemPath, depth - 1);
    }
  }

  for (const root of roots) if (await exists(root)) await visit(root, 8);
}

async function scanLargeAppData() {
  const roots = [
    [path.join(home, 'Library/Application Support'), 'app-data'],
    [path.join(home, 'Library/Containers'), 'app-data'],
    [path.join(home, 'Library/Group Containers'), 'app-data'],
  ];
  const threshold = Math.max(350 * MiB, minimumBytes);
  for (const [root, group] of roots) {
    for (const entry of await listDirectories(root, true)) {
      if (entry.name === 'Caches' || entry.name.startsWith('com.apple.')) continue;
      const itemPath = path.join(root, entry.name);
      const sizeBytes = await measure(itemPath);
      if (sizeBytes < threshold) continue;
      await addCandidate({
        label: `大型 App 資料：${entry.name}`,
        group,
        priority: 4,
        itemPath,
        reason: '容量較大的 App 支援資料；可能含重要設定、離線內容或資料庫，只供人工確認',
        sizeBytes,
        matchedRule: 'large-app-support-data',
        thresholdBytes: threshold,
      });
    }
  }
}

async function scanKnownDeveloperData() {
  const items = [
    [path.join(home, 'Library/Developer/CoreSimulator/Caches'), 'Simulator 快取', 2, 'Xcode Simulator 可重建的快取'],
    [path.join(home, 'Library/Developer/Xcode/DerivedData'), 'Xcode DerivedData', 3, 'Xcode 建置產物與索引，可在需要時重建'],
    [path.join(home, 'Library/Developer/CoreSimulator/Devices'), 'Simulator 裝置資料', 4, '可能含仍在使用的模擬器與測試資料；需在 Xcode 情境下確認'],
    ['/Library/Updates', 'macOS 更新暫存', 3, '系統更新下載內容；應先確認沒有進行中的系統更新'],
  ];
  for (const [itemPath, label, priority, reason] of items) {
    const sizeBytes = await measure(itemPath);
    if (sizeBytes >= minimumBytes) await addCandidate({
      label,
      group: itemPath.includes('Simulator') ? 'simulator' : 'runtime-caches',
      priority,
      itemPath,
      reason,
      sizeBytes,
    });
  }
}

async function scanManualCollections() {
  const fonts = path.join(home, 'Library/Fonts');
  const sizeBytes = await measure(fonts);
  if (sizeBytes >= 500 * MiB) await addCandidate({
    label: '大型字型庫／可能重複字型',
    group: 'manual',
    priority: 5,
    itemPath: fonts,
    reason: '個人字型可能有授權或工作流程用途；僅列出容量，需人工逐一檢查',
    sizeBytes,
    matchedRule: 'large-font-library',
    thresholdBytes: 500 * MiB,
  });
}

async function inspectProtectedRoots() {
  const roots = [
    'Library/Mail',
    'Library/Messages',
    'Library/Safari',
    'Library/Application Support/MobileSync',
    'Pictures/Photos Library.photoslibrary',
    '.Trash',
  ].map((relative) => path.join(home, relative));
  for (const root of roots) {
    if (!(await exists(root))) continue;
    try {
      await readdir(root);
    } catch (error) {
      noteUnreadable(root, error);
    }
  }
}

await scanKnownPackageCaches();
await scanCacheRoot(path.join(home, '.cache'), 'runtime-caches', '使用者層工具快取；通常可重新建立');
await scanCacheRoot(path.join(home, 'Library/Caches'), 'app-caches', 'App 快取；清理後可能需要重新登入、下載或建立索引');
await scanCacheRoot(path.join(home, 'Library/Application Support/Caches'), 'app-caches', 'App 支援目錄中的快取；需確認對應 App 狀態');
await scanVersionedPlugins(path.join(home, '.claude/plugins/cache'));
await scanVersionedPlugins(path.join(home, '.codex/plugins/cache'));
await scanDownloads();
await scanKnownDeveloperData();
await scanLargeAnomalies(args.quick);
await scanManualCollections();
await inspectProtectedRoots();

if (!args.quick) {
  await scanDeveloperArtifacts();
  await scanLargeAppData();
}

candidates.sort((a, b) => a.priority - b.priority || b.sizeBytes - a.sizeBytes || a.path.localeCompare(b.path));
const volume = diskUsage();
const candidateBytes = candidates.reduce((sum, candidate) => sum + candidate.sizeBytes, 0);
const conservativeCandidates = candidates.filter((candidate) => candidate.estimateClass === 'conservative');
const reviewCandidates = candidates.filter((candidate) => candidate.estimateClass !== 'conservative');
const conservativeBytes = conservativeCandidates.reduce((sum, candidate) => sum + candidate.sizeBytes, 0);
const reviewBytes = reviewCandidates.reduce((sum, candidate) => sum + candidate.sizeBytes, 0);
if (volume.usedBytes && candidateBytes > volume.usedBytes) {
  warnings.push('Candidate estimates exceed reported used bytes. APFS clones, hard links, mounts, or measurement overlap may be involved; do not treat the sum as guaranteed reclaimable space.');
}

const snapshots = run('/usr/bin/tmutil', ['listlocalsnapshots', '/'], 30_000);
const localSnapshots = snapshots.ok
  ? snapshots.stdout.split('\n').map((line) => line.trim()).filter((line) => line.includes('com.apple.TimeMachine'))
  : [];

const audit = {
  schemaVersion: 1,
  scannedAt: new Date().toISOString(),
  host: { hostname: os.hostname(), platform: process.platform, release: os.release() },
  volume,
  summary: {
    candidateBytes,
    possibleBytes: candidateBytes,
    conservativeBytes,
    reviewBytes,
    candidateCount: candidates.length,
    conservativeCount: conservativeCandidates.length,
    reviewCount: reviewCandidates.length,
  },
  scanMeta: {
    mode: args.quick ? 'quick' : 'full',
    ordinaryMinimumBytes: minimumBytes,
    unreadable,
    unreadableTotal,
    unreadableOmitted: Math.max(0, unreadableTotal - unreadable.length),
    localSnapshots,
    warnings,
    notes: [
      'All source inspection was read-only. Only this JSON output was written.',
      'Candidate sizes are estimates and are not guaranteed reclaimable bytes.',
      'Conservative candidates have high rebuild confidence and low expected impact, but still require human confirmation.',
      'Large app data and personal collections require manual context before any later action.',
    ],
  },
  candidates,
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(audit, null, 2)}\n`, { encoding: 'utf8', flag: args.force ? 'w' : 'wx' });
process.stdout.write(`Audit written to ${outputPath}\n`);
process.stdout.write(`Candidates: ${candidates.length}; estimated candidate bytes: ${candidateBytes}\n`);
process.stdout.write(`Unreadable/protected locations recorded: ${unreadableTotal} (${unreadable.length} included in JSON)\n`);
