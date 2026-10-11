// Stand-in transcriber that fails if another copy is running in the same folder at the same time:
// it holds <folder>/.transcribing for 150 ms, created exclusively.
import fs from 'node:fs';
import path from 'node:path';
const lock = path.join(path.dirname(process.argv.at(-1)), '.transcribing');
try { fs.writeFileSync(lock, 'x', { flag: 'wx' }); } catch { process.stderr.write('another transcription is running'); process.exit(1); }
setTimeout(() => { fs.rmSync(lock); process.stdout.write('one at a time\n'); }, 150);
