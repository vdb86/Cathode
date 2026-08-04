// SPDX-License-Identifier: GPL-3.0-or-later
// Windows system-volume control via the OS media keys (VK_VOLUME_UP / _DOWN /
// _MUTE). This is the SINGLE volume for Cathode - there is no separate in-app
// <video> volume any more; the companion remote's volume up/down/mute drive the
// Windows master volume directly (same idea as Plei's keyboard.send('volume ...'),
// but from Electron main via keybd_event).
//
// Why media keys / keybd_event: they move the real Windows master volume AND pop
// the native volume OSD flyout (nice feedback on a TV), and they work even when
// the app is backgrounded or minimized to the tray - the shell handles the key
// system-wide, no foreground window needed. That last point matters for an HTPC
// remote.
//
// Implementation: a single long-lived PowerShell host is spawned lazily and kept
// alive; it Add-Type's the keybd_event P/Invoke ONCE, then reads simple line
// commands (UP / DOWN / MUTE / QUIT) from stdin and taps the matching VK. This
// avoids the ~0.5s Add-Type compile cost that a spawn-per-press approach would
// pay on every volume nudge. Non-Windows platforms are a no-op.

const { spawn } = require('child_process');
let logger = null;
try { logger = require('./logger'); } catch { /* logger optional */ }
const log = (...a) => { try { logger && logger.info && logger.info('[volume]', ...a); } catch { /* ignore */ } };

// PowerShell host: define the P/Invoke, then loop reading stdin lines. keybd_event
// flags: 0 = key down, 2 = KEYEVENTF_KEYUP. A tap = down then up.
const PS_HOST = [
  '$ErrorActionPreference = "SilentlyContinue"',
  'Add-Type -Namespace Native -Name Key -MemberDefinition \'[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);\'',
  'function Tap([byte]$vk) { [Native.Key]::keybd_event($vk,0,0,[System.UIntPtr]::Zero); [Native.Key]::keybd_event($vk,0,2,[System.UIntPtr]::Zero) }',
  'while (($line = [Console]::In.ReadLine()) -ne $null) {',
  '  switch ($line.Trim()) {',
  '    "UP"   { Tap 0xAF }',   // VK_VOLUME_UP
  '    "DOWN" { Tap 0xAE }',   // VK_VOLUME_DOWN
  '    "MUTE" { Tap 0xAD }',   // VK_VOLUME_MUTE
  '    "QUIT" { break }',
  '  }',
  '}'
].join('\n');

let child = null;
let warnedUnsupported = false;

function isWindows() { return process.platform === 'win32'; }

function ensureHost() {
  if (!isWindows()) {
    if (!warnedUnsupported) { warnedUnsupported = true; log('system volume control is Windows-only; ignoring'); }
    return null;
  }
  if (child && !child.killed) return child;
  try {
    child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_HOST],
      { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', (e) => { log('host error:', e && e.message); child = null; });
    child.on('exit', () => { child = null; });
    child.unref(); // never keep the app alive on our account
    log('volume host started');
  } catch (e) {
    log('failed to start volume host:', e && e.message);
    child = null;
  }
  return child;
}

function send(line) {
  const c = ensureHost();
  if (!c || !c.stdin || !c.stdin.writable) return;
  try { c.stdin.write(line + '\n'); } catch (e) { log('write failed:', e && e.message); child = null; }
}

function volumeUp() { send('UP'); }
function volumeDown() { send('DOWN'); }
function toggleMute() { send('MUTE'); }

// Called on app quit so the helper does not linger.
function stop() {
  if (!child) return;
  try { if (child.stdin && child.stdin.writable) child.stdin.write('QUIT\n'); } catch { /* ignore */ }
  try { child.kill(); } catch { /* ignore */ }
  child = null;
}

module.exports = { volumeUp, volumeDown, toggleMute, stop };
