# Minecraft 自律型AI社会シミュレーション

Minecraft Java Edition のサバイバルワールドに、人格・記憶・人間関係を持つAI住人 (最大9人) を住まわせるプロジェクトです。

- **LLM (Ollama / ローカル・無料)** … 状況の解釈・行動の決定・目標設定・会話・日記・死への反応
- **通常のプログラム (Mineflayer)** … 移動・採掘・建築・クラフト・戦闘などの実際の操作、安全管理、記録
- **SQLite** … 個人の記憶・共有の歴史・日記・人間関係・死亡・お墓 (再起動しても消えない)
- **VOICEVOX** … キャラクターごとの声で会話を読み上げ (任意)

クラウドAPIは使いません。API料金・回数制限はありません。

> 調査結果・機材と電気代の試算は [docs/調査報告.md](docs/調査報告.md)、仕組みの詳細は [docs/設計.md](docs/設計.md) を参照。

---

## いま動くもの / まだのもの

| 項目 | 状態 |
|---|---|
| サーバー接続・自動再接続、3人同時参加 | ✅ 簡易サーバー (flying-squid 1.21.4) で確認 |
| 意思決定 → 安全審査 → 行動 → 記憶 のループ | ✅ ダミーLLMで確認 |
| AI同士の会話・返事・無限ループ防止 | ✅ ダミーLLMで確認 |
| 採掘 (collect)・移動・探索・散歩・家の建築・お墓 (看板+花)・お墓参り・死亡記録 | ✅ 簡易サーバーで確認 |
| 記憶の分離・想起・要約、関係の変化、日記、死亡時の通知と墓の提案、優先度付きLLMキュー | ✅ 単体テスト15件 |
| クラフト | ⚠ 簡易サーバーがクラフト非対応のため**未確認** (公式サーバーで要確認) |
| 本物のLLM (Ollama + Qwen) での判断・会話の質、応答速度 | ⚠ **未確認** (この開発環境ではOllamaを動かせなかった) |
| 睡眠・釣り・農業・戦闘・チェスト整理 | ⚠ 実装済み・**未確認** (簡易サーバーに敵や作物の仕組みがない) |
| VOICEVOX 読み上げ | ⚠ 実装済み・**未確認** (VOICEVOXを動かせなかった) |
| エンダードラゴン討伐、ネザー遠征、交易、本格的な建築 | ❌ 未実装 (STEP 5 以降) |

**最初にだいきさんのPCで「STEP 1 の確認」をしてください。** そこで出た問題を直してから次へ進みます。

---

## 必要なもの (すべて無料)

1. **Node.js 22.13 以上** (24 LTS 推奨) — https://nodejs.org/
2. **Ollama** — https://ollama.com/download
3. **Minecraft Java Edition サーバー** (公式 server.jar または Paper) — バージョン **1.21.4** を推奨
4. (任意) **VOICEVOX** — https://voicevox.hiroshiba.jp/

## セットアップ (Windows の例)

```powershell
# 1) このフォルダで依存関係をインストール
cd ai-society
npm install

# 2) LLMを用意 (GTX 1660 SUPER 6GB 向けの初期設定)
ollama pull qwen2.5:7b-instruct

# 3) 環境チェック
npm run check
```

### Minecraft サーバーの設定

人間がログアウトしても生活を続けるには、シングルプレイの「LANに公開」ではなく**専用サーバー**が必要です
(LANワールドはホストが抜けると止まるため)。

`server.properties` で次を設定します。

```properties
online-mode=false            # AIはMicrosoftアカウントを持たないため
enforce-secure-profile=false # 1.19以降、オフラインのAIがチャットするのに必要
spawn-protection=0           # スポーン付近でもAIが建築・採掘できるように
white-list=true              # online-mode=false なので、必ずホワイトリストで外部から守る
```

`whitelist.json` には AI の名前 (Haru, Rin, Popo …) と、だいきさんのMinecraftの名前を入れてください。
online-mode=false のサーバーはインターネットに公開しないでください (ポート開放しない)。

### 起動

```powershell
# Minecraftサーバーを起動した後で
npm start                              # characters/*.json で enabled:true の3人 (ハル・リン・ポポ)
npm start -- --agents Haru,Rin,Popo,Kaede   # 人数を指定
npm start -- --voice                   # VOICEVOXで読み上げ (VOICEVOXを先に起動)
npm start -- --minutes 30              # 30分で終了し、LLMの統計を表示 (計測用)
npm run mock                           # LLMなし(ダミー)で流れだけ確認
```

ゲーム内で `ハル、一緒に木を集めよう` のように名前を入れて話しかけると、その人が返事をします。
名前を入れない発言には、近くにいる誰か1人が反応します。

### 歴史を見る

```powershell
npm run history          # 世界の歴史・お墓・計画・住人の状態
npm run history -- Haru  # ハルの日記・人間関係・教訓・最近の記憶
```

### Ollama なしで試す (簡易サーバー)

```powershell
npm run test-server      # flying-squid の簡易サーバー (port 25565)
npm run mock             # 別のターミナルで
npm run smoke            # 行動ツールを1つずつ実行して確認
npm test                 # 単体テスト
```

---

## STEP 1 の確認手順 (だいきさんのPCで)

1. `npm run check` が全部 ✔ になること。Ollama のテスト応答時間と **token/秒** をメモ
2. `npm start -- --agents Haru --minutes 15` で1人だけ動かす
   - 木を集める・板を作る・家を建てる などを自分で選ぶか
   - ゲーム内で `ハル、こんにちは` と話しかけて返事があるか
   - 終了時に出る `LLM呼び出し…平均応答…秒` をメモ
3. 問題がなければ `npm start -- --minutes 30` で3人
4. 上の数値とエラーのログを共有してもらえれば、モデル選びと次の段階に進みます

## 設定 (config/settings.json)

自分用の変更は `config/settings.local.json` に書くと、git の管理外で上書きできます。

| 項目 | 意味 |
|---|---|
| `llm.model` | Ollama のモデル名。6GBなら `qwen2.5:7b-instruct` / 速さ優先なら `qwen2.5:3b` |
| `llm.concurrency` | LLMを同時に何件処理するか。1=順番 (VRAM最小)。増やす場合は Ollama の `OLLAMA_NUM_PARALLEL` も同じ値に |
| `agent.decide_interval_ms` | 1人が次の行動を考えるまでの最短間隔 |
| `conversation.*` | 聞こえる距離・AI同士の往復上限・クールダウン |
| `safety.*` | 逃げる体力・戦闘禁止の体力・食事する満腹度・ボス戦の解禁・夜の探索 |
| `death.permanent` | `true` で永久死亡 (その人は二度と参加しない。家は保護されて残る) |
| `voice.enabled` | VOICEVOX読み上げ |

## キャラクター (characters/*.json)

9人分を用意済み。`enabled: true` の人が参加します (最初はハル・リン・ポポの3人)。

| 名前 | 性格 | 初期 |
|---|---|---|
| ハル Haru | 行動派で冒険好き | 参加 |
| リン Rin | 慎重で論理的 | 参加 |
| ポポ Popo | 天真爛漫で好奇心旺盛 | 参加 |
| カエデ Kaede | 建築好きで几帳面 | |
| ムギ Mugi | 食べることが好き | |
| ジン Jin | 負けず嫌い | |
| ノノ Nono | マイペース | |
| ソラ Sora | 社交的で誰とでも仲良く | |
| クロ Kuro | 一匹狼で独自の目標 | |

固定の人格 (性格・口調・価値観など) は JSON に、経験で変わる部分 (成長・目標・関係・教訓) は SQLite に保存されます。

## 音声 (VOICEVOX) のクレジット

VOICEVOX の音声を配信・動画で使う場合は、キャラクターごとの利用規約に従い「VOICEVOX:キャラクター名」などのクレジット表記が必要です。
規約はキャラクターごとに異なります。使う前に必ず公式の各キャラクターの規約を確認してください (詳細は docs/調査報告.md)。

## ライセンス

このフォルダのコードは MIT。利用しているライブラリ: mineflayer / mineflayer-pathfinder / mineflayer-collectblock / mineflayer-pvp / minecraft-data (MIT)、minecraft-protocol・vec3 (BSD)、flying-squid (MIT・テスト用)。
