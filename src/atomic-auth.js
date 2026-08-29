// Atomic multi-file auth state — drop-in for Baileys' useMultiFileAuthState,
// whose bare writeFile (use-multi-file-auth-state.js:35) truncates before it
// writes: a teardown racing a creds.update leaves an EMPTY creds.json, the
// next reader sees "unregistered", attempts a re-registration, and the server
// invalidates the phone link (observed live, three re-pairs in one evening).
// Every write here goes tmp-then-rename on the same directory — a crash at
// any instant leaves either the old file or the new one, never a torn one.
import fs from 'node:fs';
import path from 'node:path';

function readJson(file, reviver) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return null; // a torn/empty file must read as absent, never as corrupt state
    return JSON.parse(raw, reviver);
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, data, replacer) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, replacer));
  fs.renameSync(tmp, file);
}

/** Same contract as Baileys' useMultiFileAuthState: { state: { creds, keys }, saveCreds }. */
export async function useAtomicAuthState(folder, baileys) {
  const { initAuthCreds, BufferJSON, proto } = baileys;
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });

  // Key names come from Baileys' own signal store (fixed categories + protocol-
  // constrained ids), but a filename builder should not have to trust that:
  // neutralize every path-meaningful character, including backslash (a
  // separator on Windows even though Linux is the supported platform).
  const fileFor = (name) => path.join(folder, `${name.replace(/[\/\\]/g, '__').replace(/:/g, '-').replace(/^\.+/, '_')}.json`);
  const creds = readJson(fileFor('creds'), BufferJSON.reviver) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: (type, ids) => {
          const data = {};
          for (const id of ids) {
            let value = readJson(fileFor(`${type}-${id}`), BufferJSON.reviver);
            if (type === 'app-state-sync-key' && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            if (value) data[id] = value;
          }
          return data;
        },
        set: (data) => {
          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category])) {
              const value = data[category][id];
              const file = fileFor(`${category}-${id}`);
              if (value) writeJsonAtomic(file, value, BufferJSON.replacer);
              else { try { fs.unlinkSync(file); } catch { /* absent */ } }
            }
          }
        },
      },
    },
    saveCreds: () => writeJsonAtomic(fileFor('creds'), creds, BufferJSON.replacer),
  };
}
