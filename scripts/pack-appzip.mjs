// SPDX-License-Identifier: GPL-3.0-or-later
// Build the small "app-only" delta zip that accompanies the full release zip.
//
// Runs AFTER electron-builder (so dist/win-unpacked exists). Almost every update
// changes only our code, which electron-builder bundles into resources/app.asar
// (the ~216MB Electron exe + DLLs are unchanged unless we bump Electron). This
// zips just the resources/ subtree - keeping the same internal layout as the full
// zip (resources/app.asar) so the updater's applier can robocopy it over the
// install dir with no special-casing.
//
// The Electron runtime version is baked into the filename
// (Cathode-<ver>-app-e<electron>-x64.zip). The updater downloads this delta ONLY
// when the installed runtime's process.versions.electron matches that <electron>;
// otherwise it falls back to the full zip. So publish BOTH assets every release.
//
// Windows-only (uses PowerShell Compress-Archive, like the rest of the app's zip
// handling). It is a build step, so that is fine.

import { execFileSync } from 'child_process';
import { readFileSync, existsSync, statSync, rmSync } from 'fs';
import path from 'path';

const root = process.cwd();
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const electronVer = JSON.parse(readFileSync(path.join(root, 'node_modules', 'electron', 'package.json'), 'utf8')).version;

const resDir = path.join(root, 'dist', 'win-unpacked', 'resources');
if (!existsSync(path.join(resDir, 'app.asar'))) {
  console.error('pack-appzip: dist/win-unpacked/resources/app.asar not found - run electron-builder first (npm run dist).');
  process.exit(1);
}

const out = path.join(root, 'dist', `Cathode-${pkg.version}-app-e${electronVer}-x64.zip`);
try { rmSync(out, { force: true }); } catch { /* ignore */ }

// Compress-Archive of the resources DIRECTORY yields entries rooted at
// "resources/..." (resources/app.asar, plus app.asar.unpacked/ if a native dep is
// ever added) - exactly the layout the full zip uses.
const psq = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const cmd = `Compress-Archive -Path ${psq(resDir)} -DestinationPath ${psq(out)} -Force`;
execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { stdio: 'inherit' });

const mb = (statSync(out).size / (1024 * 1024)).toFixed(1);
console.log(`pack-appzip: wrote ${path.basename(out)} (${mb} MB, Electron ${electronVer})`);
