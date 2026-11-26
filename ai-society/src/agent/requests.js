// プレイヤーの頼みごとを言葉から読み取る (LLMに頼らない)。
// 小さいAIは「いいよ」と返事しても行動を書き忘れるので、よくある頼みはここで確実に行動にする
const ITEM_WORDS = [
  [/パン/, 'bread'], [/原木|木材|丸太/, 'oak_log'], [/板/, 'oak_planks'], [/丸石|石/, 'cobblestone'], [/松明|たいまつ/, 'torch'],
  [/石炭/, 'coal'], [/鉄/, 'iron_ingot'], [/ツルハシ|つるはし/, 'stone_pickaxe'], [/剣/, 'stone_sword'], [/ベッド/, 'white_bed'], [/作業台/, 'crafting_table']
]

export function requestFromText (text, { from, hasHome = false } = {}) {
  const t = String(text || '')
  if (/(止まって|待って|ストップ|じっとして)/.test(t)) return { action: { name: 'rest', args: { seconds: 30 } } }
  if (/(ついてきて|ついて来て|付いてきて|ついておいで)/.test(t)) return { action: { name: 'follow', args: { name: from, seconds: 90 } } }
  if (/(寝て|寝よう|ねよう|おやすみ)/.test(t)) return { action: { name: 'sleep', args: {} } }
  if (/(ちょうだい|ください|くれ|渡して|わたして|貸して)/.test(t)) {
    const it = ITEM_WORDS.find(([re]) => re.test(t))
    if (it) return { action: { name: 'give', args: { to: from, item: it[1], count: it[1] === 'bread' ? 4 : 8 } } }
  }
  if (/(家|建築|建て|つくって|作って).*(して|て|よう|ろ|こう)|建築|家建て|家作/.test(t) && !/(作業台|ツルハシ|剣|松明)/.test(t)) {
    return { focus: 'build', action: hasHome ? null : { name: 'set_home', args: {} } }
  }
  if (/(原木|木).*(集め|取って|とって|切って|伐)/.test(t)) return { action: { name: 'collect', args: { block: 'log', count: 8 } } }
  if (/鉄.*(集め|掘|探|取って)/.test(t)) return { action: { name: 'collect', args: { block: 'iron_ore', count: 3 } } }
  if (/石炭.*(集め|掘|探|取って)/.test(t)) return { action: { name: 'collect', args: { block: 'coal_ore', count: 4 } } }
  if (/石.*(集め|掘|取って)/.test(t)) return { action: { name: 'collect', args: { block: 'stone', count: 12 } } }
  // 「集めてきて」「持ってきて」は来てではない
  if (/(来て|きて|こっち|おいで|集合)/.test(t) && !/(て来て|てきて)/.test(t)) return { action: { name: 'go_to_player', args: { name: from } } }
  return null
}
