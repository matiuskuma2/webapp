# 画像プロンプトテンプレート

## 🎨 画像生成プロンプト仕様

### スタイル固定
すべての画像は**ニュース風インフォグラフィック**スタイルで統一する。

### 言語
- **シーン固有の内容部分（`scene.image_prompt`）**: 英語推奨だが日本語も可
- **スタイル指定（固定部分）**: 英語固定
- Gemini (Nano Banana) は日本語プロンプトもサポートしているため、柔軟に対応

---

## 📐 プロンプトテンプレート

### 基本構造
```
[シーン固有の内容: scene.image_prompt] + [スタイル指定（固定部分）]
```

### スタイル指定（固定部分）
```
, clean infographic style, news broadcast quality, professional layout, modern design, data visualization elements, blue and white color scheme, high contrast, readable text hierarchy, minimalist composition, corporate aesthetic, 16:9 aspect ratio
```

---

## 📝 完全なプロンプトフォーマット

### テンプレート
```
{scene.image_prompt}, clean infographic style, news broadcast quality, professional layout, modern design, data visualization elements, blue and white color scheme, high contrast, readable text hierarchy, minimalist composition, corporate aesthetic, 16:9 aspect ratio
```

### 実装方法
```typescript
function buildImagePrompt(scenePrompt: string): string {
  const styleTemplate = ", clean infographic style, news broadcast quality, professional layout, modern design, data visualization elements, blue and white color scheme, high contrast, readable text hierarchy, minimalist composition, corporate aesthetic, 16:9 aspect ratio";
  
  return scenePrompt + styleTemplate;
}
```

---

## 🎯 シーン別プロンプト例

### 1. hook（導入・フック）
```
Modern office with holographic AI interfaces, workers collaborating with robots, futuristic workspace, technology innovation, clean infographic style, news broadcast quality, professional layout, modern design, data visualization elements, blue and white color scheme, high contrast, readable text hierarchy, minimalist composition, corporate aesthetic, 16:9 aspect ratio
```

### 2. context（背景・文脈）
```
AI technology timeline infographic, showing evolution of ChatGPT and Gemini, historical milestones, tech icons, progressive growth chart, clean infographic style, news broadcast quality, professional layout, modern design, data visualization elements, blue and white color scheme, high contrast, readable text hierarchy, minimalist composition, corporate aesthetic, 16:9 aspect ratio
```

### 3. main_point（主要ポイント）
```
Human and AI collaboration concept, creative brainstorming scene, people working with AI assistants, teamwork visualization, skill comparison chart, clean infographic style, news broadcast quality, professional layout, modern design, data visualization elements, blue and white color scheme, high contrast, readable text hierarchy, minimalist composition, corporate aesthetic, 16:9 aspect ratio
```

### 4. evidence（証拠・根拠）
```
Business data infographic, bar charts showing 40% productivity increase, statistical graphs, research visualization, McKinsey study representation, numbers and percentages, clean infographic style, news broadcast quality, professional layout, modern design, data visualization elements, blue and white color scheme, high contrast, readable text hierarchy, minimalist composition, corporate aesthetic, 16:9 aspect ratio
```

### 5. timeline（時系列）
```
Technology evolution timeline, key events from 2020 to 2030, milestone markers, chronological progression, arrow-based flow, historical perspective, clean infographic style, news broadcast quality, professional layout, modern design, data visualization elements, blue and white color scheme, high contrast, readable text hierarchy, minimalist composition, corporate aesthetic, 16:9 aspect ratio
```

### 6. analysis（分析・考察）
```
Strategic analysis diagram, SWOT matrix, analytical framework, decision tree visualization, critical thinking representation, clean infographic style, news broadcast quality, professional layout, modern design, data visualization elements, blue and white color scheme, high contrast, readable text hierarchy, minimalist composition, corporate aesthetic, 16:9 aspect ratio
```

### 7. summary（まとめ・要約）
```
Key points summary infographic, bullet point visualization, recap of main ideas, highlighted takeaways, synthesis of information, clean infographic style, news broadcast quality, professional layout, modern design, data visualization elements, blue and white color scheme, high contrast, readable text hierarchy, minimalist composition, corporate aesthetic, 16:9 aspect ratio
```

### 8. cta（行動喚起）
```
Call to action visual, person taking first step, upward arrow indicating growth, motivational scene, next steps illustration, actionable pathway, clean infographic style, news broadcast quality, professional layout, modern design, data visualization elements, blue and white color scheme, high contrast, readable text hierarchy, minimalist composition, corporate aesthetic, 16:9 aspect ratio
```

---

## 🌐 日本語プロンプト例

日本語コンテンツの場合、`scene.image_prompt`に日本語を使用することも可能です。

### 例: hook（導入・フック）- 日本語
```
未来のオフィス、ホログラムAIインターフェース、ロボットと協働する労働者、近未来的な職場、技術革新, clean infographic style, news broadcast quality, professional layout, modern design, data visualization elements, blue and white color scheme, high contrast, readable text hierarchy, minimalist composition, corporate aesthetic, 16:9 aspect ratio
```

### 例: evidence（証拠・根拠）- 日本語
```
ビジネスデータのインフォグラフィック、40%の生産性向上を示す棒グラフ、統計グラフ、調査の可視化、マッキンゼー研究の表現、数字とパーセンテージ, clean infographic style, news broadcast quality, professional layout, modern design, data visualization elements, blue and white color scheme, high contrast, readable text hierarchy, minimalist composition, corporate aesthetic, 16:9 aspect ratio
```

**推奨**: 英語プロンプトの方がGeminiの画像生成精度が高い傾向がありますが、日本語でも十分な品質が得られます。

---

## 🚫 プロンプト作成時の禁止事項

### NG例
❌ リアルな人物の顔を詳細に描写
❌ 特定の企業ロゴや商標の使用
❌ 政治的・宗教的に偏ったコンテンツ
❌ 暴力的・性的な表現
❌ 著作権で保護されたキャラクター

### OK例
✅ 抽象的な人物シルエット
✅ 一般的なアイコン・記号
✅ データビジュアライゼーション
✅ 概念図・フローチャート
✅ ビジネス・教育コンテンツ

---

## 🎨 色とデザインのガイドライン

### 推奨カラーパレット
- **プライマリ**: ブルー系（#3b82f6, #2563eb, #1e40af）
- **アクセント**: ホワイト（#ffffff）
- **テキスト**: ダークグレー（#1f2937, #374151）

### レイアウト原則
1. **階層構造**: 明確な情報階層
2. **ホワイトスペース**: 十分な余白
3. **アライメント**: 整然とした配置
4. **コントラスト**: 読みやすい対比
5. **一貫性**: 統一されたスタイル

---

## 🔧 実装詳細

### API呼び出し例
```typescript
async function generateImage(sceneId: number, scenePrompt: string) {
  const styleTemplate = ", clean infographic style, news broadcast quality, professional layout, modern design, data visualization elements, blue and white color scheme, high contrast, readable text hierarchy, minimalist composition, corporate aesthetic, 16:9 aspect ratio";
  const fullPrompt = scenePrompt + styleTemplate;
  
  const response = await fetch('https://api.gemini.google.com/v1/images/generate', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GEMINI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gemini-3-pro-image-preview',
      prompt: fullPrompt,
      aspect_ratio: '16:9'
    })
  });
  
  return await response.json();
}
```

---

最終更新: 2025-01-13
