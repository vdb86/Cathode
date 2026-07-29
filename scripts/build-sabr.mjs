// Bundles googlevideo (ESM) into a single global script for the no-bundler
// renderer, mirroring how shaka-player.compiled.js is loaded via <script>.
//
// Run after `npm install`:  npm run build:sabr
// Re-run whenever googlevideo is bumped. It reads from the SAME node_modules
// the main process uses, so the renderer bundle and main-process googlevideo
// stay on one version (important: buildSabrFormat runs in main, the adapter
// consumes its output in the renderer).
//
// Output: src/renderer/vendor/googlevideo.js exposing
//   window.GoogleVideo = { SabrStreamingAdapter, SabrUmpProcessor,
//     buildSabrFormat, FormatKeyUtils, isGoogleVideoURL }

import esbuild from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = join(root, 'src', 'renderer', 'vendor', 'googlevideo.js');
mkdirSync(dirname(outfile), { recursive: true });

const entry = [
  "export { SabrStreamingAdapter, SabrUmpProcessor } from 'googlevideo/sabr-streaming-adapter';",
  "export { buildSabrFormat, FormatKeyUtils, isGoogleVideoURL } from 'googlevideo/utils';"
].join('\n');

await esbuild.build({
  stdin: { contents: entry, resolveDir: root, sourcefile: 'gv-entry.mjs', loader: 'js' },
  bundle: true,
  format: 'iife',
  globalName: 'GoogleVideo',
  outfile,
  platform: 'browser',
  target: 'es2020',
  legalComments: 'none'
});

console.log('Wrote', outfile);
