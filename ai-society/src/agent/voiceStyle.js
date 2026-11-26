// 口調チェック: 住人の発言が、そのキャラの一人称・語尾になっているか確かめる。
// (小さいモデルは他の住人の口調や敬語が混ざりやすいので、混ざったら言い直させる)

const ALL_FIRST_PERSON = ['ボク', 'わたくし', 'あたし', '私', '俺', '僕']

export function voiceIssues (character, text) {
  const r = character?.speech_rules
  if (!r) return []
  const t = String(text || '')
  const issues = []
  for (const b of r.banned || []) if (t.includes(b)) issues.push(`「${b}」は使わない`)
  // 他のキャラの一人称が混ざっていないか
  const mine = r.first_person || []
  if (mine.length) {
    for (const fp of ALL_FIRST_PERSON) {
      if (mine.includes(fp) || (r.banned || []).includes(fp)) continue
      if (fp === '私' && mine.includes('わたくし')) continue
      if (t.includes(fp)) issues.push(`一人称は「${mine.join('」「')}」(「${fp}」ではない)`)
    }
  }
  const body = t.replace(/[\s、。！？!?…「」『』―ー〜]/g, '')
  if ((r.must_any || []).length && body.length >= 8 && !r.must_any.some(w => t.includes(w))) {
    issues.push(`語尾に「${r.must_any.join('」「')}」を付ける`)
  }
  if (r.max_len && t.length > r.max_len) issues.push(`${r.max_len}字以内で短く`)
  return issues
}

// 言い直しでも直らなかったときの最低限の手直し (一人称と、ずんだもんの「です/ます」)
export function fixVoice (character, text) {
  const r = character?.speech_rules
  if (!r) return text
  let t = String(text || '')
  const fp = (r.first_person || [])[0]
  if (fp) {
    for (const other of ALL_FIRST_PERSON) {
      if ((r.first_person || []).includes(other)) continue
      if (other === '私' && fp === 'わたくし') continue
      t = t.split(other).join(fp)
    }
  }
  if ((r.must_any || []).includes('のだ')) {
    // 丁寧語の文末を「〜のだ」に (行きます→行くのだ、行きましょう→行くのだ、元気です→元気なのだ)
    const iToU = { い: 'う', き: 'く', ぎ: 'ぐ', し: 'す', ち: 'つ', に: 'ぬ', び: 'ぶ', み: 'む', り: 'る' }
    const end = '(?=[。！？!?…ね〜ー]|$)'
    t = t.replace(new RegExp('します' + end, 'g'), 'するのだ').replace(new RegExp('しましょう' + end, 'g'), 'するのだ')
      .replace(new RegExp('([いきぎしちにびみり])(?:ます|ましょう)' + end, 'g'), (_m, c) => iToU[c] + 'のだ')
      .replace(new RegExp('(?:でしょう|です)' + end, 'g'), 'なのだ')
  }
  return t
}
