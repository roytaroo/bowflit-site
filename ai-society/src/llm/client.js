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

  async chat (messages, { json = true, temperature, model } = {}) {
    const body = {
      model: model || this.model,
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
      if (body.think === false && /think/i.test(t)) { this.think = null; return this.chat(messages, { json, temperature, model }) }
      throw new Error(`Ollama HTTP ${res.status}: ${t.slice(0, 200)}`)
    }
    const data = await res.json()
    return { text: data.message?.content ?? '', evalCount: data.eval_count, promptCount: data.prompt_eval_count }
  }
}

// ネットのAI: Claude (Anthropic API)。キーは環境変数 ANTHROPIC_API_KEY か config/settings.local.json の llm.api_key
// (settings.local.json はGitに上がらない)。小さな JSON の返事をたくさん頼むので、考える時間(thinking)は切って速くする
class AnthropicProvider {
  constructor (cfg) {
    this.model = cfg.model || 'claude-haiku-5-5'
    this.maxTokens = cfg.max_tokens ?? 1024
    this.effort = cfg.effort ?? 'low'
    this.cfg = cfg
    this.client = null
  }

  async _client () {
    if (this.client) return this.client
    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    const opts = { maxRetries: 2, timeout: (this.cfg.timeout_ms ?? 60000) }
    if (this.cfg.api_key) opts.apiKey = this.cfg.api_key
    this.client = new Anthropic(opts)
    return this.client
  }

  async chat (messages, { json = true, model } = {}) {
    const client = await this._client()
    // system は1つにまとめ、残りは user/assistant の順に (同じ役が続いたらつなげる)
    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n')
    const rest = []
    for (const m of messages.filter(m => m.role !== 'system')) {
      const last = rest[rest.length - 1]
      if (last && last.role === m.role) last.content += '\n\n' + m.content
      else rest.push({ role: m.role, content: String(m.content) })
    }
    if (!rest.length || rest[0].role !== 'user') rest.unshift({ role: 'user', content: '続けて。' })
    if (rest[rest.length - 1].role !== 'user') rest.push({ role: 'user', content: json ? 'JSONだけで答えて。' : '続けて。' })
    const res = await client.messages.create({
      model: model || this.model,
      max_tokens: this.maxTokens,
      system: system + (json ? '\n\n出力はJSONオブジェクト1つだけ。前置きやコードブロックは付けない。' : ''),
      messages: rest,
      thinking: { type: 'disabled' },
      output_config: { effort: this.effort },
      cache_control: { type: 'ephemeral' } // 同じ人格の設定文は使い回して安くする
    })
    if (res.stop_reason === 'refusal') throw new Error('Claudeが答えを断った (' + (res.stop_details?.category || '理由不明') + ')')
    const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('')
    const u = res.usage || {}
    return { text, evalCount: u.output_tokens, promptCount: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), cacheRead: u.cache_read_input_tokens || 0 }
  }
}

// ネットのAI: Gemini (Google)。無料枠は1分あたりの回数に制限があるので、間隔を空けて頼む。
// キーは config/settings.local.json の llm.api_key (set-gemini-key.bat で保存。Gitには上がらない)
export const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta'

class GeminiProvider {
  constructor (cfg) {
    this.cfg = cfg
    this.model = cfg.model
    this.minGapMs = Math.ceil(60000 / (cfg.rpm ?? 10)) // 無料枠の回数制限 (1分あたり) に合わせて間隔を空ける
    this.next = 0
    this.noThinkingConfig = false
  }

  async _slot () {
    const now = Date.now()
    const at = Math.max(now, this.next)
    this.next = at + this.minGapMs
    if (at > now) await new Promise(resolve => setTimeout(resolve, at - now))
  }

  async chat (messages, { json = true, temperature, model } = {}) {
    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n')
    const contents = []
    for (const m of messages.filter(m => m.role !== 'system')) {
      const role = m.role === 'assistant' ? 'model' : 'user'
      const last = contents[contents.length - 1]
      if (last && last.role === role) last.parts[0].text += '\n\n' + m.content
      else contents.push({ role, parts: [{ text: String(m.content) }] })
    }
    if (!contents.length || contents[contents.length - 1].role !== 'user') contents.push({ role: 'user', parts: [{ text: json ? 'JSONだけで答えて。' : '続けて。' }] })
    const generationConfig = { maxOutputTokens: this.cfg.max_tokens ?? 1024, temperature: temperature ?? this.cfg.options?.temperature ?? 0.8 }
    if (json) generationConfig.responseMimeType = 'application/json'
    if (!this.noThinkingConfig) generationConfig.thinkingConfig = { thinkingBudget: 0 } // 考える時間を切って速く (使えないモデルなら外す)
    const body = { contents, generationConfig }
    if (system) body.systemInstruction = { parts: [{ text: system }] }
    for (let attempt = 0; attempt < 3; attempt++) {
      await this._slot()
      const ac = new AbortController()
      const t = setTimeout(() => ac.abort(), this.cfg.timeout_ms ?? 60000)
      let res
      try {
        res = await fetch(`${GEMINI_BASE}/models/${model || this.model}:generateContent`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': this.cfg.api_key || process.env.GEMINI_API_KEY || '' },
          body: JSON.stringify(body),
          signal: ac.signal
        })
      } finally { clearTimeout(t) }
      if (res.status === 429 || res.status === 503) {
        // 回数制限・混雑: 少し待ってやり直す
        const wait = 15000 * (attempt + 1)
        log.warn('llm', `Geminiの回数制限/混雑 (HTTP ${res.status})。${wait / 1000}秒待ってやり直す`)
        this.next = Math.max(this.next, Date.now() + wait)
        continue
      }
      if (!res.ok) {
        const t2 = await res.text()
        if (res.status === 400 && /thinking/i.test(t2) && !this.noThinkingConfig) {
          this.noThinkingConfig = true; delete generationConfig.thinkingConfig; continue
        }
        throw new Error(`Gemini HTTP ${res.status}: ${t2.slice(0, 200)}`)
      }
      const data = await res.json()
      const cand = data.candidates?.[0]
      if (!cand?.content?.parts) throw new Error('Geminiが答えなかった (' + (cand?.finishReason || data.promptFeedback?.blockReason || '理由不明') + ')')
      const text = cand.content.parts.filter(p => !p.thought).map(p => p.text || '').join('')
      const u = data.usageMetadata || {}
      return { text, evalCount: u.candidatesTokenCount, promptCount: u.promptTokenCount }
    }
    throw new Error('Geminiの回数制限が続いている (少し時間をおいて)')
  }
}

// 使えるモデルの中から、いちばん新しい Flash を選ぶ (名前は時期で変わるので一覧から決める)
export function pickGeminiModel (models) {
  const ok = models.filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => String(m.name).replace(/^models\//, ''))
    .filter(n => /^gemini-[\d.]+-flash(-lite)?$/.test(n) || /^gemini-[\d.]+-flash(-lite)?-latest$/.test(n))
  const ver = n => Number((n.match(/gemini-([\d.]+)/) || [])[1]?.split('.').slice(0, 2).join('.') || 0)
  ok.sort((a, b) => ver(b) - ver(a) || (a.includes('lite') ? 1 : 0) - (b.includes('lite') ? 1 : 0) || a.length - b.length)
  return ok[0] || null
}

// LM Studio / llama.cpp server / vLLM などの OpenAI互換ローカルサーバー用
class OpenAICompatProvider {
  constructor (cfg) {
    this.url = (cfg.url || 'http://127.0.0.1:1234/v1').replace(/\/$/, '')
    this.model = cfg.model
    this.options = cfg.options || {}
    this.timeoutMs = cfg.timeout_ms ?? 120000
  }

  async chat (messages, { json = true, temperature, model } = {}) {
    const body = { model: model || this.model, messages, temperature: temperature ?? this.options.temperature ?? 0.8 }
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

// HUMAN: プレイヤーとの会話 (最優先) / URGENT: 緊急 / CHAT: 住人同士の会話 / DECIDE: 行動の決定 / REFLECT: 日記など
// 住人同士の会話と行動の決定は同じ優先度にして、会話ばかりで誰も動かない状態を防ぐ
export const PRIORITY = { HUMAN: -1, URGENT: 0, CHAT: 1, DECIDE: 1, REFLECT: 2 }
const AGING_MS = 20000 // 待ち時間20秒ごとに優先度を1つ上げる (後回しにされ続けないように)

export class LLMClient {
  constructor (cfg, { mockProvider = null } = {}) {
    this.cfg = cfg
    if (cfg.provider === 'mock') this.provider = mockProvider
    else if (cfg.provider === 'openai_compat') this.provider = new OpenAICompatProvider(cfg)
    else if (cfg.provider === 'anthropic') this.provider = new AnthropicProvider(cfg)
    else if (cfg.provider === 'gemini') this.provider = new GeminiProvider(cfg)
    else this.provider = new OllamaProvider(cfg)
    if (!this.provider) throw new Error('LLM provider not configured')
    this.concurrency = cfg.concurrency ?? 1
    this.queue = []
    this.running = 0
    this.seq = 0
    this.stats = { calls: 0, errors: 0, totalMs: 0, totalWaitMs: 0, tokens: 0, maxQueue: 0 }
  }

  // 優先度付きキュー。会話の返事 (0) を計画 (1) や日記 (2) より先に処理する。
  request (messages, { priority = PRIORITY.DECIDE, json = true, temperature, tag = '', model } = {}) {
    return new Promise((resolve, reject) => {
      this.queue.push({ messages, priority, json, temperature, tag, model, resolve, reject, seq: this.seq++, enq: Date.now() })
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

  // 使うモデルを途中で切り替える (グラボに入りきらないときに軽いモデルへ)
  setModel (model) {
    this.cfg.model = model
    if (this.provider && 'model' in this.provider) this.provider.model = model
  }

  _pump () {
    while (this.running < this.concurrency && this.queue.length) {
      const now = Date.now()
      const eff = j => j.priority < 0 ? j.priority : Math.max(0, j.priority - Math.floor((now - j.enq) / AGING_MS)) // プレイヤーとの会話は常に最優先
      this.queue.sort((a, b) => eff(a) - eff(b) || a.seq - b.seq)
      const job = this.queue.shift()
      // 1日の予算を使い切ったら、ネットのAIには頼まない (住人はルールの仕事だけ続ける)
      if (this.budget && this.budget.overLimit()) {
        job.reject(new Error('今日のAIの予算を使い切ったので考えない'))
        continue
      }
      this.running++
      const start = Date.now()
      this.stats.totalWaitMs += start - job.enq
      this.provider.chat(job.messages, { json: job.json, temperature: job.temperature, model: job.model })
        .then(r => {
          this.stats.calls++
          this.stats.totalMs += Date.now() - start
          this.stats.tokens += r.evalCount || 0
          this.stats.inTokens = (this.stats.inTokens || 0) + (r.promptCount || 0)
          this.stats.cacheRead = (this.stats.cacheRead || 0) + (r.cacheRead || 0)
          if (this.budget) this.budget.add(this.costOf(r))
          job.resolve(r)
        })
        .catch(e => { this.stats.errors++; job.reject(e) })
        .finally(() => { this.running--; this._pump() })
    }
  }

  // 1回の呼び出しの料金 (円)。ネットのAIのときだけ
  costOf (r) {
    if (this.cfg.provider !== 'anthropic') return 0
    const p = { input: 0.10, output: 0.50, yen: 150, ...(this.cfg.price || {}) }
    const cached = r.cacheRead || 0
    const fresh = Math.max(0, (r.promptCount || 0) - cached)
    return (fresh / 1e6 * p.input + cached / 1e6 * p.input * 0.1 + (r.evalCount || 0) / 1e6 * p.output) * p.yen
  }

  // 1日の予算 (円)。store に日付ごとの使用額を保存する
  setBudget ({ limitYen, store, onLimit = () => {} }) {
    if (!limitYen || !store) return
    const key = () => 'llm_spent:' + new Date().toLocaleDateString('sv-SE')
    let warned = false
    this.budget = {
      limitYen,
      spent: () => store.getState(key(), 0),
      add: yen => store.setState(key(), store.getState(key(), 0) + yen),
      overLimit: () => {
        const over = store.getState(key(), 0) >= limitYen
        if (over && !warned) { warned = true; onLimit(store.getState(key(), 0)) }
        if (!over) warned = false
        return over
      }
    }
  }

  summary () {
    const s = this.stats
    const n = Math.max(1, s.calls)
    let cost = ''
    if (this.cfg.provider === 'anthropic') {
      // 料金の目安 (Claude Haiku 5.5: 入力 $0.10 / 出力 $0.50 per 100万トークン、キャッシュ読み込みは入力の約1割)
      const p = { input: 0.10, output: 0.50, yen: 150, ...(this.cfg.price || {}) }
      const fresh = (s.inTokens || 0) - (s.cacheRead || 0)
      const usd = fresh / 1e6 * p.input + (s.cacheRead || 0) / 1e6 * p.input * 0.1 + s.tokens / 1e6 * p.output
      cost = ` / 料金の目安 約${Math.round(usd * p.yen * 10) / 10}円 ($${usd.toFixed(3)})`
      if (this.budget) cost += ` / 今日の合計 約${Math.round(this.budget.spent())}円 (上限${this.budget.limitYen}円)`
    }
    return `LLM呼び出し ${s.calls}回 / エラー ${s.errors} / 平均応答 ${(s.totalMs / n / 1000).toFixed(1)}秒 / 平均待ち ${(s.totalWaitMs / n / 1000).toFixed(1)}秒 / 最大キュー ${s.maxQueue} / 生成トークン ${s.tokens}${cost}`
  }
}
