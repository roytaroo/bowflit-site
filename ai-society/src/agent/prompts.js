// プロンプト生成。小さなローカルモデル (7B〜14B) でも扱えるよう、短く・JSON形式で答えさせる。
// 毎回その人物の人格・記憶・関係だけを入れるので、1つのLLMを共有しても人格は混ざらない。
import { actionListForPrompt } from './actions.js'
import { EVENT_EFFECTS } from '../society/relationships.js'

export function personaBlock (c, agentRow, { playerDisplay = 'だいき', compact = false } = {}) {
  const age = /歳|年齢|生|不詳/.test(String(c.age)) ? c.age : c.age + '歳'
  const lines = [
    `あなたは「${c.display_name}」(Minecraft上の名前: ${c.username})。${age}。Minecraftのサバイバルワールドで仲間と暮らしている住人。`,
    `性格: ${c.personality}`,
    `口調: ${c.speech}`
  ]
  if (c.never?.length) lines.push(`絶対にしないこと: ${c.never.join(' / ')}`)
  if (c.examples?.length) lines.push(`セリフの例 (この口調で話す。同じ文をそのまま使わない):\n${(compact ? c.examples.slice(0, 3) : c.examples).map(e => `「${e}」`).join('\n')}`)
  if (c.role) lines.push(`村での役割: ${c.role}`)
  if (c.about_others && !compact) for (const v of Object.values(c.about_others)) lines.push(`- ${v}`)
  if (c.about_player) lines.push(`${playerDisplay}について: ${c.about_player.replace(/だいき/g, playerDisplay)}`)
  lines.push(
    `大切にしていること: ${(c.values || []).join('、')}`,
    `好き: ${(c.likes || []).join('、')} / 嫌い: ${(c.dislikes || []).join('、')}`,
    `得意: ${(c.skills || []).join('、')} / 苦手: ${(c.weaknesses || []).join('、')}`,
    `個人的な目標: ${c.personal_goal}`,
    `長期的な夢: ${agentRow?.long_goal || c.dream}`
  )
  if (agentRow?.growth) lines.push(`経験を通して変わったこと: ${agentRow.growth}`)
  lines.push('あなたはAIやボットではなく、この世界の住人として考え、話す。他の住人の心の中は分からない。他の住人の口調(一人称・語尾)は絶対に真似しない。')
  return lines.join('\n')
}

function memoryLines (mems) {
  return mems.map(m => `- ${m.day != null ? `(${m.day}日目) ` : ''}${m.content}`).join('\n') || '- (特になし)'
}

export function buildDecidePrompt (ctx) {
  const { character, agentRow, stateText, memories, lessons, relations, shared, projects, recentChat, lastResult, rejected, names, experience = '' } = ctx
  const system = personaBlock(character, agentRow, { compact: true }) + `

あなたは次に何をするか自分で決める。体力・時間・仲間の状況・自分の目標と性格を考えて選ぶこと。
使える行動 (actionのnameはこの中から1つ):
${actionListForPrompt(DECIDE_ACTIONS)}

あなたは普段、素材集め・家づくり・自分の役割の仕事を体が勝手に続けている。ここでは「それ以外に今やりたいこと」があるときだけ actions に入れる (特になければ actions は空の配列 [] でよい)。
約束や会議の話はしない。計画を話し合うより、実際に手を動かす。
行動を優先すること。話すのは本当に必要なときだけで、普段は say を空文字にする。話すときは他の住人のセリフを真似せず、アイテムは日本語で呼ぶ。
続けてやることが決まっていれば actions に最大3つまで順番に並べてよい (例: 木を集める → 板にする → 作業台を作る)。
必ず次のJSONだけで答える:
{"thought":"判断理由(30字以内)","say":"","say_to":null,"actions":[{"name":"行動名","args":{}}],"goal":"今取り組んでいる短期目標(20字以内)"}
任意で "long_goal":"新しい長期目標" も追加できる。`

  const user = `【今の状況】
${stateText}

【今の目標】${agentRow?.current_goal || '(まだない)'}
${lastResult ? `【さっきの行動の結果】${lastResult}` : ''}
${rejected ? `【安全管理からの却下】${rejected} → 別の行動を選ぶこと` : ''}

【思い出したこと】
${memoryLines(memories)}

【過去の教訓】
${memoryLines(lessons)}
${experience ? `\n【自分の最近の経験】(これを踏まえて行動を変える。危なかった場所は避ける・見つけた場所にまた行く 等)\n${experience}\n` : ''}
【仲間との関係】
${relations || '- (まだ誰とも親しくない)'}

【みんなの最近の出来事】
${memoryLines(shared)}

【進行中・提案中の計画】
${projects || '- なし'}

【最近の会話】
${recentChat || '- なし'}
(近くにいる人と前に話した話題があれば、自分から持ち出してもよい)

仲間の名前: ${names.join(', ')}
次の行動をJSONで答えて。`
  return [{ role: 'system', content: system }, { role: 'user', content: user }]
}

// 自分で次の行動を考えるときに使える行動 (座標指定の移動・お墓・計画づくりは、小さいAIだと変な使い方をするので外す)
export const DECIDE_ACTIONS = ['collect', 'craft', 'build_house', 'explore', 'go_home', 'go_to_player', 'follow', 'give', 'eat', 'sleep', 'rest', 'wander', 'fish', 'plant_and_harvest', 'store_items', 'attack']

// プレイヤーの発言に返事を求めるときに使える行動 (安全管理の審査は通常どおり受ける)
export const REQUEST_ACTIONS = ['go_to_player', 'follow', 'give', 'rest', 'collect', 'explore', 'go_home', 'fish', 'plant_and_harvest', 'build_house', 'store_items', 'wander', 'sleep', 'set_home', 'craft', 'eat']

export function buildReplyPrompt (ctx) {
  const { character, agentRow, speakerDisplay, text, relationText, aboutMemories, recentChat, stateText, isHuman, thread, stance, why, isGroup, others = [], sightings = '', experience = '' } = ctx
  const types = Object.keys(EVENT_EFFECTS).filter(k => k !== 'died').join('|')
  const threadText = thread && thread.length > 1
    ? thread.slice(1).map(l => `- ${l.display}「${l.text}」`).join('\n')
    : ''
  const system = personaBlock(character, agentRow) + `

${speakerDisplay}が${isGroup ? 'みんなに' : 'あなたに(または近くで)'}話しかけた。自分の性格・口調・相手との関係・記憶に合わせて、自然に返事をする。
- 返事は短く、話し言葉で(60字以内)。音声で読み上げられるので記号や絵文字は使わない
- 他の人と同じことを繰り返さない。賛成でも反対でも、自分らしい理由を一言添える
- 他の人のセリフを真似しない・言い換えもしない。必ず自分の言葉で、違う内容を話す
- アイテムは日本語で呼ぶ (stone_pickaxe ではなく「石のツルハシ」)
- 気が乗らなければ断ったり、say を空にして黙ってもよい
- 他の住人に意見を聞きたいときは "ask" にその人の名前を入れる
- 頼みごとを引き受けるなら "action" に行動を入れる (${REQUEST_ACTIONS.join('|')})。引き受けないなら null
- 以前その人と話した内容を覚えていれば、自然に触れてよい
- 場所は「家から東へ約38ブロック」のように家を基準に言う (【状況】の「いる場所」をそのまま使う)。座標の数字は言わない
- 誰かの居場所を聞かれたら【見かけた人】を見て「3分前に家から東へ約56ブロックで見た」のように、いつ・どこで見たかを答える。見ていなければ「見てない」と言う。人から聞いた話なら、そう言う
- 知らないことは知らないと言い、作り話をしない
必ず次のJSONだけで答える:
{"say":"返事","ask":null または "住人の名前","action":null または {"name":"行動名","args":{}},"goal":null または "新しい短期目標","relationship_event":null または {"type":"${types}","note":"相手の発言をどう受け取ったか(20字)"}}
`
  const user = `【状況】
${stateText}

【見かけた人】
${sightings || '- (最近だれも見かけていない)'}
${experience ? `\n【自分の最近の経験】(聞かれたら話してよい。自分から持ち出してもよい)\n${experience}\n` : ''}
【${speakerDisplay}${isHuman ? '(人間のプレイヤー)' : ''}との関係】
${relationText || '特になし'}

【${speakerDisplay}についての記憶・前に話したこと】
${memoryLines(aboutMemories)}

【最近の会話】
${recentChat || '- なし'}
${threadText ? `\n【この話題で他の人がすでに言ったこと】\n${threadText}\n` : ''}${others.length ? `\n近くにいる住人: ${others.join(', ')}\n` : ''}${stance ? `\n(あなたの反応の方向性の目安: ${stance}${why ? ` — ${why}` : ''}。ただし性格に合わなければ従わなくてよい)\n` : ''}
${speakerDisplay}「${text}」
返事をJSONで答えて。`
  return [{ role: 'system', content: system }, { role: 'user', content: user }]
}

export function buildDiaryPrompt (ctx) {
  const { character, agentRow, day, todayMemories, relations, names } = ctx
  const system = personaBlock(character, agentRow) + `

一日の終わりに日記を書く。自分の口調で、正直な気持ちを書く。${character.diary_style ? `文体: ${character.diary_style}` : ''}
必ず次のJSONだけで答える:
{"diary":"日記本文(200字以内。今日したこと、話した相手、印象に残ったこと、困ったこと、仲間について気づいたこと)","tomorrow":"明日やりたいこと(40字以内)","impressions":[{"name":"仲間の名前","impression":"その人への今の印象(30字以内)","label":"関係を一言で(親友/ライバル/苦手/師匠 など。変化なしならnull)"}],"growth":"今日の経験で変わった考え方(なければ空文字)","lesson":"次に活かす教訓(なければ空文字)"}`
  const user = `【${day}日目の出来事】
${memoryLines(todayMemories)}

【仲間との関係】
${relations || '- なし'}

仲間: ${names.join(', ')}
日記をJSONで書いて。`
  return [{ role: 'system', content: system }, { role: 'user', content: user }]
}

export function buildDeathReactionPrompt (ctx) {
  const { character, agentRow, deadDisplay, cause, relationText, aboutMemories, permanent } = ctx
  const system = personaBlock(character, agentRow) + `

仲間の${deadDisplay}が${permanent ? '亡くなった。もう戻ってこない' : '死んでしまった(この世界では復活する)'}。自分の性格と相手との関係に合わせて反応する。
必ず次のJSONだけで答える:
{"say":"その場で口にする言葉(50字以内)","feeling":"心の中の気持ち(50字以内)","propose_grave":true/false,"new_goal":"これをきっかけに変わる目標(なければ空文字)"}`
  const user = `死因: ${cause}
【${deadDisplay}との関係】${relationText || '特になし'}
【${deadDisplay}との思い出】
${memoryLines(aboutMemories)}
JSONで答えて。`
  return [{ role: 'system', content: system }, { role: 'user', content: user }]
}

export function buildSummarizePrompt (name, texts) {
  return [
    { role: 'system', content: `あなたは${name}の記憶を整理する係。重要な人・場所・出来事・感情を残し、古い記憶を150字以内に要約する。JSONで {"summary":"..."} だけを返す。` },
    { role: 'user', content: texts.join('\n') }
  ]
}

// 最期のひとこと: 倒れる瞬間に口にする言葉 (短く・すぐ返せるように)
export function buildLastWordsPrompt ({ character, agentRow, situation, nearby }) {
  const system = personaBlock(character, agentRow, { compact: true }) + `

今まさに力尽きて倒れようとしている (この世界では、あとで家のベッドで目を覚ます)。
倒れる瞬間に思わず口にする最期のひとことを、自分の口調で言う。20字以内。
近くに仲間がいれば、その人への言葉でもよい。状況に合わせて、いつも同じにならないように。
必ず次のJSONだけで答える: {"say":"最期のひとこと"}`
  const user = `状況: ${situation}\n近くにいる人: ${nearby || 'だれもいない'}\nJSONで答えて。`
  return [{ role: 'system', content: system }, { role: 'user', content: user }]
}

// 仲間が倒れたのを見た / 悲鳴を聞いた (復活する世界)
export function buildWitnessPrompt ({ character, agentRow, deadDisplay, how, cause, lastWords, count, relationText, experience }) {
  const scene = how === 'saw'
    ? `今、目の前で${deadDisplay}が${cause ? cause + 'で' : ''}倒れた (この世界では、倒れても家のベッドで目を覚ます)。${lastWords ? `倒れる前に「${lastWords}」と言っていた。` : ''}`
    : `少し遠くから${deadDisplay}の悲鳴が聞こえた。何が起きたかは見ていないので分からない。`
  const system = personaBlock(character, agentRow, { compact: true }) + `

${scene}
自分の性格と${deadDisplay}との関係どおりに、思わず口にする一言を言う (30字以内)。
${count >= 2 ? `${deadDisplay}が倒れたのは、自分が知っているだけで最近${count}回目。${count >= 3 ? '「死にすぎ」「またか」のように、そのことに触れるのが自然。' : '多いと感じたら触れてよい。'}` : ''}
心配・ツッコミ・からかい・驚きなど、関係に合った反応にする。何も言わない方が自然なら say を空にする。
必ず次のJSONだけで答える: {"say":"口にする一言","feeling":"心の中(30字以内)","go_help":true/false}`
  const user = `【${deadDisplay}との関係】${relationText || '特になし'}
【自分の最近の経験】
${experience || '- 特になし'}
JSONで答えて。`
  return [{ role: 'system', content: system }, { role: 'user', content: user }]
}

// 倒れて、家のベッドで目を覚ました
export function buildRespawnPrompt ({ character, agentRow, cause, count, nearby, experience }) {
  const system = personaBlock(character, agentRow, { compact: true }) + `

さっき${cause ? cause + 'で' : ''}倒れて、今、家のベッドで目を覚ました。${count >= 2 ? `最近${count}回目。` : ''}
目を覚ましての一言を、自分の口調で言う (30字以内)。悔しい・恥ずかしい・反省・強がりなど、性格どおりに。
${nearby ? `近くに${nearby}がいる。話しかけてもよい。` : '近くに誰もいないなら、ひとりごと。'}
必ず次のJSONだけで答える: {"say":"一言","lesson":"次から気をつけること(20字以内)"}`
  const user = `【自分の最近の経験】\n${experience || '- 特になし'}\nJSONで答えて。`
  return [{ role: 'system', content: system }, { role: 'user', content: user }]
}
