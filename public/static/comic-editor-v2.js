// comic-editor-v2.js - Phase1.7 吹き出し実用化
// ============================================================
// SSOT原則:
// 1. 座標系: 正規化(0-1) + containRect補正
// 2. スケール: publishScale = naturalWidth/1000（プレビュー/公開で統一）
// 3. 吹き出し: 実用6種（speech_round/speech_oval/thought_oval/mono_box_v/caption/telop_bar）
// 4. UIルール: ボタン常時表示、Footer固定、hover非表示禁止
// 5. Tail: tip座標はドラッグ可能、enabled=false で丸形のみ可
// ============================================================

(function() {
  'use strict';

  // ============== 定数定義 ==============
  const MAX_UTTERANCES = 3;
  const MAX_BUBBLES = 5;
  
  // Phase1.7: 吹き出し6種（実運用ベース）
  const BUBBLE_TYPES = {
    speech_round:  { name: '通常（丸角）', icon: 'fa-comment', hasTail: true, category: 'serif', writingMode: 'horizontal' },
    speech_oval:   { name: '楕円', icon: 'fa-comment-dots', hasTail: true, category: 'serif', writingMode: 'horizontal' },
    thought_oval:  { name: '思考（楕円）', icon: 'fa-cloud', hasTail: true, category: 'serif', writingMode: 'horizontal' },
    mono_box_v:    { name: 'モノローグ', icon: 'fa-align-left', hasTail: false, category: 'serif', writingMode: 'vertical' },
    caption:       { name: '字幕', icon: 'fa-font', hasTail: false, category: 'narration', writingMode: 'horizontal' },
    telop_bar:     { name: 'テロップ', icon: 'fa-square', hasTail: false, category: 'narration', writingMode: 'horizontal' }
  };

  // サイズ定義（1000px基準）
  const BUBBLE_SIZES = {
    speech_round:  { w: 360, h: 180 },
    speech_oval:   { w: 380, h: 170 },
    thought_oval:  { w: 340, h: 170 },
    mono_box_v:    { w: 120, h: 280 },  // 縦長
    caption:       { w: 720, h: 100 },
    telop_bar:     { w: 720, h: 120 }
  };

  // サイズプリセット（S/M/L）
  const SIZE_PRESETS = {
    S: { multiplier: 0.7, name: '小' },
    M: { multiplier: 1.0, name: '中' },
    L: { multiplier: 1.4, name: '大' }
  };

  // ===== Phase 3: テキストスタイル設定 =====
  // SSOT: docs/BUBBLE_TEXTSTYLE_SPEC.md
  const TEXT_STYLE_OPTIONS = {
    writingMode: [
      { value: 'horizontal', name: '横書き', icon: 'fa-align-left' },
      { value: 'vertical', name: '縦書き', icon: 'fa-align-justify fa-rotate-90' }
    ],
    fontFamily: [
      { value: 'gothic', name: 'ゴシック', css: '"Noto Sans JP", sans-serif' },
      { value: 'mincho', name: '明朝', css: '"Noto Serif JP", serif' },
      { value: 'rounded', name: '丸ゴ', css: '"M PLUS Rounded 1c", sans-serif' },
      { value: 'handwritten', name: '手書き', css: '"Yomogi", cursive' }
    ],
    fontWeight: [
      { value: 'normal', name: '通常' },
      { value: 'bold', name: '太字' }
    ],
    fontScale: [
      { value: 0.7, name: '小' },
      { value: 1.0, name: '標準' },
      { value: 1.3, name: '大' },
      { value: 1.6, name: '特大' }
    ]
  };

  const DEFAULT_TEXT_STYLE = {
    writingMode: 'horizontal',
    fontFamily: 'gothic',
    fontWeight: 'normal',
    fontScale: 1.0
  };

  // スタイル定義
  const BUBBLE_STYLES = {
    speech_round: {
      fill: '#FFFFFF',
      stroke: '#222222',
      strokeWidth: 2.5,
      radius: 20,
      fontSize: 18,
      lineHeight: 26,
      padding: 16,
      textColor: '#111827',
      shadow: { color: 'rgba(0,0,0,0.12)', blur: 10, offsetY: 4 }
    },
    speech_oval: {
      fill: '#FFFFFF',
      stroke: '#222222',
      strokeWidth: 2.5,
      fontSize: 18,
      lineHeight: 26,
      padding: 20,
      textColor: '#111827',
      shadow: { color: 'rgba(0,0,0,0.12)', blur: 10, offsetY: 4 }
    },
    thought_oval: {
      fill: '#FFFFFF',
      stroke: '#333333',
      strokeWidth: 2.0,
      fontSize: 18,
      lineHeight: 26,
      padding: 20,
      textColor: '#111827',
      shadow: { color: 'rgba(0,0,0,0.10)', blur: 8, offsetY: 3 }
    },
    mono_box_v: {
      fill: '#FFFFFF',
      stroke: '#111111',
      strokeWidth: 2.5,
      radius: 6,
      fontSize: 18,
      lineHeight: 24,
      padding: 14,
      textColor: '#111827',
      shadow: { color: 'rgba(0,0,0,0.08)', blur: 6, offsetY: 2 }
    },
    caption: {
      fontSize: 24,
      lineHeight: 32,
      padding: 12,
      textColor: '#FFFFFF',
      textStroke: '#000000',
      textStrokeWidth: 4.0
    },
    telop_bar: {
      fill: 'rgba(0,0,0,0.50)',
      radius: 12,
      fontSize: 22,
      lineHeight: 30,
      padding: 16,
      textColor: '#FFFFFF',
      textStroke: 'rgba(0,0,0,0.4)',
      textStrokeWidth: 2.0,
      shadow: { color: 'rgba(0,0,0,0.15)', blur: 8, offsetY: 3 }
    }
  };

  // ============== 状態管理 ==============
  const state = {
    sceneId: null,
    scene: null,
    draft: null,
    published: null,
    baseImageGenerationId: null,
    containRect: null,
    baseImageLoaded: false,
    isDragging: false,
    dragTarget: null,
    dragOffset: { x: 0, y: 0 },
    dragMode: null, // 'bubble' | 'tail' | 'resize'
    isPublishing: false,
    isSaving: false
  };

  // ============== SSOT: 座標系変換 ==============

  function getContainRect() {
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
    
    state.containRect = {
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
    
    return state.containRect;
  }

  function normalizedToContainer(normX, normY) {
    const rect = getContainRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: rect.x + normX * rect.width,
      y: rect.y + normY * rect.height
    };
  }

  function containerToNormalized(containerX, containerY) {
    const rect = getContainRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: (containerX - rect.x) / rect.width,
      y: (containerY - rect.y) / rect.height
    };
  }

  /**
   * 吹き出しサイズ（公開画像ピクセル）
   * @param {string} type - 吹き出しタイプ
   * @param {number} naturalW - 元画像の幅
   * @param {string} sizePreset - サイズプリセット (S/M/L)
   * @param {object} sizeRect - カスタムサイズ (正規化座標) { w: 0.3, h: 0.2 }
   */
  function getBubbleSizePx(type, naturalW, sizePreset = 'M', sizeRect = null) {
    // カスタムサイズが指定されている場合
    if (sizeRect && sizeRect.w && sizeRect.h) {
      return {
        w: sizeRect.w * naturalW,
        h: sizeRect.h * naturalW  // アスペクト比を保つため naturalW を使用
      };
    }
    
    const scale = naturalW / 1000;
    const base = BUBBLE_SIZES[type] || BUBBLE_SIZES.speech_round;
    const preset = SIZE_PRESETS[sizePreset] || SIZE_PRESETS.M;
    return { 
      w: base.w * scale * preset.multiplier, 
      h: base.h * scale * preset.multiplier 
    };
  }

  /**
   * bubble オブジェクトからサイズを取得
   */
  function getBubbleSizeFromBubble(bubble, naturalW) {
    return getBubbleSizePx(bubble.type, naturalW, bubble.size, bubble.sizeRect);
  }

  function clampPosition(pos, type, naturalW, naturalH, sizePreset = 'M', sizeRect = null) {
    const size = getBubbleSizePx(type, naturalW, sizePreset, sizeRect);
    const marginPx = 2;
    
    const mx = marginPx / naturalW;
    const my = marginPx / naturalH;
    const bw = size.w / naturalW;
    const bh = size.h / naturalH;
    
    return {
      x: Math.min(Math.max(pos.x, mx), 1 - bw - mx),
      y: Math.min(Math.max(pos.y, my), 1 - bh - my)
    };
  }

  // Tail先端のクランプ（画面内に収める）
  function clampTailTip(tip, bubblePos, type, naturalW, naturalH, sizePreset = 'M', sizeRect = null) {
    const size = getBubbleSizePx(type, naturalW, sizePreset, sizeRect);
    const bw = size.w / naturalW;
    const bh = size.h / naturalH;
    
    // Tail先端は吹き出し外側で画面内に
    const margin = 0.02;
    return {
      x: Math.min(Math.max(tip.x, margin), 1 - margin),
      y: Math.min(Math.max(tip.y, margin), 1 - margin)
    };
  }

  // ============== 描画ユーティリティ ==============

  function pathRoundRect(ctx, x, y, w, h, r) {
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
  }

  // ベジェ曲線でなめらかなTailを描画
  function drawTailBezier(ctx, baseX, baseY, tipX, tipY, width, scale) {
    const half = width / 2;
    const angle = Math.atan2(tipY - baseY, tipX - baseX);
    const perpAngle = angle + Math.PI / 2;
    
    const leftX = baseX + Math.cos(perpAngle) * half;
    const leftY = baseY + Math.sin(perpAngle) * half;
    const rightX = baseX - Math.cos(perpAngle) * half;
    const rightY = baseY - Math.sin(perpAngle) * half;
    
    // コントロールポイント
    const dist = Math.sqrt((tipX - baseX) ** 2 + (tipY - baseY) ** 2);
    const ctrlDist = dist * 0.4;
    const ctrlX = baseX + Math.cos(angle) * ctrlDist;
    const ctrlY = baseY + Math.sin(angle) * ctrlDist;
    
    ctx.beginPath();
    ctx.moveTo(leftX, leftY);
    ctx.quadraticCurveTo(ctrlX, ctrlY, tipX, tipY);
    ctx.quadraticCurveTo(ctrlX, ctrlY, rightX, rightY);
    ctx.closePath();
  }

  function wrapText(ctx, text, maxW) {
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
    return lines.slice(0, 6);
  }

  // 縦書きテキストのラップ（1文字ずつ縦に）
  function wrapTextVertical(ctx, text, maxH, lineH) {
    if (!text) return [['']];
    const columns = [];
    let column = [];
    let currentH = 0;
    
    for (const ch of text) {
      if (ch === '\n') {
        if (column.length > 0) columns.push(column);
        column = [];
        currentH = 0;
        continue;
      }
      if (currentH + lineH > maxH && column.length > 0) {
        columns.push(column);
        column = [];
        currentH = 0;
      }
      column.push(ch);
      currentH += lineH;
    }
    if (column.length > 0) columns.push(column);
    return columns.slice(0, 6);
  }

  function fitText(ctx, text, innerW, innerH, baseFontPx, baseLineH, isBold) {
    const minFont = 12;
    for (let font = baseFontPx; font >= minFont; font -= 1) {
      ctx.font = `${isBold ? '700' : '400'} ${font}px "Hiragino Kaku Gothic ProN", "Hiragino Sans", sans-serif`;
      const lineH = Math.round(baseLineH * (font / baseFontPx));
      const lines = wrapText(ctx, text, innerW);
      const neededH = lines.length * lineH;
      if (neededH <= innerH) {
        return { ok: true, fontPx: font, lineH, lines };
      }
    }
    return { ok: false };
  }

  function fitTextVertical(ctx, text, innerW, innerH, baseFontPx, baseLineH) {
    const minFont = 12;
    for (let font = baseFontPx; font >= minFont; font -= 1) {
      ctx.font = `700 ${font}px "Hiragino Kaku Gothic ProN", "Hiragino Sans", sans-serif`;
      const lineH = font * 1.2;
      const colW = font * 1.4;
      const columns = wrapTextVertical(ctx, text, innerH, lineH);
      const neededW = columns.length * colW;
      if (neededW <= innerW) {
        return { ok: true, fontPx: font, lineH, colW, columns };
      }
    }
    return { ok: false };
  }

  // ============== 吹き出し描画 ==============

  function drawSpeechRoundBubble(ctx, w, h, scale, tailTip, tailEnabled) {
    const style = BUBBLE_STYLES.speech_round;
    const r = style.radius * scale;
    
    // 影
    ctx.save();
    ctx.shadowColor = style.shadow.color;
    ctx.shadowBlur = style.shadow.blur * scale;
    ctx.shadowOffsetY = style.shadow.offsetY * scale;
    
    if (tailEnabled && tailTip) {
      pathSpeechWithTail(ctx, w, h, r, tailTip, scale);
    } else {
      pathRoundRect(ctx, 0, 0, w, h, r);
    }
    ctx.fillStyle = style.fill;
    ctx.fill();
    ctx.restore();
    
    // 枠線
    if (tailEnabled && tailTip) {
      pathSpeechWithTail(ctx, w, h, r, tailTip, scale);
    } else {
      pathRoundRect(ctx, 0, 0, w, h, r);
    }
    ctx.strokeStyle = style.stroke;
    ctx.lineWidth = style.strokeWidth * scale;
    ctx.stroke();
  }

  function pathSpeechWithTail(ctx, w, h, r, tailTip, scale) {
    const tailBaseW = 36 * scale;
    const half = tailBaseW / 2;
    
    // Tail根元は吹き出し下辺の中央付近
    const tailBaseX = w * 0.5;
    const left = Math.max(r + 4 * scale, tailBaseX - half);
    const right = Math.min(w - r - 4 * scale, tailBaseX + half);
    
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(w - r, 0);
    ctx.quadraticCurveTo(w, 0, w, r);
    ctx.lineTo(w, h - r);
    ctx.quadraticCurveTo(w, h, w - r, h);
    
    // Tail
    ctx.lineTo(right, h);
    ctx.lineTo(tailTip.x, tailTip.y);
    ctx.lineTo(left, h);
    
    ctx.lineTo(r, h);
    ctx.quadraticCurveTo(0, h, 0, h - r);
    ctx.lineTo(0, r);
    ctx.quadraticCurveTo(0, 0, r, 0);
    ctx.closePath();
  }

  function drawSpeechOvalBubble(ctx, w, h, scale, tailTip, tailEnabled) {
    const style = BUBBLE_STYLES.speech_oval;
    
    ctx.save();
    ctx.shadowColor = style.shadow.color;
    ctx.shadowBlur = style.shadow.blur * scale;
    ctx.shadowOffsetY = style.shadow.offsetY * scale;
    
    ctx.beginPath();
    ctx.ellipse(w/2, h/2, w/2, h/2, 0, 0, Math.PI * 2);
    ctx.fillStyle = style.fill;
    ctx.fill();
    ctx.restore();
    
    ctx.beginPath();
    ctx.ellipse(w/2, h/2, w/2, h/2, 0, 0, Math.PI * 2);
    ctx.strokeStyle = style.stroke;
    ctx.lineWidth = style.strokeWidth * scale;
    ctx.stroke();
    
    // Tail
    if (tailEnabled && tailTip) {
      const baseX = w * 0.5;
      const baseY = h;
      ctx.fillStyle = style.fill;
      ctx.strokeStyle = style.stroke;
      ctx.lineWidth = style.strokeWidth * scale;
      drawTailBezier(ctx, baseX, baseY, tailTip.x, tailTip.y, 30 * scale, scale);
      ctx.fill();
      ctx.stroke();
    }
  }

  function drawThoughtOvalBubble(ctx, w, h, scale, tailTip, tailEnabled) {
    const style = BUBBLE_STYLES.thought_oval;
    
    ctx.save();
    ctx.shadowColor = style.shadow.color;
    ctx.shadowBlur = style.shadow.blur * scale;
    ctx.shadowOffsetY = style.shadow.offsetY * scale;
    
    ctx.beginPath();
    ctx.ellipse(w/2, h/2, w/2, h/2, 0, 0, Math.PI * 2);
    ctx.fillStyle = style.fill;
    ctx.fill();
    ctx.restore();
    
    ctx.beginPath();
    ctx.ellipse(w/2, h/2, w/2, h/2, 0, 0, Math.PI * 2);
    ctx.strokeStyle = style.stroke;
    ctx.lineWidth = style.strokeWidth * scale;
    ctx.stroke();
    
    // ぽこぽこTail
    if (tailEnabled && tailTip) {
      const sx = w * 0.5;
      const sy = h + 2 * scale;
      const tx = tailTip.x;
      const ty = tailTip.y;
      
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
    }
  }

  function drawMonoBoxVBubble(ctx, w, h, scale) {
    const style = BUBBLE_STYLES.mono_box_v;
    const r = style.radius * scale;
    
    ctx.save();
    ctx.shadowColor = style.shadow.color;
    ctx.shadowBlur = style.shadow.blur * scale;
    ctx.shadowOffsetY = style.shadow.offsetY * scale;
    
    pathRoundRect(ctx, 0, 0, w, h, r);
    ctx.fillStyle = style.fill;
    ctx.fill();
    ctx.restore();
    
    pathRoundRect(ctx, 0, 0, w, h, r);
    ctx.strokeStyle = style.stroke;
    ctx.lineWidth = style.strokeWidth * scale;
    ctx.stroke();
  }

  function drawTelopBarBubble(ctx, w, h, scale) {
    const style = BUBBLE_STYLES.telop_bar;
    const r = style.radius * scale;
    
    ctx.save();
    ctx.shadowColor = style.shadow.color;
    ctx.shadowBlur = style.shadow.blur * scale;
    ctx.shadowOffsetY = style.shadow.offsetY * scale;
    
    pathRoundRect(ctx, 0, 0, w, h, r);
    ctx.fillStyle = style.fill;
    ctx.fill();
    ctx.restore();
  }

  function drawBubbleText(ctx, text, type, w, h, scale, textStyle = null) {
    const style = BUBBLE_STYLES[type] || BUBBLE_STYLES.speech_round;
    const padding = style.padding * scale;
    const innerW = w - padding * 2;
    const innerH = h - padding * 2;
    
    const isNarration = type === 'telop_bar' || type === 'caption';
    
    // Phase 3: textStyle から書字方向を取得（優先）、なければ BUBBLE_TYPES から
    const isVertical = textStyle?.writingMode === 'vertical' || 
                       (!textStyle && BUBBLE_TYPES[type]?.writingMode === 'vertical');
    
    // Phase 3: fontScale を適用
    const fontScale = textStyle?.fontScale || 1.0;
    const baseFontPx = style.fontSize * scale * fontScale;
    const baseLineH = style.lineHeight * scale * fontScale;
    
    // Phase 3: fontFamily と fontWeight を適用
    const fontFamily = textStyle?.fontFamily || 'gothic';
    const fontFamilyCSS = TEXT_STYLE_OPTIONS.fontFamily.find(f => f.value === fontFamily)?.css 
                          || '"Hiragino Kaku Gothic ProN", "Hiragino Sans", sans-serif';
    const fontWeight = textStyle?.fontWeight === 'bold' ? '700' : '400';
    
    if (isVertical) {
      // 縦書き
      const fit = fitTextVertical(ctx, text, innerW, innerH, baseFontPx, baseLineH);
      if (!fit.ok) return { ok: false };
      
      // Phase 3: textStyle のフォント設定を適用
      ctx.font = `${fontWeight} ${fit.fontPx}px ${fontFamilyCSS}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = style.textColor;
      
      // 右から左へ列を描画
      const totalColW = fit.columns.length * fit.colW;
      const startX = padding + innerW - (innerW - totalColW) / 2 - fit.colW / 2;
      
      for (let col = 0; col < fit.columns.length; col++) {
        const column = fit.columns[col];
        const x = startX - col * fit.colW;
        const totalH = column.length * fit.lineH;
        const startY = padding + (innerH - totalH) / 2 + fit.lineH / 2;
        
        for (let row = 0; row < column.length; row++) {
          ctx.fillText(column[row], x, startY + row * fit.lineH);
        }
      }
      
      return { ok: true };
    }
    
    // 横書き
    const fit = fitText(ctx, text, innerW, innerH, baseFontPx, baseLineH, isNarration);
    if (!fit.ok) return { ok: false };
    
    // Phase 3: textStyle のフォント設定を適用（ナレーションは常に太字）
    const effectiveWeight = isNarration ? '700' : fontWeight;
    ctx.font = `${effectiveWeight} ${fit.fontPx}px ${fontFamilyCSS}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    const startY = padding + (innerH - fit.lines.length * fit.lineH) / 2 + fit.lineH / 2;
    
    for (let i = 0; i < fit.lines.length; i++) {
      const lx = w / 2;
      const ly = startY + i * fit.lineH;
      
      if (type === 'caption' || type === 'telop_bar') {
        ctx.lineWidth = style.textStrokeWidth * scale;
        ctx.strokeStyle = style.textStroke;
        ctx.lineJoin = 'round';
        ctx.strokeText(fit.lines[i], lx, ly);
        ctx.fillStyle = style.textColor;
        ctx.fillText(fit.lines[i], lx, ly);
      } else {
        ctx.fillStyle = style.textColor;
        ctx.fillText(fit.lines[i], lx, ly);
      }
    }
    
    return { ok: true };
  }

  function drawOneBubble(ctx, bubble, text, scale, options = {}) {
    // カスタムサイズ（sizeRect）をサポート
    let w, h;
    if (bubble.sizeRect && bubble.sizeRect.w && bubble.sizeRect.h) {
      // sizeRect は 1000px 基準の正規化値
      w = bubble.sizeRect.w * scale * 1000;
      h = bubble.sizeRect.h * scale * 1000;
    } else {
      const baseSize = BUBBLE_SIZES[bubble.type] || BUBBLE_SIZES.speech_round;
      const sizePreset = SIZE_PRESETS[bubble.size] || SIZE_PRESETS.M;
      w = baseSize.w * scale * sizePreset.multiplier;
      h = baseSize.h * scale * sizePreset.multiplier;
    }
    
    const tailEnabled = bubble.tail?.enabled ?? false;
    const tailTip = tailEnabled && bubble.tail?.tip
      ? { x: bubble.tail.tip.x * w, y: bubble.tail.tip.y * h }
      : null;
    
    switch (bubble.type) {
      case 'speech_round':
        drawSpeechRoundBubble(ctx, w, h, scale, tailTip, tailEnabled);
        break;
      case 'speech_oval':
        drawSpeechOvalBubble(ctx, w, h, scale, tailTip, tailEnabled);
        break;
      case 'thought_oval':
        drawThoughtOvalBubble(ctx, w, h, scale, tailTip, tailEnabled);
        break;
      case 'mono_box_v':
        drawMonoBoxVBubble(ctx, w, h, scale);
        break;
      case 'telop_bar':
        drawTelopBarBubble(ctx, w, h, scale);
        break;
      case 'caption':
        // 背景なし
        break;
    }
    
    // Phase 3: textStyle を渡す
    const result = drawBubbleText(ctx, text, bubble.type, w, h, scale, bubble.textStyle);
    
    if (options.showDeleteButton) {
      drawDeleteButton(ctx, w, scale);
    }
    
    // Tail先端ハンドル表示（プレビュー時）
    if (options.showTailHandle && tailEnabled && tailTip) {
      drawTailHandle(ctx, tailTip.x, tailTip.y, scale);
    }
    
    // リサイズハンドル表示（プレビュー時）
    if (options.showResizeHandle) {
      drawResizeHandle(ctx, w, h, scale);
    }
    
    return { ok: result.ok, w, h };
  }

  function drawDeleteButton(ctx, bubbleWidth, scale) {
    const btnRadius = 11 * scale;
    const btnX = bubbleWidth - 6 * scale;
    const btnY = 6 * scale;
    
    ctx.beginPath();
    ctx.arc(btnX, btnY, btnRadius, 0, Math.PI * 2);
    ctx.fillStyle = '#EF4444';
    ctx.fill();
    
    ctx.fillStyle = 'white';
    ctx.font = `bold ${12 * scale}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('×', btnX, btnY);
  }

  function drawTailHandle(ctx, x, y, scale) {
    const r = 8 * scale;
    
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#3B82F6';
    ctx.fill();
    
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 2 * scale;
    ctx.stroke();
    
    // ドラッグアイコン
    ctx.fillStyle = 'white';
    ctx.font = `bold ${8 * scale}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('⊕', x, y);
  }

  function drawResizeHandle(ctx, w, h, scale) {
    const size = 12 * scale;
    const x = w - size / 2;
    const y = h - size / 2;
    
    // 三角形のリサイズハンドル（右下角）
    ctx.beginPath();
    ctx.moveTo(w, h - size);
    ctx.lineTo(w, h);
    ctx.lineTo(w - size, h);
    ctx.closePath();
    ctx.fillStyle = '#10B981';
    ctx.fill();
    
    // 枠線
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 1.5 * scale;
    ctx.stroke();
    
    // 斜め線（リサイズ感を出す）
    ctx.beginPath();
    ctx.moveTo(w - size * 0.7, h);
    ctx.lineTo(w, h - size * 0.7);
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 1 * scale;
    ctx.stroke();
    
    ctx.beginPath();
    ctx.moveTo(w - size * 0.4, h);
    ctx.lineTo(w, h - size * 0.4);
    ctx.stroke();
  }

  // ============== バリデーション ==============

  function validateDraft() {
    const errors = [];
    const rect = getContainRect();
    if (!rect || !state.draft) return { ok: true, errors: [] };
    
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const scale = rect.naturalWidth / 1000;
    
    for (const bubble of state.draft.bubbles || []) {
      const ut = state.draft.utterances.find(u => u.id === bubble.utterance_id);
      const text = (ut?.text || '').trim();
      
      // 画面外チェック（カスタムサイズ対応）
      const clamped = clampPosition(bubble.position, bubble.type, rect.naturalWidth, rect.naturalHeight, bubble.size, bubble.sizeRect);
      if (Math.abs(clamped.x - bubble.position.x) > 0.001 || Math.abs(clamped.y - bubble.position.y) > 0.001) {
        errors.push({ type: 'OUT_OF_BOUNDS', bubbleId: bubble.id, message: '吹き出しが画面外です' });
      }
      
      // 文字溢れチェック（カスタムサイズ対応）
      if (text) {
        let w, h;
        if (bubble.sizeRect && bubble.sizeRect.w && bubble.sizeRect.h) {
          w = bubble.sizeRect.w * scale * 1000;
          h = bubble.sizeRect.h * scale * 1000;
        } else {
          const baseSize = BUBBLE_SIZES[bubble.type] || BUBBLE_SIZES.speech_round;
          const sizeMultiplier = (SIZE_PRESETS[bubble.size] || SIZE_PRESETS.M).multiplier;
          w = baseSize.w * scale * sizeMultiplier;
          h = baseSize.h * scale * sizeMultiplier;
        }
        
        const style = BUBBLE_STYLES[bubble.type] || BUBBLE_STYLES.speech_round;
        const padding = style.padding * scale;
        const innerW = w - padding * 2;
        const innerH = h - padding * 2;
        
        const baseFontPx = style.fontSize * scale;
        const baseLineH = style.lineHeight * scale;
        const isNarration = bubble.type === 'telop_bar' || bubble.type === 'caption';
        const isVertical = BUBBLE_TYPES[bubble.type]?.writingMode === 'vertical';
        
        const fit = isVertical
          ? fitTextVertical(ctx, text, innerW, innerH, baseFontPx, baseLineH)
          : fitText(ctx, text, innerW, innerH, baseFontPx, baseLineH, isNarration);
        
        if (!fit.ok) {
          errors.push({ type: 'TEXT_OVERFLOW', bubbleId: bubble.id, message: 'テキストが収まりません' });
        }
      }
    }
    
    return { ok: errors.length === 0, errors };
  }

  // ============== プレビュー描画 ==============

  function renderPreview() {
    const canvas = document.getElementById('comicPreviewCanvas');
    const ctx = canvas?.getContext('2d');
    if (!ctx || !state.baseImageLoaded) return;
    
    const rect = getContainRect();
    if (!rect) return;
    
    const dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
    
    const bubbles = state.draft?.bubbles || [];
    
    const publishScale = rect.naturalWidth / 1000;
    const displayScale = rect.scale;
    
    const validation = validateDraft();
    const errorBubbleIds = new Set(validation.errors.map(e => e.bubbleId));
    
    bubbles.forEach((bubble) => {
      const utterance = state.draft.utterances.find(u => u.id === bubble.utterance_id);
      const text = utterance?.text || '';
      
      const containerPos = normalizedToContainer(bubble.position.x, bubble.position.y);
      
      ctx.save();
      ctx.translate(containerPos.x, containerPos.y);
      ctx.scale(displayScale, displayScale);
      
      if (errorBubbleIds.has(bubble.id)) {
        // エラー表示: カスタムサイズ対応
        let w, h;
        if (bubble.sizeRect && bubble.sizeRect.w && bubble.sizeRect.h) {
          w = bubble.sizeRect.w * publishScale * 1000;
          h = bubble.sizeRect.h * publishScale * 1000;
        } else {
          const baseSize = BUBBLE_SIZES[bubble.type] || BUBBLE_SIZES.speech_round;
          const sizeMultiplier = (SIZE_PRESETS[bubble.size] || SIZE_PRESETS.M).multiplier;
          w = baseSize.w * publishScale * sizeMultiplier;
          h = baseSize.h * publishScale * sizeMultiplier;
        }
        ctx.strokeStyle = '#EF4444';
        ctx.lineWidth = 3 * publishScale;
        ctx.strokeRect(-2 * publishScale, -2 * publishScale, w + 4 * publishScale, h + 4 * publishScale);
      }
      
      drawOneBubble(ctx, bubble, text, publishScale, { 
        showDeleteButton: true,
        showTailHandle: bubble.tail?.enabled,
        showResizeHandle: true
      });
      
      ctx.restore();
    });
    
    updateValidationUI();
  }

  // ============== Canvas出力（公開用） ==============

  async function renderToCanvasAsync() {
    const baseImage = document.getElementById('comicBaseImage');
    if (!baseImage) throw new Error('Base image not found');

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    const width = baseImage.naturalWidth || baseImage.width;
    const height = baseImage.naturalHeight || baseImage.height;
    
    canvas.width = width;
    canvas.height = height;
    
    ctx.drawImage(baseImage, 0, 0, width, height);
    
    const scale = width / 1000;
    const bubbles = state.draft?.bubbles || [];
    
    for (const bubble of bubbles) {
      const utterance = state.draft.utterances.find(u => u.id === bubble.utterance_id);
      const text = utterance?.text || '';
      
      const x = bubble.position.x * width;
      const y = bubble.position.y * height;
      
      ctx.save();
      ctx.translate(x, y);
      drawOneBubble(ctx, bubble, text, scale, { showDeleteButton: false, showTailHandle: false });
      ctx.restore();
    }
    
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
  }

  // ============== ドラッグ操作 ==============

  /**
   * 吹き出しの表示サイズを取得（カスタムサイズ対応）
   */
  function getDisplayBubbleSize(bubble, displayBubbleScale) {
    if (bubble.sizeRect && bubble.sizeRect.w && bubble.sizeRect.h) {
      return {
        w: bubble.sizeRect.w * displayBubbleScale * 1000,
        h: bubble.sizeRect.h * displayBubbleScale * 1000
      };
    }
    const baseSize = BUBBLE_SIZES[bubble.type] || BUBBLE_SIZES.speech_round;
    const sizeMultiplier = (SIZE_PRESETS[bubble.size] || SIZE_PRESETS.M).multiplier;
    return {
      w: baseSize.w * displayBubbleScale * sizeMultiplier,
      h: baseSize.h * displayBubbleScale * sizeMultiplier
    };
  }

  function findBubbleAt(canvasX, canvasY) {
    const rect = getContainRect();
    if (!rect) return null;
    
    const bubbles = state.draft?.bubbles || [];
    const displayBubbleScale = rect.width / 1000;
    
    for (let i = bubbles.length - 1; i >= 0; i--) {
      const bubble = bubbles[i];
      const containerPos = normalizedToContainer(bubble.position.x, bubble.position.y);
      const { w: bubbleWidth, h: bubbleHeight } = getDisplayBubbleSize(bubble, displayBubbleScale);
      
      if (canvasX >= containerPos.x && canvasX <= containerPos.x + bubbleWidth &&
          canvasY >= containerPos.y && canvasY <= containerPos.y + bubbleHeight) {
        return bubble;
      }
    }
    
    return null;
  }

  function findTailHandleAt(canvasX, canvasY) {
    const rect = getContainRect();
    if (!rect) return null;
    
    const bubbles = state.draft?.bubbles || [];
    const displayBubbleScale = rect.width / 1000;
    
    for (let i = bubbles.length - 1; i >= 0; i--) {
      const bubble = bubbles[i];
      if (!bubble.tail?.enabled || !bubble.tail?.tip) continue;
      
      const containerPos = normalizedToContainer(bubble.position.x, bubble.position.y);
      const { w: bubbleWidth, h: bubbleHeight } = getDisplayBubbleSize(bubble, displayBubbleScale);
      
      const tipX = containerPos.x + bubble.tail.tip.x * bubbleWidth;
      const tipY = containerPos.y + bubble.tail.tip.y * bubbleHeight;
      
      const handleRadius = 12 * displayBubbleScale;
      const dx = canvasX - tipX;
      const dy = canvasY - tipY;
      
      if (dx * dx + dy * dy <= handleRadius * handleRadius) {
        return bubble;
      }
    }
    
    return null;
  }

  function findResizeHandleAt(canvasX, canvasY) {
    const rect = getContainRect();
    if (!rect) return null;
    
    const bubbles = state.draft?.bubbles || [];
    const displayBubbleScale = rect.width / 1000;
    
    for (let i = bubbles.length - 1; i >= 0; i--) {
      const bubble = bubbles[i];
      const containerPos = normalizedToContainer(bubble.position.x, bubble.position.y);
      const { w: bubbleWidth, h: bubbleHeight } = getDisplayBubbleSize(bubble, displayBubbleScale);
      
      // 右下角のハンドル領域（三角形の当たり判定を矩形で近似）
      const handleSize = 16 * displayBubbleScale;
      const handleX = containerPos.x + bubbleWidth - handleSize;
      const handleY = containerPos.y + bubbleHeight - handleSize;
      
      if (canvasX >= handleX && canvasX <= containerPos.x + bubbleWidth &&
          canvasY >= handleY && canvasY <= containerPos.y + bubbleHeight) {
        return bubble;
      }
    }
    
    return null;
  }

  function isDeleteButtonClick(canvasX, canvasY, bubble) {
    const rect = getContainRect();
    if (!rect) return false;
    
    const displayBubbleScale = rect.width / 1000;
    const containerPos = normalizedToContainer(bubble.position.x, bubble.position.y);
    const { w: bubbleWidth } = getDisplayBubbleSize(bubble, displayBubbleScale);
    
    const btnX = containerPos.x + bubbleWidth - 6 * displayBubbleScale;
    const btnY = containerPos.y + 6 * displayBubbleScale;
    const btnRadius = 13 * displayBubbleScale;
    
    const dx = canvasX - btnX;
    const dy = canvasY - btnY;
    
    return (dx * dx + dy * dy) <= (btnRadius * btnRadius);
  }

  function handleMouseDown(e) {
    e.preventDefault();
    
    const canvas = document.getElementById('comicPreviewCanvas');
    const canvasRect = canvas.getBoundingClientRect();
    
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    
    const canvasX = clientX - canvasRect.left;
    const canvasY = clientY - canvasRect.top;
    
    // リサイズハンドルをチェック（最優先）
    const resizeBubble = findResizeHandleAt(canvasX, canvasY);
    if (resizeBubble) {
      state.isDragging = true;
      state.dragTarget = resizeBubble.id;
      state.dragMode = 'resize';
      return;
    }
    
    // Tail先端ハンドルをチェック
    const tailBubble = findTailHandleAt(canvasX, canvasY);
    if (tailBubble) {
      state.isDragging = true;
      state.dragTarget = tailBubble.id;
      state.dragMode = 'tail';
      return;
    }
    
    const bubble = findBubbleAt(canvasX, canvasY);
    
    if (bubble) {
      if (isDeleteButtonClick(canvasX, canvasY, bubble)) {
        removeBubble(bubble.id);
        return;
      }
      
      state.isDragging = true;
      state.dragTarget = bubble.id;
      state.dragMode = 'bubble';
      
      const bubbleContainerPos = normalizedToContainer(bubble.position.x, bubble.position.y);
      state.dragOffset = {
        x: canvasX - bubbleContainerPos.x,
        y: canvasY - bubbleContainerPos.y
      };
    }
  }

  function handleMouseMove(e) {
    if (!state.isDragging || !state.dragTarget) return;
    e.preventDefault();
    
    const canvas = document.getElementById('comicPreviewCanvas');
    const canvasRect = canvas.getBoundingClientRect();
    const rect = getContainRect();
    if (!rect) return;
    
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    
    const canvasX = clientX - canvasRect.left;
    const canvasY = clientY - canvasRect.top;
    
    const bubble = state.draft.bubbles.find(b => b.id === state.dragTarget);
    if (!bubble) return;
    
    const displayBubbleScale = rect.width / 1000;
    
    if (state.dragMode === 'resize') {
      // リサイズ操作
      const containerPos = normalizedToContainer(bubble.position.x, bubble.position.y);
      
      // 新しいサイズを計算（ピクセル単位）
      let newWidth = canvasX - containerPos.x;
      let newHeight = canvasY - containerPos.y;
      
      // 最小サイズ制限（100px @ 1000px基準）
      const minSize = 80 * displayBubbleScale;
      newWidth = Math.max(newWidth, minSize);
      newHeight = Math.max(newHeight, minSize);
      
      // 最大サイズ制限（画面をはみ出さないように）
      const maxWidth = rect.width - (bubble.position.x * rect.width);
      const maxHeight = rect.height - (bubble.position.y * rect.height);
      newWidth = Math.min(newWidth, maxWidth - 4);
      newHeight = Math.min(newHeight, maxHeight - 4);
      
      // sizeRect として保存（1000px 基準の正規化値）
      bubble.sizeRect = {
        w: newWidth / (displayBubbleScale * 1000),
        h: newHeight / (displayBubbleScale * 1000)
      };
      
      // プリセットサイズをクリア（カスタムサイズを使用）
      bubble.size = 'custom';
      
      renderPreview();
      renderBubbles();  // UIも更新
    } else if (state.dragMode === 'tail') {
      // Tail先端をドラッグ
      const containerPos = normalizedToContainer(bubble.position.x, bubble.position.y);
      const { w: bubbleWidth, h: bubbleHeight } = getDisplayBubbleSize(bubble, displayBubbleScale);
      
      // 吹き出し座標系でのTail位置
      const localX = (canvasX - containerPos.x) / bubbleWidth;
      const localY = (canvasY - containerPos.y) / bubbleHeight;
      
      // 正規化してクランプ
      bubble.tail.tip = {
        x: Math.min(Math.max(localX, -0.3), 1.3),
        y: Math.min(Math.max(localY, -0.3), 1.5)
      };
      
      renderPreview();
    } else {
      // 吹き出し本体をドラッグ
      const adjustedX = canvasX - state.dragOffset.x;
      const adjustedY = canvasY - state.dragOffset.y;
      
      let normalized = containerToNormalized(adjustedX, adjustedY);
      normalized = clampPosition(normalized, bubble.type, rect.naturalWidth, rect.naturalHeight, bubble.size, bubble.sizeRect);
      bubble.position.x = normalized.x;
      bubble.position.y = normalized.y;
      renderPreview();
    }
  }

  function handleMouseUp() {
    state.isDragging = false;
    state.dragTarget = null;
    state.dragMode = null;
  }

  function setupDragEvents() {
    const canvas = document.getElementById('comicPreviewCanvas');
    if (!canvas || canvas.dataset.eventsAttached) return;
    
    canvas.addEventListener('mousedown', handleMouseDown);
    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mouseup', handleMouseUp);
    canvas.addEventListener('mouseleave', handleMouseUp);
    
    canvas.addEventListener('touchstart', handleMouseDown, { passive: false });
    canvas.addEventListener('touchmove', handleMouseMove, { passive: false });
    canvas.addEventListener('touchend', handleMouseUp);
    
    canvas.dataset.eventsAttached = 'true';
  }

  // ============== UI更新 ==============

  function updateValidationUI() {
    const validation = validateDraft();
    const errorsDiv = document.getElementById('comicValidationErrors');
    const publishBtn = document.getElementById('comicPublishBtn');
    
    if (!errorsDiv || !publishBtn) return;
    
    if (validation.errors.length > 0) {
      errorsDiv.innerHTML = `
        <div class="bg-red-50 border border-red-200 rounded-lg p-3">
          <p class="text-red-700 text-sm font-semibold mb-1">
            <i class="fas fa-exclamation-triangle mr-1"></i>公開できません
          </p>
          <ul class="text-red-600 text-xs space-y-1">
            ${validation.errors.map(e => `<li>・${escapeHtml(e.message)}</li>`).join('')}
          </ul>
        </div>
      `;
      errorsDiv.classList.remove('hidden');
      publishBtn.disabled = true;
      publishBtn.classList.add('opacity-50', 'cursor-not-allowed');
    } else {
      errorsDiv.classList.add('hidden');
      errorsDiv.innerHTML = '';
      publishBtn.disabled = false;
      publishBtn.classList.remove('opacity-50', 'cursor-not-allowed');
    }
  }

  function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ============== データ操作 ==============

  function generateId() {
    return 'id_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }

  function addUtterance() {
    if (!state.draft) return;
    if (state.draft.utterances.length >= MAX_UTTERANCES) {
      showToast(`発話は最大${MAX_UTTERANCES}個までです`, 'warning');
      return;
    }
    
    const newUtterance = {
      id: generateId(),
      speaker_type: 'narration',
      speaker_character_key: null,
      narrator_voice_preset_id: 'ja-JP-Neural2-B',
      text: ''
    };
    
    state.draft.utterances.push(newUtterance);
    renderUtterances();
    updateBubbleUtteranceSelect();
  }

  function removeUtterance(utteranceId) {
    if (!state.draft) return;
    if (state.draft.utterances.length <= 1) {
      showToast('最低1つの発話が必要です', 'warning');
      return;
    }
    
    state.draft.utterances = state.draft.utterances.filter(u => u.id !== utteranceId);
    state.draft.bubbles = state.draft.bubbles.filter(b => b.utterance_id !== utteranceId);
    
    renderUtterances();
    renderBubbles();
    renderPreview();
    updateBubbleUtteranceSelect();
  }

  function updateUtteranceText(utteranceId, text) {
    if (!state.draft) return;
    const utterance = state.draft.utterances.find(u => u.id === utteranceId);
    if (utterance) {
      utterance.text = text;
      renderPreview();
    }
  }

  function updateUtteranceSpeakerType(utteranceId, speakerType) {
    if (!state.draft) return;
    const utterance = state.draft.utterances.find(u => u.id === utteranceId);
    if (utterance) {
      utterance.speaker_type = speakerType;
      if (speakerType === 'narration') {
        utterance.speaker_character_key = null;
      } else if (speakerType === 'character') {
        const characters = state.scene?.characters || [];
        if (characters.length > 0 && !utterance.speaker_character_key) {
          utterance.speaker_character_key = characters[0].character_key;
        }
      }
      renderUtterances();
    }
  }

  function updateUtteranceCharacter(utteranceId, characterKey) {
    if (!state.draft) return;
    const utterance = state.draft.utterances.find(u => u.id === utteranceId);
    if (utterance) {
      utterance.speaker_character_key = characterKey;
    }
  }

  function addBubble(utteranceId, type = 'speech_round') {
    if (!state.draft) return;
    if (state.draft.bubbles.length >= MAX_BUBBLES) {
      showToast(`吹き出しは最大${MAX_BUBBLES}個までです`, 'warning');
      return;
    }
    
    const rect = getContainRect();
    const naturalW = rect?.naturalWidth || 1024;
    const naturalH = rect?.naturalHeight || 1024;
    
    const existingBubbles = state.draft.bubbles.filter(b => b.utterance_id === utteranceId);
    const yOffset = existingBubbles.length * 0.15;
    
    let pos = { x: 0.1, y: 0.1 + yOffset };
    pos = clampPosition(pos, type, naturalW, naturalH);
    
    const hasTail = BUBBLE_TYPES[type]?.hasTail || false;
    
    const newBubble = {
      id: generateId(),
      utterance_id: utteranceId,
      type: type,
      size: 'M',
      position: pos,
      tail: hasTail 
        ? { enabled: true, tip: { x: 0.5, y: 1.3 } }  // デフォルト下向き
        : { enabled: false }
    };
    
    state.draft.bubbles.push(newBubble);
    renderBubbles();
    renderPreview();
  }

  function removeBubble(bubbleId) {
    if (!state.draft) return;
    state.draft.bubbles = state.draft.bubbles.filter(b => b.id !== bubbleId);
    renderBubbles();
    renderPreview();
  }

  function updateBubbleType(bubbleId, type) {
    if (!state.draft) return;
    const bubble = state.draft.bubbles.find(b => b.id === bubbleId);
    if (bubble) {
      bubble.type = type;
      const hasTail = BUBBLE_TYPES[type]?.hasTail || false;
      bubble.tail = hasTail 
        ? { enabled: true, tip: { x: 0.5, y: 1.3 } }
        : { enabled: false };
      
      const rect = getContainRect();
      if (rect) {
        bubble.position = clampPosition(bubble.position, type, rect.naturalWidth, rect.naturalHeight, bubble.size);
      }
      
      renderBubbles();
      renderPreview();
    }
  }

  function updateBubbleSize(bubbleId, size) {
    if (!state.draft) return;
    const bubble = state.draft.bubbles.find(b => b.id === bubbleId);
    if (bubble) {
      // プリセットサイズを選択した場合、カスタムサイズをクリア
      if (size !== 'custom' && SIZE_PRESETS[size]) {
        bubble.size = size;
        delete bubble.sizeRect;  // カスタムサイズをクリア
      }
      // 'custom' を選択した場合は何もしない（現在のサイズを維持）
      
      const rect = getContainRect();
      if (rect) {
        bubble.position = clampPosition(bubble.position, bubble.type, rect.naturalWidth, rect.naturalHeight, bubble.size, bubble.sizeRect);
      }
      
      renderBubbles();
      renderPreview();
    }
  }

  function toggleBubbleTail(bubbleId) {
    if (!state.draft) return;
    const bubble = state.draft.bubbles.find(b => b.id === bubbleId);
    if (bubble && BUBBLE_TYPES[bubble.type]?.hasTail) {
      bubble.tail.enabled = !bubble.tail.enabled;
      if (bubble.tail.enabled && !bubble.tail.tip) {
        bubble.tail.tip = { x: 0.5, y: 1.3 };
      }
      renderBubbles();
      renderPreview();
    }
  }

  // ============== UI描画 ==============

  function renderUtterances() {
    const container = document.getElementById('utteranceList');
    if (!container) return;
    
    const utterances = state.draft?.utterances || [];
    const sceneCharacters = state.scene?.characters || [];
    const voicePresets = [
      { id: 'ja-JP-Neural2-B', name: '女性A' },
      { id: 'ja-JP-Neural2-C', name: '男性A' },
      { id: 'ja-JP-Neural2-D', name: '男性B' },
      { id: 'ja-JP-Wavenet-A', name: '女性B' }
    ];
    
    container.innerHTML = utterances.map((ut, index) => {
      const isNarration = ut.speaker_type === 'narration';
      const isCharacter = ut.speaker_type === 'character';
      
      const charOptions = sceneCharacters.length > 0 
        ? sceneCharacters.map(c => 
            `<option value="${c.character_key}" ${ut.speaker_character_key === c.character_key ? 'selected' : ''}>${escapeHtml(c.character_name)}</option>`
          ).join('')
        : '<option value="" disabled>キャラ未設定</option>';
      
      const presetOptions = voicePresets.map(p => 
        `<option value="${p.id}" ${ut.narrator_voice_preset_id === p.id ? 'selected' : ''}>${p.name}</option>`
      ).join('');
      
      return `
      <div class="bg-gray-50 rounded-lg p-3 border border-gray-200" data-utterance-id="${ut.id}">
        <div class="flex items-center justify-between mb-2">
          <span class="font-semibold text-sm text-gray-700">
            <i class="fas fa-comment-alt mr-1 text-purple-500"></i>発話 ${index + 1}
          </span>
          ${utterances.length > 1 ? `
          <button 
            onclick="window.ComicEditorV2.removeUtterance('${ut.id}')"
            class="text-red-500 hover:text-red-700 text-sm px-2 py-1 rounded hover:bg-red-50"
          >
            <i class="fas fa-trash"></i>
          </button>
          ` : ''}
        </div>
        
        <div class="flex gap-2 mb-2">
          <button 
            onclick="window.ComicEditorV2.updateUtteranceSpeakerType('${ut.id}', 'narration')"
            class="flex-1 px-2 py-1.5 rounded text-xs font-semibold transition-colors ${isNarration ? 'bg-purple-600 text-white' : 'bg-white border border-gray-300 text-gray-700 hover:bg-purple-50'}"
          >
            <i class="fas fa-microphone mr-1"></i>ナレ
          </button>
          <button 
            onclick="window.ComicEditorV2.updateUtteranceSpeakerType('${ut.id}', 'character')"
            class="flex-1 px-2 py-1.5 rounded text-xs font-semibold transition-colors ${isCharacter ? 'bg-green-600 text-white' : 'bg-white border border-gray-300 text-gray-700 hover:bg-green-50'} ${sceneCharacters.length === 0 ? 'opacity-50 cursor-not-allowed' : ''}"
            ${sceneCharacters.length === 0 ? 'disabled' : ''}
          >
            <i class="fas fa-user mr-1"></i>キャラ
          </button>
        </div>
        
        ${isNarration ? `
        <select 
          class="w-full px-2 py-1.5 text-sm border border-gray-300 rounded mb-2"
          onchange="window.ComicEditorV2.updateUtteranceNarratorPreset('${ut.id}', this.value)"
        >
          ${presetOptions}
        </select>
        ` : ''}
        
        ${isCharacter ? `
        <select 
          class="w-full px-2 py-1.5 text-sm border border-gray-300 rounded mb-2"
          onchange="window.ComicEditorV2.updateUtteranceCharacter('${ut.id}', this.value)"
        >
          ${charOptions}
        </select>
        ` : ''}
        
        <textarea 
          class="w-full px-2 py-1.5 text-sm border border-gray-300 rounded resize-none"
          rows="2"
          placeholder="セリフを入力..."
          oninput="window.ComicEditorV2.updateUtteranceText('${ut.id}', this.value)"
        >${escapeHtml(ut.text || '')}</textarea>
      </div>
      `;
    }).join('');
    
    renderBubbles();
  }

  function renderBubbles() {
    const container = document.getElementById('bubbleList');
    if (!container) return;
    
    const bubbles = state.draft?.bubbles || [];
    const utterances = state.draft?.utterances || [];
    
    const utteranceColors = ['bg-purple-100 border-purple-300', 'bg-green-100 border-green-300', 'bg-blue-100 border-blue-300'];
    
    container.innerHTML = bubbles.map((bubble, index) => {
      const utterance = utterances.find(u => u.id === bubble.utterance_id);
      const utteranceIndex = utterances.findIndex(u => u.id === bubble.utterance_id);
      const bubbleType = BUBBLE_TYPES[bubble.type] || BUBBLE_TYPES.speech_round;
      const colorClass = utteranceColors[utteranceIndex] || 'bg-gray-100 border-gray-300';
      const currentSize = bubble.size || 'M';
      const isCustomSize = bubble.sizeRect && bubble.sizeRect.w && bubble.sizeRect.h;
      const hasTailOption = bubbleType.hasTail;
      const tailEnabled = bubble.tail?.enabled ?? false;
      
      const typeOptions = Object.entries(BUBBLE_TYPES).map(([key, val]) => 
        `<option value="${key}" ${bubble.type === key ? 'selected' : ''}>${val.name}</option>`
      ).join('');
      
      // カスタムサイズの場合は「カスタム」を追加
      let sizeOptions = Object.entries(SIZE_PRESETS).map(([key, val]) =>
        `<option value="${key}" ${!isCustomSize && currentSize === key ? 'selected' : ''}>${val.name}</option>`
      ).join('');
      if (isCustomSize) {
        sizeOptions += `<option value="custom" selected>カスタム</option>`;
      }
      
      // Phase 3: textStyle 設定
      const ts = bubble.textStyle || DEFAULT_TEXT_STYLE;
      const writingModeOptions = TEXT_STYLE_OPTIONS.writingMode.map(opt =>
        `<option value="${opt.value}" ${ts.writingMode === opt.value ? 'selected' : ''}>${opt.name}</option>`
      ).join('');
      const fontFamilyOptions = TEXT_STYLE_OPTIONS.fontFamily.map(opt =>
        `<option value="${opt.value}" ${ts.fontFamily === opt.value ? 'selected' : ''}>${opt.name}</option>`
      ).join('');
      const fontScaleOptions = TEXT_STYLE_OPTIONS.fontScale.map(opt =>
        `<option value="${opt.value}" ${ts.fontScale === opt.value ? 'selected' : ''}>${opt.name}</option>`
      ).join('');
      const isBold = ts.fontWeight === 'bold';
      
      return `
      <div class="rounded-lg p-2 border text-xs ${colorClass}" data-bubble-id="${bubble.id}">
        <div class="flex items-center justify-between mb-1">
          <span class="font-medium text-gray-700">
            <i class="fas ${bubbleType.icon} mr-1"></i>
            吹出${index + 1} → <span class="font-bold">発話${utteranceIndex + 1}</span>
          </span>
          <button 
            onclick="window.ComicEditorV2.removeBubble('${bubble.id}')"
            class="text-red-500 hover:text-red-700 px-1"
          >
            <i class="fas fa-times"></i>
          </button>
        </div>
        <div class="flex gap-1 items-center mb-1">
          <select 
            class="flex-1 px-1 py-1 text-xs border border-gray-300 rounded"
            onchange="window.ComicEditorV2.updateBubbleType('${bubble.id}', this.value)"
          >
            ${typeOptions}
          </select>
          <select 
            class="w-14 px-1 py-1 text-xs border border-gray-300 rounded ${isCustomSize ? 'bg-green-50 border-green-300' : ''}"
            onchange="window.ComicEditorV2.updateBubbleSize('${bubble.id}', this.value)"
            title="サイズ（右下の緑●でドラッグ調整可）"
          >
            ${sizeOptions}
          </select>
          ${hasTailOption ? `
          <button 
            onclick="window.ComicEditorV2.toggleBubbleTail('${bubble.id}')"
            class="px-2 py-1 text-xs border rounded ${tailEnabled ? 'bg-blue-500 text-white border-blue-500' : 'bg-white text-gray-600 border-gray-300'}"
            title="尾(Tail)"
          >
            <i class="fas fa-location-arrow"></i>
          </button>
          ` : ''}
        </div>
        <!-- Phase 3: テキストスタイル設定 -->
        <div class="flex gap-1 items-center border-t border-gray-200 pt-1">
          <select 
            class="w-12 px-1 py-0.5 text-[10px] border border-gray-200 rounded bg-gray-50"
            onchange="window.ComicEditorV2.updateBubbleTextStyle('${bubble.id}', 'writingMode', this.value)"
            title="書字方向"
          >
            ${writingModeOptions}
          </select>
          <select 
            class="w-14 px-1 py-0.5 text-[10px] border border-gray-200 rounded bg-gray-50"
            onchange="window.ComicEditorV2.updateBubbleTextStyle('${bubble.id}', 'fontFamily', this.value)"
            title="フォント"
          >
            ${fontFamilyOptions}
          </select>
          <button 
            onclick="window.ComicEditorV2.toggleBubbleFontWeight('${bubble.id}')"
            class="px-1.5 py-0.5 text-[10px] border rounded ${isBold ? 'bg-gray-700 text-white border-gray-700' : 'bg-gray-50 text-gray-600 border-gray-200'}"
            title="太字"
          >
            <i class="fas fa-bold"></i>
          </button>
          <select 
            class="w-10 px-0.5 py-0.5 text-[10px] border border-gray-200 rounded bg-gray-50"
            onchange="window.ComicEditorV2.updateBubbleTextStyle('${bubble.id}', 'fontScale', parseFloat(this.value))"
            title="文字サイズ"
          >
            ${fontScaleOptions}
          </select>
        </div>
        ${hasTailOption && tailEnabled ? `
        <div class="mt-1 text-gray-500 text-[10px]">
          <i class="fas fa-info-circle mr-1"></i>青●=尾の先端、緑▲=サイズ調整
        </div>
        ` : `
        <div class="mt-1 text-gray-500 text-[10px]">
          <i class="fas fa-info-circle mr-1"></i>右下の緑▲でサイズ調整
        </div>
        `}
      </div>
      `;
    }).join('');
    
    if (bubbles.length === 0) {
      container.innerHTML = '<p class="text-gray-400 text-xs text-center py-2">吹き出しなし</p>';
    }
  }

  // ============== 保存・公開 ==============

  async function saveDraft() {
    if (state.isSaving) return;
    
    const btn = document.getElementById('comicSaveBtn');
    state.isSaving = true;
    
    try {
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>保存中...';
      }
      
      await axios.post(`/api/scenes/${state.sceneId}/comic/draft`, {
        draft: state.draft,
        base_image_generation_id: state.baseImageGenerationId
      });
      
      showToast('下書き保存しました', 'success');
    } catch (err) {
      console.error('[ComicEditorV2] Save failed:', err);
      showToast('保存に失敗しました', 'error');
    } finally {
      state.isSaving = false;
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-save mr-1"></i>下書き保存';
      }
    }
  }

  async function publish() {
    if (state.isPublishing) return;
    
    const validation = validateDraft();
    if (!validation.ok) {
      showToast('エラーを修正してください', 'error');
      return;
    }
    
    const btn = document.getElementById('comicPublishBtn');
    state.isPublishing = true;
    
    try {
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>公開中...';
      }
      
      const imageData = await renderToCanvasAsync();
      
      await axios.post(`/api/scenes/${state.sceneId}/comic/publish`, {
        image_data: imageData,
        draft: state.draft,
        base_image_generation_id: state.baseImageGenerationId
      });
      
      try {
        await axios.patch(`/api/scenes/${state.sceneId}`, {
          display_asset_type: 'comic'
        });
      } catch (e) {
        console.warn('[ComicEditorV2] Auto-switch failed:', e);
      }
      
      showToast('公開しました！', 'success');
      close();
      
      if (typeof window.initBuilderTab === 'function') {
        window.initBuilderTab();
      } else if (typeof window.loadScenes === 'function') {
        window.loadScenes();
      }
    } catch (err) {
      console.error('[ComicEditorV2] Publish failed:', err);
      showToast('公開に失敗: ' + (err.message || 'エラー'), 'error');
    } finally {
      state.isPublishing = false;
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-upload mr-1"></i>公開';
      }
    }
  }

  // ============== モーダル ==============

  function renderModal(imageUrl) {
    const existingModal = document.getElementById('comicEditorModal');
    if (existingModal) existingModal.remove();
    
    const statusBadge = getStatusBadge();
    
    const modal = document.createElement('div');
    modal.id = 'comicEditorModal';
    modal.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50';
    modal.innerHTML = `
      <div class="bg-white rounded-xl shadow-2xl w-full max-w-5xl mx-4 max-h-[90vh] flex flex-col">
        <!-- Header -->
        <div class="flex items-center justify-between px-6 py-4 border-b border-gray-200 flex-shrink-0">
          <div class="flex items-center gap-3">
            <h2 class="text-xl font-bold text-gray-800">
              <i class="fas fa-pencil-alt mr-2 text-purple-500"></i>漫画編集 <span class="text-sm font-normal text-gray-500">v2</span>
            </h2>
            ${statusBadge}
          </div>
          <button onclick="window.ComicEditorV2.close()" class="text-gray-400 hover:text-gray-600 text-2xl">
            <i class="fas fa-times"></i>
          </button>
        </div>
        
        <!-- Body -->
        <div class="flex-1 overflow-y-auto p-6">
          <div class="flex gap-6">
            <!-- 左: プレビュー -->
            <div class="flex-1 flex items-center justify-center">
              <div id="comicCanvasContainer" class="relative bg-gray-100 rounded-lg" style="max-height: 70vh; width: 100%;">
                <img id="comicBaseImage" 
                     src="${imageUrl}" 
                     class="w-full h-auto max-h-[70vh] object-contain mx-auto block"
                     crossorigin="anonymous"
                     onload="window.ComicEditorV2.onBaseImageLoad()"
                     onerror="window.ComicEditorV2.onBaseImageError()">
                <canvas id="comicPreviewCanvas" 
                        class="absolute inset-0 w-full h-full pointer-events-auto cursor-grab"
                        style="touch-action: none;"></canvas>
              </div>
            </div>
            
            <!-- 右: 編集パネル -->
            <div class="w-80 flex flex-col gap-4">
              <!-- 発話セクション -->
              <div class="bg-white rounded-lg border border-gray-200 p-3">
                <div class="flex items-center justify-between mb-2">
                  <h3 class="font-semibold text-sm text-gray-700">
                    <i class="fas fa-comments mr-1 text-purple-500"></i>発話
                  </h3>
                  <button 
                    onclick="window.ComicEditorV2.addUtterance()"
                    class="text-xs bg-purple-500 hover:bg-purple-600 text-white px-2 py-1 rounded"
                  >
                    <i class="fas fa-plus mr-1"></i>追加
                  </button>
                </div>
                <div id="utteranceList" class="space-y-2 max-h-48 overflow-y-auto"></div>
              </div>
              
              <!-- 吹き出しセクション -->
              <div class="bg-white rounded-lg border border-gray-200 p-3">
                <div class="flex items-center justify-between mb-2">
                  <h3 class="font-semibold text-sm text-gray-700">
                    <i class="fas fa-comment mr-1 text-blue-500"></i>吹き出し
                  </h3>
                  <div class="flex gap-1">
                    <select id="addBubbleUtteranceSelect" class="text-xs border rounded px-1 py-0.5">
                    </select>
                    <select id="addBubbleTypeSelect" class="text-xs border rounded px-1 py-0.5">
                      ${Object.entries(BUBBLE_TYPES).map(([key, val]) => 
                        `<option value="${key}">${val.name}</option>`
                      ).join('')}
                    </select>
                    <button 
                      onclick="window.ComicEditorV2.addBubbleFromUI()"
                      class="text-xs bg-blue-500 hover:bg-blue-600 text-white px-2 py-1 rounded"
                    >
                      <i class="fas fa-plus"></i>
                    </button>
                  </div>
                </div>
                <div id="bubbleList" class="space-y-2 max-h-40 overflow-y-auto"></div>
              </div>
              
              <!-- 操作ヒント -->
              <div class="bg-blue-50 rounded-lg p-3 text-xs text-blue-700">
                <p class="font-semibold mb-1"><i class="fas fa-lightbulb mr-1"></i>操作ヒント</p>
                <ul class="space-y-0.5 text-blue-600">
                  <li>• 吹き出しをドラッグして移動</li>
                  <li>• <span class="text-blue-500 font-bold">青●</span> で尾の方向を調整</li>
                  <li>• <span class="text-green-600 font-bold">緑▲</span> でサイズを調整</li>
                  <li>• <span class="text-red-500 font-bold">赤×</span> で吹き出しを削除</li>
                </ul>
              </div>
              
              <!-- バリデーションエラー -->
              <div id="comicValidationErrors" class="hidden"></div>
            </div>
          </div>
        </div>
        
        <!-- Footer -->
        <div class="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-200 bg-gray-50 flex-shrink-0">
          <button 
            onclick="window.ComicEditorV2.close()"
            class="px-4 py-2 text-gray-600 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 font-medium"
          >
            キャンセル
          </button>
          <button 
            id="comicSaveBtn"
            onclick="window.ComicEditorV2.saveDraft()"
            class="px-4 py-2 text-white bg-gray-600 hover:bg-gray-700 rounded-lg font-medium"
          >
            <i class="fas fa-save mr-1"></i>下書き保存
          </button>
          <button 
            id="comicPublishBtn"
            onclick="window.ComicEditorV2.publish()"
            class="px-4 py-2 text-white bg-green-600 hover:bg-green-700 rounded-lg font-medium"
          >
            <i class="fas fa-upload mr-1"></i>公開
          </button>
        </div>
      </div>
    `;
    
    document.body.appendChild(modal);
    
    modal.addEventListener('click', (e) => {
      if (e.target === modal) close();
    });
    
    document.addEventListener('keydown', handleKeyDown);
  }

  function getStatusBadge() {
    if (state.published) {
      return '<span class="px-2 py-1 bg-green-100 text-green-700 text-xs rounded-full">公開済み</span>';
    } else if (state.draft && state.draft.bubbles?.length > 0) {
      return '<span class="px-2 py-1 bg-yellow-100 text-yellow-700 text-xs rounded-full">未公開</span>';
    }
    return '<span class="px-2 py-1 bg-gray-100 text-gray-600 text-xs rounded-full">新規</span>';
  }

  function onBaseImageLoad() {
    console.log('[ComicEditorV2] Base image loaded');
    state.baseImageLoaded = true;
    
    const container = document.getElementById('comicCanvasContainer');
    const canvas = document.getElementById('comicPreviewCanvas');
    
    if (container && canvas) {
      const rect = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      canvas.style.width = rect.width + 'px';
      canvas.style.height = rect.height + 'px';
      
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
    }
    
    setupDragEvents();
    renderUtterances();
    renderPreview();
    updateBubbleUtteranceSelect();
  }

  function onBaseImageError() {
    console.error('[ComicEditorV2] Base image failed to load');
    showToast('画像の読み込みに失敗しました', 'error');
  }

  function updateBubbleUtteranceSelect() {
    const select = document.getElementById('addBubbleUtteranceSelect');
    if (!select) return;
    
    const utterances = state.draft?.utterances || [];
    select.innerHTML = utterances.map((ut, i) => 
      `<option value="${ut.id}">発話${i + 1}</option>`
    ).join('');
  }

  function addBubbleFromUI() {
    const utteranceSelect = document.getElementById('addBubbleUtteranceSelect');
    const typeSelect = document.getElementById('addBubbleTypeSelect');
    
    if (!utteranceSelect || !typeSelect) return;
    
    const utteranceId = utteranceSelect.value;
    const type = typeSelect.value;
    
    if (utteranceId) {
      addBubble(utteranceId, type);
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape') {
      close();
    }
  }

  function close() {
    const modal = document.getElementById('comicEditorModal');
    if (modal) modal.remove();
    document.removeEventListener('keydown', handleKeyDown);
    
    state.sceneId = null;
    state.scene = null;
    state.draft = null;
    state.published = null;
    state.baseImageGenerationId = null;
    state.containRect = null;
    state.baseImageLoaded = false;
    state.isDragging = false;
    state.dragTarget = null;
    state.dragMode = null;
  }

  function showToast(message, type = 'info') {
    if (typeof window.showToast === 'function') {
      window.showToast(message, type);
    } else {
      console.log(`[Toast] ${type}: ${message}`);
      alert(message);
    }
  }

  // ============== メイン ==============

  async function open(sceneId) {
    console.log('[ComicEditorV2] Opening for scene:', sceneId);
    state.sceneId = sceneId;
    
    try {
      const res = await axios.get(`/api/scenes/${sceneId}?view=board`);
      state.scene = res.data;
      console.log('[ComicEditorV2] Scene loaded:', state.scene);
    } catch (err) {
      console.error('[ComicEditorV2] Failed to load scene:', err);
      showToast('シーンの読み込みに失敗しました', 'error');
      return;
    }
    
    const activeImage = state.scene.active_image;
    const baseImage = state.scene.base_image; // Phase1.7: 漫画編集用の元画像（吹き出しなし）
    const latestImage = state.scene.latest_image;
    const displayAssetType = state.scene.display_asset_type || 'image';
    
    // Phase1.7: 漫画編集時は必ず吹き出しなしのAI画像をベースにする
    // 優先順位:
    // 1. base_image（公開済み漫画の元画像 - 再編集時に最も重要）
    // 2. activeImage（アクティブなAI画像）
    // 3. latestImage（最新の画像 - is_active=0 でも漫画化可能）
    // 
    // 重要: activeComic（吹き出し付き漫画画像）は絶対に使わない！
    // 吹き出し付き画像の上に吹き出しを描画すると二重になるため
    
    let imageUrl = null;
    let baseImageId = null;
    
    // 1. base_image を最優先（再編集時）
    if (baseImage?.r2_url) {
      imageUrl = baseImage.r2_url;
      baseImageId = baseImage.id;
      console.log('[ComicEditorV2] Using base_image (original AI image for comic editing)');
    }
    // 2. activeImage（新規漫画化時）
    else if (activeImage?.r2_url || activeImage?.image_url) {
      imageUrl = activeImage.r2_url || activeImage.image_url;
      baseImageId = activeImage.id;
      console.log('[ComicEditorV2] Using active_image (new comic creation)');
    }
    // 3. latestImage（フォールバック）
    else if (latestImage?.r2_url && latestImage?.status === 'completed') {
      imageUrl = latestImage.r2_url;
      baseImageId = latestImage.id;
      console.log('[ComicEditorV2] Using latest_image (fallback)');
    }
    
    if (!imageUrl) {
      showToast('画像が生成されていません。先にAI画像を生成してください。', 'warning');
      return;
    }
    
    state.baseImageGenerationId = baseImageId;
    initComicData();
    renderModal(imageUrl);
  }

  function initComicData() {
    const comicData = state.scene?.comic_data || {};
    
    state.published = comicData.published || null;
    state.draft = comicData.draft ? JSON.parse(JSON.stringify(comicData.draft)) : null;
    
    if (!state.draft) {
      const initialText = state.scene?.dialogue || '';
      state.draft = {
        utterances: [
          {
            id: generateId(),
            speaker_type: 'narration',
            speaker_character_key: null,
            narrator_voice_preset_id: 'ja-JP-Neural2-B',
            text: initialText
          }
        ],
        bubbles: []
      };
    }
    
    // 旧タイプから新タイプへの移行
    if (state.draft.bubbles) {
      state.draft.bubbles = state.draft.bubbles.map(b => {
        // 旧タイプを新タイプに変換
        const typeMapping = {
          'speech': 'speech_round',
          'whisper': 'speech_oval',
          'thought': 'thought_oval',
          'telop': 'telop_bar'
          // caption はそのまま
        };
        if (typeMapping[b.type]) {
          b.type = typeMapping[b.type];
        }
        // 新しいタイプが存在しない場合はデフォルト
        if (!BUBBLE_TYPES[b.type]) {
          b.type = 'speech_round';
        }
        return b;
      });
    }
  }

  // ============== グローバル公開 ==============

  // ===== Phase 3: テキストスタイル更新関数 =====
  
  function updateBubbleTextStyle(bubbleId, key, value) {
    if (!state.draft) return;
    const bubble = state.draft.bubbles.find(b => b.id === bubbleId);
    if (!bubble) return;
    
    // textStyle オブジェクトを初期化（なければ）
    if (!bubble.textStyle) {
      bubble.textStyle = { ...DEFAULT_TEXT_STYLE };
    }
    
    bubble.textStyle[key] = value;
    console.log(`[ComicEditorV2] Updated bubble ${bubbleId} textStyle.${key} = ${value}`);
    
    // 再描画＆パネル更新
    renderCanvas();
    renderBubbleList();
  }
  
  function toggleBubbleFontWeight(bubbleId) {
    if (!state.draft) return;
    const bubble = state.draft.bubbles.find(b => b.id === bubbleId);
    if (!bubble) return;
    
    if (!bubble.textStyle) {
      bubble.textStyle = { ...DEFAULT_TEXT_STYLE };
    }
    
    bubble.textStyle.fontWeight = bubble.textStyle.fontWeight === 'bold' ? 'normal' : 'bold';
    console.log(`[ComicEditorV2] Toggled bubble ${bubbleId} fontWeight to ${bubble.textStyle.fontWeight}`);
    
    renderCanvas();
    renderBubbleList();
  }

  window.ComicEditorV2 = {
    open,
    close,
    onBaseImageLoad,
    onBaseImageError,
    addUtterance,
    removeUtterance,
    updateUtteranceText,
    updateUtteranceSpeakerType,
    updateUtteranceCharacter,
    updateUtteranceNarratorPreset: (id, preset) => {
      if (!state.draft) return;
      const ut = state.draft.utterances.find(u => u.id === id);
      if (ut) ut.narrator_voice_preset_id = preset;
    },
    addBubble,
    addBubbleFromUI,
    removeBubble,
    updateBubbleType,
    updateBubbleSize,
    toggleBubbleTail,
    // Phase 3: テキストスタイル
    updateBubbleTextStyle,
    toggleBubbleFontWeight,
    saveDraft,
    publish
  };

  // 互換性: openComicEditor
  window.openComicEditor = function(sceneId) {
    window.ComicEditorV2.open(sceneId);
  };

  console.log('[ComicEditorV2] Phase1.7 SSOT v2 loaded - 6 bubble types with tail drag');

})();
