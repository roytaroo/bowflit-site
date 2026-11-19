// シンプルなロガー。LOG_LEVEL=debug で詳細表示。
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 }
const level = LEVELS[process.env.LOG_LEVEL || 'info'] ?? 1
const ts = () => new Date().toTimeString().slice(0, 8)

function out (lv, tag, msg) {
  if (LEVELS[lv] < level) return
  const line = `${ts()} ${lv.toUpperCase().padEnd(5)} [${tag}] ${msg}`
  if (lv === 'error' || lv === 'warn') console.error(line)
  else console.log(line)
}

export const log = {
  debug: (t, m) => out('debug', t, m),
  info: (t, m) => out('info', t, m),
  warn: (t, m) => out('warn', t, m),
  error: (t, m) => out('error', t, m)
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export function withTimeout (promise, ms, label = 'action') {
  let t
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_resolve, reject) => { t = setTimeout(() => reject(new Error(`${label} timeout ${ms}ms`)), ms) })
  ])
}
