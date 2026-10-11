// Stand-in for a speech-to-text program: prints a fixed transcript for the file it is given.
import fs from 'node:fs';
if (!fs.existsSync(process.argv.at(-1))) { process.stderr.write('no such audio file'); process.exit(1); }
process.stdout.write('hello from the voice note\n');
