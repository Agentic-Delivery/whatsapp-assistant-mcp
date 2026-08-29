#!/usr/bin/env node
// One-shot pairing CLI: connects, shows a QR (or requests a pairing code), waits for
// the connection to open with creds saved, prints the paired identity, and exits.
// This is the only place a human is expected to watch stdout interactively.

import qrcodeTerminal from 'qrcode-terminal';
import { connect, waHome } from './wa-client.js';

function parseArgs(argv) {
  const args = { code: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--code') {
      args.code = argv[i + 1];
      i++;
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      args.help = true;
    }
  }
  return args;
}

function printUsage() {
  console.log('Usage: wa-pair [--code <phone-number>]');
  console.log('');
  console.log('  (no flags)         Pair by scanning a QR code with WhatsApp > Linked Devices.');
  console.log('  --code <number>    Pair by entering a code instead, for the given phone number');
  console.log('                     in international format, e.g. --code 15551234567');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    process.exit(0);
    return;
  }

  console.log('WhatsApp Assistant -- pairing');
  console.log(`Auth state will be stored under ${waHome()}`);
  console.log('');

  if (args.code) {
    console.log(`Requesting a pairing code for ${args.code} ...`);
  } else {
    console.log('Scan this QR code with WhatsApp: Settings > Linked Devices > Link a Device');
    console.log('');
  }

  let result;
  try {
    result = await connect({
      reconnect: false,
      phoneNumber: args.code || null,
      onQr: (qr) => {
        if (!args.code) qrcodeTerminal.generate(qr, { small: true });
      },
      onPairingCode: (pairingCode) => {
        console.log('');
        console.log(`Pairing code: ${pairingCode}`);
        console.log('Enter this code in WhatsApp: Settings > Linked Devices > Link a Device > Link with phone number instead');
        console.log('');
      },
    });
  } catch (err) {
    console.error(`Pairing failed: ${err.message}`);
    process.exit(1);
    return;
  }

  console.log(`PAIRED as ${result.jid || 'unknown'}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`Pairing failed: ${err.message}`);
  process.exit(1);
});
