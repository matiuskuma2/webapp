# ドメインモデル仕様

## 🎯 RILARCScenarioV1 JSON Schema

整形・シーン分割の最終出力は、**必ず以下のJSON構造に完全準拠**すること。

---

## 📋 JSON Schema定義

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "type": "object",
  "required": ["version", "metadata", "scenes"],
  "properties": {
    "version": {
      "type": "string",
      "const": "1.0",
      "description": "RILARCシナリオのバージョン（固定）"
    },
    "metadata": {
      "type": "object",
      "required": ["title", "total_scenes", "estimated_duration_seconds"],
      "properties": {
        "title": {
          "type": "string",
          "minLength": 1,
          "maxLength": 100,
          "description": "シナリオ全体のタイトル"
        },
        "total_scenes": {
          "type": "integer",
          "minimum": 3,
          "maximum": 50,
          "description": "総シーン数"
        },
        "estimated_duration_seconds": {
          "type": "integer",
          "minimum": 30,
          "description": "推定再生時間（秒）"
        }
      }
    },
    "scenes": {
      "type": "array",
      "minItems": 3,
      "maxItems": 50,
      "items": {
        "type": "object",
        "required": ["idx", "role", "title", "dialogue", "bullets", "image_prompt"],
        "properties": {
          "idx": {
            "type": "integer",
            "minimum": 1,
            "description": "シーン番号（1から開始、連番）"
          },
          "role": {
            "type": "string",
            "enum": [
              "hook",
              "context",
              "main_point",
              "evidence",
              "timeline",
              "analysis",
              "summary",
              "cta"
            ],
            "description": "シーンの役割"
          },
          "title": {
            "type": "string",
            "minLength": 1,
            "maxLength": 50,
            "description": "シーンのタイトル"
          },
          "dialogue": {
            "type": "string",
            "minLength": 40,
            "maxLength": 220,
            "description": "読み上げセリフ（10〜30秒目安）"
          },
          "bullets": {
            "type": "array",
            "minItems": 2,
            "maxItems": 4,
            "items": {
              "type": "string",
              "minLength": 6,
              "maxLength": 26,
              "description": "要点（箇条書き）"
            }
          },
          "image_prompt": {
            "type": "string",
            "minLength": 20,
            "maxLength": 500,
            "description": "画像生成プロンプト（英語推奨）"
          }
        }
      }
    }
  }
}
```

---

## 📖 フィールド説明

### version（固定値）
- **値**: `"1.0"`
- **説明**: RILARCシナリオのバージョン
- **制約**: 変更不可

### metadata
| フィールド | 型 | 必須 | 制約 | 説明 |
|-----------|-----|------|------|------|
| title | string | ✅ | 1〜100文字 | シナリオ全体のタイトル |
| total_scenes | integer | ✅ | 3〜50 | 総シーン数 |
| estimated_duration_seconds | integer | ✅ | 30以上 | 推定再生時間（秒） |

### scenes[]
| フィールド | 型 | 必須 | 制約 | 説明 |
|-----------|-----|------|------|------|
| idx | integer | ✅ | 1から連番 | シーン番号 |
| role | string | ✅ | enum（下記参照） | シーンの役割 |
| title | string | ✅ | 1〜50文字 | シーンのタイトル |
| dialogue | string | ✅ | 40〜220文字 | 読み上げセリフ（10〜30秒目安） |
| bullets | string[] | ✅ | 2〜4個、各6〜26文字 | 要点（箇条書き） |
| image_prompt | string | ✅ | 20〜500文字 | 画像生成プロンプト |

### role（enum値）
| 値 | 説明 | 使用例 |
|----|------|--------|
| hook | 導入・フック | 視聴者の興味を引くオープニング |
| context | 背景・文脈 | 話題の背景情報、前提知識 |
| main_point | 主要ポイント | 最も重要な論点・主張 |
| evidence | 証拠・根拠 | データ、事実、引用 |
| timeline | 時系列 | 経緯、歴史的流れ |
| analysis | 分析・考察 | 深掘り、解釈、意味づけ |
| summary | まとめ・要約 | 重要ポイントの振り返り |
| cta | 行動喚起 | 視聴者への呼びかけ、次のアクション |

---

## 📝 出力例

```json
{
  "version": "1.0",
  "metadata": {
    "title": "AIが変える未来の働き方",
    "total_scenes": 5,
    "estimated_duration_seconds": 90
  },
  "scenes": [
    {
      "idx": 1,
      "role": "hook",
      "title": "衝撃の未来予測",
      "dialogue": "2030年、あなたの仕事の半分がAIに置き換わる。これは脅威なのか、それとも解放なのか？今日はその真実に迫ります。",
      "bullets": [
        "2030年の労働市場",
        "AIの影響範囲",
        "人間の役割変化"
      ],
      "image_prompt": "Modern office with holographic AI interfaces, workers collaborating with robots, futuristic infographic style"
    },
    {
      "idx": 2,
      "role": "context",
      "title": "AI技術の現状",
      "dialogue": "現在、ChatGPTやGeminiなどの生成AIが急速に普及しています。これらのツールは既に多くの業務を効率化し、私たちの働き方を変え始めています。",
      "bullets": [
        "生成AIの普及",
        "業務効率化の実例",
        "導入企業の増加"
      ],
      "image_prompt": "AI technology timeline infographic, showing evolution of ChatGPT and Gemini, modern tech illustration"
    },
    {
      "idx": 3,
      "role": "main_point",
      "title": "変わる仕事の本質",
      "dialogue": "重要なのは、AIに奪われる仕事ではなく、AIと協働する新しい仕事の形です。創造性、共感力、戦略的思考—これらの人間特有のスキルがますます重要になります。",
      "bullets": [
        "AI協働の重要性",
        "人間固有のスキル",
        "新しい価値創造"
      ],
      "image_prompt": "Human and AI collaboration concept, creative brainstorming scene, infographic showing human skills vs AI skills"
    },
    {
      "idx": 4,
      "role": "evidence",
      "title": "データが示す未来",
      "dialogue": "マッキンゼーの調査によると、AI導入企業の生産性は平均40%向上しています。同時に、新たに創出される雇用も年々増加しており、単純な仕事の減少を補っています。",
      "bullets": [
        "生産性40%向上",
        "新規雇用の創出",
        "スキル転換の必要性"
      ],
      "image_prompt": "Business data infographic, bar charts showing 40% productivity increase, McKinsey research visualization"
    },
    {
      "idx": 5,
      "role": "cta",
      "title": "今すぐ始めるべきこと",
      "dialogue": "未来を待つのではなく、今日から行動しましょう。AIツールを実際に使い、学び、自分のスキルをアップデートする。その一歩が、あなたの未来を大きく変えます。",
      "bullets": [
        "AIツールを試す",
        "継続的な学習",
        "スキルアップデート"
      ],
      "image_prompt": "Call to action infographic, person taking first step towards AI learning, upward arrow indicating growth"
    }
  ]
}
```

---

## ✅ バリデーションルール

### 必須チェック
1. ✅ `version` が `"1.0"` であること
2. ✅ `metadata.total_scenes` が `scenes.length` と一致すること
3. ✅ `scenes[].idx` が 1 から連番であること（欠番なし）
4. ✅ `scenes[].role` が enum 値のいずれかであること
5. ✅ `scenes[].dialogue` が 40〜220 文字であること
6. ✅ `scenes[].bullets` が 2〜4 個であること
7. ✅ `scenes[].bullets[]` が各 6〜26 文字であること
8. ✅ すべての必須フィールドが存在すること

### パース不能な出力の禁止
- JSON構文エラーを含むレスポンスを返してはいけない
- 不完全なJSONオブジェクトを返してはいけない
- スキーマ違反のデータを返してはいけない

---

## 🔧 OpenAI Chat API での使用方法

### System Prompt例
```
あなたは動画シナリオ作成の専門家です。
提供された文字起こしテキストを、RILARCシナリオ形式に変換してください。

RILARCは以下の役割を持つシーン構成です：
- hook: 視聴者の興味を引く
- context: 背景情報を提供
- main_point: 主要な論点を提示
- evidence: データや事実で裏付け
- timeline: 時系列で説明
- analysis: 深く分析
- summary: 重要点をまとめ
- cta: 行動を促す

シーン数は3〜50の範囲で、各シーンは以下の制約を守ってください：
- dialogue: 40〜220文字（読み上げ10〜30秒）
- bullets: 2〜4個の要点（各6〜26文字）
- image_prompt: 画像生成用プロンプト（英語、20〜500文字）

必ずJSON形式で出力してください。
```

### API呼び出し例
```typescript
const response = await fetch('https://api.openai.com/v1/chat/completions', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${OPENAI_API_KEY}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: transcriptionText }
    ],
    response_format: { type: 'json_object' }
  })
});

const data = await response.json();
const scenario = JSON.parse(data.choices[0].message.content);

// バリデーション
validateRILARCSchema(scenario);
```

---

最終更新: 2025-01-13
