// LLMなしで全体の流れを確認するための「ダミーLLM」。
// プロンプトの種類を見分けて、それらしいJSONを規則ベースで返す。
// 本物の判断力は無い (性格による違いも出ない)。動作確認・テスト専用。

function pick (arr) { return arr[Math.floor(Math.random() * arr.length)] }

export class MockProvider {
  constructor ({ latencyMs = 50 } = {}) { this.latencyMs = latencyMs; this.calls = [] }

  async chat (messages) {
    await new Promise(resolve => setTimeout(resolve, this.latencyMs))
    const sys = messages[0]?.content || ''
    const user = messages[messages.length - 1]?.content || ''
    this.calls.push({ sys: sys.slice(0, 60), user: user.slice(0, 60) })
    let out
    if (sys.includes('記憶を整理する係')) out = { summary: '昔のことをまとめた記憶' }
    else if (sys.includes('日記を書く')) {
      out = { diary: '今日は木を集めて、仲間と少し話した。明日はもっと頑張りたい。', tomorrow: '家を建てる材料を集める', impressions: [], growth: '', lesson: '' }
    } else if (sys.includes('が亡くなった') || sys.includes('死んでしまった')) {
      out = { say: 'そんな…', feeling: 'とても悲しい', propose_grave: true, new_goal: '' }
    } else if (sys.includes('話しかけた')) {
      out = { say: pick(['うん、いいね!', 'そうだね。', 'ちょっと忙しいけど、後でね', 'わかった!']), relationship_event: { type: 'good_talk', note: '楽しい会話' }, action: null }
    } else {
      out = this._decide(user)
    }
    return { text: JSON.stringify(out), evalCount: 20 }
  }

  _decide (user) {
    const inv = (user.match(/持ち物: (.*)/) || [])[1] || ''
    const logs = (inv.match(/_logx(\d+)/g) || []).reduce((n, s) => n + Number(s.match(/\d+/)[0]), 0)
    const planks = /_planksx/.test(inv)
    if (/近くの敵: (?!なし)/.test(user) && /体力 (\d+)/.test(user) && Number(user.match(/体力 (\d+)/)[1]) > 14) {
      const enemy = user.match(/近くの敵: ([a-z_]+)/)[1]
      return { thought: '敵を追い払う', say: '', say_to: null, action: { name: 'attack', args: { target: enemy } }, goal: '身を守る' }
    }
    if (/安全管理からの却下/.test(user)) return { thought: '一休みしよう', say: '', say_to: null, action: { name: 'rest', args: { seconds: 5 } }, goal: '様子を見る' }
    if (/まだ家がない/.test(user) && Math.random() < 0.3) return { thought: 'ここに住もう', say: 'ここを家にしよう!', say_to: null, action: { name: 'set_home', args: {} }, goal: '家を作る' }
    if (logs < 4 && /log\d+個/.test(user)) return { thought: '木を集めよう', say: '', say_to: null, action: { name: 'collect', args: { block: 'log', count: 3 } }, goal: '木を集める' }
    if (logs >= 2 && !planks) return { thought: '板にしよう', say: '', say_to: null, action: { name: 'craft', args: { item: 'oak_planks', count: 4 } }, goal: '道具を作る' }
    const names = ((user.match(/仲間の名前: (.*)/) || [])[1] || '').split(',').map(s => s.trim().split('(')[0]).filter(Boolean)
    if (names.length && Math.random() < 0.35) {
      const n = pick(names)
      return { thought: '話しかけてみよう', say: `${n}、調子はどう?`, say_to: n, action: { name: 'rest', args: { seconds: 3 } }, goal: '仲良くなる' }
    }
    return pick([
      { thought: '散歩しよう', say: '', say_to: null, action: { name: 'wander', args: { radius: 10 } }, goal: '周りを知る' },
      { thought: '探検だ', say: '', say_to: null, action: { name: 'explore', args: { direction: pick(['north', 'south', 'east', 'west']), distance: 24 } }, goal: '探検' },
      { thought: '少し休む', say: '', say_to: null, action: { name: 'rest', args: { seconds: 5 } }, goal: '休憩' }
    ])
  }
}
