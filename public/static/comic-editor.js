// comic-editor.js - Phase1.5 SSOT: 漫画編集ポップアップ（座標系統一・描画SSOT）
// 仕様: Canvas直接描画 SSOT / 既存機能に影響なし / 発話最大3 / 吹き出し最大5
// Draft: 編集状態（シーンに出ない）
// Published: 公開済み（シーンに出る、動画化対象になれる）
// SSOT原則: プレビューと公開画像は同一の描画ロジック（Canvas）で生成

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
  MAX_BUBBLES: 5,
  
  // キャッシュ
  _containRect: null,
  _baseImageLoaded: false,
  
  // 吹き出しタイプ
  BUBBLE_TYPES: [
    { id: 'speech', name: '通常吹き出し', icon: 'fa-comment' },
    { id: 'thought', name: '思考吹き出し', icon: 'fa-cloud' },
    { id: 'shout', name: '叫び吹き出し', icon: 'fa-bolt' },
    { id: 'whisper', name: 'ささやき吹き出し', icon: 'fa-comment-dots' },
    { id: 'narration', name: 'ナレーション（テロップ）', icon: 'fa-quote-right' },
    { id: 'caption', name: '字幕（枠なし）', icon: 'fa-font' }
  ],

  /**
   * SSOT: containRect を計算（object-contain による画像表示領域）
   * プレビュー座標変換の基準となる
   */
  getContainRect() {
    const container = document.getElementById('comicCanvasContainer');
    const baseImage = document.getElementById('comicBaseImage');
    
    if (!container || !baseImage) return null;
    
    const containerRect = container.getBoundingClientRect();
    const naturalWidth = baseImage.naturalWidth || containerRect.width;
    const naturalHeight = baseImage.naturalHeight || containerRect.height;
    
    // object-contain による実際の表示領域を計算
    const containerAspect = containerRect.width / containerRect.height;
    const imageAspect = naturalWidth / naturalHeight;
    
    let displayWidth, displayHeight, offsetX, offsetY;
    
    if (containerAspect > imageAspect) {
      // コンテナが横長 → 画像は高さに合わせ、左右に余白
      displayHeight = containerRect.height;
      displayWidth = displayHeight * imageAspect;
      offsetX = (containerRect.width - displayWidth) / 2;
      offsetY = 0;
    } else {
      // コンテナが縦長 → 画像は幅に合わせ、上下に余白
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
   * SSOT: 正規化座標(0-1) → コンテナ座標（プレビュー表示用）
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
   * SSOT: コンテナ座標 → 正規化座標(0-1)（ドラッグ用）
   */
  containerToNormalized(containerX, containerY) {
    const rect = this.getContainRect();
    if (!rect) return { x: 0, y: 0 };
    
    return {
      x: Math.max(0, Math.min(1, (containerX - rect.x) / rect.width)),
      y: Math.max(0, Math.min(1, (containerY - rect.y) / rect.height))
    };
  },

  /**
   * SSOT: 正規化座標(0-1) → 元画像座標（Canvas出力用）
   */
  normalizedToNatural(normX, normY) {
    const rect = this.getContainRect();
    if (!rect) return { x: 0, y: 0 };
    
    return {
      x: normX * rect.naturalWidth,
      y: normY * rect.naturalHeight
    };
  },

  /**
   * 漫画編集ポップアップを開く
   */
  async open(sceneId) {
    console.log('[ComicEditor] Opening for scene:', sceneId);
    this.currentSceneId = sceneId;
    this._containRect = null;
    this._baseImageLoaded = false;

    // シーンデータ取得
    try {
      const res = await axios.get(`/api/scenes/${sceneId}?view=board`);
      this.currentScene = res.data;
      console.log('[ComicEditor] Scene loaded:', this.currentScene);
    } catch (err) {
      console.error('[ComicEditor] Failed to load scene:', err);
      showToast('シーンの読み込みに失敗しました', 'error');
      return;
    }

    // 画像がない場合は開けない
    const activeImage = this.currentScene.active_image;
    const imageUrl = activeImage?.r2_url || activeImage?.image_url;
    if (!imageUrl) {
      showToast('画像が生成されていません', 'warning');
      return;
    }

    // base_image_generation_id を保存（監査用）
    this.baseImageGenerationId = activeImage?.id || null;

    // comic_data 初期化（Draft/Published分離）
    this.initComicData();

    // モーダル表示
    this.renderModal(imageUrl);
    this.showModal();
  },

  /**
   * comic_data の初期化（Phase1.5: Draft/Published分離）
   */
  initComicData() {
    const comicData = this.currentScene.comic_data;
    
    if (comicData && comicData.draft) {
      // 既存Draftがあれば使用
      this.draft = comicData.draft;
      this.published = comicData.published || null;
      this.baseImageGenerationId = comicData.base_image_generation_id || this.baseImageGenerationId;
    } else if (comicData && comicData.published) {
      // Publishedがあれば、そこからdraftを復元
      this.draft = JSON.parse(JSON.stringify(comicData.published));
      this.published = comicData.published;
      this.baseImageGenerationId = comicData.base_image_generation_id || this.baseImageGenerationId;
    } else {
      // 初期生成: dialogue → utterances[0].text（SSOT維持）
      this.draft = {
        enabled: true,
        utterances: [
          {
            id: 'ut_1',
            speaker_type: 'narration',
            speaker_id: null,
            text: this.currentScene.dialogue || ''
          }
        ],
        bubbles: []
      };
      this.published = null;
    }
    
    console.log('[ComicEditor] Draft initialized:', this.draft);
    console.log('[ComicEditor] Published:', this.published);
  },

  /**
   * モーダルHTMLを生成・挿入
   */
  renderModal(imageUrl) {
    // 既存モーダルがあれば削除
    const existing = document.getElementById('comicEditorModal');
    if (existing) existing.remove();

    const hasPublished = !!this.published?.image_generation_id;
    const hasDraftChanges = this.draft && JSON.stringify(this.draft) !== JSON.stringify(this.published);
    
    let statusBadge = '';
    if (hasPublished && hasDraftChanges) {
      statusBadge = `<span class="ml-2 px-2 py-1 bg-orange-500 text-white text-xs rounded-full">未公開の変更あり</span>`;
    } else if (hasPublished) {
      statusBadge = `<span class="ml-2 px-2 py-1 bg-green-500 text-white text-xs rounded-full">公開済み</span>`;
    } else {
      statusBadge = `<span class="ml-2 px-2 py-1 bg-yellow-500 text-white text-xs rounded-full">未公開</span>`;
    }

    const modalHtml = `
      <div id="comicEditorModal" class="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-60" style="display: none;">
        <div class="bg-white rounded-xl shadow-2xl w-full max-w-6xl max-h-[90vh] overflow-hidden flex flex-col">
          <!-- Header -->
          <div class="bg-gradient-to-r from-purple-600 to-blue-600 px-6 py-4 flex items-center justify-between">
            <h2 class="text-xl font-bold text-white flex items-center">
              <i class="fas fa-comment-alt mr-2"></i>
              漫画編集 - シーン #${this.currentScene.idx}
              ${statusBadge}
            </h2>
            <button onclick="ComicEditor.close()" class="text-white hover:text-gray-200 text-2xl">
              <i class="fas fa-times"></i>
            </button>
          </div>

          <!-- Content -->
          <div class="flex-1 overflow-hidden p-6">
            <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 h-full">
              <!-- 左: Canvas プレビュー（SSOT: Canvas直接描画） -->
              <div class="space-y-4">
                <h3 class="font-semibold text-gray-700 flex items-center">
                  <i class="fas fa-image mr-2 text-purple-600"></i>プレビュー（編集中）
                </h3>
                <div id="comicCanvasContainer" class="relative bg-gray-900 rounded-lg overflow-hidden" style="aspect-ratio: 16/9;">
                  <img 
                    id="comicBaseImage" 
                    src="${imageUrl}" 
                    crossorigin="anonymous" 
                    class="w-full h-full object-contain" 
                    alt="Scene image" 
                    onload="ComicEditor.onBaseImageLoad()"
                  />
                  <!-- Canvas オーバーレイ（プレビュー用） -->
                  <canvas 
                    id="comicPreviewCanvas" 
                    class="absolute inset-0 w-full h-full" 
                    style="pointer-events: auto;"
                  ></canvas>
                </div>
                <p class="text-xs text-gray-500">
                  <i class="fas fa-info-circle mr-1"></i>
                  吹き出しをドラッグして位置を調整できます
                </p>
              </div>

              <!-- 右: 発話リスト + 吹き出し管理（スクロール可能） -->
              <div class="space-y-4 overflow-y-auto" style="max-height: calc(90vh - 200px);">
                <h3 class="font-semibold text-gray-700 flex items-center sticky top-0 bg-white pb-2 z-10">
                  <i class="fas fa-list mr-2 text-blue-600"></i>発話・吹き出し設定
                </h3>

                <!-- 発話リスト -->
                <div id="utteranceList" class="space-y-3">
                  <!-- 発話がここに描画される -->
                </div>

                <!-- 吹き出し追加（種類選択） -->
                <div class="pt-4 border-t border-gray-200 pb-4">
                  <label class="block text-xs font-semibold text-gray-600 mb-2">吹き出しを追加（最大 ${this.MAX_BUBBLES} 個）</label>
                  <div class="space-y-3" id="bubbleTypeButtons">
                    <!-- キャラクター用吹き出し -->
                    <p class="text-xs text-gray-500 font-semibold">セリフ用</p>
                    <div class="grid grid-cols-2 gap-2">
                      <button onclick="ComicEditor.addBubble('speech')" class="px-3 py-2 bg-white border-2 border-gray-300 rounded-lg hover:bg-blue-50 hover:border-blue-400 transition-colors text-sm">
                        <i class="fas fa-comment text-gray-700 mr-1"></i>通常
                      </button>
                      <button onclick="ComicEditor.addBubble('thought')" class="px-3 py-2 bg-white border-2 border-gray-300 rounded-lg hover:bg-gray-100 hover:border-gray-400 transition-colors text-sm">
                        <i class="fas fa-cloud text-gray-500 mr-1"></i>思考
                      </button>
                      <button onclick="ComicEditor.addBubble('shout')" class="px-3 py-2 bg-white border-2 border-gray-300 rounded-lg hover:bg-yellow-50 hover:border-yellow-400 transition-colors text-sm">
                        <i class="fas fa-bolt text-yellow-500 mr-1"></i>叫び
                      </button>
                      <button onclick="ComicEditor.addBubble('whisper')" class="px-3 py-2 bg-white border-2 border-gray-300 rounded-lg hover:bg-purple-50 hover:border-purple-400 transition-colors text-sm">
                        <i class="fas fa-comment-dots text-purple-500 mr-1"></i>ささやき
                      </button>
                    </div>
                    
                    <!-- ナレーション用 -->
                    <p class="text-xs text-gray-500 font-semibold mt-3">ナレーション用</p>
                    <div class="grid grid-cols-2 gap-2">
                      <button onclick="ComicEditor.addBubble('narration')" class="px-3 py-2 bg-gray-800 text-white border-2 border-gray-800 rounded-lg hover:bg-gray-700 transition-colors text-sm font-medium">
                        <i class="fas fa-square mr-1"></i>テロップ帯
                      </button>
                      <button onclick="ComicEditor.addBubble('caption')" class="px-3 py-2 bg-white text-gray-800 border-2 border-gray-400 rounded-lg hover:bg-gray-100 transition-colors text-sm font-medium">
                        <i class="fas fa-font mr-1"></i>字幕（枠なし）
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Footer（Phase1.5: Draft/Publish分離） -->
          <div class="bg-gray-100 px-6 py-4 flex justify-between items-center border-t border-gray-200">
            <div class="text-sm text-gray-600">
              <i class="fas fa-exclamation-triangle text-yellow-500 mr-1"></i>
              「公開」するまでシーンには反映されません
            </div>
            <div class="flex gap-3">
              <button 
                onclick="ComicEditor.close()"
                class="px-6 py-2 bg-gray-300 text-gray-700 rounded-lg hover:bg-gray-400 transition-colors font-semibold"
              >
                <i class="fas fa-times mr-2"></i>キャンセル
              </button>
              <button 
                id="comicSaveBtn"
                onclick="ComicEditor.saveDraft()"
                class="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <i class="fas fa-save mr-2"></i>下書き保存
              </button>
              <button 
                id="comicPublishBtn"
                onclick="ComicEditor.publish()"
                class="px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <i class="fas fa-upload mr-2"></i>公開
              </button>
            </div>
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHtml);

    // ESCキーで閉じる
    document.addEventListener('keydown', this.handleKeyDown);

    // 発話リストと吹き出しを描画
    this.renderUtterances();
  },

  /**
   * ベース画像のロード完了時
   */
  onBaseImageLoad() {
    console.log('[ComicEditor] Base image loaded');
    this._baseImageLoaded = true;
    this._containRect = null; // キャッシュをクリア
    
    // プレビューCanvasを初期化
    this.initPreviewCanvas();
    this.renderPreview();
    
    // ドラッグイベントを設定
    this.setupDragEvents();
  },

  /**
   * プレビューCanvasを初期化
   */
  initPreviewCanvas() {
    const canvas = document.getElementById('comicPreviewCanvas');
    const container = document.getElementById('comicCanvasContainer');
    
    if (!canvas || !container) return;
    
    // Canvasのサイズをコンテナに合わせる（Retina対応）
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
   * ドラッグイベントを設定
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
   * マウスダウンハンドラ（吹き出し選択・ドラッグ開始）
   */
  handleMouseDown(e) {
    e.preventDefault();
    
    const canvas = document.getElementById('comicPreviewCanvas');
    const canvasRect = canvas.getBoundingClientRect();
    
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    
    const canvasX = clientX - canvasRect.left;
    const canvasY = clientY - canvasRect.top;
    
    // クリック位置に吹き出しがあるか確認
    const bubble = this.findBubbleAt(canvasX, canvasY);
    
    if (bubble) {
      // 削除ボタンの判定
      if (this.isDeleteButtonClick(canvasX, canvasY, bubble)) {
        this.removeBubble(bubble.id);
        return;
      }
      
      // ドラッグ開始
      this.isDragging = true;
      this.dragTarget = bubble.id;
      
      const containRect = this.getContainRect();
      const bubbleContainerPos = this.normalizedToContainer(bubble.position.x, bubble.position.y);
      
      this.dragOffset = {
        x: canvasX - bubbleContainerPos.x,
        y: canvasY - bubbleContainerPos.y
      };
    }
  },

  /**
   * マウス移動ハンドラ（ドラッグ中）
   */
  handleMouseMove(e) {
    if (!this.isDragging || !this.dragTarget) return;
    e.preventDefault();
    
    const canvas = document.getElementById('comicPreviewCanvas');
    const canvasRect = canvas.getBoundingClientRect();
    
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    
    const canvasX = clientX - canvasRect.left;
    const canvasY = clientY - canvasRect.top;
    
    // オフセットを考慮した位置
    const adjustedX = canvasX - this.dragOffset.x;
    const adjustedY = canvasY - this.dragOffset.y;
    
    // コンテナ座標 → 正規化座標
    const normalized = this.containerToNormalized(adjustedX, adjustedY);
    
    // 範囲制限（0.8まで: 吹き出しが画像からはみ出さないように）
    normalized.x = Math.max(0, Math.min(0.8, normalized.x));
    normalized.y = Math.max(0, Math.min(0.8, normalized.y));
    
    // データ更新
    const bubble = this.draft.bubbles.find(b => b.id === this.dragTarget);
    if (bubble) {
      bubble.position.x = normalized.x;
      bubble.position.y = normalized.y;
      this.renderPreview();
    }
  },

  /**
   * マウスアップハンドラ（ドラッグ終了）
   */
  handleMouseUp() {
    this.isDragging = false;
    this.dragTarget = null;
  },

  /**
   * 指定座標にある吹き出しを探す
   */
  findBubbleAt(canvasX, canvasY) {
    const containRect = this.getContainRect();
    if (!containRect) return null;
    
    const bubbles = this.draft.bubbles || [];
    const baseScale = containRect.width / 1000;
    
    // 逆順でチェック（後から描画されたものが上）
    for (let i = bubbles.length - 1; i >= 0; i--) {
      const bubble = bubbles[i];
      const containerPos = this.normalizedToContainer(bubble.position.x, bubble.position.y);
      
      const isNarration = bubble.type === 'narration' || bubble.type === 'caption';
      const bubbleWidth = (isNarration ? 280 : 200) * baseScale;
      const bubbleHeight = (isNarration ? 60 : 100) * baseScale;
      
      if (canvasX >= containerPos.x && canvasX <= containerPos.x + bubbleWidth &&
          canvasY >= containerPos.y && canvasY <= containerPos.y + bubbleHeight) {
        return bubble;
      }
    }
    
    return null;
  },

  /**
   * 削除ボタンがクリックされたか判定
   */
  isDeleteButtonClick(canvasX, canvasY, bubble) {
    const containRect = this.getContainRect();
    if (!containRect) return false;
    
    const baseScale = containRect.width / 1000;
    const containerPos = this.normalizedToContainer(bubble.position.x, bubble.position.y);
    
    const isNarration = bubble.type === 'narration' || bubble.type === 'caption';
    const bubbleWidth = (isNarration ? 280 : 200) * baseScale;
    
    // 削除ボタンの位置
    const btnX = containerPos.x + bubbleWidth - 5 * baseScale;
    const btnY = containerPos.y + 5 * baseScale;
    const btnRadius = 12 * baseScale;
    
    const dx = canvasX - btnX;
    const dy = canvasY - btnY;
    
    return (dx * dx + dy * dy) <= (btnRadius * btnRadius);
  },

  /**
   * プレビューを描画（SSOT: Canvasに直接描画）
   */
  renderPreview() {
    const canvas = document.getElementById('comicPreviewCanvas');
    const ctx = canvas?.getContext('2d');
    if (!ctx || !this._baseImageLoaded) return;
    
    const containRect = this.getContainRect();
    if (!containRect) return;
    
    // クリア
    ctx.clearRect(0, 0, canvas.width / (window.devicePixelRatio || 1), canvas.height / (window.devicePixelRatio || 1));
    
    // 吹き出しを描画
    const bubbles = this.draft.bubbles || [];
    const baseScale = containRect.width / 1000; // プレビュー用スケール
    
    bubbles.forEach((bubble) => {
      const utterance = this.draft.utterances.find(u => u.id === bubble.utterance_id);
      const text = utterance?.text || '';
      
      // 正規化座標 → コンテナ座標
      const containerPos = this.normalizedToContainer(bubble.position.x, bubble.position.y);
      
      // 吹き出しサイズ
      const isNarration = bubble.type === 'narration' || bubble.type === 'caption';
      const bubbleWidth = (isNarration ? 280 : 200) * baseScale;
      const bubbleHeight = (isNarration ? 60 : 100) * baseScale;
      
      ctx.save();
      ctx.translate(containerPos.x, containerPos.y);
      
      // 吹き出し背景を描画
      if (bubble.type !== 'caption') {
        this.drawBubbleBackground(ctx, bubble.type, bubbleWidth, bubbleHeight, baseScale);
      }
      
      // テキストを描画
      this.drawBubbleText(ctx, text, bubble.type, bubbleWidth, bubbleHeight, baseScale);
      
      // 削除ボタンを描画
      this.drawDeleteButton(ctx, bubbleWidth, baseScale);
      
      ctx.restore();
    });
    
    // ボタン状態を更新
    this.updateBubbleButtons();
  },

  /**
   * 削除ボタンを描画
   */
  drawDeleteButton(ctx, bubbleWidth, scale) {
    const btnRadius = 10 * scale;
    const btnX = bubbleWidth - 5 * scale;
    const btnY = 5 * scale;
    
    // 赤丸
    ctx.beginPath();
    ctx.arc(btnX, btnY, btnRadius, 0, Math.PI * 2);
    ctx.fillStyle = '#EF4444';
    ctx.fill();
    
    // ×アイコン
    ctx.fillStyle = 'white';
    ctx.font = `bold ${12 * scale}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('×', btnX, btnY);
  },

  /**
   * 発話リストを描画（SSOT: シーンのキャラクターから選択）
   */
  renderUtterances() {
    const container = document.getElementById('utteranceList');
    if (!container) return;

    const utterances = this.draft.utterances || [];
    // シーンに割り当てられたキャラクター（最大3人）
    const sceneCharacters = this.currentScene.characters || [];
    // 音声プリセット（ナレーション用）
    const voicePresets = [
      { id: 'ja-JP-Neural2-B', name: '女性A（Neural2）' },
      { id: 'ja-JP-Neural2-C', name: '男性A（Neural2）' },
      { id: 'ja-JP-Neural2-D', name: '男性B（Neural2）' },
      { id: 'ja-JP-Wavenet-A', name: '女性A（WaveNet）' },
      { id: 'ja-JP-Wavenet-B', name: '女性B（WaveNet）' },
      { id: 'ja-JP-Wavenet-C', name: '男性A（WaveNet）' }
    ];
    
    container.innerHTML = utterances.map((ut, index) => {
      const isNarration = ut.speaker_type === 'narration';
      const isCharacter = ut.speaker_type === 'character';
      
      // キャラクター選択オプション
      const charOptions = sceneCharacters.length > 0 
        ? sceneCharacters.map(c => 
            `<option value="${c.character_key}" ${ut.speaker_character_key === c.character_key ? 'selected' : ''}>${this.escapeHtml(c.character_name)}</option>`
          ).join('')
        : '<option value="" disabled>キャラクター未割当</option>';
      
      // 音声プリセットオプション
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
            title="この発話を削除"
          >
            <i class="fas fa-trash"></i>
          </button>
          ` : ''}
        </div>
        
        <!-- 話者タイプ選択 -->
        <div class="flex gap-2 mb-3">
          <button 
            onclick="ComicEditor.updateUtteranceSpeakerType('${ut.id}', 'narration')"
            class="flex-1 px-3 py-2 rounded-lg text-sm font-semibold transition-colors ${isNarration ? 'bg-purple-600 text-white' : 'bg-white border border-gray-300 text-gray-700 hover:bg-purple-50'}"
          >
            <i class="fas fa-microphone mr-1"></i>ナレーション
          </button>
          <button 
            onclick="ComicEditor.updateUtteranceSpeakerType('${ut.id}', 'character')"
            class="flex-1 px-3 py-2 rounded-lg text-sm font-semibold transition-colors ${isCharacter ? 'bg-green-600 text-white' : 'bg-white border border-gray-300 text-gray-700 hover:bg-green-50'} ${sceneCharacters.length === 0 ? 'opacity-50 cursor-not-allowed' : ''}"
            ${sceneCharacters.length === 0 ? 'disabled title="シーンにキャラクターを割り当ててください"' : ''}
          >
            <i class="fas fa-user mr-1"></i>キャラクター
          </button>
        </div>
        
        <!-- ナレーション用：音声プリセット選択 -->
        ${isNarration ? `
        <div class="mb-3">
          <label class="block text-xs font-semibold text-gray-600 mb-1">
            <i class="fas fa-sliders-h mr-1"></i>音声プリセット
          </label>
          <select 
            onchange="ComicEditor.updateUtteranceNarratorVoice('${ut.id}', this.value)"
            class="w-full text-sm px-3 py-2 rounded-lg border border-purple-300 bg-purple-50 focus:border-purple-500"
          >
            ${presetOptions}
          </select>
        </div>
        ` : ''}
        
        <!-- キャラクター用：シーン内キャラから選択 -->
        ${isCharacter ? `
        <div class="mb-3">
          <label class="block text-xs font-semibold text-gray-600 mb-1">
            <i class="fas fa-users mr-1"></i>話すキャラクター
          </label>
          <select 
            onchange="ComicEditor.updateUtteranceCharacter('${ut.id}', this.value)"
            class="w-full text-sm px-3 py-2 rounded-lg border border-green-300 bg-green-50 focus:border-green-500"
          >
            ${charOptions}
          </select>
          ${sceneCharacters.length === 0 ? `
          <p class="text-xs text-orange-600 mt-1">
            <i class="fas fa-exclamation-triangle mr-1"></i>
            シーンにキャラクターが割り当てられていません
          </p>
          ` : ''}
        </div>
        ` : ''}
        
        <!-- セリフ入力 -->
        <textarea
          id="utteranceText-${ut.id}"
          class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm resize-none"
          rows="3"
          placeholder="${isNarration ? 'ナレーションテキストを入力...' : 'セリフを入力...'}"
          onchange="ComicEditor.updateUtterance('${ut.id}', this.value)"
          oninput="ComicEditor.updateUtterance('${ut.id}', this.value)"
        >${this.escapeHtml(ut.text)}</textarea>
      </div>
    `}).join('');

    // 発話追加ボタン（最大3まで）
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
   * 吹き出しボタンの状態を更新
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

  /**
   * 吹き出し背景をCanvasに描画
   */
  drawBubbleBackground(ctx, type, width, height, scale) {
    ctx.beginPath();
    
    // 影を追加
    ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
    ctx.shadowBlur = 4 * scale;
    ctx.shadowOffsetX = 2 * scale;
    ctx.shadowOffsetY = 2 * scale;
    
    switch (type) {
      case 'thought':
        // 雲形
        this.drawThoughtBubble(ctx, width, height, scale);
        ctx.fillStyle = '#F3F4F6';
        ctx.strokeStyle = '#9CA3AF';
        ctx.lineWidth = 2 * scale;
        break;
        
      case 'shout':
        // ギザギザ
        this.drawShoutBubble(ctx, width, height, scale);
        ctx.fillStyle = '#FEF3C7';
        ctx.strokeStyle = '#F59E0B';
        ctx.lineWidth = 3 * scale;
        break;
        
      case 'whisper':
        this.drawRoundRect(ctx, 0, 0, width, height, 10 * scale);
        ctx.fillStyle = '#F9FAFB';
        ctx.strokeStyle = '#9CA3AF';
        ctx.lineWidth = 1 * scale;
        ctx.setLineDash([5 * scale, 3 * scale]);
        break;
        
      case 'narration':
        ctx.rect(0, 0, width, height);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
        ctx.strokeStyle = 'transparent';
        break;
        
      default: // speech
        this.drawSpeechBubble(ctx, width, height, scale);
        ctx.fillStyle = 'white';
        ctx.strokeStyle = '#374151';
        ctx.lineWidth = 2 * scale;
    }
    
    ctx.fill();
    if (ctx.strokeStyle !== 'transparent') {
      ctx.stroke();
    }
    
    // 影をリセット
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.setLineDash([]);
  },

  /**
   * 通常吹き出しを描画（しっぽ付き）
   */
  drawSpeechBubble(ctx, width, height, scale) {
    const r = 10 * scale;
    const tailSize = 12 * scale;
    
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(width - r, 0);
    ctx.quadraticCurveTo(width, 0, width, r);
    ctx.lineTo(width, height - r);
    ctx.quadraticCurveTo(width, height, width - r, height);
    ctx.lineTo(width / 2 + tailSize, height);
    ctx.lineTo(width / 2, height + tailSize);
    ctx.lineTo(width / 2 - tailSize, height);
    ctx.lineTo(r, height);
    ctx.quadraticCurveTo(0, height, 0, height - r);
    ctx.lineTo(0, r);
    ctx.quadraticCurveTo(0, 0, r, 0);
    ctx.closePath();
  },

  /**
   * 思考吹き出しを描画（雲形）
   */
  drawThoughtBubble(ctx, width, height, scale) {
    // 楕円ベースの雲
    ctx.beginPath();
    ctx.ellipse(width / 2, height / 2, width / 2 - 5 * scale, height / 2 - 5 * scale, 0, 0, Math.PI * 2);
    
    // 小さな円（しっぽ）
    ctx.moveTo(width / 4 + 8 * scale, height + 5 * scale);
    ctx.arc(width / 4, height + 5 * scale, 6 * scale, 0, Math.PI * 2);
    ctx.moveTo(width / 4 - 5 * scale + 4 * scale, height + 16 * scale);
    ctx.arc(width / 4 - 5 * scale, height + 16 * scale, 4 * scale, 0, Math.PI * 2);
  },

  /**
   * 叫び吹き出しを描画（ギザギザ）
   */
  drawShoutBubble(ctx, width, height, scale) {
    const spikes = 8;
    const spikeDepth = 8 * scale;
    const cx = width / 2;
    const cy = height / 2;
    const rx = width / 2 - spikeDepth;
    const ry = height / 2 - spikeDepth;
    
    ctx.beginPath();
    for (let i = 0; i < spikes * 2; i++) {
      const angle = (i / (spikes * 2)) * Math.PI * 2 - Math.PI / 2;
      const r = i % 2 === 0 ? 1 : 0.7;
      const x = cx + Math.cos(angle) * rx * r + (i % 2 === 0 ? Math.cos(angle) * spikeDepth : 0);
      const y = cy + Math.sin(angle) * ry * r + (i % 2 === 0 ? Math.sin(angle) * spikeDepth : 0);
      
      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.closePath();
  },

  /**
   * 角丸矩形を描画
   */
  drawRoundRect(ctx, x, y, width, height, radius) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
  },

  /**
   * 吹き出しテキストをCanvasに描画
   */
  drawBubbleText(ctx, text, type, bubbleWidth, bubbleHeight, scale) {
    const isNarration = type === 'narration' || type === 'caption';
    const fontSize = (isNarration ? 18 : 14) * scale;
    const lineHeight = 20 * scale;
    const charsPerLine = isNarration ? 28 : 20;
    
    ctx.font = `${isNarration ? 'bold' : 'normal'} ${fontSize}px "Hiragino Kaku Gothic ProN", "Hiragino Sans", "Yu Gothic", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    // テキストを行に分割
    const lines = this.wrapText(text, charsPerLine);
    const textStartY = (bubbleHeight - lines.length * lineHeight) / 2 + lineHeight / 2;
    
    lines.forEach((line, i) => {
      const textX = bubbleWidth / 2;
      const textY = textStartY + i * lineHeight;
      
      if (type === 'caption') {
        // 縁取りテキスト（白文字に黒縁）
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 4 * scale;
        ctx.lineJoin = 'round';
        ctx.strokeText(line, textX, textY);
        ctx.fillStyle = '#FFFFFF';
        ctx.fillText(line, textX, textY);
      } else if (type === 'narration') {
        // 白文字（影付き）
        ctx.fillStyle = '#FFFFFF';
        ctx.fillText(line, textX, textY);
      } else {
        // 黒文字
        ctx.fillStyle = '#1F2937';
        ctx.fillText(line, textX, textY);
      }
    });
  },

  /**
   * テキストを折り返す
   */
  wrapText(text, maxChars) {
    if (!text) return [''];
    const lines = [];
    let current = '';
    
    for (const char of text) {
      if (char === '\n') {
        lines.push(current);
        current = '';
      } else if (current.length >= maxChars) {
        lines.push(current);
        current = char;
      } else {
        current += char;
      }
    }
    if (current) lines.push(current);
    
    return lines.slice(0, 5); // 最大5行
  },

  /**
   * 発話を追加
   */
  addUtterance() {
    if (this.draft.utterances.length >= this.MAX_UTTERANCES) {
      showToast(`発話は最大${this.MAX_UTTERANCES}つまでです`, 'warning');
      return;
    }

    const newId = `ut_${Date.now()}`;
    this.draft.utterances.push({
      id: newId,
      speaker_type: 'narration',
      speaker_id: null,
      speaker_character_key: null,
      narrator_voice_preset_id: 'ja-JP-Neural2-B',
      text: ''
    });

    this.renderUtterances();
  },

  /**
   * 発話を更新
   */
  updateUtterance(utteranceId, text) {
    const utterance = this.draft.utterances.find(u => u.id === utteranceId);
    if (utterance) {
      utterance.text = text;
      this.renderPreview(); // プレビューを更新
    }
  },

  /**
   * 発話のspeaker_typeを更新（UI再描画あり）
   */
  updateUtteranceSpeakerType(utteranceId, speakerType) {
    const utterance = this.draft.utterances.find(u => u.id === utteranceId);
    if (utterance) {
      utterance.speaker_type = speakerType;
      // キャラクターに変更した場合、シーンの最初のキャラを自動選択
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

  /**
   * 発話のナレーター音声プリセットを更新
   */
  updateUtteranceNarratorVoice(utteranceId, presetId) {
    const utterance = this.draft.utterances.find(u => u.id === utteranceId);
    if (utterance) {
      utterance.narrator_voice_preset_id = presetId;
    }
  },

  /**
   * 発話のキャラクターを更新
   */
  updateUtteranceCharacter(utteranceId, characterKey) {
    const utterance = this.draft.utterances.find(u => u.id === utteranceId);
    if (utterance) {
      utterance.speaker_character_key = characterKey;
      this.renderPreview();
    }
  },

  /**
   * @deprecated Use updateUtteranceSpeakerType instead
   */
  updateUtteranceSpeaker(utteranceId, speakerType) {
    this.updateUtteranceSpeakerType(utteranceId, speakerType);
  },

  /**
   * 発話を削除
   */
  removeUtterance(utteranceId) {
    // 紐付いている吹き出しも削除
    this.draft.bubbles = this.draft.bubbles.filter(b => b.utterance_id !== utteranceId);
    // 発話を削除
    this.draft.utterances = this.draft.utterances.filter(u => u.id !== utteranceId);
    this.renderUtterances();
    this.renderPreview();
  },

  /**
   * 吹き出しを追加（種類指定対応）
   */
  addBubble(type = 'speech') {
    if (this.draft.bubbles.length >= this.MAX_BUBBLES) {
      showToast(`吹き出しは最大${this.MAX_BUBBLES}つまでです`, 'warning');
      return;
    }

    // 紐付ける発話を選択（最初の発話をデフォルト）
    const firstUtterance = this.draft.utterances[0];
    if (!firstUtterance) {
      showToast('発話を先に追加してください', 'warning');
      return;
    }

    const newId = `b_${Date.now()}`;
    // ナレーション系は下の方、それ以外はランダムな位置
    const isNarration = type === 'narration' || type === 'caption';
    const position = isNarration 
      ? { x: 0.1 + Math.random() * 0.1, y: 0.7 + Math.random() * 0.1 }
      : { x: 0.2 + Math.random() * 0.3, y: 0.1 + Math.random() * 0.3 };
    
    this.draft.bubbles.push({
      id: newId,
      utterance_id: firstUtterance.id,
      type: type,
      position: position
    });

    this.renderPreview();
    showToast('吹き出しを追加しました', 'success');
  },

  /**
   * 吹き出しを削除
   */
  removeBubble(bubbleId) {
    this.draft.bubbles = this.draft.bubbles.filter(b => b.id !== bubbleId);
    this.renderPreview();
  },

  /**
   * 下書き保存（Phase1.5）- 二重押し防止 + finally復帰
   */
  async saveDraft() {
    if (this.isSaving) return;
    this.isSaving = true;
    
    const btn = document.getElementById('comicSaveBtn');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>保存中...';
    }
    
    try {
      console.log('[ComicEditor] Saving draft:', this.draft);

      const res = await axios.post(`/api/scenes/${this.currentSceneId}/comic/draft`, {
        draft: this.draft,
        base_image_generation_id: this.baseImageGenerationId
      });

      console.log('[ComicEditor] Draft saved:', res.data);
      showToast('下書きを保存しました', 'success');

    } catch (err) {
      console.error('[ComicEditor] Draft save failed:', err);
      showToast('下書きの保存に失敗しました', 'error');
    } finally {
      this.isSaving = false;
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-save mr-2"></i>下書き保存';
      }
    }
  },

  /**
   * 公開（SSOT: Canvas→PNG変換→アップロード）- toBlob非同期 + 二重押し防止
   */
  async publish() {
    if (this.isPublishing) return;
    this.isPublishing = true;
    
    const btn = document.getElementById('comicPublishBtn');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>公開中...';
    }
    
    try {
      // 吹き出しがない場合は警告
      if (this.draft.bubbles.length === 0) {
        const confirmed = confirm('吹き出しがありません。このまま公開しますか？');
        if (!confirmed) {
          return;
        }
      }

      showToast('画像を生成中...', 'info');

      // Canvas→PNG変換（非同期toBlob）
      const imageData = await this.renderToCanvasAsync();
      
      console.log('[ComicEditor] Publishing comic...');

      const res = await axios.post(`/api/scenes/${this.currentSceneId}/comic/publish`, {
        image_data: imageData,
        base_image_generation_id: this.baseImageGenerationId,
        draft: this.draft
      });

      console.log('[ComicEditor] Publish response:', res.data);
      
      this.published = res.data.comic_data?.published;
      
      // 自動的に漫画を採用状態にする
      try {
        await axios.put(`/api/scenes/${this.currentSceneId}/display-asset-type`, {
          display_asset_type: 'comic'
        });
        console.log('[ComicEditor] Auto-switched to comic display');
      } catch (e) {
        console.warn('[ComicEditor] Failed to auto-switch display type:', e);
      }
      
      showToast('漫画を公開しました！', 'success');
      this.close();

      // シーン一覧を更新
      if (typeof window.initBuilderTab === 'function') {
        window.initBuilderTab();
      } else if (typeof window.loadScenes === 'function') {
        window.loadScenes();
      }

    } catch (err) {
      console.error('[ComicEditor] Publish failed:', err);
      showToast('公開に失敗しました: ' + (err.message || 'エラー'), 'error');
    } finally {
      this.isPublishing = false;
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-upload mr-2"></i>公開';
      }
    }
  },

  /**
   * SSOT: Canvas出力（非同期toBlob使用）
   * プレビューと同一の描画ロジックで最終画像を生成
   */
  async renderToCanvasAsync() {
    const baseImage = document.getElementById('comicBaseImage');
    
    if (!baseImage) {
      throw new Error('Base image not found');
    }

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    // 元画像のサイズ（出力サイズ）
    const width = baseImage.naturalWidth || baseImage.width;
    const height = baseImage.naturalHeight || baseImage.height;
    
    canvas.width = width;
    canvas.height = height;
    
    // 1. ベース画像を描画
    ctx.drawImage(baseImage, 0, 0, width, height);
    
    // 2. 吹き出しを直接Canvasに描画（プレビューと同じロジック）
    const baseScale = width / 1000; // 出力用スケール
    const bubbles = this.draft.bubbles || [];
    
    for (const bubble of bubbles) {
      const utterance = this.draft.utterances.find(u => u.id === bubble.utterance_id);
      const text = utterance?.text || '';
      
      // 正規化座標 → 元画像座標
      const x = bubble.position.x * width;
      const y = bubble.position.y * height;
      
      // 吹き出しサイズ
      const isNarration = bubble.type === 'narration' || bubble.type === 'caption';
      const bubbleWidth = (isNarration ? 280 : 200) * baseScale;
      const bubbleHeight = (isNarration ? 60 : 100) * baseScale;
      
      ctx.save();
      ctx.translate(x, y);
      
      // 吹き出し背景を描画
      if (bubble.type !== 'caption') {
        this.drawBubbleBackground(ctx, bubble.type, bubbleWidth, bubbleHeight, baseScale);
      }
      
      // テキストを描画
      this.drawBubbleText(ctx, text, bubble.type, bubbleWidth, bubbleHeight, baseScale);
      
      ctx.restore();
    }
    
    // 非同期でBlobに変換し、base64に
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error('Failed to create blob'));
          return;
        }
        
        const reader = new FileReader();
        reader.onloadend = () => {
          resolve(reader.result);
        };
        reader.onerror = () => {
          reject(new Error('Failed to read blob'));
        };
        reader.readAsDataURL(blob);
      }, 'image/png', 1.0);
    });
  },

  /**
   * モーダルを表示
   */
  showModal() {
    const modal = document.getElementById('comicEditorModal');
    if (modal) {
      modal.style.display = 'flex';
    }
  },

  /**
   * モーダルを閉じる
   */
  close() {
    const modal = document.getElementById('comicEditorModal');
    if (modal) {
      modal.remove();
    }
    document.removeEventListener('keydown', this.handleKeyDown);
    this.currentSceneId = null;
    this.currentScene = null;
    this.draft = null;
    this.published = null;
    this.baseImageGenerationId = null;
    this._containRect = null;
    this._baseImageLoaded = false;
  },

  /**
   * キーダウンハンドラ（ESCで閉じる）
   */
  handleKeyDown(e) {
    if (e.key === 'Escape') {
      window.ComicEditor.close();
    }
  },

  /**
   * HTMLエスケープ
   */
  escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
};

// グローバル関数として公開
window.openComicEditor = function(sceneId) {
  window.ComicEditor.open(sceneId);
};

console.log('[ComicEditor] SSOT Phase1.5 loaded successfully');
