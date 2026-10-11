// Starts a helper in its own process group that keeps our stdout open for 5 s, then waits for ever.
import { spawn } from 'node:child_process';
spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { detached: true, stdio: ['ignore', 'inherit', 'ignore'] }).unref();
setInterval(() => {}, 1000);
