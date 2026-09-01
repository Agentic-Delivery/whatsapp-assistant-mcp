// Stand-in for @whiskeysockets/baileys, loaded by src/wa-client.js when
// WA_CLIENT_FAKE points at this file (see loadBaileysModule() in src/wa-client.js).
// Mirrors just enough of the real module's shape -- default export = socket
// factory, plus useMultiFileAuthState and DisconnectReason -- for the smoke tests
// to drive connect() end-to-end without a real network connection.
//
// No real WhatsApp connection is ever attempted by this fixture or by the tests
// that use it.

import { EventEmitter } from 'node:events';

/** Every fake socket created, most recent last -- lets a test grab the socket a
 *  connect() call is now using and fire events on it (e.g. messages.upsert). */
export const createdSockets = [];

export default function makeWASocket(_config) {
  const ev = new EventEmitter();
  const sent = [];
  const sock = {
    ev,
    user: { id: 'fake-self@s.whatsapp.net' },
    sendMessage: async (jid, content) => {
      const msgId = `fake-msg-${sent.length + 1}`;
      sent.push({ jid, content, msgId });
      return { key: { id: msgId } };
    },
    requestPairingCode: async (_phoneNumber) => '123-456',
    __sent: sent,
  };
  createdSockets.push(sock);
  // Real Baileys reaches "open" asynchronously after a handshake; emitting it on
  // the next tick is enough to let connect() resolve without a real connection.
  setTimeout(() => ev.emit('connection.update', { connection: 'open' }), 0);
  return sock;
}

export async function useMultiFileAuthState(_folder) {
  return {
    // registered:false mirrors a fresh, never-paired session -- the realistic
    // starting state for wa-pair -- and is what lets connect()'s phoneNumber
    // branch actually call requestPairingCode() during a test.
    state: { creds: { registered: false, me: { id: 'fake-self@s.whatsapp.net' } }, keys: {} },
    saveCreds: async () => {},
  };
}

export const DisconnectReason = { loggedOut: 401 };

// Incoming-attachment download stand-in: returns deterministic bytes so the
// daemon's allowlist-gated save path can be exercised without a network.
export async function downloadMediaMessage(rawMsg) {
  const name = rawMsg?.message?.documentMessage?.fileName || 'doc';
  return Buffer.from(`fake-bytes-of:${name}`);
}

// Minimal stand-ins for the atomic auth adapter's needs: a FAKE initAuthCreds
// yields a REGISTERED identity (the tests exercise post-pairing behaviour;
// pairing itself is covered by the real pair flow), and BufferJSON/proto are
// pass-throughs.
export function initAuthCreds() {
  return { registered: true, me: { id: 'fake-self@s.whatsapp.net' } };
}
export const BufferJSON = { replacer: undefined, reviver: undefined };
export const proto = { Message: { AppStateSyncKeyData: { fromObject: (o) => o } } };
