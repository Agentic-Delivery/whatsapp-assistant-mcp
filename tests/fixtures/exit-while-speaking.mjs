// Starts a hanging speak command, prints the private folder it uses, then exits the process mid-way.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const { speakToFile } = await import('../../src/speech.js');
const late = process.argv[2];
speakToFile([process.execPath, path.join(here, 'fake-speak.mjs'), '--text-file', '{textFile}', '--output', '{output}', '--hang', late], 'private words').catch(() => {});
setTimeout(() => process.exit(0), 200);
