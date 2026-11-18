// Keeps objects out of what the process prints.
//
// A dependency of the WhatsApp client reports session changes with calls such
// as console.info("Closing session:", session), where the second argument is a
// whole session record including private key buffers. Under a service manager
// every printed line is kept in the system journal, so those calls would leave
// key material readable there. This project's own log lines are plain strings,
// so nothing of ours is lost by printing only strings, numbers and the like.
//
// After installConsoleRedaction() every wrapped console method (see METHODS)
// prints its string, number, boolean, null and undefined arguments unchanged,
// an Error as its stack (or message), and any other object or function as the
// fixed text "[object omitted]".

const METHODS = ['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'dirxml', 'table', 'assert', 'group', 'groupCollapsed', 'timeLog'];
const INSTALLED = Symbol.for('whatsapp-assistant-mcp.console-redaction');
export const OMITTED = '[object omitted]';

export function redactArg(arg) {
  if (arg instanceof Error) return String(arg.stack || arg.message || arg.name);
  if (arg !== null && (typeof arg === 'object' || typeof arg === 'function')) return OMITTED;
  if (typeof arg === 'symbol') return String(arg);
  return arg;
}

export function installConsoleRedaction(target = console) {
  if (target[INSTALLED]) return target;
  for (const method of METHODS) {
    if (typeof target[method] !== 'function') continue;
    const original = target[method].bind(target);
    target[method] = (...args) => original(...args.map(redactArg));
  }
  target[INSTALLED] = true;
  return target;
}
