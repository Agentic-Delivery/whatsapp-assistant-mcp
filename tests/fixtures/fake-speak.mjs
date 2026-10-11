// Stand-in for a text-to-speech program: writes the text it was given into the --output file, plus the
// permission bits of the text file and its folder so tests can check they are private.
//   --fail   writes the output, then exits 1 and prints the output path on stderr
//   --hang <file>  starts a child that writes <file> after 600 ms, then waits forever
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const a = process.argv.slice(2);
const textFile = a[a.indexOf('--text-file') + 1];
const output = a[a.indexOf('--output') + 1];
if (a.includes('--hang')) {
  const late = a[a.indexOf('--hang') + 1];
  spawn(process.execPath, ['-e', `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(late)}, 'x'), 600)`], { stdio: 'ignore' });
  setInterval(() => {}, 1000);
} else {
  const text = fs.readFileSync(textFile, 'utf8');
  const mode = (p) => (fs.statSync(p).mode & 0o777).toString(8);
  fs.writeFileSync(output, `OggS-fake:${text}|file:${mode(textFile)}|dir:${mode(path.dirname(textFile))}`);
  if (a.includes('--fail')) { process.stderr.write(`engine crashed after writing ${output}`); process.exit(1); }
}
