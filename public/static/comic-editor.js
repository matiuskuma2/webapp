// comic-editor.js - Phase1.6: 漫画編集ポップアップ（SSOT統合・実用5種）
// 吹き出し5種: speech / whisper / thought / telop / caption
// SSOT原則: プレビューと公開画像は同一のCanvas描画ロジック
// 座標系: 正規化(0-1) + containRect補正

window.ComicEditor = {
  // 状態
  currentSceneId: null,
  currentScene: null,
  draft: null,
  published: null,
  baseImageGenerationId: null,
  isDragging: false,
  dragTarget: null,
  dragOffset: { x: 0, y: 0 },
  isPublishing: false,
  isSaving: false,

  // 定数
  MAX_UTTERANCES: 3,
  MAX_BUBBLES: 3, // 画面破綻防止のため3に制限
  
  // キャッシュ
  _containRect: null,
  _baseImageLoaded: false,
  
  // Phase1.6: 実用5種のみ
  BUBBLE_TYPES: {
    speech:  { name: '通常', icon: 'fa-comment', hasTail: true, category: 'serif' },
    whisper: { name: '小声', icon: 'fa-comment-dots', hasTail: true, category: 'serif' },
    thought: { name: '思考', icon: 'fa-cloud', hasTail: true, category: 'serif' },
    telop:   { name: 'テロップ帯', icon: 'fa-square', hasTail: false, category: 'narration' },
    caption: { name: '字幕', icon: 'fa-font', hasTail: false, category: 'narration' }
  },

  // Phase1.6: サイズ定義（1000px基準）
  BUBBLE_SIZES: {
    speech:  { w: 380, h: 200 },
    whisper: { w: 380, h: 200 },
    thought: { w: 360, h: 190 },
    telop:   { w: 760, h: 140 },
    caption: { w: 760, h: 120 }
  },

  // Phase1.6: スタイル定義
  BUBBLE_STYLES: {
    speech: {
      fill: '#FFFFFF',
      stroke: 'rgba(0,0,0,0.70)',
      strokeWidth: 2.5,
      radius: 22,
      fontSize: 18,
      lineHeight: 26,
      padding: 18,
      textColor: '#111827'
    },
    whisper: {
      fill: '#FFFFFF',
      stroke: 'rgba(0,0,0,0.45)',
      strokeWidth: 2.0,
      strokeDash: [6, 5],
      radius: 22,
      fontSize: 18,
      lineHeight: 26,
      padding: 18,
      textColor: '#111827'
    },
    thought: {
      fill: '#FFFFFF',
      stroke: 'rgba(0,0,0,0.55)',
      strokeWidth: 2.0,
      fontSize: 18,
      lineHeight: 26,
      padding: 18,
      textColor: '#111827'
    },
    telop: {
      fill: 'rgba(0,0,0,0.50)', // 半透明（真っ黒禁止）
      radius: 16,
      fontSize: 24,
      lineHeight: 32,
      padding: 20,
      textColor: '#FFFFFF',
      textStroke: 'rgba(0,0,0,0.65)',
      textStrokeWidth: 2.0
    },
    caption: {
      // 背景なし
      fontSize: 26,
      lineHeight: 34,
      padding: 16,
      textColor: '#FFFFFF',
      textStroke: 'rgba(0,0,0,0.85)',
      textStrokeWidth: 4.0
    }
  },

  // ============== SSOT: 座標系変換 ==============

  /**
   * SSOT: containRect を計算（object-contain による画像表示領域）
   */
  getContainRect() {
    const container = document.getElementById('comicCanvasContainer');
    const baseImage = document.getElementById('comicBaseImage');
    
    if (!container || !baseImage) return null;
    
    const containerRect = container.getBoundingClientRect();
    const naturalWidth = baseImage.naturalWidth || containerRect.width;
    const naturalHeight = baseImage.naturalHeight || containerRect.height;
    
    const containerAspect = containerRect.width / containerRect.height;
    const imageAspect = naturalWidth / naturalHeight;
    
    let displayWidth, displayHeight, offsetX, offsetY;
    
    if (containerAspect > imageAspect) {
      displayHeight = containerRect.height;
      displayWidth = displayHeight * imageAspect;
      offsetX = (containerRect.width - displayWidth) / 2;
      offsetY = 0;
    } else {
      displayWidth = containerRect.width;
      displayHeight = displayWidth / imageAspect;
      offsetX = 0;
      offsetY = (containerRect.height - displayHeight) / 2;
    }
    
    return {
      x: offsetX,
      y: offsetY,
      width: displayWidth,
      height: displayHeight,
      naturalWidth,
      naturalHeight,
      containerWidth: containerRect.width,
      containerHeight: containerRect.height,
      scale: displayWidth / naturalWidth
    };
  },

  /**
   * 正規化座標(0-1) → コンテナ座標（プレビュー表示用）
   */
  normalizedToContainer(normX, normY) {
    const rect = this.getContainRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: rect.x + normX * rect.width,
      y: rect.y + normY * rect.height
    };
  },

  /**
   * コンテナ座標 → 正規化座標(0-1)（ドラッグ用）
   */
  containerToNormalized(containerX, containerY) {
    const rect = this.getContainRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: (containerX - rect.x) / rect.width,
      y: (containerY - rect.y) / rect.height
    };
  },

  /**
   * bubbleサイズをピクセルで取得
   */
  getBubbleSizePx(type, naturalW) {
    const scale = naturalW / 1000;
    const base = this.BUBBLE_SIZES[type] || this.BUBBLE_SIZES.speech;
    return { w: base.w * scale, h: base.h * scale };
  },

  /**
   * SSOT: 画面内に収まるようクランプ（bubbleサイズ込み）
   */
  clampBubblePosition(pos, type, naturalW, naturalH) {
    const size = this.getBubbleSizePx(type, naturalW);
    const marginPx = 16;
    
    const mx = marginPx / naturalW;
    const my = marginPx / naturalH;
    const bw = size.w / naturalW;
    const bh = size.h / naturalH;
    
    return {
      x: Math.min(Math.max(pos.x, mx), 1 - bw - mx),
      y: Math.min(Math.max(pos.y, my), 1 - bh - my)
    };
  },

  // ============== 描画ユーティリティ ==============

  /**
   * 角丸長方形パス
   */
  pathRoundRect(ctx, x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  },

  /**
   * Tail付き長方形パス（speech/whisper用）
   */
  pathSpeechWithTail(ctx, w, h, r, tailTip, scale) {
    const tailBaseX = w * 0.55;
    const tailBaseW = 44 * scale;
    const half = Math.max(10 * scale, tailBaseW / 2);
    
    // Tail先端（デフォルトは下方向）
    const tipX = tailTip?.x ?? tailBaseX;
    const tipY = tailTip?.y ?? (h + 26 * scale);
    
    const left = Math.max(r + 8 * scale, tailBaseX - half);
    const right = Math.min(w - r - 8 * scale, tailBaseX + half);
    
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(w - r, 0);
    ctx.quadraticCurveTo(w, 0, w, r);
    ctx.lineTo(w, h - r);
    ctx.quadraticCurveTo(w, h, w - r, h);
    
    // 下辺（Tail部分）
    ctx.lineTo(right, h);
    ctx.lineTo(tipX, tipY);
    ctx.lineTo(left, h);
    
    ctx.lineTo(r, h);
    ctx.quadraticCurveTo(0, h, 0, h - r);
    ctx.lineTo(0, r);
    ctx.quadraticCurveTo(0, 0, r, 0);
    ctx.closePath();
  },

  /**
   * テキスト自動改行（measureText使用）
   */
  wrapTextByMeasure(ctx, text, maxW) {
    if (!text) return [''];
    const lines = [];
    let line = '';
    for (const ch of text) {
      if (ch === '\n') {
        lines.push(line);
        line = '';
        continue;
      }
      const test = line + ch;
      if (ctx.measureText(test).width > maxW && line.length > 0) {
        lines.push(line);
        line = ch;
      } else {
        line = test;
      }
    }
    if (line) lines.push(line);
    return lines.slice(0, 6); // 最大6行
  },

  /**
   * テキストがフィットするか検証＋自動縮小
   */
  fitText(ctx, text, innerW, innerH, baseFontPx, baseLineH, isBold) {
    const minFont = 12;
    for (let font = baseFontPx; font >= minFont; font -= 1) {
      ctx.font = `${isBold ? '700' : '400'} ${font}px "Hiragino Kaku Gothic ProN", "Hiragino Sans", sans-serif`;
      const lineH = Math.round(baseLineH * (font / baseFontPx));
      const lines = this.wrapTextByMeasure(ctx, text, innerW);
      const neededH = lines.length * lineH;
      if (neededH <= innerH) {
        return { ok: true, fontPx: font, lineH, lines };
      }
    }
    return { ok: false };
  },

  // ============== 吹き出し描画（SSOT） ==============

  /**
   * speech吹き出しを描画（丸角長方形＋Tail）
   */
  drawSpeechBubble(ctx, w, h, scale, tailTip) {
    const style = this.BUBBLE_STYLES.speech;
    const r = style.radius * scale;
    
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.18)';
    ctx.shadowBlur = 10 * scale;
    ctx.shadowOffsetY = 4 * scale;
    
    this.pathSpeechWithTail(ctx, w, h, r, tailTip, scale);
    ctx.fillStyle = style.fill;
    ctx.fill();
    ctx.restore();
    
    ctx.strokeStyle = style.stroke;
    ctx.lineWidth = style.strokeWidth * scale;
    ctx.stroke();
  },

  /**
   * whisper吹き出しを描画（点線枠＋Tail）
   */
  drawWhisperBubble(ctx, w, h, scale, tailTip) {
    const style = this.BUBBLE_STYLES.whisper;
    const r = style.radius * scale;
    
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.14)';
    ctx.shadowBlur = 8 * scale;
    ctx.shadowOffsetY = 3 * scale;
    
    this.pathSpeechWithTail(ctx, w, h, r, tailTip, scale);
    ctx.fillStyle = style.fill;
    ctx.fill();
    ctx.restore();
    
    ctx.strokeStyle = style.stroke;
    ctx.lineWidth = style.strokeWidth * scale;
    ctx.setLineDash(style.strokeDash.map(d => d * scale));
    ctx.stroke();
    ctx.setLineDash([]);
  },

  /**
   * thought吹き出しを描画（楕円＋ぽこぽこTail）
   */
  drawThoughtBubble(ctx, w, h, scale, tailTip) {
    const style = this.BUBBLE_STYLES.thought;
    
    // 楕円本体
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.18)';
    ctx.shadowBlur = 10 * scale;
    ctx.shadowOffsetY = 4 * scale;
    
    ctx.beginPath();
    ctx.ellipse(w/2, h/2, w/2, h/2, 0, 0, Math.PI * 2);
    ctx.fillStyle = style.fill;
    ctx.fill();
    ctx.restore();
    
    ctx.strokeStyle = style.stroke;
    ctx.lineWidth = style.strokeWidth * scale;
    ctx.stroke();
    
    // ぽこぽこTail（3つの円）
    const sx = w * 0.50;
    const sy = h + 6 * scale;
    const tx = tailTip?.x ?? (w * 0.58);
    const ty = tailTip?.y ?? (h + 50 * scale);
    
    const points = [
      { x: sx + (tx - sx) * 0.25, y: sy + (ty - sy) * 0.25, r: 8 * scale },
      { x: sx + (tx - sx) * 0.55, y: sy + (ty - sy) * 0.55, r: 6 * scale },
      { x: sx + (tx - sx) * 0.85, y: sy + (ty - sy) * 0.85, r: 4 * scale }
    ];
    
    ctx.fillStyle = style.fill;
    ctx.strokeStyle = style.stroke;
    ctx.lineWidth = style.strokeWidth * scale;
    
    for (const p of points) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  },

  /**
   * telop（帯テロップ）を描画
   */
  drawTelopBubble(ctx, w, h, scale) {
    const style = this.BUBBLE_STYLES.telop;
    const r = style.radius * scale;
    
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.14)';
    ctx.shadowBlur = 8 * scale;
    ctx.shadowOffsetY = 4 * scale;
    
    this.pathRoundRect(ctx, 0, 0, w, h, r);
    ctx.fillStyle = style.fill;
    ctx.fill();
    ctx.restore();
  },

  /**
   * 吹き出しテキストを描画
   * @returns {object} { ok: boolean } - falseなら文字溢れ
   */
  drawBubbleText(ctx, text, type, w, h, scale) {
    const style = this.BUBBLE_STYLES[type] || this.BUBBLE_STYLES.speech;
    const padding = style.padding * scale;
    const innerW = w - padding * 2;
    const innerH = h - padding * 2;
    
    const isNarration = type === 'telop' || type === 'caption';
    const baseFontPx = style.fontSize * scale;
    const baseLineH = style.lineHeight * scale;
    
    const fit = this.fitText(ctx, text, innerW, innerH, baseFontPx, baseLineH, isNarration);
    
    if (!fit.ok) {
      return { ok: false };
    }
    
    ctx.font = `${isNarration ? '700' : '400'} ${fit.fontPx}px "Hiragino Kaku Gothic ProN", "Hiragino Sans", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    const startY = padding + (innerH - fit.lines.length * fit.lineH) / 2 + fit.lineH / 2;
    
    for (let i = 0; i < fit.lines.length; i++) {
      const lx = w / 2;
      const ly = startY + i * fit.lineH;
      
      if (type === 'caption' || type === 'telop') {
        // 白文字＋黒縁
        ctx.lineWidth = style.textStrokeWidth * scale;
        ctx.strokeStyle = style.textStroke;
        ctx.lineJoin = 'round';
        ctx.strokeText(fit.lines[i], lx, ly);
        ctx.fillStyle = style.textColor;
        ctx.fillText(fit.lines[i], lx, ly);
      } else {
        // 通常セリフは黒文字
        ctx.fillStyle = style.textColor;
        ctx.fillText(fit.lines[i], lx, ly);
      }
    }
    
    return { ok: true };
  },

  /**
   * 1つの吹き出しを描画（統合関数）
   */
  drawOneBubble(ctx, bubble, text, scale, options = {}) {
    const size = this.BUBBLE_SIZES[bubble.type] || this.BUBBLE_SIZES.speech;
    const w = size.w * scale;
    const h = size.h * scale;
    
    // Tail先端（bubbleローカル座標）
    const tailTip = bubble.tail?.enabled 
      ? { x: (bubble.tail.tip?.x ?? 0.55) * w, y: (bubble.tail.tip?.y ?? 1.15) * h }
      : null;
    
    // 背景描画
    switch (bubble.type) {
      case 'speech':
        this.drawSpeechBubble(ctx, w, h, scale, tailTip);
        break;
      case 'whisper':
        this.drawWhisperBubble(ctx, w, h, scale, tailTip);
        break;
      case 'thought':
        this.drawThoughtBubble(ctx, w, h, scale, tailTip);
        break;
      case 'telop':
        this.drawTelopBubble(ctx, w, h, scale);
        break;
      case 'caption':
        // 背景なし
        break;
    }
    
    // テキスト描画
    const result = this.drawBubbleText(ctx, text, bubble.type, w, h, scale);
    
    // 削除ボタン（プレビュー時のみ）
    if (options.showDeleteButton) {
      this.drawDeleteButton(ctx, w, scale);
    }
    
    return { ok: result.ok, w, h };
  },

  /**
   * 削除ボタンを描画
   */
  drawDeleteButton(ctx, bubbleWidth, scale) {
    const btnRadius = 12 * scale;
    const btnX = bubbleWidth - 8 * scale;
    const btnY = 8 * scale;
    
    ctx.beginPath();
    ctx.arc(btnX, btnY, btnRadius, 0, Math.PI * 2);
    ctx.fillStyle = '#EF4444';
    ctx.fill();
    
    ctx.fillStyle = 'white';
    ctx.font = `bold ${14 * scale}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('×', btnX, btnY);
  },

  // ============== バリデーション ==============

  /**
   * draft全体をバリデート（文字溢れ・画面外チェック）
   * @returns {object} { ok: boolean, errors: [] }
   */
  validateDraft() {
    const errors = [];
    const rect = this.getContainRect();
    if (!rect) return { ok: true, errors: [] };
    
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const scale = rect.naturalWidth / 1000;
    
    for (const bubble of this.draft.bubbles || []) {
      const ut = this.draft.utterances.find(u => u.id === bubble.utterance_id);
      const text = (ut?.text || '').trim();
      
      // 画面外チェック
      const clamped = this.clampBubblePosition(bubble.position, bubble.type, rect.naturalWidth, rect.naturalHeight);
      if (Math.abs(clamped.x - bubble.position.x) > 0.001 || Math.abs(clamped.y - bubble.position.y) > 0.001) {
        errors.push({ type: 'OUT_OF_BOUNDS', bubbleId: bubble.id, message: '吹き出しが画面外にはみ出しています' });
      }
      
      // 文字溢れチェック（テキストがある場合のみ）
      if (text) {
        const size = this.BUBBLE_SIZES[bubble.type] || this.BUBBLE_SIZES.speech;
        const style = this.BUBBLE_STYLES[bubble.type] || this.BUBBLE_STYLES.speech;
        const w = size.w * scale;
        const h = size.h * scale;
        const padding = style.padding * scale;
        const innerW = w - padding * 2;
        const innerH = h - padding * 2;
        
        const baseFontPx = style.fontSize * scale;
        const baseLineH = style.lineHeight * scale;
        const isNarration = bubble.type === 'telop' || bubble.type === 'caption';
        
        const fit = this.fitText(ctx, text, innerW, innerH, baseFontPx, baseLineH, isNarration);
        if (!fit.ok) {
          errors.push({ type: 'TEXT_OVERFLOW', bubbleId: bubble.id, message: 'テキストが収まりません。短くしてください' });
        }
      }
    }
    
    return { ok: errors.length === 0, errors };
  },

  // ============== UI関連 ==============

  /**
   * 漫画編集ポップアップを開く
   */
  async open(sceneId) {
    console.log('[ComicEditor] Opening for scene:', sceneId);
    this.currentSceneId = sceneId;
    this._containRect = null;
    this._baseImageLoaded = false;

    try {
      const res = await axios.get(`/api/scenes/${sceneId}?view=board`);
      this.currentScene = res.data;
      console.log('[ComicEditor] Scene loaded:', this.currentScene);
    } catch (err) {
      console.error('[ComicEditor] Failed to load scene:', err);
      showToast('シーンの読み込みに失敗しました', 'error');
      return;
    }

    const activeImage = this.currentScene.active_image;
    const imageUrl = activeImage?.r2_url || activeImage?.image_url;
    if (!imageUrl) {
      showToast('画像が生成されていません', 'warning');
      return;
    }

    this.baseImageGenerationId = activeImage?.id || null;
    this.initComicData();
    this.renderModal(imageUrl);
    this.showModal();
  },

  /**
   * comic_data の初期化
   */
  initComicData() {
    const comicData = this.currentScene.comic_data;
    
    if (comicData && comicData.draft) {
      this.draft = comicData.draft;
      this.published = comicData.published || null;
      this.baseImageGenerationId = comicData.base_image_generation_id || this.baseImageGenerationId;
    } else if (comicData && comicData.published) {
      this.draft = JSON.parse(JSON.stringify(comicData.published));
      this.published = comicData.published;
      this.baseImageGenerationId = comicData.base_image_generation_id || this.baseImageGenerationId;
    } else {
      this.draft = {
        enabled: true,
        utterances: [{
          id: 'ut_1',
          speaker_type: 'narration',
          speaker_id: null,
          text: this.currentScene.dialogue || ''
        }],
        bubbles: []
      };
      this.published = null;
    }
    
    // 既存データのtail初期化
    for (const bubble of this.draft.bubbles || []) {
      const typeInfo = this.BUBBLE_TYPES[bubble.type];
      if (!bubble.tail && typeInfo?.hasTail) {
        bubble.tail = { enabled: true, tip: { x: 0.55, y: 1.15 } };
      }
    }
    
    console.log('[ComicEditor] Draft initialized:', this.draft);
  },

  /**
   * モーダルHTMLを生成・挿入
   */
  renderModal(imageUrl) {
    const existing = document.getElementById('comicEditorModal');
    if (existing) existing.remove();

    const hasPublished = !!this.published?.image_generation_id;
    const hasDraftChanges = this.draft && JSON.stringify(this.draft) !== JSON.stringify(this.published);
    
    let statusBadge = '';
    if (hasPublished && hasDraftChanges) {
      statusBadge = `<span class="ml-2 px-2 py-1 bg-orange-500 text-white text-xs rounded-full">未公開の変更</span>`;
    } else if (hasPublished) {
      statusBadge = `<span class="ml-2 px-2 py-1 bg-green-500 text-white text-xs rounded-full">公開済み</span>`;
    } else {
      statusBadge = `<span class="ml-2 px-2 py-1 bg-yellow-500 text-white text-xs rounded-full">未公開</span>`;
    }

    const modalHtml = `
      <div id="comicEditorModal" class="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-60" style="display: none;">
        <div class="bg-white rounded-xl shadow-2xl w-full max-w-6xl max-h-[90vh] flex flex-col">
          <!-- Header（固定） -->
          <div class="bg-gradient-to-r from-purple-600 to-blue-600 px-6 py-4 flex items-center justify-between flex-shrink-0">
            <h2 class="text-xl font-bold text-white flex items-center">
              <i class="fas fa-comment-alt mr-2"></i>
              漫画編集 - シーン #${this.currentScene.idx}
              ${statusBadge}
            </h2>
            <button onclick="ComicEditor.close()" class="text-white hover:text-gray-200 text-2xl">
              <i class="fas fa-times"></i>
            </button>
          </div>

          <!-- Body（スクロール可） -->
          <div class="flex-1 overflow-hidden p-6">
            <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 h-full">
              <!-- 左: プレビュー -->
              <div class="flex flex-col space-y-3">
                <h3 class="font-semibold text-gray-700 flex items-center flex-shrink-0">
                  <i class="fas fa-image mr-2 text-purple-600"></i>プレビュー
                </h3>
                <div id="comicCanvasContainer" class="relative bg-gray-900 rounded-lg overflow-hidden flex-1" style="min-height: 300px;">
                  <img 
                    id="comicBaseImage" 
                    src="${imageUrl}" 
                    crossorigin="anonymous" 
                    class="w-full h-full object-contain" 
                    alt="Scene image" 
                    onload="ComicEditor.onBaseImageLoad()"
                  />
                  <canvas 
                    id="comicPreviewCanvas" 
                    class="absolute inset-0 w-full h-full" 
                    style="pointer-events: auto;"
                  ></canvas>
                </div>
                <p class="text-xs text-gray-500 flex-shrink-0">
                  <i class="fas fa-arrows-alt mr-1"></i>吹き出しをドラッグで移動
                </p>
              </div>

              <!-- 右: 発話＋吹き出し（スクロール可） -->
              <div class="flex flex-col h-full overflow-hidden">
                <h3 class="font-semibold text-gray-700 flex items-center flex-shrink-0 pb-2">
                  <i class="fas fa-list mr-2 text-blue-600"></i>発話・吹き出し
                </h3>

                <!-- スクロール領域 -->
                <div class="flex-1 overflow-y-auto space-y-4 pr-2">
                  <!-- 発話リスト -->
                  <div id="utteranceList" class="space-y-3"></div>

                  <!-- 吹き出し追加 -->
                  <div class="pt-4 border-t border-gray-200">
                    <label class="block text-xs font-semibold text-gray-600 mb-3">
                      吹き出しを追加（最大 ${this.MAX_BUBBLES} 個）
                    </label>
                    <div class="space-y-3" id="bubbleTypeButtons">
                      <!-- セリフ用 -->
                      <p class="text-xs text-gray-500 font-semibold">セリフ用（Tailあり）</p>
                      <div class="grid grid-cols-3 gap-2">
                        <button onclick="ComicEditor.addBubble('speech')" class="px-3 py-2 bg-white border-2 border-gray-300 rounded-lg hover:bg-blue-50 hover:border-blue-400 transition-colors text-sm font-medium">
                          <i class="fas fa-comment text-blue-600 mr-1"></i>通常
                        </button>
                        <button onclick="ComicEditor.addBubble('whisper')" class="px-3 py-2 bg-white border-2 border-gray-300 rounded-lg hover:bg-gray-100 hover:border-gray-400 transition-colors text-sm font-medium">
                          <i class="fas fa-comment-dots text-gray-500 mr-1"></i>小声
                        </button>
                        <button onclick="ComicEditor.addBubble('thought')" class="px-3 py-2 bg-white border-2 border-gray-300 rounded-lg hover:bg-purple-50 hover:border-purple-400 transition-colors text-sm font-medium">
                          <i class="fas fa-cloud text-purple-500 mr-1"></i>思考
                        </button>
                      </div>
                      
                      <!-- ナレーション用 -->
                      <p class="text-xs text-gray-500 font-semibold mt-3">ナレーション用（Tailなし）</p>
                      <div class="grid grid-cols-2 gap-2">
                        <button onclick="ComicEditor.addBubble('telop')" class="px-3 py-2 bg-gray-800 text-white border-2 border-gray-800 rounded-lg hover:bg-gray-700 transition-colors text-sm font-medium">
                          <i class="fas fa-square mr-1"></i>テロップ帯
                        </button>
                        <button onclick="ComicEditor.addBubble('caption')" class="px-3 py-2 bg-white text-gray-800 border-2 border-gray-400 rounded-lg hover:bg-gray-100 transition-colors text-sm font-medium">
                          <i class="fas fa-font mr-1"></i>字幕（枠なし）
                        </button>
                      </div>
                    </div>
                  </div>
                  
                  <!-- エラー表示エリア -->
                  <div id="comicValidationErrors" class="hidden pt-3"></div>
                </div>
              </div>
            </div>
          </div>

          <!-- Footer（固定） -->
          <div class="bg-gray-100 px-6 py-4 flex justify-between items-center border-t border-gray-200 flex-shrink-0">
            <div class="text-sm text-gray-600">
              <i class="fas fa-info-circle text-blue-500 mr-1"></i>
              「公開」でシーンに反映
            </div>
            <div class="flex gap-3">
              <button 
                onclick="ComicEditor.close()"
                class="px-5 py-2 bg-gray-300 text-gray-700 rounded-lg hover:bg-gray-400 transition-colors font-semibold"
              >
                <i class="fas fa-times mr-1"></i>閉じる
              </button>
              <button 
                id="comicSaveBtn"
                onclick="ComicEditor.saveDraft()"
                class="px-5 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <i class="fas fa-save mr-1"></i>下書き
              </button>
              <button 
                id="comicPublishBtn"
                onclick="ComicEditor.publish()"
                class="px-5 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <i class="fas fa-upload mr-1"></i>公開
              </button>
            </div>
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHtml);
    document.addEventListener('keydown', this.handleKeyDown);
    this.renderUtterances();
  },

  /**
   * ベース画像ロード完了
   */
  onBaseImageLoad() {
    console.log('[ComicEditor] Base image loaded');
    this._baseImageLoaded = true;
    this._containRect = null;
    
    this.initPreviewCanvas();
    this.renderPreview();
    this.setupDragEvents();
  },

  /**
   * プレビューCanvas初期化
   */
  initPreviewCanvas() {
    const canvas = document.getElementById('comicPreviewCanvas');
    const container = document.getElementById('comicCanvasContainer');
    if (!canvas || !container) return;
    
    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
  },

  /**
   * ドラッグイベント設定
   */
  setupDragEvents() {
    const canvas = document.getElementById('comicPreviewCanvas');
    if (!canvas || canvas.dataset.eventsAttached) return;
    
    canvas.addEventListener('mousedown', (e) => this.handleMouseDown(e));
    canvas.addEventListener('mousemove', (e) => this.handleMouseMove(e));
    canvas.addEventListener('mouseup', () => this.handleMouseUp());
    canvas.addEventListener('mouseleave', () => this.handleMouseUp());
    
    canvas.addEventListener('touchstart', (e) => this.handleMouseDown(e), { passive: false });
    canvas.addEventListener('touchmove', (e) => this.handleMouseMove(e), { passive: false });
    canvas.addEventListener('touchend', () => this.handleMouseUp());
    
    canvas.dataset.eventsAttached = 'true';
  },

  /**
   * マウスダウン（吹き出し選択・ドラッグ開始）
   */
  handleMouseDown(e) {
    e.preventDefault();
    
    const canvas = document.getElementById('comicPreviewCanvas');
    const canvasRect = canvas.getBoundingClientRect();
    
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    
    const canvasX = clientX - canvasRect.left;
    const canvasY = clientY - canvasRect.top;
    
    const bubble = this.findBubbleAt(canvasX, canvasY);
    
    if (bubble) {
      if (this.isDeleteButtonClick(canvasX, canvasY, bubble)) {
        this.removeBubble(bubble.id);
        return;
      }
      
      this.isDragging = true;
      this.dragTarget = bubble.id;
      
      const bubbleContainerPos = this.normalizedToContainer(bubble.position.x, bubble.position.y);
      this.dragOffset = {
        x: canvasX - bubbleContainerPos.x,
        y: canvasY - bubbleContainerPos.y
      };
    }
  },

  /**
   * マウス移動（ドラッグ中）
   */
  handleMouseMove(e) {
    if (!this.isDragging || !this.dragTarget) return;
    e.preventDefault();
    
    const canvas = document.getElementById('comicPreviewCanvas');
    const canvasRect = canvas.getBoundingClientRect();
    const rect = this.getContainRect();
    if (!rect) return;
    
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    
    const canvasX = clientX - canvasRect.left;
    const canvasY = clientY - canvasRect.top;
    
    const adjustedX = canvasX - this.dragOffset.x;
    const adjustedY = canvasY - this.dragOffset.y;
    
    let normalized = this.containerToNormalized(adjustedX, adjustedY);
    
    // クランプ（画面外に出ない）
    const bubble = this.draft.bubbles.find(b => b.id === this.dragTarget);
    if (bubble) {
      normalized = this.clampBubblePosition(normalized, bubble.type, rect.naturalWidth, rect.naturalHeight);
      bubble.position.x = normalized.x;
      bubble.position.y = normalized.y;
      this.renderPreview();
    }
  },

  /**
   * マウスアップ（ドラッグ終了）
   */
  handleMouseUp() {
    this.isDragging = false;
    this.dragTarget = null;
    // バリデーション更新
    this.updateValidationUI();
  },

  /**
   * 指定座標の吹き出しを探す
   */
  findBubbleAt(canvasX, canvasY) {
    const containRect = this.getContainRect();
    if (!containRect) return null;
    
    const bubbles = this.draft.bubbles || [];
    const scale = containRect.width / 1000;
    
    for (let i = bubbles.length - 1; i >= 0; i--) {
      const bubble = bubbles[i];
      const containerPos = this.normalizedToContainer(bubble.position.x, bubble.position.y);
      const size = this.BUBBLE_SIZES[bubble.type] || this.BUBBLE_SIZES.speech;
      const bubbleWidth = size.w * scale;
      const bubbleHeight = size.h * scale;
      
      if (canvasX >= containerPos.x && canvasX <= containerPos.x + bubbleWidth &&
          canvasY >= containerPos.y && canvasY <= containerPos.y + bubbleHeight) {
        return bubble;
      }
    }
    
    return null;
  },

  /**
   * 削除ボタンクリック判定
   */
  isDeleteButtonClick(canvasX, canvasY, bubble) {
    const containRect = this.getContainRect();
    if (!containRect) return false;
    
    const scale = containRect.width / 1000;
    const containerPos = this.normalizedToContainer(bubble.position.x, bubble.position.y);
    const size = this.BUBBLE_SIZES[bubble.type] || this.BUBBLE_SIZES.speech;
    const bubbleWidth = size.w * scale;
    
    const btnX = containerPos.x + bubbleWidth - 8 * scale;
    const btnY = containerPos.y + 8 * scale;
    const btnRadius = 14 * scale;
    
    const dx = canvasX - btnX;
    const dy = canvasY - btnY;
    
    return (dx * dx + dy * dy) <= (btnRadius * btnRadius);
  },

  /**
   * プレビュー描画（SSOT）
   */
  renderPreview() {
    const canvas = document.getElementById('comicPreviewCanvas');
    const ctx = canvas?.getContext('2d');
    if (!ctx || !this._baseImageLoaded) return;
    
    const containRect = this.getContainRect();
    if (!containRect) return;
    
    const dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
    
    const bubbles = this.draft.bubbles || [];
    const scale = containRect.width / 1000;
    
    // バリデーション結果を取得
    const validation = this.validateDraft();
    const errorBubbleIds = new Set(validation.errors.map(e => e.bubbleId));
    
    bubbles.forEach((bubble) => {
      const utterance = this.draft.utterances.find(u => u.id === bubble.utterance_id);
      const text = utterance?.text || '';
      
      const containerPos = this.normalizedToContainer(bubble.position.x, bubble.position.y);
      
      ctx.save();
      ctx.translate(containerPos.x, containerPos.y);
      
      // エラーの吹き出しは赤枠で囲む
      if (errorBubbleIds.has(bubble.id)) {
        const size = this.BUBBLE_SIZES[bubble.type] || this.BUBBLE_SIZES.speech;
        ctx.strokeStyle = '#EF4444';
        ctx.lineWidth = 4 * scale;
        ctx.strokeRect(-2 * scale, -2 * scale, size.w * scale + 4 * scale, size.h * scale + 4 * scale);
      }
      
      this.drawOneBubble(ctx, bubble, text, scale, { showDeleteButton: true });
      
      ctx.restore();
    });
    
    this.updateBubbleButtons();
    this.updateValidationUI();
  },

  /**
   * バリデーションUIを更新
   */
  updateValidationUI() {
    const validation = this.validateDraft();
    const errorsDiv = document.getElementById('comicValidationErrors');
    const publishBtn = document.getElementById('comicPublishBtn');
    
    if (validation.errors.length > 0) {
      errorsDiv.innerHTML = `
        <div class="bg-red-50 border border-red-200 rounded-lg p-3">
          <p class="text-red-700 text-sm font-semibold mb-2">
            <i class="fas fa-exclamation-triangle mr-1"></i>公開できません
          </p>
          <ul class="text-red-600 text-xs space-y-1">
            ${validation.errors.map(e => `<li>• ${e.message}</li>`).join('')}
          </ul>
        </div>
      `;
      errorsDiv.classList.remove('hidden');
      publishBtn.disabled = true;
    } else {
      errorsDiv.classList.add('hidden');
      errorsDiv.innerHTML = '';
      publishBtn.disabled = false;
    }
  },

  /**
   * 発話リスト描画
   */
  renderUtterances() {
    const container = document.getElementById('utteranceList');
    if (!container) return;

    const utterances = this.draft.utterances || [];
    const sceneCharacters = this.currentScene.characters || [];
    const voicePresets = [
      { id: 'ja-JP-Neural2-B', name: '女性A' },
      { id: 'ja-JP-Neural2-C', name: '男性A' },
      { id: 'ja-JP-Neural2-D', name: '男性B' },
      { id: 'ja-JP-Wavenet-A', name: '女性B' },
      { id: 'ja-JP-Wavenet-B', name: '女性C' },
      { id: 'ja-JP-Wavenet-C', name: '男性C' }
    ];
    
    container.innerHTML = utterances.map((ut, index) => {
      const isNarration = ut.speaker_type === 'narration';
      const isCharacter = ut.speaker_type === 'character';
      
      const charOptions = sceneCharacters.length > 0 
        ? sceneCharacters.map(c => 
            `<option value="${c.character_key}" ${ut.speaker_character_key === c.character_key ? 'selected' : ''}>${this.escapeHtml(c.character_name)}</option>`
          ).join('')
        : '<option value="" disabled>キャラ未割当</option>';
      
      const presetOptions = voicePresets.map(p => 
        `<option value="${p.id}" ${ut.narrator_voice_preset_id === p.id ? 'selected' : ''}>${p.name}</option>`
      ).join('');
      
      return `
      <div class="bg-gray-50 rounded-lg p-4 border border-gray-200" data-utterance-id="${ut.id}">
        <div class="flex items-center justify-between mb-3">
          <span class="font-semibold text-sm text-gray-700">
            <i class="fas fa-comment-alt mr-1 text-purple-500"></i>発話 ${index + 1}
          </span>
          ${utterances.length > 1 ? `
          <button 
            onclick="ComicEditor.removeUtterance('${ut.id}')"
            class="text-red-500 hover:text-red-700 text-sm px-2 py-1 rounded hover:bg-red-50"
          >
            <i class="fas fa-trash"></i>
          </button>
          ` : ''}
        </div>
        
        <div class="flex gap-2 mb-3">
          <button 
            onclick="ComicEditor.updateUtteranceSpeakerType('${ut.id}', 'narration')"
            class="flex-1 px-3 py-2 rounded-lg text-sm font-semibold transition-colors ${isNarration ? 'bg-purple-600 text-white' : 'bg-white border border-gray-300 text-gray-700 hover:bg-purple-50'}"
          >
            <i class="fas fa-microphone mr-1"></i>ナレ
          </button>
          <button 
            onclick="ComicEditor.updateUtteranceSpeakerType('${ut.id}', 'character')"
            class="flex-1 px-3 py-2 rounded-lg text-sm font-semibold transition-colors ${isCharacter ? 'bg-green-600 text-white' : 'bg-white border border-gray-300 text-gray-700 hover:bg-green-50'} ${sceneCharacters.length === 0 ? 'opacity-50 cursor-not-allowed' : ''}"
            ${sceneCharacters.length === 0 ? 'disabled' : ''}
          >
            <i class="fas fa-user mr-1"></i>キャラ
          </button>
        </div>
        
        ${isNarration ? `
        <div class="mb-3">
          <label class="block text-xs font-semibold text-gray-600 mb-1">音声</label>
          <select 
            onchange="ComicEditor.updateUtteranceNarratorVoice('${ut.id}', this.value)"
            class="w-full text-sm px-3 py-2 rounded-lg border border-purple-300 bg-purple-50"
          >
            ${presetOptions}
          </select>
        </div>
        ` : ''}
        
        ${isCharacter ? `
        <div class="mb-3">
          <label class="block text-xs font-semibold text-gray-600 mb-1">話者</label>
          <select 
            onchange="ComicEditor.updateUtteranceCharacter('${ut.id}', this.value)"
            class="w-full text-sm px-3 py-2 rounded-lg border border-green-300 bg-green-50"
          >
            ${charOptions}
          </select>
        </div>
        ` : ''}
        
        <textarea
          id="utteranceText-${ut.id}"
          class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm resize-none"
          rows="3"
          placeholder="${isNarration ? 'ナレーション...' : 'セリフ...'}"
          oninput="ComicEditor.updateUtterance('${ut.id}', this.value)"
        >${this.escapeHtml(ut.text)}</textarea>
      </div>
    `}).join('');

    if (utterances.length < this.MAX_UTTERANCES) {
      container.insertAdjacentHTML('beforeend', `
        <button 
          onclick="ComicEditor.addUtterance()"
          class="w-full px-4 py-2 border-2 border-dashed border-gray-300 rounded-lg text-gray-500 hover:border-purple-400 hover:text-purple-600 transition-colors text-sm"
        >
          <i class="fas fa-plus mr-2"></i>発話を追加
        </button>
      `);
    }
  },

  /**
   * 吹き出しボタン状態更新
   */
  updateBubbleButtons() {
    const bubbleTypeButtons = document.getElementById('bubbleTypeButtons');
    if (!bubbleTypeButtons) return;
    
    const bubbles = this.draft.bubbles || [];
    const buttons = bubbleTypeButtons.querySelectorAll('button');
    
    buttons.forEach(btn => {
      if (bubbles.length >= this.MAX_BUBBLES) {
        btn.disabled = true;
        btn.classList.add('opacity-50', 'cursor-not-allowed');
      } else {
        btn.disabled = false;
        btn.classList.remove('opacity-50', 'cursor-not-allowed');
      }
    });
  },

  // ============== 発話・吹き出し操作 ==============

  addUtterance() {
    if (this.draft.utterances.length >= this.MAX_UTTERANCES) {
      showToast(`発話は最大${this.MAX_UTTERANCES}つ`, 'warning');
      return;
    }

    this.draft.utterances.push({
      id: `ut_${Date.now()}`,
      speaker_type: 'narration',
      speaker_id: null,
      speaker_character_key: null,
      narrator_voice_preset_id: 'ja-JP-Neural2-B',
      text: ''
    });

    this.renderUtterances();
  },

  updateUtterance(utteranceId, text) {
    const utterance = this.draft.utterances.find(u => u.id === utteranceId);
    if (utterance) {
      utterance.text = text;
      this.renderPreview();
    }
  },

  updateUtteranceSpeakerType(utteranceId, speakerType) {
    const utterance = this.draft.utterances.find(u => u.id === utteranceId);
    if (utterance) {
      utterance.speaker_type = speakerType;
      if (speakerType === 'character') {
        const sceneCharacters = this.currentScene.characters || [];
        if (sceneCharacters.length > 0 && !utterance.speaker_character_key) {
          utterance.speaker_character_key = sceneCharacters[0].character_key;
        }
      }
      this.renderUtterances();
      this.renderPreview();
    }
  },

  updateUtteranceNarratorVoice(utteranceId, presetId) {
    const utterance = this.draft.utterances.find(u => u.id === utteranceId);
    if (utterance) {
      utterance.narrator_voice_preset_id = presetId;
    }
  },

  updateUtteranceCharacter(utteranceId, characterKey) {
    const utterance = this.draft.utterances.find(u => u.id === utteranceId);
    if (utterance) {
      utterance.speaker_character_key = characterKey;
      this.renderPreview();
    }
  },

  removeUtterance(utteranceId) {
    this.draft.bubbles = this.draft.bubbles.filter(b => b.utterance_id !== utteranceId);
    this.draft.utterances = this.draft.utterances.filter(u => u.id !== utteranceId);
    this.renderUtterances();
    this.renderPreview();
  },

  addBubble(type = 'speech') {
    if (this.draft.bubbles.length >= this.MAX_BUBBLES) {
      showToast(`吹き出しは最大${this.MAX_BUBBLES}つ`, 'warning');
      return;
    }

    const firstUtterance = this.draft.utterances[0];
    if (!firstUtterance) {
      showToast('発話を先に追加', 'warning');
      return;
    }

    const rect = this.getContainRect();
    const typeInfo = this.BUBBLE_TYPES[type];
    const isNarration = typeInfo?.category === 'narration';
    
    // 初期位置（ナレーション系は下、セリフ系は上寄り）
    let position = isNarration 
      ? { x: 0.12 + Math.random() * 0.05, y: 0.70 + Math.random() * 0.05 }
      : { x: 0.15 + Math.random() * 0.2, y: 0.08 + Math.random() * 0.15 };
    
    // クランプ
    if (rect) {
      position = this.clampBubblePosition(position, type, rect.naturalWidth, rect.naturalHeight);
    }
    
    const newBubble = {
      id: `b_${Date.now()}`,
      utterance_id: firstUtterance.id,
      type: type,
      position: position
    };
    
    // Tail付きの場合
    if (typeInfo?.hasTail) {
      newBubble.tail = { enabled: true, tip: { x: 0.55, y: 1.15 } };
    }
    
    this.draft.bubbles.push(newBubble);

    this.renderPreview();
    showToast(`${typeInfo?.name || '吹き出し'}を追加`, 'success');
  },

  removeBubble(bubbleId) {
    this.draft.bubbles = this.draft.bubbles.filter(b => b.id !== bubbleId);
    this.renderPreview();
  },

  // ============== 保存・公開 ==============

  async saveDraft() {
    if (this.isSaving) return;
    this.isSaving = true;
    
    const btn = document.getElementById('comicSaveBtn');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>保存中...';
    }
    
    try {
      // 位置をクランプして修正
      const rect = this.getContainRect();
      if (rect) {
        for (const bubble of this.draft.bubbles) {
          const clamped = this.clampBubblePosition(bubble.position, bubble.type, rect.naturalWidth, rect.naturalHeight);
          bubble.position = clamped;
        }
      }
      
      const res = await axios.post(`/api/scenes/${this.currentSceneId}/comic/draft`, {
        draft: this.draft,
        base_image_generation_id: this.baseImageGenerationId
      });

      console.log('[ComicEditor] Draft saved:', res.data);
      showToast('下書き保存しました', 'success');

    } catch (err) {
      console.error('[ComicEditor] Draft save failed:', err);
      showToast('保存に失敗しました', 'error');
    } finally {
      this.isSaving = false;
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-save mr-1"></i>下書き';
      }
    }
  },

  async publish() {
    if (this.isPublishing) return;
    
    // バリデーション
    const validation = this.validateDraft();
    if (!validation.ok) {
      showToast('エラーを修正してください', 'error');
      return;
    }
    
    this.isPublishing = true;
    
    const btn = document.getElementById('comicPublishBtn');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>公開中...';
    }
    
    try {
      if (this.draft.bubbles.length === 0) {
        const confirmed = confirm('吹き出しがありません。公開しますか？');
        if (!confirmed) return;
      }

      showToast('画像生成中...', 'info');

      // 位置をクランプ
      const rect = this.getContainRect();
      if (rect) {
        for (const bubble of this.draft.bubbles) {
          const clamped = this.clampBubblePosition(bubble.position, bubble.type, rect.naturalWidth, rect.naturalHeight);
          bubble.position = clamped;
        }
      }

      const imageData = await this.renderToCanvasAsync();
      
      console.log('[ComicEditor] Publishing...');

      const res = await axios.post(`/api/scenes/${this.currentSceneId}/comic/publish`, {
        image_data: imageData,
        base_image_generation_id: this.baseImageGenerationId,
        draft: this.draft
      });

      console.log('[ComicEditor] Publish response:', res.data);
      
      this.published = res.data.comic_data?.published;
      
      // 自動で漫画表示に切替
      try {
        await axios.put(`/api/scenes/${this.currentSceneId}/display-asset-type`, {
          display_asset_type: 'comic'
        });
      } catch (e) {
        console.warn('[ComicEditor] Auto-switch failed:', e);
      }
      
      showToast('公開しました！', 'success');
      this.close();

      if (typeof window.initBuilderTab === 'function') {
        window.initBuilderTab();
      } else if (typeof window.loadScenes === 'function') {
        window.loadScenes();
      }

    } catch (err) {
      console.error('[ComicEditor] Publish failed:', err);
      showToast('公開に失敗: ' + (err.message || 'エラー'), 'error');
    } finally {
      this.isPublishing = false;
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-upload mr-1"></i>公開';
      }
    }
  },

  /**
   * Canvas出力（非同期toBlob）
   */
  async renderToCanvasAsync() {
    const baseImage = document.getElementById('comicBaseImage');
    if (!baseImage) throw new Error('Base image not found');

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    const width = baseImage.naturalWidth || baseImage.width;
    const height = baseImage.naturalHeight || baseImage.height;
    
    canvas.width = width;
    canvas.height = height;
    
    // ベース画像
    ctx.drawImage(baseImage, 0, 0, width, height);
    
    // 吹き出し描画
    const scale = width / 1000;
    const bubbles = this.draft.bubbles || [];
    
    for (const bubble of bubbles) {
      const utterance = this.draft.utterances.find(u => u.id === bubble.utterance_id);
      const text = utterance?.text || '';
      
      const x = bubble.position.x * width;
      const y = bubble.position.y * height;
      
      ctx.save();
      ctx.translate(x, y);
      
      this.drawOneBubble(ctx, bubble, text, scale, { showDeleteButton: false });
      
      ctx.restore();
    }
    
    // 非同期Blob変換
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error('Blob作成失敗'));
          return;
        }
        
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Blob読み込み失敗'));
        reader.readAsDataURL(blob);
      }, 'image/png', 1.0);
    });
  },

  // ============== ユーティリティ ==============

  showModal() {
    const modal = document.getElementById('comicEditorModal');
    if (modal) modal.style.display = 'flex';
  },

  close() {
    const modal = document.getElementById('comicEditorModal');
    if (modal) modal.remove();
    document.removeEventListener('keydown', this.handleKeyDown);
    this.currentSceneId = null;
    this.currentScene = null;
    this.draft = null;
    this.published = null;
    this.baseImageGenerationId = null;
    this._containRect = null;
    this._baseImageLoaded = false;
  },

  handleKeyDown(e) {
    if (e.key === 'Escape') {
      window.ComicEditor.close();
    }
  },

  escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
};

// グローバル公開
window.openComicEditor = function(sceneId) {
  window.ComicEditor.open(sceneId);
};

console.log('[ComicEditor] Phase1.6 SSOT loaded');
