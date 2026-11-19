// LLMクライアント + 共有キュー。
// 1つのローカルLLM (Ollama) を9人で共有する。人格・記憶はプロンプト側で毎回切り替えるので混ざらない。
// concurrency=1 なら「順番に処理」(VRAM最小・1人あたり待ち時間が増える)。
// concurrency>1 は Ollama 側の OLLAMA_NUM_PARALLEL と合わせて使う (同時処理。KVキャッシュ分VRAMが増える)。
import { log } from '../util/log.js'

export function extractJson (text) {
  if (text == null) throw new Error('empty LLM response')
  let s = String(text).replace(/<think>[\s\S]*?<\/think>/g, '').trim()
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  try { return JSON.parse(s) } catch {}
  const start = s.indexOf('{')
  if (start < 0) throw new Error('no JSON object in LLM response: ' + s.slice(0, 120))
  let depth = 0; let inStr = false; let esc = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return JSON.parse(s.slice(start, i + 1)) }
  }
  throw new Error('unterminated JSON in LLM response')
}

class OllamaProvider {
  constructor (cfg) {
    this.url = (cfg.url || 'http://127.0.0.1:11434').replace(/\/$/, '')
    this.model = cfg.model
    this.options = { temperature: 0.8, num_ctx: 4096, ...(cfg.options || {}) }
    this.keepAlive = cfg.keep_alive ?? '30m'
    this.think = cfg.think ?? false
    this.timeoutMs = cfg.timeout_ms ?? 120000
  }

  async chat (messages, { json = true, temperature } = {}) {
    const body = {
      model: this.model,
      messages,
      stream: false,
      keep_alive: this.keepAlive,
      options: { ...this.options, ...(temperature != null ? { temperature } : {}) }
    }
    if (json) body.format = 'json'
    if (this.think === false) body.think = false
    const res = await fetchWithTimeout(this.url + '/api/chat', body, this.timeoutMs)
    if (!res.ok) {
      const t = await res.text()
      // 古いOllamaは think パラメータを知らないことがあるので1回だけ外して再試行
      if (body.think === false && /think/i.test(t)) { this.think = null; return this.chat(messages, { json, temperature }) }
      throw new Error(`Ollama HTTP ${res.status}: ${t.slice(0, 200)}`)
    }
    const data = await res.json()
    return { text: data.message?.content ?? '', evalCount: data.eval_count, promptCount: data.prompt_eval_count }
  }
}

// LM Studio / llama.cpp server / vLLM などの OpenAI互換ローカルサーバー用
class OpenAICompatProvider {
  constructor (cfg) {
    this.url = (cfg.url || 'http://127.0.0.1:1234/v1').replace(/\/$/, '')
    this.model = cfg.model
    this.options = cfg.options || {}
    this.timeoutMs = cfg.timeout_ms ?? 120000
  }

  async chat (messages, { json = true, temperature } = {}) {
    const body = { model: this.model, messages, temperature: temperature ?? this.options.temperature ?? 0.8 }
    if (json) body.response_format = { type: 'json_object' }
    const res = await fetchWithTimeout(this.url + '/chat/completions', body, this.timeoutMs)
    if (!res.ok) throw new Error(`OpenAI-compat HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const data = await res.json()
    return { text: data.choices?.[0]?.message?.content ?? '', evalCount: data.usage?.completion_tokens }
  }
}

async function fetchWithTimeout (url, body, ms) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), ms)
  try {
    return await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal })
  } finally { clearTimeout(t) }
}

export const PRIORITY = { CHAT: 0, URGENT: 0, DECIDE: 1, REFLECT: 2 }

export class LLMClient {
  constructor (cfg, { mockProvider = null } = {}) {
    this.cfg = cfg
    if (cfg.provider === 'mock') this.provider = mockProvider
    else if (cfg.provider === 'openai_compat') this.provider = new OpenAICompatProvider(cfg)
    else this.provider = new OllamaProvider(cfg)
    if (!this.provider) throw new Error('LLM provider not configured')
    this.concurrency = cfg.concurrency ?? 1
    this.queue = []
    this.running = 0
    this.seq = 0
    this.stats = { calls: 0, errors: 0, totalMs: 0, totalWaitMs: 0, tokens: 0, maxQueue: 0 }
  }

  // 優先度付きキュー。会話の返事 (0) を計画 (1) や日記 (2) より先に処理する。
  request (messages, { priority = PRIORITY.DECIDE, json = true, temperature, tag = '' } = {}) {
    return new Promise((resolve, reject) => {
      this.queue.push({ messages, priority, json, temperature, tag, resolve, reject, seq: this.seq++, enq: Date.now() })
      this.queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq)
      this.stats.maxQueue = Math.max(this.stats.maxQueue, this.queue.length)
      this._pump()
    })
  }

  async requestJson (messages, opts = {}) {
    let lastErr
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { text } = await this.request(messages, { ...opts, json: true })
        return extractJson(text)
      } catch (e) {
        lastErr = e
        log.warn('llm', `JSON取得失敗 (${opts.tag || ''}) 試行${attempt + 1}: ${e.message}`)
      }
    }
    throw lastErr
  }

  pending () { return this.queue.length + this.running }

  _pump () {
    while (this.running < this.concurrency && this.queue.length) {
      const job = this.queue.shift()
      this.running++
      const start = Date.now()
      this.stats.totalWaitMs += start - job.enq
      this.provider.chat(job.messages, { json: job.json, temperature: job.temperature })
        .then(r => {
          this.stats.calls++
          this.stats.totalMs += Date.now() - start
          this.stats.tokens += r.evalCount || 0
          job.resolve(r)
        })
        .catch(e => { this.stats.errors++; job.reject(e) })
        .finally(() => { this.running--; this._pump() })
    }
  }

  summary () {
    const s = this.stats
    const n = Math.max(1, s.calls)
    return `LLM呼び出し ${s.calls}回 / エラー ${s.errors} / 平均応答 ${(s.totalMs / n / 1000).toFixed(1)}秒 / 平均待ち ${(s.totalWaitMs / n / 1000).toFixed(1)}秒 / 最大キュー ${s.maxQueue} / 生成トークン ${s.tokens}`
  }
}
