# Minecraft 自律型AI社会シミュレーション

Minecraft のサバイバルワールドに、人格・記憶・人間関係を持つ AI 住人 (最大11人) を住まわせるプロジェクト。
プレイヤーは**チャットでもマイクでも**住人に話しかけられて、住人はそれぞれの声で答える。

- **LLM (Ollama / ローカル・無料)** … 行動の決定・目標・会話・誰が返事するか・日記・死への反応
- **通常のプログラム (Mineflayer)** … 移動・採掘・建築などの操作、安全管理、記録
- **SQLite** … 個人の記憶・共有の歴史・日記・人間関係・死亡・お墓 (再起動しても消えない)
- **音声** … 認識は Whisper (faster-whisper)、合成は VOICEVOX とゆっくり (AquesTalk 系)

クラウド API は使わない。API 料金・回数制限なし。

詳しい資料:
- [docs/音声会話.md](docs/音声会話.md) … マイク会話の仕組み・使い方・PC 負荷・声の規約・声のクローン
- [docs/調査報告.md](docs/調査報告.md) … 既存プロジェクト調査・LLM 構成・機材と電気代
- [docs/設計.md](docs/設計.md) … LLM とプログラムの役割分担・記憶・関係・死亡

---

## いま動くもの / まだのもの

| 項目 | 状態 |
|---|---|
| サーバー接続・自動再接続、複数人同時参加 | ✅ 簡易サーバー (flying-squid 1.21.4) で確認 |
| 意思決定 → 安全審査 → 行動 → 記憶 のループ | ✅ ダミー LLM で確認 |
| 採掘・移動・探索・家の建築・お墓 (看板+花)・お墓参り・死亡記録 | ✅ 簡易サーバーで確認 |
| プレイヤーの発言 → 進行役 → 複数人が態度を変えて順番に返事 (文字入力モードで送信) | ✅ 簡易サーバー + ダミー LLM で確認 |
| 名指し・「みんな」・話を振る・黙る・頼みごとの引き受け・会話の順番処理 | ✅ 単体テスト |
| 音声キュー (優先度・重なり防止)、話者名からの ID 解決、マイク入力サーバー、発話区間検出・幻の文章フィルタ | ✅ 単体テスト (Node 28件 + Python 3件) |
| 本物の LLM (Ollama + Qwen) での判断・会話の質・速度 | ⚠ **未確認** (この開発環境では Ollama を動かせなかった) |
| Whisper の音声認識、マイク録音、VOICEVOX・ゆっくりの実際の再生 | ⚠ **未確認** (モデルのダウンロードとマイク・音声エンジンが使えなかった) |
| クラフト・睡眠・釣り・農業・戦闘・チェスト整理 | ⚠ 実装済み・**未確認** (簡易サーバーが未対応) |
| 全自動セットアップ (bootstrap.ps1 / setup.bat / start.bat) | ⚠ 起動の流れは簡易サーバーで確認。**Windows 実機・ダウンロード部分は未確認** |
| ゲーム内の位置から声が聞こえる立体音響、声のクローン | ❌ 未実装 (将来) |

---

## 全自動セットアップ (Windows)

**PowerShell を開いて、次の1行を貼り付けて Enter** するだけ:

```powershell
iex ([Text.Encoding]::UTF8.GetString((iwr -UseBasicParsing 'https://raw.githubusercontent.com/roytaroo/bowflit-site/claude/minecraft-9-ai-society-fdttk2/ai-society/scripts/windows/bootstrap.ps1').RawContentStream.ToArray()))
```

自動でやること:
1. winget で Git / Node.js / Java 21 / Ollama / Python / VOICEVOX をインストール (確認画面が出たら「はい」)
2. コードを `%USERPROFILE%\ai-minecraft` にダウンロード
3. `setup.bat` を実行
   - GPU の VRAM を調べて LLM のモデルを選んでダウンロード (6GB なら qwen2.5:7b-instruct)
   - 統合版かJava版か・名前を聞いて設定を保存
   - Minecraft サーバー (Paper 1.21.4) と Geyser・Floodgate・ViaVersion をダウンロードして設定
   - マイク会話用の Python 環境を作る
4. デスクトップに「AI Society 起動」を作る

あとは **「AI Society 起動」をダブルクリック** → Ollama・VOICEVOX・サーバー・住人・マイク入力が全部立ち上がる。
止めるときはそのウィンドウで Ctrl+C (ワールドを保存してから止まる)。

統合版から入るとき: 「サーバー」タブで「サーバーを追加」→ アドレスに setup の最後に表示される IP (例 192.168.x.x)、ポート 19132。
初回に Windows のファイアウォールの確認が出たら「許可」。Switch / PS は外部サーバーを直接追加できないので、別の手順が必要 (PC・スマホ・タブレットの統合版なら上の方法でOK)。

手動でやる場合は下の「必要なもの」から。

## 必要なもの (すべて無料)

1. **Node.js 22.13 以上** (24 LTS 推奨)
2. **Ollama** — https://ollama.com/download
3. **Minecraft Java Edition サーバー** (Paper 推奨) バージョン **1.21.4**。統合版から入るなら Geyser + Floodgate
4. **VOICEVOX** — https://voicevox.hiroshiba.jp/ (音声を使う場合)
5. **Python 3.10 以上** (マイク会話を使う場合)

## セットアップ (Windows の例)

```powershell
cd ai-society
npm install
ollama pull qwen2.5:7b-instruct
npm run check          # Node / キャラクター / Ollama / VOICEVOX / サーバー を確認
npm run voices         # VOICEVOX を起動した状態で、全員の声が見つかるか確認
```

`config/settings.local.json` を作って、自分用の設定を書く (git の管理外):

```json
{
  "player": { "name": "自分のMinecraftの名前", "display_name": "だいき" },
  "voice": { "enabled": true }
}
```

### Minecraft サーバーの設定 (`server.properties`)

```properties
online-mode=false            # AI は Microsoft アカウントを持たないため
enforce-secure-profile=false # 1.19 以降、オフラインの AI がチャットするのに必要
spawn-protection=0           # スポーン付近でも建築・採掘できるように
white-list=true              # 必ずホワイトリストで守る (ネットに公開しない)
```

`whitelist.json` に住人の名前 (Zundamon, Metan, Kiritan …) と自分の名前を入れる。
人間がログアウトしても生活を続けるには、LAN ワールドではなく専用サーバーが必要。

### 起動

```powershell
npm start                                   # enabled:true の住人 (最初はずんだもん・めたん・きりたん)
npm start -- --agents Zundamon              # 1人だけ
npm start -- --agents Zundamon,Metan,Kiritan,Reimu,Marisa
npm start -- --voice                        # 声で話す
npm start -- --minutes 30                   # 30分で終了して LLM の統計を表示 (計測用)
npm run mock                                # LLM なし (ダミー) で流れだけ確認
```

### マイクで話す

```powershell
cd voice_input
python -m venv .venv ; .venv\Scripts\activate
pip install -r requirements.txt
python talk.py                 # F9 を押している間だけ録音 (プッシュ・トゥ・トーク)
python talk.py --mode always   # 常時会話 (ヘッドホン推奨)
python talk.py --mode text     # マイクなしで文字入力
```

話しかけ方:
- `ずんだもん、木を集めてきて` → ずんだもんが答えて、引き受けたら行動する
- `みんな、今日はダイヤを探しに行かない?` → 何人かが、賛成・反対・面倒がる・他の人に振る などそれぞれの反応をする
- 名前を呼ばない独り言には、誰も答えないこともある

### 歴史を見る

```powershell
npm run history              # 世界の歴史・お墓・計画・住人の状態
npm run history -- Zundamon  # その人の日記・人間関係・教訓・最近の記憶
```

### Ollama なしで試す

```powershell
npm run test-server   # 簡易サーバー (port 25565)
npm run mock          # 別ターミナルで
npm run smoke         # 行動ツールを1つずつ確認
npm test              # 単体テスト
```

---

## 確認の順番 (だいきの PC で)

1. **1人と声で話す**: `npm start -- --agents Zundamon --voice` + `python talk.py`
   - F9 を押して「ずんだもん、こんにちは」→ 声で返事が来るか、何秒かかるか
   - `npm run check` の token/秒、`python talk.py` が表示する認識時間をメモ
2. **3人**: `npm start -- --voice` で「みんな、〜しない?」と話しかけて、反応がばらけるか
3. 数値とログを共有 → モデル選び・速度調整 → 11人へ

## 住人 (characters/*.json)

| 名前 | 性格 (初期設定) | 声 | 初期参加 |
|---|---|---|---|
| ずんだもん Zundamon | 天真爛漫で好奇心旺盛、調子に乗りやすい | VOICEVOX | ✅ |
| 四国めたん Metan | お嬢様気取りの自信家、金欠 | VOICEVOX | ✅ |
| 東北きりたん Kiritan | クールで効率重視、面倒くさがり | VOICEVOX | ✅ |
| 東北ずん子 Zunko | 面倒見のいいまとめ役 | VOICEVOX | |
| 白上虎太郎 Kotaro | まっすぐな負けず嫌い (仮設定) | VOICEVOX | |
| 青山龍星 Ryusei | 寡黙な一匹狼 (仮設定) | VOICEVOX | |
| ナースロボ_タイプT NurseT | 献身的で安全第一、少し機械的 | VOICEVOX | |
| 満別花丸 Hanamaru | おおらかで褒め上手、動物好き (仮設定) | VOICEVOX | |
| あんこもん Ankomon | あんこ好きのマイペース (仮設定) | VOICEVOX | |
| 霊夢 Reimu | のんびり面倒くさがり、勘が鋭い | ゆっくり | |
| 魔理沙 Marisa | 好奇心旺盛な行動派、収集癖 | ゆっくり | |

- 固定の人格 (性格・口調・価値観など) は JSON に、経験で変わる部分 (成長・目標・関係・教訓) は SQLite に保存
- **公式設定を確認できなかった住人は「仮設定」**。`canon_note` を見て、公式設定に合わせて書き換えてほしい
- 声の規約 (VOICEVOX のクレジット表記、ゆっくり = AquesTalk のライセンス、東方Project の二次創作ガイドライン) は [docs/音声会話.md](docs/音声会話.md) を参照

## 主な設定 (config/settings.json)

| 項目 | 意味 |
|---|---|
| `player.name` / `display_name` | 自分の Minecraft の名前と、住人からの呼ばれ方 |
| `llm.model` / `llm.concurrency` | Ollama のモデル、同時処理数 (増やすなら `OLLAMA_NUM_PARALLEL` も同じに) |
| `floor.*` | 「みんな」への最大返事人数、口を挟む確率、話を振る連鎖の上限、進行役だけ別モデル |
| `conversation.*` | 聞こえる距離、AI 同士の往復上限 |
| `safety.*` | 逃げる体力・戦闘禁止の体力・夜の探索 など |
| `death.permanent` | `true` で永久死亡 |
| `voice.*` | 音声合成。`aquestalk.command` にゆっくり音声のコマンド |
| `voice_input.*` | マイク入力の受付ポート、自分の発言をゲーム内に表示するか |

## ライセンス

このフォルダのコードは MIT。利用ライブラリ: mineflayer / mineflayer-pathfinder / mineflayer-collectblock / mineflayer-pvp / minecraft-data (MIT)、minecraft-protocol・vec3 (BSD)、flying-squid (MIT・テスト用)、faster-whisper (MIT)。
キャラクター・音声の権利はそれぞれの権利者にある。
