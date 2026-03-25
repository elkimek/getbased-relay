// logger.js — Structured logging Console that intercepts Evolu's relay logger
//
// Evolu's createRelayLogger calls our Console methods with patterns like:
//   log("[relay]", "connection", { totalConnectionCount })
//   error("[relay]", "storage", error)
//   log("Evolu Relay started on port 4000")
//
// We parse these into structured JSON events at appropriate log levels.

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

// Map Evolu relay log tags to our log levels
const TAG_LEVELS = {
  'connection':      'info',
  'close':           'info',
  'subscribe':       'info',
  'unsubscribe':     'info',
  'broadcast':       'debug',
  'on message':      'debug',
  'responseLength':  'debug',
  'storage':         'error',
  'error':           'error',
  'socket error':    'warn',
  'invalid or missing ownerId in URL': 'warn',
  'unauthorized owner': 'warn',
  'applyProtocolMessageAsRelay': 'error',
  'applyProtocolMessageAsRelayUnknownError': 'error',
};

export function createLogger(config) {
  const minLevel = LEVELS[config.logLevel] ?? LEVELS.info;
  const isJson = config.logFormat === 'json';
  let currentConnections = 0;

  function shouldLog(level) {
    return (LEVELS[level] ?? 0) >= minLevel;
  }

  function emit(level, event, data) {
    if (!shouldLog(level)) return;

    if (isJson) {
      const entry = {
        ts: new Date().toISOString(),
        level,
        event,
        ...data,
      };
      const stream = level === 'error' ? process.stderr : process.stdout;
      stream.write(JSON.stringify(entry) + '\n');
    } else {
      const prefix = `[${new Date().toISOString()}] [${level.toUpperCase()}]`;
      const detail = data && Object.keys(data).length > 0
        ? ' ' + JSON.stringify(data)
        : '';
      const stream = level === 'error' ? process.stderr : process.stdout;
      stream.write(`${prefix} ${event}${detail}\n`);
    }
  }

  function parseRelayLog(method, args) {
    // Evolu relay logger always starts with "[relay]" tag for structured events
    if (args[0] === '[relay]') {
      const tag = args[1];
      const data = args[2];
      const level = TAG_LEVELS[tag] || 'debug';

      // Track connection count from Evolu's events
      if (tag === 'connection' && data?.totalConnectionCount !== undefined) {
        currentConnections = data.totalConnectionCount;
      }
      if (tag === 'close' && data?.totalConnectionCount !== undefined) {
        currentConnections = data.totalConnectionCount;
      }

      emit(level, `relay.${tag.replace(/\s+/g, '_')}`, data || {});
      return;
    }

    // Untagged messages (startup, shutdown)
    const msg = typeof args[0] === 'string' ? args[0] : '';
    if (msg.startsWith('Evolu Relay started')) {
      emit('info', 'relay.started', { message: msg });
    } else if (msg.startsWith('Shutting down')) {
      emit('info', 'relay.shutdown', {});
    } else if (msg.includes('disposed')) {
      emit('info', 'relay.disposed', { message: msg });
    } else {
      // Pass through anything else at debug level
      emit('debug', 'relay.internal', { args: args.map(String) });
    }
  }

  // The Console interface that Evolu expects.
  // Evolu's relay logger sets console.enabled = enableLogging after startup,
  // but some events check `if (console.enabled)` before calling console.log.
  // We lock enabled=true so ALL events reach our filter — we handle levels ourselves.
  const console = {
    log:   (...args) => parseRelayLog('log', args),
    info:  (...args) => parseRelayLog('info', args),
    warn:  (...args) => parseRelayLog('warn', args),
    error: (...args) => parseRelayLog('error', args),
    debug: (...args) => parseRelayLog('debug', args),
    time:     () => {},
    timeLog:  () => {},
    timeEnd:  () => {},
    dir:      () => {},
    table:    () => {},
    count:    () => {},
    countReset: () => {},
    assert:   () => {},
    trace:    () => {},
  };

  // Lock enabled=true — Evolu tries to set it to false, but we need all events
  Object.defineProperty(console, 'enabled', { get: () => true, set: () => {} });

  return {
    console,
    emit,
    getCurrentConnections: () => currentConnections,
  };
}
