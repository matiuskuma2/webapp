// comic-editor.js - Phase1: 漫画編集ポップアップ
// 仕様: SVG + vanilla JS / 既存機能に影響なし / 発話最大3 / 吹き出し最大3

window.ComicEditor = {
  // 状態
  currentSceneId: null,
  currentScene: null,
  comicData: null,
  isDragging: false,
  dragTarget: null,
  dragOffset: { x: 0, y: 0 },

  // 定数
  MAX_UTTERANCES: 3,
  MAX_BUBBLES: 3,

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
    const imageUrl = this.currentScene.active_image?.r2_url || this.currentScene.active_image?.image_url;
    if (!imageUrl) {
      showToast('画像が生成されていません', 'warning');
      return;
    }

    // comic_data 初期化（NULLの場合はdialogueから生成）
    this.initComicData();

    // モーダル表示
    this.renderModal(imageUrl);
    this.showModal();
  },

  /**
   * comic_data の初期化（SSOT: dialogueが正）
   */
  initComicData() {
    if (this.currentScene.comic_data) {
      this.comicData = this.currentScene.comic_data;
    } else {
      // 初期生成: dialogue → utterances[0].text
      this.comicData = {
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
    }
    console.log('[ComicEditor] Comic data initialized:', this.comicData);
  },

  /**
   * モーダルHTMLを生成・挿入
   * @param {string} imageUrl 
   */
  renderModal(imageUrl) {
    // 既存モーダルがあれば削除
    const existing = document.getElementById('comicEditorModal');
    if (existing) existing.remove();

    const modalHtml = `
      <div id="comicEditorModal" class="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-60" style="display: none;">
        <div class="bg-white rounded-xl shadow-2xl w-full max-w-6xl max-h-[90vh] overflow-hidden flex flex-col">
          <!-- Header -->
          <div class="bg-gradient-to-r from-purple-600 to-blue-600 px-6 py-4 flex items-center justify-between">
            <h2 class="text-xl font-bold text-white flex items-center">
              <i class="fas fa-comment-alt mr-2"></i>
              漫画編集 - シーン #${this.currentScene.idx}
            </h2>
            <button onclick="ComicEditor.close()" class="text-white hover:text-gray-200 text-2xl">
              <i class="fas fa-times"></i>
            </button>
          </div>

          <!-- Content -->
          <div class="flex-1 overflow-auto p-6">
            <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <!-- 左: 画像 + SVGオーバーレイ -->
              <div class="space-y-4">
                <h3 class="font-semibold text-gray-700 flex items-center">
                  <i class="fas fa-image mr-2 text-purple-600"></i>プレビュー
                </h3>
                <div id="comicCanvasContainer" class="relative bg-gray-100 rounded-lg overflow-hidden" style="aspect-ratio: 16/9;">
                  <img id="comicBaseImage" src="${imageUrl}" class="w-full h-full object-contain" alt="Scene image" />
                  <svg id="comicSvgOverlay" class="absolute inset-0 w-full h-full pointer-events-none" style="pointer-events: all;">
                    <!-- 吹き出しがここに描画される -->
                  </svg>
                </div>
                <p class="text-xs text-gray-500">
                  <i class="fas fa-info-circle mr-1"></i>
                  吹き出しをドラッグして位置を調整できます
                </p>
              </div>

              <!-- 右: 発話リスト + 吹き出し管理 -->
              <div class="space-y-4">
                <h3 class="font-semibold text-gray-700 flex items-center">
                  <i class="fas fa-list mr-2 text-blue-600"></i>発話・吹き出し設定
                </h3>

                <!-- 発話リスト -->
                <div id="utteranceList" class="space-y-3">
                  <!-- 発話がここに描画される -->
                </div>

                <!-- 吹き出し追加ボタン -->
                <div class="pt-4 border-t border-gray-200">
                  <button 
                    id="addBubbleBtn"
                    onclick="ComicEditor.addBubble()"
                    class="w-full px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors font-semibold"
                  >
                    <i class="fas fa-plus mr-2"></i>吹き出しを追加
                  </button>
                  <p class="text-xs text-gray-500 mt-2 text-center">
                    最大 ${this.MAX_BUBBLES} 個まで
                  </p>
                </div>
              </div>
            </div>
          </div>

          <!-- Footer -->
          <div class="bg-gray-100 px-6 py-4 flex justify-end gap-3 border-t border-gray-200">
            <button 
              onclick="ComicEditor.close()"
              class="px-6 py-2 bg-gray-300 text-gray-700 rounded-lg hover:bg-gray-400 transition-colors font-semibold"
            >
              <i class="fas fa-times mr-2"></i>キャンセル
            </button>
            <button 
              onclick="ComicEditor.save()"
              class="px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-semibold"
            >
              <i class="fas fa-save mr-2"></i>保存
            </button>
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
   * 発話リストを描画
   */
  renderUtterances() {
    const container = document.getElementById('utteranceList');
    if (!container) return;

    const utterances = this.comicData.utterances || [];
    
    container.innerHTML = utterances.map((ut, index) => `
      <div class="bg-gray-50 rounded-lg p-4 border border-gray-200" data-utterance-id="${ut.id}">
        <div class="flex items-center justify-between mb-2">
          <span class="font-semibold text-sm text-gray-700">
            発話 ${index + 1}
          </span>
          <span class="text-xs px-2 py-1 rounded-full ${
            ut.speaker_type === 'narration' 
              ? 'bg-gray-200 text-gray-700' 
              : 'bg-blue-100 text-blue-700'
          }">
            ${ut.speaker_type === 'narration' ? 'ナレーション' : 'キャラクター'}
          </span>
        </div>
        <textarea
          id="utteranceText-${ut.id}"
          class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm resize-none"
          rows="3"
          placeholder="セリフを入力..."
          onchange="ComicEditor.updateUtterance('${ut.id}', this.value)"
        >${this.escapeHtml(ut.text)}</textarea>
      </div>
    `).join('');

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

    const bubbles = this.comicData.bubbles || [];
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
      const utterance = this.comicData.utterances.find(u => u.id === bubble.utterance_id);
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

      // 吹き出し背景
      const bubbleWidth = 160;
      const bubbleHeight = 80;
      const path = this.createBubblePath(bubble.type, bubbleWidth, bubbleHeight);
      
      const pathEl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      pathEl.setAttribute('d', path);
      pathEl.setAttribute('fill', 'white');
      pathEl.setAttribute('stroke', bubble.type === 'thought' ? '#9CA3AF' : '#374151');
      pathEl.setAttribute('stroke-width', '2');
      pathEl.setAttribute('filter', 'url(#bubbleShadow)');
      g.appendChild(pathEl);

      // テキスト（複数行対応）
      const lines = this.wrapText(text, 18);
      const lineHeight = 16;
      const textStartY = (bubbleHeight - lines.length * lineHeight) / 2 + lineHeight;

      lines.forEach((line, i) => {
        const textEl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        textEl.setAttribute('x', bubbleWidth / 2);
        textEl.setAttribute('y', textStartY + i * lineHeight);
        textEl.setAttribute('text-anchor', 'middle');
        textEl.setAttribute('font-size', '12');
        textEl.setAttribute('fill', '#1F2937');
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

    // ドラッグイベントリスナー（グローバル）
    svg.addEventListener('mousemove', (e) => this.onDrag(e));
    svg.addEventListener('mouseup', () => this.endDrag());
    svg.addEventListener('mouseleave', () => this.endDrag());
    svg.addEventListener('touchmove', (e) => this.onDrag(e), { passive: false });
    svg.addEventListener('touchend', () => this.endDrag());

    // 追加ボタンの状態更新
    const addBtn = document.getElementById('addBubbleBtn');
    if (addBtn) {
      if (bubbles.length >= this.MAX_BUBBLES) {
        addBtn.disabled = true;
        addBtn.classList.add('opacity-50', 'cursor-not-allowed');
      } else {
        addBtn.disabled = false;
        addBtn.classList.remove('opacity-50', 'cursor-not-allowed');
      }
    }
  },

  /**
   * 吹き出しのSVGパスを生成
   */
  createBubblePath(type, width, height) {
    const tailSize = 15;
    
    if (type === 'thought') {
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
    } else {
      // 通常の吹き出し（角丸矩形 + しっぽ）
      const r = 10;
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

    const svg = document.getElementById('comicSvgOverlay');
    const container = document.getElementById('comicCanvasContainer');
    const rect = container.getBoundingClientRect();

    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;

    const bubble = this.comicData.bubbles.find(b => b.id === bubbleId);
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
    const bubble = this.comicData.bubbles.find(b => b.id === this.dragTarget);
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
    if (this.comicData.utterances.length >= this.MAX_UTTERANCES) {
      showToast(`発話は最大${this.MAX_UTTERANCES}つまでです`, 'warning');
      return;
    }

    const newId = `ut_${Date.now()}`;
    this.comicData.utterances.push({
      id: newId,
      speaker_type: 'narration',
      speaker_id: null,
      text: ''
    });

    this.renderUtterances();
  },

  /**
   * 発話を更新
   */
  updateUtterance(utteranceId, text) {
    const utterance = this.comicData.utterances.find(u => u.id === utteranceId);
    if (utterance) {
      utterance.text = text;
      this.renderBubbles(); // 吹き出しのテキストを更新
    }
  },

  /**
   * 吹き出しを追加
   */
  addBubble() {
    if (this.comicData.bubbles.length >= this.MAX_BUBBLES) {
      showToast(`吹き出しは最大${this.MAX_BUBBLES}つまでです`, 'warning');
      return;
    }

    // 紐付ける発話を選択（最初の発話をデフォルト）
    const firstUtterance = this.comicData.utterances[0];
    if (!firstUtterance) {
      showToast('発話を先に追加してください', 'warning');
      return;
    }

    const newId = `b_${Date.now()}`;
    this.comicData.bubbles.push({
      id: newId,
      utterance_id: firstUtterance.id,
      type: 'speech',
      position: { x: 0.3 + Math.random() * 0.2, y: 0.2 + Math.random() * 0.2 }
    });

    this.renderBubbles();
  },

  /**
   * 吹き出しを削除
   */
  removeBubble(bubbleId) {
    this.comicData.bubbles = this.comicData.bubbles.filter(b => b.id !== bubbleId);
    this.renderBubbles();
  },

  /**
   * 保存
   */
  async save() {
    try {
      console.log('[ComicEditor] Saving comic_data:', this.comicData);

      const res = await axios.put(`/api/scenes/${this.currentSceneId}`, {
        comic_data: this.comicData
      });

      console.log('[ComicEditor] Save response:', res.data);
      showToast('漫画データを保存しました', 'success');
      this.close();

    } catch (err) {
      console.error('[ComicEditor] Save failed:', err);
      showToast('保存に失敗しました', 'error');
    }
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
    this.comicData = null;
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

console.log('[ComicEditor] Loaded successfully');
