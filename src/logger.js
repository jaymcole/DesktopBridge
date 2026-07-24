// Minimal structured logger: one JSON object per line to stdout/stderr.
// Keeps the service dependency-free while giving the UI/operator parseable logs.

function emit(stream, level, msg, fields) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  });
  stream.write(line + '\n');
}

export const log = {
  debug: (msg, fields = {}) => emit(process.stdout, 'debug', msg, fields),
  info: (msg, fields = {}) => emit(process.stdout, 'info', msg, fields),
  warn: (msg, fields = {}) => emit(process.stdout, 'warn', msg, fields),
  error: (msg, fields = {}) => emit(process.stderr, 'error', msg, fields),
};
