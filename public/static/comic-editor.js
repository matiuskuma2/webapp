// comic-editor.js - Phase1.5: 漫画編集ポップアップ（Draft/Published分離対応）
// 仕様: SVG + vanilla JS / 既存機能に影響なし / 発話最大3 / 吹き出し最大3
// Draft: 編集状態（シーンに出ない）
// Published: 公開済み（シーンに出る、動画化対象になれる）

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

  // 定数
  MAX_UTTERANCES: 3,
  MAX_BUBBLES: 5,
  
  // 吹き出しタイプ
  BUBBLE_TYPES: [
    { id: 'speech', name: '通常吹き出し', icon: 'fa-comment' },
    { id: 'thought', name: '思考吹き出し', icon: 'fa-cloud' },
    { id: 'shout', name: '叫び吹き出し', icon: 'fa-bolt' },
    { id: 'whisper', name: 'ささやき吹き出し', icon: 'fa-comment-dots' },
    { id: 'narration', name: 'ナレーション（テロップ）', icon: 'fa-quote-right' }
  ],

  /**
   * 漫画編集ポップアップを開く
   * @param {number} sceneId 
   */
  async open(sceneId) {
    console.log('[ComicEditor] Opening for scene:', sceneId);
    this.currentSceneId = sceneId;

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
      this.published = comicData?.published || null;
    }
    
    console.log('[ComicEditor] Draft initialized:', this.draft);
    console.log('[ComicEditor] Published:', this.published);
  },

  /**
   * モーダルHTMLを生成・挿入
   * @param {string} imageUrl 
   */
  renderModal(imageUrl) {
    // 既存モーダルがあれば削除
    const existing = document.getElementById('comicEditorModal');
    if (existing) existing.remove();

    const hasPublished = !!this.published?.image_generation_id;
    const publishedBadge = hasPublished 
      ? `<span class="ml-2 px-2 py-1 bg-green-500 text-white text-xs rounded-full">公開済み</span>`
      : `<span class="ml-2 px-2 py-1 bg-yellow-500 text-white text-xs rounded-full">未公開</span>`;

    const modalHtml = `
      <div id="comicEditorModal" class="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-60" style="display: none;">
        <div class="bg-white rounded-xl shadow-2xl w-full max-w-6xl max-h-[90vh] overflow-hidden flex flex-col">
          <!-- Header -->
          <div class="bg-gradient-to-r from-purple-600 to-blue-600 px-6 py-4 flex items-center justify-between">
            <h2 class="text-xl font-bold text-white flex items-center">
              <i class="fas fa-comment-alt mr-2"></i>
              漫画編集 - シーン #${this.currentScene.idx}
              ${publishedBadge}
            </h2>
            <button onclick="ComicEditor.close()" class="text-white hover:text-gray-200 text-2xl">
              <i class="fas fa-times"></i>
            </button>
          </div>

          <!-- Content -->
          <div class="flex-1 overflow-hidden p-6">
            <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 h-full">
              <!-- 左: 画像 + SVGオーバーレイ -->
              <div class="space-y-4">
                <h3 class="font-semibold text-gray-700 flex items-center">
                  <i class="fas fa-image mr-2 text-purple-600"></i>プレビュー（編集中）
                </h3>
                <div id="comicCanvasContainer" class="relative bg-gray-100 rounded-lg overflow-hidden" style="aspect-ratio: 16/9;">
                  <img id="comicBaseImage" src="${imageUrl}" crossorigin="anonymous" class="w-full h-full object-contain" alt="Scene image" />
                  <svg id="comicSvgOverlay" class="absolute inset-0 w-full h-full" style="pointer-events: auto;">
                    <!-- 吹き出しがここに描画される -->
                  </svg>
                </div>
                <p class="text-xs text-gray-500">
                  <i class="fas fa-info-circle mr-1"></i>
                  吹き出しをドラッグして位置を調整できます
                </p>
              </div>

              <!-- 右: 発話リスト + 吹き出し管理（スクロール可能） -->
              <div class="flex flex-col h-full max-h-[60vh] lg:max-h-full">
                <h3 class="font-semibold text-gray-700 flex items-center mb-3 flex-shrink-0">
                  <i class="fas fa-list mr-2 text-blue-600"></i>発話・吹き出し設定
                </h3>

                <!-- スクロール可能エリア -->
                <div class="flex-1 overflow-y-auto space-y-4 pr-2">
                  <!-- 発話リスト -->
                  <div id="utteranceList" class="space-y-3">
                    <!-- 発話がここに描画される -->
                  </div>

                  <!-- 吹き出し追加（種類選択） -->
                  <div class="pt-4 border-t border-gray-200">
                    <label class="block text-xs font-semibold text-gray-600 mb-2">吹き出しを追加（最大 ${this.MAX_BUBBLES} 個）</label>
                    <div class="space-y-2" id="bubbleTypeButtons">
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
                      <div class="grid grid-cols-1 gap-2">
                        <button onclick="ComicEditor.addBubble('narration')" class="px-3 py-2 bg-gradient-to-r from-gray-800 to-gray-700 text-white rounded-lg hover:from-gray-700 hover:to-gray-600 transition-all text-sm shadow-md">
                          <i class="fas fa-tv mr-1"></i>テロップ帯（黒背景）
                        </button>
                      </div>
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
                onclick="ComicEditor.saveDraft()"
                class="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-semibold"
              >
                <i class="fas fa-save mr-2"></i>下書き保存
              </button>
              <button 
                onclick="ComicEditor.publish()"
                class="px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-semibold"
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
    this.renderBubbles();
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
   * SVG吹き出しを描画
   */
  renderBubbles() {
    const svg = document.getElementById('comicSvgOverlay');
    if (!svg) return;

    const bubbles = this.draft.bubbles || [];
    const container = document.getElementById('comicCanvasContainer');
    const rect = container.getBoundingClientRect();

    // SVGをクリア（defs以外）
    svg.innerHTML = `
      <defs>
        <filter id="bubbleShadow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="2" dy="2" stdDeviation="3" flood-opacity="0.3"/>
        </filter>
      </defs>
    `;

    bubbles.forEach((bubble, index) => {
      const utterance = this.draft.utterances.find(u => u.id === bubble.utterance_id);
      const text = utterance?.text || '';
      
      // 正規化座標からピクセル座標に変換
      const x = bubble.position.x * rect.width;
      const y = bubble.position.y * rect.height;

      // 吹き出しグループ
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('id', `bubble-${bubble.id}`);
      g.setAttribute('data-bubble-id', bubble.id);
      g.setAttribute('transform', `translate(${x}, ${y})`);
      g.style.cursor = 'move';

      // 吹き出し背景（サイズはタイプ別）
      const bubbleWidth = (bubble.type === 'narration' || bubble.type === 'caption') ? 280 : 200;
      const bubbleHeight = (bubble.type === 'narration' || bubble.type === 'caption') ? 60 : 100;
      const path = this.createBubblePath(bubble.type, bubbleWidth, bubbleHeight);
      
      // caption タイプは吹き出し背景なし（縁取りテキストのみ）
      if (path !== null) {
        const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        pathEl.setAttribute('d', path);
        
        // 種類別スタイル
        switch (bubble.type) {
          case 'thought':
            pathEl.setAttribute('fill', '#F3F4F6');
            pathEl.setAttribute('stroke', '#9CA3AF');
            pathEl.setAttribute('stroke-width', '2');
            break;
          case 'shout':
            pathEl.setAttribute('fill', '#FEF3C7');
            pathEl.setAttribute('stroke', '#F59E0B');
            pathEl.setAttribute('stroke-width', '3');
            break;
          case 'whisper':
            pathEl.setAttribute('fill', '#F9FAFB');
            pathEl.setAttribute('stroke', '#9CA3AF');
            pathEl.setAttribute('stroke-width', '1');
            pathEl.setAttribute('stroke-dasharray', '5,3');
            break;
          case 'narration':
            pathEl.setAttribute('fill', 'rgba(0,0,0,0.7)');
            pathEl.setAttribute('stroke', 'none');
            break;
          default:
            pathEl.setAttribute('fill', 'white');
            pathEl.setAttribute('stroke', '#374151');
            pathEl.setAttribute('stroke-width', '2');
        }
        pathEl.setAttribute('filter', 'url(#bubbleShadow)');
        g.appendChild(pathEl);
      }

      // テキスト（複数行対応）- サイズ拡大
      const isNarrationStyle = bubble.type === 'narration' || bubble.type === 'caption';
      const charsPerLine = isNarrationStyle ? 28 : 20;
      const lines = this.wrapText(text, charsPerLine);
      const lineHeight = 20;
      const textStartY = (bubbleHeight - lines.length * lineHeight) / 2 + lineHeight;

      lines.forEach((line, i) => {
        const textEl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        textEl.setAttribute('x', bubbleWidth / 2);
        textEl.setAttribute('y', textStartY + i * lineHeight);
        textEl.setAttribute('text-anchor', 'middle');
        textEl.setAttribute('font-size', isNarrationStyle ? '18' : '14');
        textEl.setAttribute('font-weight', isNarrationStyle ? 'bold' : 'normal');
        
        // caption: 縁取りテキスト（白文字に黒縁）
        if (bubble.type === 'caption') {
          textEl.setAttribute('fill', '#FFFFFF');
          textEl.setAttribute('stroke', '#000000');
          textEl.setAttribute('stroke-width', '3');
          textEl.setAttribute('paint-order', 'stroke');
        } else if (bubble.type === 'narration') {
          textEl.setAttribute('fill', '#FFFFFF');
          textEl.setAttribute('stroke', '#000000');
          textEl.setAttribute('stroke-width', '0.5');
        } else {
          textEl.setAttribute('fill', '#1F2937');
        }
        textEl.textContent = line;
        g.appendChild(textEl);
      });

      // 削除ボタン
      const deleteBtn = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      deleteBtn.setAttribute('cx', bubbleWidth - 5);
      deleteBtn.setAttribute('cy', '5');
      deleteBtn.setAttribute('r', '10');
      deleteBtn.setAttribute('fill', '#EF4444');
      deleteBtn.setAttribute('cursor', 'pointer');
      deleteBtn.onclick = (e) => {
        e.stopPropagation();
        this.removeBubble(bubble.id);
      };
      g.appendChild(deleteBtn);

      const deleteIcon = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      deleteIcon.setAttribute('x', bubbleWidth - 5);
      deleteIcon.setAttribute('y', '9');
      deleteIcon.setAttribute('text-anchor', 'middle');
      deleteIcon.setAttribute('font-size', '12');
      deleteIcon.setAttribute('fill', 'white');
      deleteIcon.setAttribute('pointer-events', 'none');
      deleteIcon.textContent = '×';
      g.appendChild(deleteIcon);

      // ドラッグイベント
      g.addEventListener('mousedown', (e) => this.startDrag(e, bubble.id));
      g.addEventListener('touchstart', (e) => this.startDrag(e, bubble.id), { passive: false });

      svg.appendChild(g);
    });

    // ドラッグイベントリスナー（グローバル）- 重複防止のため一度だけ設定
    if (!svg.dataset.listenersAttached) {
      svg.addEventListener('mousemove', (e) => this.onDrag(e));
      svg.addEventListener('mouseup', () => this.endDrag());
      svg.addEventListener('mouseleave', () => this.endDrag());
      svg.addEventListener('touchmove', (e) => this.onDrag(e), { passive: false });
      svg.addEventListener('touchend', () => this.endDrag());
      svg.dataset.listenersAttached = 'true';
    }

    // 追加ボタンの状態更新（複数ボタン対応）
    const bubbleTypeButtons = document.getElementById('bubbleTypeButtons');
    if (bubbleTypeButtons) {
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
    }
  },

  /**
   * 吹き出しのSVGパスを生成（種類拡張）
   */
  createBubblePath(type, width, height) {
    const tailSize = 15;
    const r = 10;
    
    switch (type) {
      case 'thought':
        // 雲形（楕円で近似）
        return `M 10,${height/2} 
                Q 0,${height/4} 10,10 
                Q ${width/4},0 ${width/2},10 
                Q ${width*3/4},0 ${width-10},10 
                Q ${width},${height/4} ${width-10},${height/2}
                Q ${width},${height*3/4} ${width-10},${height-10}
                Q ${width*3/4},${height} ${width/2},${height-10}
                Q ${width/4},${height} 10,${height-10}
                Q 0,${height*3/4} 10,${height/2}
                Z
                M ${width/4},${height+5} 
                A 6,6 0 1,1 ${width/4+12},${height+5}
                M ${width/4-5},${height+18} 
                A 4,4 0 1,1 ${width/4+3},${height+18}`;
      
      case 'shout':
        // 叫び吹き出し（ギザギザ）
        const spikes = 8;
        const spikeDepth = 8;
        let path = `M 0,${height/2}`;
        for (let i = 0; i < spikes; i++) {
          const angle1 = (i / spikes) * Math.PI;
          const angle2 = ((i + 0.5) / spikes) * Math.PI;
          const x1 = (width/2) + (width/2 + spikeDepth) * Math.cos(angle1);
          const y1 = (height/2) - (height/2 + spikeDepth) * Math.sin(angle1);
          const x2 = (width/2) + (width/2 - spikeDepth) * Math.cos(angle2);
          const y2 = (height/2) - (height/2 - spikeDepth) * Math.sin(angle2);
          path += ` L ${x1},${y1} L ${x2},${y2}`;
        }
        path += ` L ${width},${height/2}`;
        for (let i = 0; i < spikes; i++) {
          const angle1 = Math.PI + (i / spikes) * Math.PI;
          const angle2 = Math.PI + ((i + 0.5) / spikes) * Math.PI;
          const x1 = (width/2) + (width/2 + spikeDepth) * Math.cos(angle1);
          const y1 = (height/2) - (height/2 + spikeDepth) * Math.sin(angle1);
          const x2 = (width/2) + (width/2 - spikeDepth) * Math.cos(angle2);
          const y2 = (height/2) - (height/2 - spikeDepth) * Math.sin(angle2);
          path += ` L ${x1},${y1} L ${x2},${y2}`;
        }
        path += ' Z';
        return path;
      
      case 'whisper':
        // ささやき吹き出し（点線角丸）- パスは通常と同じ、strokeで点線にする
        return `M ${r},0 
                H ${width-r} 
                Q ${width},0 ${width},${r} 
                V ${height-r} 
                Q ${width},${height} ${width-r},${height}
                H ${width/2 + tailSize}
                L ${width/2},${height + tailSize}
                L ${width/2 - tailSize},${height}
                H ${r}
                Q 0,${height} 0,${height-r}
                V ${r}
                Q 0,0 ${r},0
                Z`;
      
      case 'narration':
        // ナレーション（テロップ風 - 半透明黒背景の帯）
        return `M 0,0 
                H ${width} 
                V ${height}
                H 0
                Z`;
      
      case 'caption':
        // キャプション（吹き出しなし - 縁取りテキストのみ）
        // pathは描画しない。renderBubblesで特別処理
        return null;
      
      default:
        // 通常の吹き出し（角丸矩形 + しっぽ）
        return `M ${r},0 
                H ${width-r} 
                Q ${width},0 ${width},${r} 
                V ${height-r} 
                Q ${width},${height} ${width-r},${height}
                H ${width/2 + tailSize}
                L ${width/2},${height + tailSize}
                L ${width/2 - tailSize},${height}
                H ${r}
                Q 0,${height} 0,${height-r}
                V ${r}
                Q 0,0 ${r},0
                Z`;
    }
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
   * ドラッグ開始
   */
  startDrag(e, bubbleId) {
    e.preventDefault();
    this.isDragging = true;
    this.dragTarget = bubbleId;

    const container = document.getElementById('comicCanvasContainer');
    const rect = container.getBoundingClientRect();

    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;

    const bubble = this.draft.bubbles.find(b => b.id === bubbleId);
    if (bubble) {
      this.dragOffset = {
        x: clientX - rect.left - bubble.position.x * rect.width,
        y: clientY - rect.top - bubble.position.y * rect.height
      };
    }
  },

  /**
   * ドラッグ中
   */
  onDrag(e) {
    if (!this.isDragging || !this.dragTarget) return;
    e.preventDefault();

    const container = document.getElementById('comicCanvasContainer');
    const rect = container.getBoundingClientRect();

    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;

    // 新しい位置を計算（正規化座標）
    let newX = (clientX - rect.left - this.dragOffset.x) / rect.width;
    let newY = (clientY - rect.top - this.dragOffset.y) / rect.height;

    // 範囲制限
    newX = Math.max(0, Math.min(0.8, newX));
    newY = Math.max(0, Math.min(0.8, newY));

    // データ更新
    const bubble = this.draft.bubbles.find(b => b.id === this.dragTarget);
    if (bubble) {
      bubble.position.x = newX;
      bubble.position.y = newY;

      // SVG要素を直接更新（再描画なし）
      const g = document.getElementById(`bubble-${bubble.id}`);
      if (g) {
        g.setAttribute('transform', `translate(${newX * rect.width}, ${newY * rect.height})`);
      }
    }
  },

  /**
   * ドラッグ終了
   */
  endDrag() {
    this.isDragging = false;
    this.dragTarget = null;
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
      narrator_voice_preset_id: 'ja-JP-Neural2-B', // デフォルト
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
      this.renderBubbles(); // 吹き出しのテキストを更新
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
      this.renderBubbles();
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
      this.renderBubbles(); // 吹き出しの表示を更新
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
    this.renderBubbles();
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
    // ナレーションは下の方、それ以外はランダムな位置
    const position = type === 'narration' 
      ? { x: 0.1 + Math.random() * 0.1, y: 0.75 + Math.random() * 0.1 }
      : { x: 0.3 + Math.random() * 0.2, y: 0.2 + Math.random() * 0.2 };
    
    this.draft.bubbles.push({
      id: newId,
      utterance_id: firstUtterance.id,
      type: type,
      position: position
    });

    this.renderBubbles();
    showToast('吹き出しを追加しました', 'success');
  },

  /**
   * 吹き出しを削除
   */
  removeBubble(bubbleId) {
    this.draft.bubbles = this.draft.bubbles.filter(b => b.id !== bubbleId);
    this.renderBubbles();
  },

  /**
   * 下書き保存（Phase1.5）
   */
  async saveDraft() {
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
    }
  },

  /**
   * 公開（Phase1.5: Canvas→PNG変換→アップロード）
   */
  async publish() {
    try {
      // 吹き出しがない場合は警告
      if (this.draft.bubbles.length === 0) {
        const confirmed = confirm('吹き出しがありません。このまま公開しますか？');
        if (!confirmed) return;
      }

      showToast('公開準備中...', 'info');

      // Canvas→PNG変換
      const imageData = await this.renderToCanvas();
      
      console.log('[ComicEditor] Publishing comic...');

      const res = await axios.post(`/api/scenes/${this.currentSceneId}/comic/publish`, {
        image_data: imageData,
        base_image_generation_id: this.baseImageGenerationId,
        draft: this.draft
      });

      console.log('[ComicEditor] Publish response:', res.data);
      
      this.published = res.data.comic_data?.published;
      
      showToast('漫画を公開しました！「漫画を採用」でシーンに反映できます', 'success');
      this.close();

      // シーン一覧を更新（もしあれば）
      if (typeof window.loadScenes === 'function') {
        window.loadScenes();
      }

    } catch (err) {
      console.error('[ComicEditor] Publish failed:', err);
      showToast('公開に失敗しました', 'error');
    }
  },

  /**
   * Canvas→PNG変換（クライアント側レンダリング）
   */
  async renderToCanvas() {
    return new Promise((resolve, reject) => {
      const container = document.getElementById('comicCanvasContainer');
      const baseImage = document.getElementById('comicBaseImage');
      const svgOverlay = document.getElementById('comicSvgOverlay');
      
      if (!container || !baseImage || !svgOverlay) {
        reject(new Error('Required elements not found'));
        return;
      }

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      
      // 元画像のサイズに合わせる
      const img = new Image();
      img.crossOrigin = 'anonymous';
      
      img.onload = () => {
        canvas.width = img.naturalWidth || img.width;
        canvas.height = img.naturalHeight || img.height;
        
        // 画像を描画
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        
        // SVGを描画
        const svgData = new XMLSerializer().serializeToString(svgOverlay);
        const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
        const svgUrl = URL.createObjectURL(svgBlob);
        
        const svgImg = new Image();
        svgImg.crossOrigin = 'anonymous';
        
        svgImg.onload = () => {
          // SVGのサイズを調整してcanvasに描画
          const containerRect = container.getBoundingClientRect();
          const scaleX = canvas.width / containerRect.width;
          const scaleY = canvas.height / containerRect.height;
          
          ctx.save();
          ctx.scale(scaleX, scaleY);
          ctx.drawImage(svgImg, 0, 0, containerRect.width, containerRect.height);
          ctx.restore();
          
          URL.revokeObjectURL(svgUrl);
          
          // PNG base64に変換
          const dataUrl = canvas.toDataURL('image/png');
          resolve(dataUrl);
        };
        
        svgImg.onerror = (err) => {
          URL.revokeObjectURL(svgUrl);
          reject(new Error('SVG loading failed'));
        };
        
        svgImg.src = svgUrl;
      };
      
      img.onerror = () => {
        reject(new Error('Base image loading failed'));
      };
      
      img.src = baseImage.src;
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

console.log('[ComicEditor] Phase1.5 loaded successfully');
