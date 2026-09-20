/** One-line JSON logs. Anything the host collects (Signoz, Coolify) can read them. */
type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function emit(level: Level, message: string, context?: Record<string, unknown>) {
  const min = ORDER[(process.env.LOG_LEVEL as Level) || 'info'] ?? 20;
  if (ORDER[level] < min) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, message, ...context });
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export const logger = {
  debug: (m: string, c?: Record<string, unknown>) => emit('debug', m, c),
  info: (m: string, c?: Record<string, unknown>) => emit('info', m, c),
  warn: (m: string, c?: Record<string, unknown>) => emit('warn', m, c),
  error: (m: string, c?: Record<string, unknown>) => emit('error', m, c),
};
