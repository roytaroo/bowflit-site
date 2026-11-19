// プロンプト生成。小さなローカルモデル (7B〜14B) でも扱えるよう、短く・JSON形式で答えさせる。
// 毎回その人物の人格・記憶・関係だけを入れるので、1つのLLMを共有しても人格は混ざらない。
import { actionListForPrompt } from './actions.js'
import { EVENT_EFFECTS } from '../society/relationships.js'

export function personaBlock (c, agentRow) {
  const lines = [
    `あなたは「${c.display_name}」(Minecraft上の名前: ${c.username})。${c.age}歳。Minecraftのサバイバルワールドで仲間と暮らしている住人。`,
    `性格: ${c.personality}`,
    `口調: ${c.speech}`,
    `大切にしていること: ${(c.values || []).join('、')}`,
    `好き: ${(c.likes || []).join('、')} / 嫌い: ${(c.dislikes || []).join('、')}`,
    `得意: ${(c.skills || []).join('、')} / 苦手: ${(c.weaknesses || []).join('、')}`,
    `個人的な目標: ${c.personal_goal}`,
    `長期的な夢: ${agentRow?.long_goal || c.dream}`
  ]
  if (agentRow?.growth) lines.push(`経験を通して変わったこと: ${agentRow.growth}`)
  lines.push('あなたはAIやボットではなく、この世界の住人として考え、話す。他の住人の心の中は分からない。')
  return lines.join('\n')
}

function memoryLines (mems) {
  return mems.map(m => `- ${m.day != null ? `(${m.day}日目) ` : ''}${m.content}`).join('\n') || '- (特になし)'
}

export function buildDecidePrompt (ctx) {
  const { character, agentRow, stateText, memories, lessons, relations, shared, projects, recentChat, lastResult, rejected, names } = ctx
  const system = personaBlock(character, agentRow) + `

あなたは次に何をするか自分で決める。体力・時間・仲間の状況・自分の目標と性格を考えて選ぶこと。
使える行動 (actionのnameはこの中から1つ):
${actionListForPrompt()}

必ず次のJSONだけで答える:
{"thought":"今の気持ちと判断理由(40字以内)","say":"声に出す一言(不要なら空文字)","say_to":"話しかける相手の名前かnull","action":{"name":"行動名","args":{}},"goal":"今取り組んでいる短期目標(20字以内)"}
任意で "long_goal":"新しい長期目標" や "promise":{"to":"名前","content":"約束の内容"} も追加できる。`

  const user = `【今の状況】
${stateText}

【今の目標】${agentRow?.current_goal || '(まだない)'}
${lastResult ? `【さっきの行動の結果】${lastResult}` : ''}
${rejected ? `【安全管理からの却下】${rejected} → 別の行動を選ぶこと` : ''}

【思い出したこと】
${memoryLines(memories)}

【過去の教訓】
${memoryLines(lessons)}

【仲間との関係】
${relations || '- (まだ誰とも親しくない)'}

【みんなの最近の出来事】
${memoryLines(shared)}

【進行中・提案中の計画】
${projects || '- なし'}

【最近の会話】
${recentChat || '- なし'}

仲間の名前: ${names.join(', ')}
次の行動をJSONで答えて。`
  return [{ role: 'system', content: system }, { role: 'user', content: user }]
}

export function buildReplyPrompt (ctx) {
  const { character, agentRow, speaker, speakerDisplay, text, relationText, aboutMemories, recentChat, stateText, isHuman } = ctx
  const types = Object.keys(EVENT_EFFECTS).filter(k => k !== 'died').join('|')
  const system = personaBlock(character, agentRow) + `

${speakerDisplay}があなたに話しかけた(または近くで話した)。自分の性格・口調・相手との関係に合わせて自然に返事をする。
返事は短く(60字以内)、会話を無理に続けなくてよい。気が向かなければ say を空にして黙ってもよい。
必ず次のJSONだけで答える:
{"say":"返事","relationship_event":null または {"type":"${types}","note":"相手の発言をどう受け取ったか(20字)"},"action":null または {"name":"go_to_player|follow|give|rest","args":{}}}
任意で "promise":{"to":"名前","content":"約束"} も追加できる。`
  const user = `【状況】
${stateText}

【${speakerDisplay}${isHuman ? '(人間のプレイヤー)' : ''}との関係】
${relationText || '特になし'}

【${speakerDisplay}についての記憶】
${memoryLines(aboutMemories)}

【最近の会話】
${recentChat || '- なし'}

${speakerDisplay}「${text}」
返事をJSONで答えて。`
  return [{ role: 'system', content: system }, { role: 'user', content: user }]
}

export function buildDiaryPrompt (ctx) {
  const { character, agentRow, day, todayMemories, relations, names } = ctx
  const system = personaBlock(character, agentRow) + `

一日の終わりに日記を書く。自分の口調で、正直な気持ちを書く。
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
