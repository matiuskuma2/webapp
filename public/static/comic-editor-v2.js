// comic-editor-v2.js - Phase1.6 SSOT漫画編集（完全再構築版）
// ============================================================
// SSOT原則:
// 1. 座標系: 正規化(0-1) + containRect補正
// 2. スケール: publishScale = naturalWidth/1000（プレビュー/公開で統一）
// 3. 吹き出し: 実用5種のみ（speech/whisper/thought/telop/caption）
// 4. UIルール: ボタン常時表示、Footer固定、hover非表示禁止
// ============================================================

(function() {
  'use strict';

  // ============== 定数定義 ==============
  const MAX_UTTERANCES = 3;
  const MAX_BUBBLES = 5;
  
  // 吹き出し5種（SSOT）
  const BUBBLE_TYPES = {
    speech:  { name: '通常', icon: 'fa-comment', hasTail: true, category: 'serif' },
    whisper: { name: '小声', icon: 'fa-comment-dots', hasTail: true, category: 'serif' },
    thought: { name: '思考', icon: 'fa-cloud', hasTail: true, category: 'serif' },
    telop:   { name: 'テロップ', icon: 'fa-square', hasTail: false, category: 'narration' },
    caption: { name: '字幕', icon: 'fa-font', hasTail: false, category: 'narration' }
  };

  // サイズ定義（1000px基準）
  const BUBBLE_SIZES = {
    speech:  { w: 360, h: 180 },
    whisper: { w: 360, h: 180 },
    thought: { w: 340, h: 170 },
    telop:   { w: 720, h: 120 },
    caption: { w: 720, h: 100 }
  };

  // スタイル定義
  const BUBBLE_STYLES = {
    speech: {
      fill: '#FFFFFF',
      stroke: 'rgba(0,0,0,0.70)',
      strokeWidth: 2.5,
      radius: 20,
      fontSize: 18,
      lineHeight: 26,
      padding: 16,
      textColor: '#111827'
    },
    whisper: {
      fill: '#FFFFFF',
      stroke: 'rgba(0,0,0,0.45)',
      strokeWidth: 2.0,
      strokeDash: [6, 4],
      radius: 20,
      fontSize: 18,
      lineHeight: 26,
      padding: 16,
      textColor: '#111827'
    },
    thought: {
      fill: '#FFFFFF',
      stroke: 'rgba(0,0,0,0.55)',
      strokeWidth: 2.0,
      fontSize: 18,
      lineHeight: 26,
      padding: 16,
      textColor: '#111827'
    },
    telop: {
      fill: 'rgba(0,0,0,0.45)',
      radius: 12,
      fontSize: 22,
      lineHeight: 30,
      padding: 16,
      textColor: '#FFFFFF',
      textStroke: 'rgba(0,0,0,0.6)',
      textStrokeWidth: 2.0
    },
    caption: {
      fontSize: 24,
      lineHeight: 32,
      padding: 12,
      textColor: '#FFFFFF',
      textStroke: 'rgba(0,0,0,0.85)',
      textStrokeWidth: 4.0
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
    isPublishing: false,
    isSaving: false
  };

  // ============== SSOT: 座標系変換 ==============

  /**
   * containRect を計算（object-contain による画像表示領域）
   */
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

  /**
   * 正規化座標(0-1) → コンテナ座標（プレビュー用）
   */
  function normalizedToContainer(normX, normY) {
    const rect = getContainRect();
    if (!rect) return { x: 0, y: 0 };
    return {
      x: rect.x + normX * rect.width,
      y: rect.y + normY * rect.height
    };
  }

  /**
   * コンテナ座標 → 正規化座標(0-1)（ドラッグ用）
   */
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
   */
  function getBubbleSizePx(type, naturalW) {
    const scale = naturalW / 1000;
    const base = BUBBLE_SIZES[type] || BUBBLE_SIZES.speech;
    return { w: base.w * scale, h: base.h * scale };
  }

  /**
   * 画面内クランプ（サイズ込み）
   */
  function clampPosition(pos, type, naturalW, naturalH) {
    const size = getBubbleSizePx(type, naturalW);
    const marginPx = 12;
    
    const mx = marginPx / naturalW;
    const my = marginPx / naturalH;
    const bw = size.w / naturalW;
    const bh = size.h / naturalH;
    
    return {
      x: Math.min(Math.max(pos.x, mx), 1 - bw - mx),
      y: Math.min(Math.max(pos.y, my), 1 - bh - my)
    };
  }

  // ============== 描画ユーティリティ ==============

  /**
   * 角丸長方形パス
   */
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

  /**
   * Tail付き長方形パス（speech/whisper用）
   */
  function pathSpeechWithTail(ctx, w, h, r, tailTip, scale) {
    const tailBaseX = w * 0.55;
    const tailBaseW = 40 * scale;
    const half = Math.max(8 * scale, tailBaseW / 2);
    
    const tipX = tailTip?.x ?? tailBaseX;
    const tipY = tailTip?.y ?? (h + 24 * scale);
    
    const left = Math.max(r + 6 * scale, tailBaseX - half);
    const right = Math.min(w - r - 6 * scale, tailBaseX + half);
    
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(w - r, 0);
    ctx.quadraticCurveTo(w, 0, w, r);
    ctx.lineTo(w, h - r);
    ctx.quadraticCurveTo(w, h, w - r, h);
    ctx.lineTo(right, h);
    ctx.lineTo(tipX, tipY);
    ctx.lineTo(left, h);
    ctx.lineTo(r, h);
    ctx.quadraticCurveTo(0, h, 0, h - r);
    ctx.lineTo(0, r);
    ctx.quadraticCurveTo(0, 0, r, 0);
    ctx.closePath();
  }

  /**
   * テキスト自動改行
   */
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

  /**
   * テキストフィット検証＋自動縮小
   */
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

  // ============== 吹き出し描画 ==============

  function drawSpeechBubble(ctx, w, h, scale, tailTip) {
    const style = BUBBLE_STYLES.speech;
    const r = style.radius * scale;
    
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.15)';
    ctx.shadowBlur = 8 * scale;
    ctx.shadowOffsetY = 3 * scale;
    
    pathSpeechWithTail(ctx, w, h, r, tailTip, scale);
    ctx.fillStyle = style.fill;
    ctx.fill();
    ctx.restore();
    
    pathSpeechWithTail(ctx, w, h, r, tailTip, scale);
    ctx.strokeStyle = style.stroke;
    ctx.lineWidth = style.strokeWidth * scale;
    ctx.stroke();
  }

  function drawWhisperBubble(ctx, w, h, scale, tailTip) {
    const style = BUBBLE_STYLES.whisper;
    const r = style.radius * scale;
    
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.12)';
    ctx.shadowBlur = 6 * scale;
    ctx.shadowOffsetY = 2 * scale;
    
    pathSpeechWithTail(ctx, w, h, r, tailTip, scale);
    ctx.fillStyle = style.fill;
    ctx.fill();
    ctx.restore();
    
    pathSpeechWithTail(ctx, w, h, r, tailTip, scale);
    ctx.strokeStyle = style.stroke;
    ctx.lineWidth = style.strokeWidth * scale;
    ctx.setLineDash(style.strokeDash.map(d => d * scale));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function drawThoughtBubble(ctx, w, h, scale, tailTip) {
    const style = BUBBLE_STYLES.thought;
    
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.15)';
    ctx.shadowBlur = 8 * scale;
    ctx.shadowOffsetY = 3 * scale;
    
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
    const sx = w * 0.5;
    const sy = h + 4 * scale;
    const tx = tailTip?.x ?? (w * 0.58);
    const ty = tailTip?.y ?? (h + 45 * scale);
    
    const points = [
      { x: sx + (tx - sx) * 0.25, y: sy + (ty - sy) * 0.25, r: 7 * scale },
      { x: sx + (tx - sx) * 0.55, y: sy + (ty - sy) * 0.55, r: 5 * scale },
      { x: sx + (tx - sx) * 0.85, y: sy + (ty - sy) * 0.85, r: 3 * scale }
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

  function drawTelopBubble(ctx, w, h, scale) {
    const style = BUBBLE_STYLES.telop;
    const r = style.radius * scale;
    
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.12)';
    ctx.shadowBlur = 6 * scale;
    ctx.shadowOffsetY = 3 * scale;
    
    pathRoundRect(ctx, 0, 0, w, h, r);
    ctx.fillStyle = style.fill;
    ctx.fill();
    ctx.restore();
  }

  function drawBubbleText(ctx, text, type, w, h, scale) {
    const style = BUBBLE_STYLES[type] || BUBBLE_STYLES.speech;
    const padding = style.padding * scale;
    const innerW = w - padding * 2;
    const innerH = h - padding * 2;
    
    const isNarration = type === 'telop' || type === 'caption';
    const baseFontPx = style.fontSize * scale;
    const baseLineH = style.lineHeight * scale;
    
    const fit = fitText(ctx, text, innerW, innerH, baseFontPx, baseLineH, isNarration);
    
    if (!fit.ok) return { ok: false };
    
    ctx.font = `${isNarration ? '700' : '400'} ${fit.fontPx}px "Hiragino Kaku Gothic ProN", "Hiragino Sans", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    const startY = padding + (innerH - fit.lines.length * fit.lineH) / 2 + fit.lineH / 2;
    
    for (let i = 0; i < fit.lines.length; i++) {
      const lx = w / 2;
      const ly = startY + i * fit.lineH;
      
      if (type === 'caption' || type === 'telop') {
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

  /**
   * 1つの吹き出しを描画（SSOT統合関数）
   */
  function drawOneBubble(ctx, bubble, text, scale, options = {}) {
    const size = BUBBLE_SIZES[bubble.type] || BUBBLE_SIZES.speech;
    const w = size.w * scale;
    const h = size.h * scale;
    
    const tailTip = bubble.tail?.enabled
      ? { x: (bubble.tail.tip?.x ?? 0.55) * w, y: (bubble.tail.tip?.y ?? 1.15) * h }
      : null;
    
    switch (bubble.type) {
      case 'speech':
        drawSpeechBubble(ctx, w, h, scale, tailTip);
        break;
      case 'whisper':
        drawWhisperBubble(ctx, w, h, scale, tailTip);
        break;
      case 'thought':
        drawThoughtBubble(ctx, w, h, scale, tailTip);
        break;
      case 'telop':
        drawTelopBubble(ctx, w, h, scale);
        break;
      case 'caption':
        // 背景なし
        break;
    }
    
    const result = drawBubbleText(ctx, text, bubble.type, w, h, scale);
    
    if (options.showDeleteButton) {
      drawDeleteButton(ctx, w, scale);
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
      
      // 画面外チェック
      const clamped = clampPosition(bubble.position, bubble.type, rect.naturalWidth, rect.naturalHeight);
      if (Math.abs(clamped.x - bubble.position.x) > 0.001 || Math.abs(clamped.y - bubble.position.y) > 0.001) {
        errors.push({ type: 'OUT_OF_BOUNDS', bubbleId: bubble.id, message: '吹き出しが画面外です' });
      }
      
      // 文字溢れチェック
      if (text) {
        const size = BUBBLE_SIZES[bubble.type] || BUBBLE_SIZES.speech;
        const style = BUBBLE_STYLES[bubble.type] || BUBBLE_STYLES.speech;
        const w = size.w * scale;
        const h = size.h * scale;
        const padding = style.padding * scale;
        const innerW = w - padding * 2;
        const innerH = h - padding * 2;
        
        const baseFontPx = style.fontSize * scale;
        const baseLineH = style.lineHeight * scale;
        const isNarration = bubble.type === 'telop' || bubble.type === 'caption';
        
        const fit = fitText(ctx, text, innerW, innerH, baseFontPx, baseLineH, isNarration);
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
    
    // SSOT: 公開と同じスケール
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
      
      // エラー表示
      if (errorBubbleIds.has(bubble.id)) {
        const size = BUBBLE_SIZES[bubble.type] || BUBBLE_SIZES.speech;
        ctx.strokeStyle = '#EF4444';
        ctx.lineWidth = 3 * publishScale;
        ctx.strokeRect(-2 * publishScale, -2 * publishScale, size.w * publishScale + 4 * publishScale, size.h * publishScale + 4 * publishScale);
      }
      
      drawOneBubble(ctx, bubble, text, publishScale, { showDeleteButton: true });
      
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
      drawOneBubble(ctx, bubble, text, scale, { showDeleteButton: false });
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

  function findBubbleAt(canvasX, canvasY) {
    const rect = getContainRect();
    if (!rect) return null;
    
    const bubbles = state.draft?.bubbles || [];
    const displayBubbleScale = rect.width / 1000;
    
    for (let i = bubbles.length - 1; i >= 0; i--) {
      const bubble = bubbles[i];
      const containerPos = normalizedToContainer(bubble.position.x, bubble.position.y);
      const size = BUBBLE_SIZES[bubble.type] || BUBBLE_SIZES.speech;
      const bubbleWidth = size.w * displayBubbleScale;
      const bubbleHeight = size.h * displayBubbleScale;
      
      if (canvasX >= containerPos.x && canvasX <= containerPos.x + bubbleWidth &&
          canvasY >= containerPos.y && canvasY <= containerPos.y + bubbleHeight) {
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
    const size = BUBBLE_SIZES[bubble.type] || BUBBLE_SIZES.speech;
    const bubbleWidth = size.w * displayBubbleScale;
    
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
    
    const bubble = findBubbleAt(canvasX, canvasY);
    
    if (bubble) {
      if (isDeleteButtonClick(canvasX, canvasY, bubble)) {
        removeBubble(bubble.id);
        return;
      }
      
      state.isDragging = true;
      state.dragTarget = bubble.id;
      
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
    
    const adjustedX = canvasX - state.dragOffset.x;
    const adjustedY = canvasY - state.dragOffset.y;
    
    let normalized = containerToNormalized(adjustedX, adjustedY);
    
    const bubble = state.draft.bubbles.find(b => b.id === state.dragTarget);
    if (bubble) {
      normalized = clampPosition(normalized, bubble.type, rect.naturalWidth, rect.naturalHeight);
      bubble.position.x = normalized.x;
      bubble.position.y = normalized.y;
      renderPreview();
    }
  }

  function handleMouseUp() {
    state.isDragging = false;
    state.dragTarget = null;
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

  function addBubble(utteranceId, type = 'speech') {
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
      position: pos,
      tail: hasTail ? { enabled: true, tip: { x: 0.55, y: 1.15 } } : { enabled: false }
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
      bubble.tail = BUBBLE_TYPES[type]?.hasTail 
        ? { enabled: true, tip: { x: 0.55, y: 1.15 } } 
        : { enabled: false };
      
      const rect = getContainRect();
      if (rect) {
        bubble.position = clampPosition(bubble.position, type, rect.naturalWidth, rect.naturalHeight);
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
    
    container.innerHTML = bubbles.map((bubble, index) => {
      const utterance = utterances.find(u => u.id === bubble.utterance_id);
      const utteranceIndex = utterances.findIndex(u => u.id === bubble.utterance_id) + 1;
      const bubbleType = BUBBLE_TYPES[bubble.type] || BUBBLE_TYPES.speech;
      
      const typeOptions = Object.entries(BUBBLE_TYPES).map(([key, val]) => 
        `<option value="${key}" ${bubble.type === key ? 'selected' : ''}>${val.name}</option>`
      ).join('');
      
      return `
      <div class="bg-white rounded-lg p-2 border border-gray-200 text-xs" data-bubble-id="${bubble.id}">
        <div class="flex items-center justify-between mb-1">
          <span class="text-gray-600">
            <i class="fas ${bubbleType.icon} mr-1 text-blue-500"></i>
            吹出${index + 1} → 発話${utteranceIndex}
          </span>
          <button 
            onclick="window.ComicEditorV2.removeBubble('${bubble.id}')"
            class="text-red-500 hover:text-red-700 px-1"
          >
            <i class="fas fa-times"></i>
          </button>
        </div>
        <select 
          class="w-full px-1 py-1 text-xs border border-gray-300 rounded"
          onchange="window.ComicEditorV2.updateBubbleType('${bubble.id}', this.value)"
        >
          ${typeOptions}
        </select>
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
      
      // display_asset_type を comic に切替
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
        <!-- Header（固定） -->
        <div class="flex items-center justify-between px-6 py-4 border-b border-gray-200 flex-shrink-0">
          <div class="flex items-center gap-3">
            <h2 class="text-xl font-bold text-gray-800">
              <i class="fas fa-pencil-alt mr-2 text-purple-500"></i>漫画編集
            </h2>
            ${statusBadge}
          </div>
          <button onclick="window.ComicEditorV2.close()" class="text-gray-400 hover:text-gray-600 text-2xl">
            <i class="fas fa-times"></i>
          </button>
        </div>
        
        <!-- Body（スクロール可能） -->
        <div class="flex-1 overflow-y-auto p-6">
          <div class="flex gap-6">
            <!-- 左: プレビュー -->
            <div class="flex-1">
              <div id="comicCanvasContainer" class="relative bg-gray-100 rounded-lg overflow-hidden" style="aspect-ratio: 1/1;">
                <img id="comicBaseImage" 
                     src="${imageUrl}" 
                     class="w-full h-full object-contain"
                     crossorigin="anonymous"
                     onload="window.ComicEditorV2.onBaseImageLoad()"
                     onerror="window.ComicEditorV2.onBaseImageError()">
                <canvas id="comicPreviewCanvas" 
                        class="absolute inset-0 w-full h-full pointer-events-auto cursor-grab"></canvas>
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
                      <!-- 発話リストで埋められる -->
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
                <div id="bubbleList" class="space-y-2 max-h-32 overflow-y-auto"></div>
              </div>
              
              <!-- バリデーションエラー -->
              <div id="comicValidationErrors" class="hidden"></div>
            </div>
          </div>
        </div>
        
        <!-- Footer（固定・常時表示） -->
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
    
    // 背景クリックで閉じる
    modal.addEventListener('click', (e) => {
      if (e.target === modal) close();
    });
    
    // ESCで閉じる
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
    const imageUrl = activeImage?.r2_url || activeImage?.image_url;
    
    if (!imageUrl) {
      showToast('画像が生成されていません', 'warning');
      return;
    }
    
    state.baseImageGenerationId = activeImage?.id || null;
    initComicData();
    renderModal(imageUrl);
  }

  function initComicData() {
    const comicData = state.scene?.comic_data || {};
    
    state.published = comicData.published || null;
    state.draft = comicData.draft ? JSON.parse(JSON.stringify(comicData.draft)) : null;
    
    // 下書きがなければ初期化
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
  }

  // ============== グローバル公開 ==============

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
      const ut = state.draft?.utterances.find(u => u.id === id);
      if (ut) ut.narrator_voice_preset_id = preset;
    },
    addBubble,
    addBubbleFromUI,
    removeBubble,
    updateBubbleType,
    saveDraft,
    publish
  };

  // 互換性: 旧 openComicEditor 関数名での呼び出しに対応
  window.openComicEditor = function(sceneId) {
    window.ComicEditorV2.open(sceneId);
  };

  console.log('[ComicEditorV2] SSOT v2 loaded');
})();
