// public/static/world-character-modal.js
// Responsibility: Modal DOM + validation only (Phase X-2 UI-2)
// Design pattern: Same as audio-ui.js (DOM manipulation + validation)
// 
// Phase F-2: UI改善 - 外見設定と参照画像の重要性を明確化
// - Aliases欄の誤用防止（プロフィール情報を入れないよう案内）
// - appearance_description未設定時の警告
// - 参照画像未設定時の警告

(function () {
  'use strict';

  /**
   * XSS-safe HTML escaping
   * @param {string} s - Unsafe string
   * @returns {string} Escaped string safe for innerHTML
   */
  function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  /**
   * Show toast notification (fallback to alert)
   * @param {string} msg - Message to display
   * @param {string} type - 'success', 'error', 'warning', 'info'
   */
  function toast(msg, type = 'info') {
    if (typeof window.showToast === 'function') {
      return window.showToast(msg, type);
    }
    alert(msg);
  }

  /**
   * Parse aliases from newline-separated text
   * Filter out 2-char or shorter aliases (Phase X-2 requirement)
   * @param {string} text - Newline-separated aliases
   * @returns {{valid: string[], invalid: string[]}}
   */
  function parseAliases(text) {
    const raw = (text || '')
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean);

    const valid = raw.filter(a => a.length >= 3);
    const invalid = raw.filter(a => a.length > 0 && a.length < 3);
    return { valid, invalid };
  }

  /**
   * Validate character key format (alphanumeric + underscore only)
   * @param {string} key - Character key
   * @returns {boolean}
   */
  function isValidKey(key) {
    return /^[a-zA-Z0-9_]+$/.test(key);
  }

  /**
   * Ensure modal DOM exists (idempotent)
   */
  function ensureDom() {
    if (document.getElementById('wc-character-modal')) return;

    const modal = document.createElement('div');
    modal.id = 'wc-character-modal';
    modal.className = 'fixed inset-0 hidden items-center justify-center z-50';
    modal.innerHTML = `
      <div class="absolute inset-0 bg-black/40" id="wc-modal-backdrop"></div>
      <div class="relative bg-white rounded-xl shadow-xl w-[min(720px,94vw)] max-h-[90vh] flex flex-col">
        <div class="flex items-center justify-between p-6 pb-4 border-b border-gray-200">
          <h3 id="wc-modal-title" class="text-lg font-bold">キャラクター追加</h3>
          <button id="wc-modal-close" class="px-3 py-2 rounded hover:bg-gray-100 transition-colors">
            <i class="fas fa-times"></i>
          </button>
        </div>

        <div class="space-y-4 px-6 py-4 overflow-y-auto flex-1">
          <!-- Character Key -->
          <div>
            <label class="block text-sm font-semibold text-gray-700 mb-1">
              Character Key <span class="text-red-500">*</span>
            </label>
            <input id="wc-key" type="text" 
              class="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500" 
              placeholder="例: protagonist_1" />
            <p class="text-xs text-gray-500 mt-1">英数字+アンダースコアのみ（重複不可）</p>
          </div>

          <!-- Character Name -->
          <div>
            <label class="block text-sm font-semibold text-gray-700 mb-1">
              Character Name <span class="text-red-500">*</span>
            </label>
            <input id="wc-name" type="text" 
              class="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500" 
              placeholder="例: 太郎" />
            <p id="wc-danger-warning" class="text-xs text-orange-600 mt-1 hidden">
              <i class="fas fa-exclamation-triangle mr-1"></i>
              ⚠️ 一般名詞の可能性が高く、自動割当で優先度が下がります
            </p>
          </div>

          <!-- Phase F-2: 外見・ビジュアル設定（重要度を上げる） -->
          <div class="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
            <label class="block text-sm font-bold text-gray-800 mb-1">
              <i class="fas fa-user-circle mr-1 text-yellow-600"></i>
              外見・ビジュアル設定（強く推奨）
              <span class="text-yellow-600 text-xs ml-2">← 画像生成に直接影響</span>
            </label>
            <textarea id="wc-appearance" 
              class="w-full border border-yellow-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-yellow-500 bg-white" 
              rows="3" 
              placeholder="例: 32歳の日本人女性、黒髪ショートボブ、派手すぎないオフィスカジュアル、疲れた表情"></textarea>
            <p class="text-xs text-gray-600 mt-1">
              <i class="fas fa-lightbulb mr-1 text-yellow-500"></i>
              <strong>画像生成で使用される外見情報</strong>です。年齢・髪型・服装・表情などを具体的に記述してください。
            </p>
            <p id="wc-appearance-warning" class="text-xs text-orange-600 mt-1">
              <i class="fas fa-exclamation-triangle mr-1"></i>
              未設定の場合「日本人」がデフォルトで適用されますが、一貫性が低下する可能性があります
            </p>
          </div>

          <!-- Phase F-2: 参照画像設定（重要度を上げる） -->
          <div class="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <label class="block text-sm font-bold text-gray-800 mb-2">
              <i class="fas fa-image mr-1 text-blue-600"></i>
              参照画像設定（強く推奨）
              <span class="text-blue-600 text-xs ml-2">← 一貫性に大きく影響</span>
            </label>
            <p class="text-xs text-gray-600 mb-3">
              <i class="fas fa-lightbulb mr-1 text-blue-500"></i>
              画像生成AIがこの画像を参考にキャラクターを描画します。<strong>設定すると外見の一貫性が大幅に向上</strong>します。
            </p>
            <p id="wc-refimg-warning" class="text-xs text-orange-600 mb-3">
              <i class="fas fa-exclamation-triangle mr-1"></i>
              未設定の場合、シーンごとに外見が変わる可能性があります（外国人風になることも）
            </p>
            
            <!-- Tab Buttons -->
            <div class="flex gap-2 mb-3 border-b border-gray-200">
              <button id="wc-ref-tab-prompt" class="px-4 py-2 text-sm font-semibold border-b-2 border-blue-600 text-blue-600">
                プロンプト生成
              </button>
              <button id="wc-ref-tab-upload" class="px-4 py-2 text-sm font-semibold border-b-2 border-transparent text-gray-600 hover:text-gray-800">
                画像アップロード
              </button>
            </div>

            <!-- Tab Content: Prompt Generation -->
            <div id="wc-ref-content-prompt">
              <textarea id="wc-appearance" 
                class="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500 mb-2" 
                rows="3" 
                placeholder="例: 黒髪ロングの女性、和服、日本庭園"></textarea>
              <button id="wc-ref-generate-btn" class="px-4 py-2 rounded bg-purple-600 text-white hover:bg-purple-700 transition-colors">
                <i class="fas fa-wand-magic-sparkles mr-1"></i> 画像を生成
              </button>
              <div id="wc-ref-generated-container" class="hidden mt-3">
                <div class="w-64 h-64 bg-gray-100 rounded-lg overflow-hidden border border-gray-300">
                  <img id="wc-ref-generated-preview" src="" alt="Generated" class="w-full h-full object-contain" />
                </div>
                <div class="flex gap-2 mt-2">
                  <button id="wc-ref-regenerate-btn" class="px-3 py-1 text-sm rounded bg-gray-200 hover:bg-gray-300">
                    <i class="fas fa-rotate mr-1"></i> 再生成
                  </button>
                </div>
                <p class="text-xs text-gray-500 mt-2">
                  ✅ プレビュー確認後、下の「保存」ボタンで確定します
                </p>
              </div>
            </div>

            <!-- Tab Content: Upload -->
            <div id="wc-ref-content-upload" class="hidden">
              <div id="wc-ref-preview-container" class="hidden mb-3">
                <div class="w-64 h-64 bg-gray-100 rounded-lg overflow-hidden border border-gray-300">
                  <img id="wc-ref-preview" src="" alt="Reference" class="w-full h-full object-contain" />
                </div>
                <button id="wc-ref-delete" class="mt-2 px-3 py-1 text-sm rounded bg-red-100 text-red-700 hover:bg-red-200 transition-colors">
                  <i class="fas fa-trash mr-1"></i> 削除
                </button>
              </div>
              <div id="wc-ref-upload-container">
                <input type="file" id="wc-ref-file" accept="image/png,image/jpeg,image/webp" class="hidden" />
                <button id="wc-ref-upload-btn" class="px-4 py-2 rounded bg-blue-600 text-white hover:bg-blue-700 transition-colors">
                  <i class="fas fa-upload mr-1"></i> ファイルを選択
                </button>
                <p class="text-xs text-gray-500 mt-1">PNG/JPEG/WEBP、最大5MB</p>
              </div>
            </div>
          </div>
          <!-- 参照画像設定の閉じdiv -->
          </div>

          <!-- Phase F-2: Aliases（重要度を下げて下に移動） -->
          <div class="border border-gray-200 rounded-lg p-4">
            <label class="block text-sm font-semibold text-gray-700 mb-1">
              <i class="fas fa-tags mr-1 text-gray-500"></i>
              別名・呼び名（任意・改行区切り）
            </label>
            <textarea id="wc-aliases" 
              class="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500" 
              rows="3" 
              placeholder="例:&#10;たろう&#10;タロウ&#10;主人公"></textarea>
            <p class="text-xs text-gray-500 mt-1">
              <i class="fas fa-info-circle mr-1"></i>
              台本中でこのキャラクターを指す<strong>別の呼び名</strong>を入力。自動割当で使用されます。
            </p>
            <p class="text-xs text-gray-500 mt-1">3文字以上の別名のみ有効（2文字以下は自動除外）</p>
            <p id="wc-alias-warning" class="text-xs text-orange-600 mt-1 hidden"></p>
            <div class="mt-2 p-2 bg-amber-50 border border-amber-200 rounded text-xs text-amber-700">
              <i class="fas fa-exclamation-circle mr-1"></i>
              <strong>注意:</strong> ここには「呼び名」のみ入力してください。<br>
              年齢・職業・性格などのプロフィール情報は上の「外見・ビジュアル設定」に入力してください。
            </div>
          </div>

          <!-- Voice Preset -->
          <div>
            <label class="block text-sm font-semibold text-gray-700 mb-1">
              Voice Preset（任意）
            </label>
            <div class="flex gap-2">
              <select id="wc-voice" 
                class="flex-1 border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="">-- None --</option>
              </select>
              <button 
                type="button"
                id="wc-voice-preview-btn"
                onclick="window.WorldCharacterModal.previewVoice()"
                class="px-3 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors"
                title="選択した音声をプレビュー"
              >
                <i class="fas fa-play"></i>
              </button>
            </div>
            <p class="text-xs text-gray-500 mt-1">Fish Audio / Google TTS のプリセットから選択（▶で試聴）</p>
          </div>

          <!-- Fish Audio Character ID (Custom) -->
          <!-- F-6: Fish Audio警告 - 読み間違いリスク -->
          <div class="p-3 bg-amber-50 border border-amber-200 rounded-lg">
            <div class="flex items-start gap-2 mb-2">
              <i class="fas fa-exclamation-triangle text-amber-600 mt-1"></i>
              <div>
                <span class="text-sm font-bold text-amber-800">Fish Audio の使用について</span>
                <p class="text-xs text-amber-700 mt-1">
                  Fish Audio は読み間違いが多いため、本番運用では<strong>Google TTS（Voice Presetで選択）</strong>を推奨します。
                  Fish Audio は特定のキャラクターボイスが必要な場合のみ使用してください。
                </p>
              </div>
            </div>
            <label class="block text-sm font-semibold text-gray-700 mb-1">
              Fish Audio Character ID（任意・非推奨）
            </label>
            <input id="wc-fish-id" type="text" 
              class="w-full border border-amber-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-amber-500 bg-amber-25" 
              placeholder="例: 71bf4cb71cd44df6aa603d51db8f92ff" />
            <p class="text-xs text-gray-500 mt-1">
              <a href="https://fish.audio/models" target="_blank" class="text-blue-600 hover:underline">キャラを探す</a>
              <span class="text-amber-600">（※ログインが必要です）</span>
            </p>
            <p class="text-xs text-amber-600 mt-1">
              <i class="fas fa-info-circle mr-1"></i>
              入力すると Voice Preset より優先されます（読み間違いリスクあり）
            </p>
          </div>

        </div>
        
        <!-- Action Buttons (Fixed at bottom) -->
        <div class="flex gap-3 justify-end p-6 pt-4 border-t border-gray-200 bg-gray-50">
          <button id="wc-cancel" 
            class="px-4 py-2 rounded-lg bg-gray-200 hover:bg-gray-300 transition-colors font-semibold">
            キャンセル
          </button>
          <button id="wc-save" 
            class="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors font-semibold">
            保存
          </button>
        </div>
      </div>
    `;
    
    document.body.appendChild(modal);

    // Bind close events
    document.getElementById('wc-modal-close').addEventListener('click', () => close());
    document.getElementById('wc-cancel').addEventListener('click', () => close());
    document.getElementById('wc-modal-backdrop').addEventListener('click', () => close());
  }

  // Modal state
  let state = {
    mode: 'create', // 'create' | 'edit'
    originalKey: null,
    dangerousWordsSet: new Set(),
    referenceImageR2Url: null, // Track current reference image URL
    pendingImage: null, // { file: File } | null - pending image to save
    pendingPreviewUrl: null, // objectURL for preview (needs cleanup)
  };

  /**
   * Load dangerous words list (once per session)
   */
  async function loadDangerousWordsOnce() {
    if (state.dangerousWordsSet.size > 0) return;
    
    try {
      const data = await window.WorldCharacterClient.fetchDangerousWords();
      const ja = (data?.dangerousWords?.ja || []).map(s => String(s).toLowerCase());
      const en = (data?.dangerousWords?.en || []).map(s => String(s).toLowerCase());
      state.dangerousWordsSet = new Set([...ja, ...en]);
      console.log(`[WorldCharacterModal] Loaded ${state.dangerousWordsSet.size} dangerous words`);
    } catch (e) {
      // TODO: 要確認 - 取得できない場合の扱い（現状は警告なしで進む）
      console.warn('[WorldCharacterModal] Failed to load dangerous words:', e);
    }
  }

  /**
   * Load voice presets into select dropdown
   */
  async function loadVoicePresetsIntoSelect() {
    const sel = document.getElementById('wc-voice');
    if (!sel) return;

    try {
      const data = await window.WorldCharacterClient.fetchVoicePresets();
      const presets = data.voice_presets || [];

      const opts = ['<option value="">-- None --</option>'];
      for (const p of presets) {
        const id = escapeHtml(p.id);
        const name = escapeHtml(p.name);
        opts.push(`<option value="${id}">${name}</option>`);
      }
      sel.innerHTML = opts.join('');
      console.log(`[WorldCharacterModal] Loaded ${presets.length} voice presets`);
    } catch (e) {
      // TODO: 要確認 - voice-presets.json が無い場合の運用
      console.error('[WorldCharacterModal] Failed to load voice presets:', e);
      sel.innerHTML = '<option value="">(プリセット取得失敗)</option>';
    }
  }

  /**
   * Open modal for character creation or editing
   * @param {object|null} character - Character data for editing, null for creation
   */
  function open(character = null) {
    try {
      ensureDom();

      state.mode = character ? 'edit' : 'create';
      state.originalKey = character?.character_key || null;
      
      // Clear pending image state
      state.pendingImage = null;
      if (state.pendingPreviewUrl) {
        URL.revokeObjectURL(state.pendingPreviewUrl);
        state.pendingPreviewUrl = null;
      }

      document.getElementById('wc-modal-title').textContent = 
        character ? 'キャラクター編集' : 'キャラクター追加';
    } catch (err) {
      console.error('[WorldCharacterModal] open() initialization failed:', err);
      throw err;
    }

    const keyEl = document.getElementById('wc-key');
    const nameEl = document.getElementById('wc-name');
    const aliasesEl = document.getElementById('wc-aliases');
    const appearanceEl = document.getElementById('wc-appearance');
    const voiceEl = document.getElementById('wc-voice');
    const fishIdEl = document.getElementById('wc-fish-id');

    // Populate form fields
    keyEl.value = character?.character_key || '';
    nameEl.value = character?.character_name || '';
    appearanceEl.value = character?.appearance_description || '';
    
    // Voice preset handling: 'fish:ID' format -> extract to Fish ID field
    const voicePresetId = character?.voice_preset_id || '';
    if (voicePresetId.startsWith('fish:')) {
      fishIdEl.value = voicePresetId.substring(5); // Extract ID after 'fish:'
      voiceEl.value = ''; // Clear preset selection
    } else {
      voiceEl.value = voicePresetId;
      fishIdEl.value = ''; // Clear Fish ID
    }

    // Parse aliases_json → textarea (newline-separated)
    let aliases = [];
    try {
      aliases = character?.aliases_json ? JSON.parse(character.aliases_json) : [];
      if (!Array.isArray(aliases)) aliases = [];
    } catch (_) {
      console.warn('[WorldCharacterModal] Failed to parse aliases_json:', character?.aliases_json);
      aliases = [];
    }
    aliasesEl.value = aliases.join('\n');

    // Edit mode: disable key field (prevent accidental key change)
    keyEl.disabled = !!character;
    if (character) {
      keyEl.classList.add('bg-gray-100', 'cursor-not-allowed');
    } else {
      keyEl.classList.remove('bg-gray-100', 'cursor-not-allowed');
    }

    // Phase X-4: Setup reference image UI
    // CRITICAL: Only enable for EXISTING characters (edit mode)
    // New characters MUST save first before accessing image features
    try {
      if (character) {
        // Edit mode: Enable full image UI
        enableReferenceImageUI(character);
      } else {
        // Create mode: Disable image UI entirely
        disableReferenceImageUI();
      }
    } catch (err) {
      console.error('[WorldCharacterModal] Image UI setup failed:', err);
      // Continue anyway - image features are optional
    }

    // Reset warnings
    document.getElementById('wc-alias-warning').classList.add('hidden');
    document.getElementById('wc-danger-warning').classList.add('hidden');

    // Bind save button
    const saveBtn = document.getElementById('wc-save');
    saveBtn.onclick = async () => {
      const payload = collectAndValidate();
      if (!payload) return;
      
      // Call external onSave handler (set by world-character-ui.js)
      if (window.WorldCharacterModal.onSave) {
        window.WorldCharacterModal.onSave(payload, state);
      }
    };

    // Show modal
    const modal = document.getElementById('wc-character-modal');
    if (!modal) {
      console.error('[WorldCharacterModal] Modal element not found');
      throw new Error('Modal element not found');
    }
    
    modal.classList.remove('hidden');
    modal.classList.add('flex');

    // Load helpers
    loadDangerousWordsOnce().then(() => {
      // Check if character name is a dangerous word
      const n = (nameEl.value || '').trim().toLowerCase();
      if (n && state.dangerousWordsSet.has(n)) {
        document.getElementById('wc-danger-warning').classList.remove('hidden');
      }
    });
    loadVoicePresetsIntoSelect();

    // Real-time warnings
    nameEl.onblur = () => {
      const n = (nameEl.value || '').trim().toLowerCase();
      const w = document.getElementById('wc-danger-warning');
      if (n && state.dangerousWordsSet.has(n)) {
        w.classList.remove('hidden');
      } else {
        w.classList.add('hidden');
      }
    };

    aliasesEl.onblur = () => {
      const { invalid } = parseAliases(aliasesEl.value);
      const w = document.getElementById('wc-alias-warning');
      if (invalid.length > 0) {
        w.textContent = `⚠️ 2文字以下の別名は除外されます: ${invalid.join(', ')}`;
        w.classList.remove('hidden');
      } else {
        w.classList.add('hidden');
      }
    };

    console.log(`[WorldCharacterModal] Opened in ${state.mode} mode`);
  }

  /**
   * Close modal
   */
  function close() {
    const modal = document.getElementById('wc-character-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    
    // Reload characters list to reflect latest changes (including uploaded images)
    if (window.WorldCharacterUI && window.WorldCharacterUI.loadCharactersList) {
      window.WorldCharacterUI.loadCharactersList();
    }
    
    console.log('[WorldCharacterModal] Closed and reloaded characters list');
  }

  /**
   * Phase X-4: Bind reference image upload/delete events
   */
  function bindReferenceImageEvents() {
    const fileInput = document.getElementById('wc-ref-file');
    const uploadBtn = document.getElementById('wc-ref-upload-btn');
    const deleteBtn = document.getElementById('wc-ref-delete');

    // Guard: Check if elements exist
    if (!fileInput || !uploadBtn || !deleteBtn) {
      console.warn('[WorldCharacterModal] Reference image elements not found, skipping bind');
      return;
    }

    // Remove existing listeners
    const newFileInput = fileInput.cloneNode(true);
    fileInput.parentNode.replaceChild(newFileInput, fileInput);
    const newUploadBtn = uploadBtn.cloneNode(true);
    uploadBtn.parentNode.replaceChild(newUploadBtn, uploadBtn);
    const newDeleteBtn = deleteBtn.cloneNode(true);
    deleteBtn.parentNode.replaceChild(newDeleteBtn, deleteBtn);

    // Upload button click → trigger file input
    newUploadBtn.addEventListener('click', () => {
      newFileInput.click();
    });

    // File selected → set as pending (save on main Save button)
    newFileInput.addEventListener('change', async () => {
      const file = newFileInput.files?.[0];
      if (!file) return;

      // Validation
      const validTypes = ['image/png', 'image/jpeg', 'image/webp'];
      if (!validTypes.includes(file.type)) {
        toast('PNG、JPEG、WEBP のみ対応しています', 'warning');
        return;
      }

      const maxSize = 5 * 1024 * 1024;
      if (file.size > maxSize) {
        toast('ファイルサイズが5MBを超えています', 'warning');
        return;
      }

      // Create objectURL for preview
      if (state.pendingPreviewUrl) {
        URL.revokeObjectURL(state.pendingPreviewUrl);
      }
      state.pendingPreviewUrl = URL.createObjectURL(file);

      // Update preview
      const refPreview = document.getElementById('wc-ref-preview');
      const refPreviewContainer = document.getElementById('wc-ref-preview-container');
      const refUploadContainer = document.getElementById('wc-ref-upload-container');
      
      if (refPreview) refPreview.src = state.pendingPreviewUrl;
      if (refPreviewContainer) refPreviewContainer.classList.remove('hidden');
      if (refUploadContainer) refUploadContainer.classList.add('hidden');

      // Store in pending state
      state.pendingImage = { file };

      toast('プレビュー設定OK。保存するとキャラ画像として確定します', 'success');

      // Reset input
      newFileInput.value = '';
    });

    // Delete button click
    newDeleteBtn.addEventListener('click', async () => {
      const projectId = window.PROJECT_ID;
      const characterKey = state.originalKey;
      if (!projectId || !characterKey) {
        toast('削除できません', 'error');
        return;
      }

      if (!confirm('参照画像を削除しますか？')) return;

      try {
        toast('削除中...', 'info');
        await window.WorldCharacterClient.deleteCharacterReferenceImage(projectId, characterKey);

        // Update UI
        const refPreviewContainer = document.getElementById('wc-ref-preview-container');
        const refUploadContainer = document.getElementById('wc-ref-upload-container');
        
        refPreviewContainer.classList.add('hidden');
        refUploadContainer.classList.remove('hidden');

        toast('削除完了', 'success');
        console.log('[WorldCharacterModal] Reference image deleted');
      } catch (err) {
        console.error('[WorldCharacterModal] Delete failed:', err);
        toast(`削除失敗: ${err.message}`, 'error');
      }
    });
  }

  /**
   * Bind tab switching for reference image setting
   */
  function bindReferenceTabSwitching() {
    const promptTab = document.getElementById('wc-ref-tab-prompt');
    const uploadTab = document.getElementById('wc-ref-tab-upload');
    const promptContent = document.getElementById('wc-ref-content-prompt');
    const uploadContent = document.getElementById('wc-ref-content-upload');

    if (!promptTab || !uploadTab || !promptContent || !uploadContent) return;

    promptTab.addEventListener('click', () => {
      // Switch to prompt tab
      promptTab.classList.add('border-blue-600', 'text-blue-600');
      promptTab.classList.remove('border-transparent', 'text-gray-600');
      uploadTab.classList.remove('border-blue-600', 'text-blue-600');
      uploadTab.classList.add('border-transparent', 'text-gray-600');
      
      promptContent.classList.remove('hidden');
      uploadContent.classList.add('hidden');
    });

    uploadTab.addEventListener('click', () => {
      // Switch to upload tab
      uploadTab.classList.add('border-blue-600', 'text-blue-600');
      uploadTab.classList.remove('border-transparent', 'text-gray-600');
      promptTab.classList.remove('border-blue-600', 'text-blue-600');
      promptTab.classList.add('border-transparent', 'text-gray-600');
      
      uploadContent.classList.remove('hidden');
      promptContent.classList.add('hidden');
    });
  }

  /**
   * Bind image generation from prompt
   */
  function bindImageGeneration() {
    const generateBtn = document.getElementById('wc-ref-generate-btn');
    const regenerateBtn = document.getElementById('wc-ref-regenerate-btn');
    const generatedContainer = document.getElementById('wc-ref-generated-container');
    const generatedPreview = document.getElementById('wc-ref-generated-preview');
    const appearanceEl = document.getElementById('wc-appearance');

    // Guard: Check if elements exist
    if (!generateBtn || !regenerateBtn || !generatedContainer || !generatedPreview || !appearanceEl) {
      console.warn('[WorldCharacterModal] Image generation elements not found, skipping bind');
      return;
    }

    const generateImage = async () => {
      const prompt = appearanceEl.value.trim();
      if (!prompt) {
        toast('プロンプトを入力してください', 'warning');
        return;
      }

      const projectId = window.PROJECT_ID;
      if (!projectId) {
        toast('プロジェクトIDが取得できません', 'error');
        return;
      }

      try {
        toast('画像生成中...（30秒ほどかかります）', 'info');
        generateBtn.disabled = true;
        generateBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i> 生成中...';
        regenerateBtn.disabled = true;

        // Generate preview image (returns Blob, no R2 save)
        const blob = await window.WorldCharacterClient.generateCharacterPreviewImage(projectId, prompt);
        
        // Create objectURL for preview
        if (state.pendingPreviewUrl) {
          URL.revokeObjectURL(state.pendingPreviewUrl);
        }
        state.pendingPreviewUrl = URL.createObjectURL(blob);
        
        // Display preview
        generatedPreview.src = state.pendingPreviewUrl;
        generatedContainer.classList.remove('hidden');
        
        // Store in pending state
        state.pendingImage = {
          file: new File([blob], 'generated.png', { type: 'image/png' })
        };
        
        toast('プレビュー生成完了。保存するとキャラ画像として確定します', 'success');
      } catch (err) {
        console.error('[WorldCharacterModal] Image generation failed:', err);
        toast(`生成失敗: ${err.message}`, 'error');
      } finally {
        generateBtn.disabled = false;
        generateBtn.innerHTML = '<i class="fas fa-wand-magic-sparkles mr-1"></i> 画像を生成';
        regenerateBtn.disabled = false;
      }
    };

    generateBtn.addEventListener('click', generateImage);
    regenerateBtn.addEventListener('click', generateImage);

    // Note: "Accept" button is now hidden/removed from UI
    // Images are saved only when the main "Save" button is clicked
  }

  /**
   * Collect form data and validate
   * Phase F-2: Added warnings for missing appearance/reference image
   * @returns {object|null} Validated payload or null if validation fails
   */
  function collectAndValidate() {
    const key = document.getElementById('wc-key').value.trim();
    const name = document.getElementById('wc-name').value.trim();
    const aliasesText = document.getElementById('wc-aliases').value;
    const appearance = document.getElementById('wc-appearance').value.trim();
    const voicePreset = document.getElementById('wc-voice').value || null;
    const fishId = document.getElementById('wc-fish-id').value.trim();
    
    // Priority: Fish Audio ID > Voice Preset
    const voice = fishId ? `fish:${fishId}` : voicePreset;

    // Required fields validation
    if (!key || !name) {
      toast('Character Key と Name は必須です', 'warning');
      return null;
    }
    
    if (!isValidKey(key)) {
      toast('Character Key は英数字+アンダースコアのみです', 'warning');
      return null;
    }
    
    if (name.length < 2) {
      toast('Character Name は2文字以上です', 'warning');
      return null;
    }
    
    // 音声必須バリデーション（キャラクターには必ず音声を設定）
    if (!voice) {
      toast('音声設定は必須です。Voice Preset または Fish Audio ID を設定してください。', 'warning');
      return null;
    }

    // Aliases validation
    const { valid, invalid } = parseAliases(aliasesText);
    if (invalid.length > 0) {
      toast(`2文字以下の別名は除外されます: ${invalid.join(', ')}`, 'info');
    }

    // Phase F-2: Warn about missing appearance/reference image
    const warnings = [];
    
    if (!appearance) {
      warnings.push('・外見設定が空です（「日本人」がデフォルト適用されますが、一貫性が低下する可能性があります）');
    }
    
    // Check for reference image (existing or pending)
    const hasExistingRef = state.referenceImageR2Url;
    const hasPendingRef = state.pendingImage?.file;
    if (!hasExistingRef && !hasPendingRef && state.mode === 'edit') {
      warnings.push('・参照画像が未設定です（シーンごとに外見が変わる可能性があります）');
    }
    
    // Show confirmation if warnings exist
    if (warnings.length > 0) {
      const proceed = confirm(
        '以下の設定が未完了です:\n\n' +
        warnings.join('\n') +
        '\n\n画像生成の品質に影響する可能性があります。\nこのまま保存しますか？'
      );
      if (!proceed) {
        return null;
      }
    }

    const payload = {
      character_key: key,
      character_name: name,
      aliases: valid.length > 0 ? valid : null,
      appearance_description: appearance || null,
      voice_preset_id: voice || null,
    };

    console.log('[WorldCharacterModal] Validated payload:', payload);
    return payload;
  }

  /**
   * Open scene character assignment modal (UI-4)
   * @param {number} sceneId - Scene ID to assign characters
   */
  async function openAssign(sceneId) {
    console.log('[WorldCharacterModal] openAssign called with sceneId:', sceneId, 'type:', typeof sceneId);
    
    if (!sceneId) {
      toast('Scene ID が不正です', 'error');
      return;
    }

    ensureAssignDom();

    const projectId = window.PROJECT_ID;
    console.log('[WorldCharacterModal] projectId:', projectId);
    
    if (!projectId) {
      toast('プロジェクトIDが取得できません', 'error');
      return;
    }

    try {
      console.log('[WorldCharacterModal] Fetching characters for project', projectId, 'and scene', sceneId);
      
      // Fetch character candidates and current assignments
      const [charactersData, assignmentsData] = await Promise.all([
        window.WorldCharacterClient.fetchCharacters(projectId),
        window.WorldCharacterClient.fetchSceneCharacters(sceneId),
      ]);
      
      console.log('[WorldCharacterModal] charactersData:', charactersData);
      console.log('[WorldCharacterModal] assignmentsData:', assignmentsData);

      const characters = charactersData.characters || [];
      const assignments = assignmentsData.scene_characters || [];

      // Show modal
      const modal = document.getElementById('wc-assign-modal');
      document.getElementById('wc-assign-title').textContent = `シーン #${sceneId} のキャラ割当`;
      modal.classList.remove('hidden');
      modal.classList.add('flex');

      // Populate slots (max 3)
      populateAssignSlots(characters, assignments);

      // Bind save button with double-click prevention
      const saveBtn = document.getElementById('wc-assign-save');
      let isSaving = false; // Prevent double-click
      
      saveBtn.onclick = async () => {
        // Prevent double-click
        if (isSaving) {
          console.log('[WorldCharacterModal] Save already in progress, ignoring click');
          return;
        }
        
        const payload = collectAssignments();
        if (payload === null) return;

        try {
          isSaving = true;
          saveBtn.disabled = true;
          saveBtn.textContent = '保存中...';
          
          await window.WorldCharacterClient.batchUpdateSceneCharacters(sceneId, payload);
          toast('割当を保存しました', 'success');
          closeAssign();

          // ✅ Phase F-6: 保存後にBuilder全体を再レンダリング（新レイアウト対応）
          // initBuilderTab() が存在すればそれを呼ぶ（最も確実）
          if (typeof window.initBuilderTab === 'function') {
            console.log('[WorldCharacterModal] Refreshing Builder tab via initBuilderTab()');
            await window.initBuilderTab();
          } else {
            // Fallback: 古いタグ更新 + loadScenes
            await refreshSceneCardTags(sceneId);
            if (typeof window.loadScenes === 'function') {
              console.log('[WorldCharacterModal] Refreshing Scene Split tab via loadScenes()');
              await window.loadScenes();
            }
          }
        } catch (e) {
          console.error('[WorldCharacterModal] Failed to save assignments:', e);
          toast(`保存に失敗しました: ${e.message}`, 'error');
        } finally {
          isSaving = false;
          saveBtn.disabled = false;
          saveBtn.textContent = '保存';
        }
      };

      console.log(`[WorldCharacterModal] Opened assign modal for scene ${sceneId}`);
    } catch (e) {
      console.error('[WorldCharacterModal] Failed to load assignment data:', e);
      if (e.status === 404) {
        toast('シーンが見つかりません。ページを再読み込みしてください。', 'error');
      } else if (e.status === 401) {
        toast('認証エラー。再ログインしてください。', 'error');
      } else {
        toast(`データの読み込みに失敗しました: ${e.message}`, 'error');
      }
    }
  }

  /**
   * Ensure assignment modal DOM exists (idempotent)
   * Phase F-6: Separate image and voice character selection
   */
  function ensureAssignDom() {
    if (document.getElementById('wc-assign-modal')) return;

    const modal = document.createElement('div');
    modal.id = 'wc-assign-modal';
    modal.className = 'fixed inset-0 hidden items-center justify-center z-50';
    modal.innerHTML = `
      <div class="absolute inset-0 bg-black/40" id="wc-assign-backdrop"></div>
      <div class="relative bg-white rounded-xl shadow-xl w-[min(640px,94vw)] max-h-[90vh] overflow-auto p-6">
        <div class="flex items-center justify-between mb-4">
          <h3 id="wc-assign-title" class="text-lg font-bold">シーンキャラ割当</h3>
          <button id="wc-assign-close" class="px-3 py-2 rounded hover:bg-gray-100 transition-colors">
            <i class="fas fa-times"></i>
          </button>
        </div>

        <div class="space-y-6">
          <!-- Image Characters Section -->
          <div class="border border-blue-200 rounded-lg p-4 bg-blue-50/30">
            <h4 class="text-sm font-bold text-blue-800 mb-2 flex items-center">
              <i class="fas fa-image mr-2"></i>画像キャラクター（最大3人）
            </h4>
            <p class="text-xs text-blue-600 mb-3">画像生成時に登場するキャラクター。参照画像が設定されていると外見が固定されます。</p>
            
            <div id="wc-image-chars-container" class="space-y-2">
              <!-- Populated dynamically -->
            </div>
          </div>

          <!-- Voice Character Section -->
          <div class="border border-green-200 rounded-lg p-4 bg-green-50/30">
            <h4 class="text-sm font-bold text-green-800 mb-2 flex items-center">
              <i class="fas fa-microphone mr-2"></i>音声キャラクター（1人）
            </h4>
            <p class="text-xs text-green-600 mb-3">このシーンのセリフを喋るキャラクター。キャラに設定された音声が適用されます。</p>
            
            <select id="wc-voice-char" class="w-full border border-green-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500 bg-white">
              <option value="">-- ナレーター（キャラなし） --</option>
            </select>
            <p class="text-xs text-gray-500 mt-2">※キャラなしの場合は、下部の「音声生成」設定が適用されます。</p>
          </div>

          <!-- Action Buttons -->
          <div class="flex gap-3 justify-end pt-2">
            <button id="wc-assign-cancel" 
              class="px-4 py-2 rounded-lg bg-gray-200 hover:bg-gray-300 transition-colors font-semibold">
              キャンセル
            </button>
            <button id="wc-assign-save" 
              class="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors font-semibold">
              保存
            </button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

    // Bind close events
    document.getElementById('wc-assign-close').addEventListener('click', () => closeAssign());
    document.getElementById('wc-assign-cancel').addEventListener('click', () => closeAssign());
    document.getElementById('wc-assign-backdrop').addEventListener('click', () => closeAssign());
  }

  /**
   * Close assignment modal
   */
  function closeAssign() {
    const modal = document.getElementById('wc-assign-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    console.log('[WorldCharacterModal] Closed assign modal');
  }

  /**
   * Populate assignment slots with character options
   * @param {Array} characters - Available characters
   * @param {Array} assignments - Current assignments
   */
  /**
   * Phase F-6: Populate image character checkboxes and voice character dropdown
   * @param {Array} characters - Available characters in project
   * @param {Array} assignments - Current scene assignments (with is_primary field)
   */
  function populateAssignSlots(characters, assignments) {
    // All assigned characters are image characters
    // is_primary=1 indicates voice character
    const currentImageChars = assignments.map(a => a.character_key);
    const currentVoiceChar = assignments.find(a => a.is_primary === 1)?.character_key || '';

    // === Image Characters Section (Checkboxes) ===
    const imageContainer = document.getElementById('wc-image-chars-container');
    if (imageContainer) {
      if (characters.length === 0) {
        imageContainer.innerHTML = `
          <p class="text-sm text-gray-500 italic">キャラクターが登録されていません。</p>
        `;
      } else {
        imageContainer.innerHTML = characters.map(ch => {
          const key = escapeHtml(ch.character_key);
          const name = escapeHtml(ch.character_name);
          const checked = currentImageChars.includes(ch.character_key) ? 'checked' : '';
          const hasRef = ch.reference_image_r2_url ? '📷' : '';
          return `
            <label class="flex items-center gap-3 p-2 rounded-lg hover:bg-blue-100 cursor-pointer transition-colors">
              <input type="checkbox" class="wc-image-char-cb w-4 h-4 text-blue-600 rounded" 
                     value="${key}" ${checked} />
              <span class="text-sm">${hasRef} ${name}</span>
              <span class="text-xs text-gray-400">(${key})</span>
            </label>
          `;
        }).join('');

        // Bind change event for max 3 validation
        imageContainer.querySelectorAll('.wc-image-char-cb').forEach(cb => {
          cb.addEventListener('change', () => validateImageCharCount());
        });
      }
    }

    // === Voice Character Section (Dropdown) ===
    const voiceSelect = document.getElementById('wc-voice-char');
    if (voiceSelect) {
      const opts = ['<option value="">-- ナレーター（キャラなし） --</option>'];
      for (const ch of characters) {
        const key = escapeHtml(ch.character_key);
        const name = escapeHtml(ch.character_name);
        const hasVoice = ch.voice_preset_id ? '🎤' : '';
        const selected = ch.character_key === currentVoiceChar ? 'selected' : '';
        opts.push(`<option value="${key}" ${selected}>${hasVoice} ${name} (${key})</option>`);
      }
      voiceSelect.innerHTML = opts.join('');
    }
  }

  /**
   * Validate image character count (max 3)
   */
  function validateImageCharCount() {
    const checkboxes = document.querySelectorAll('.wc-image-char-cb:checked');
    if (checkboxes.length > 3) {
      toast('画像キャラクターは最大3人までです', 'warning');
      // Uncheck the last one
      const lastChecked = Array.from(checkboxes).pop();
      if (lastChecked) lastChecked.checked = false;
    }
  }

  /**
   * Phase F-6: Collect assignment data from new UI
   * @returns {object|null} Batch API payload with image_characters and voice_character
   */
  function collectAssignments() {
    // Collect image characters (checkboxes)
    const imageCheckboxes = document.querySelectorAll('.wc-image-char-cb:checked');
    const imageCharacters = Array.from(imageCheckboxes).map(cb => cb.value);

    // Validate max 3
    if (imageCharacters.length > 3) {
      toast('画像キャラクターは最大3人までです', 'warning');
      return null;
    }

    // Collect voice character (dropdown)
    const voiceSelect = document.getElementById('wc-voice-char');
    const voiceCharacter = voiceSelect?.value?.trim() || null;

    // Return new format payload
    return {
      image_characters: imageCharacters,
      voice_character: voiceCharacter
    };
  }

  // =============================
  // UI-4: Save -> Immediate Tag Refresh (No full rerender)
  // =============================

  /**
   * Local escape (avoid relying on project-editor.js global; XSS safety)
   * @param {any} text - Text to escape
   * @returns {string} Escaped HTML-safe string
   */
  function escapeHtmlLocal(text) {
    const s = String(text ?? '');
    return s.replace(/[&<>"']/g, (m) => {
      switch (m) {
        case '&': return '&amp;';
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '"': return '&quot;';
        case "'": return '&#039;';
        default: return m;
      }
    });
  }

  /**
   * Refresh character tags in the scene card, without full rerender.
   * - If card is not in DOM (pagination/filter), do nothing.
   * - Fetch latest assignments from SSOT endpoint.
   * @param {number} sceneId - Scene ID
   */
  async function refreshSceneCardTags(sceneId) {
    const card = document.getElementById(`builder-scene-${sceneId}`);
    if (!card) {
      console.log(`[WorldCharacterModal] Scene #${sceneId} card not in DOM, skipping tag refresh`);
      return;
    }

    const tagsContainer = card.querySelector('.scene-character-tags');
    if (!tagsContainer) {
      console.warn(`[WorldCharacterModal] .scene-character-tags not found for scene ${sceneId}`);
      return;
    }

    try {
      const data = await window.WorldCharacterClient.fetchSceneCharacters(sceneId);

      // ✅ SSOT fallback (環境差対策)
      // TODO: 要確認 - fetchSceneCharactersの返却キーを統一できるなら統一したい
      const assignments =
        data?.scene_characters ||
        data?.scene_characters?.results ||
        data?.characters ||
        data?.assignments ||
        [];

      // ✅ Use SSOT from WorldCharacterUI (avoid duplication)
      if (window.WorldCharacterUI && typeof window.WorldCharacterUI.renderTagsInnerHTML === 'function') {
        tagsContainer.innerHTML = window.WorldCharacterUI.renderTagsInnerHTML(sceneId, assignments);
      } else {
        // Fallback: use local implementation if WorldCharacterUI not loaded
        tagsContainer.innerHTML = generateCharacterTagsInnerHTML(sceneId, assignments);
      }
      console.log(`[WorldCharacterModal] Refreshed tags for scene #${sceneId}`);
    } catch (e) {
      console.warn(`[WorldCharacterModal] Failed to refresh tags for scene #${sceneId}:`, e);
      // Fail silently: next renderBuilderScenes will reflect it anyway
    }
  }

  /**
   * Generate character tags inner HTML (XSS-safe, wrapper-free)
   * ⚠️ DEPRECATED: This is now a fallback. Primary implementation is in WorldCharacterUI.renderTagsInnerHTML()
   * TODO: Remove this after confirming WorldCharacterUI is always loaded
   * @param {number} sceneId - Scene ID
   * @param {Array} assignments - Character assignments
   * @returns {string} Inner HTML string for character tags (no wrapper div)
   */
  function generateCharacterTagsInnerHTML(sceneId, assignments) {
    const arr = Array.isArray(assignments) ? assignments : [];
    const top = arr
      .filter((a) => a && a.character_name) // name is required for display
      .slice(0, 3);

    if (top.length === 0) {
      return `
        <span class="inline-flex items-center px-3 py-1 rounded-full bg-gray-100 text-gray-500 text-xs font-semibold">
          <i class="fas fa-user-slash mr-1"></i>
          キャラ未割当
        </span>
      `;
    }

    return top.map((ch) => {
      const name = escapeHtmlLocal(ch.character_name);
      const key = escapeHtmlLocal(ch.character_key || '');
      const star = ch.is_primary ? '★ ' : '';
      return `
        <button
          type="button"
          class="char-tag inline-flex items-center px-3 py-1 rounded-full bg-blue-50 text-blue-700 text-xs font-semibold hover:bg-blue-100 transition-colors border border-blue-200"
          data-action="open-character-assign"
          data-scene-id="${sceneId}"
          data-character-key="${key}"
          title="クリックで割当編集"
        >
          ${star}${name}
        </button>
      `;
    }).join('');
  }

  /**
   * Disable reference image UI for new characters (create mode)
   * Users must save the character first before accessing image features
   */
  function disableReferenceImageUI() {
    // Hide entire reference section
    const refSection = document.querySelector('[class*="参照画像"]')?.closest('.space-y-1');
    if (refSection) {
      refSection.style.display = 'none';
    }
    
    // Alternative: Hide tabs and show notice
    const promptTab = document.getElementById('wc-ref-tab-prompt');
    const uploadTab = document.getElementById('wc-ref-tab-upload');
    const promptContent = document.getElementById('wc-ref-content-prompt');
    const uploadContent = document.getElementById('wc-ref-content-upload');
    
    if (promptTab) promptTab.style.display = 'none';
    if (uploadTab) uploadTab.style.display = 'none';
    if (promptContent) promptContent.style.display = 'none';
    if (uploadContent) uploadContent.style.display = 'none';
    
    // Show notice: "Save character first to enable image features"
    const noticeHtml = `
      <div class="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm text-blue-700">
        <i class="fas fa-info-circle mr-2"></i>
        キャラクターを保存した後、編集から参照画像を設定できます
      </div>
    `;
    
    const refContainer = document.getElementById('wc-ref-preview-container')?.parentElement;
    if (refContainer) {
      refContainer.innerHTML = noticeHtml;
    }
  }

  /**
   * Enable reference image UI for existing characters (edit mode)
   * @param {object} character - Character data
   */
  function enableReferenceImageUI(character) {
    try {
      // Show reference section
      const refSection = document.querySelector('[class*="参照画像"]')?.closest('.space-y-1');
      if (refSection) {
        refSection.style.display = '';
      }
      
      // Show tabs
      const promptTab = document.getElementById('wc-ref-tab-prompt');
      const uploadTab = document.getElementById('wc-ref-tab-upload');
      const promptContent = document.getElementById('wc-ref-content-prompt');
      const uploadContent = document.getElementById('wc-ref-content-upload');
      
      if (promptTab) promptTab.style.display = '';
      if (uploadTab) uploadTab.style.display = '';
      if (promptContent) promptContent.style.display = '';
      if (uploadContent) uploadContent.style.display = '';
      
      // Setup reference image preview
      const refPreviewContainer = document.getElementById('wc-ref-preview-container');
      const refPreview = document.getElementById('wc-ref-preview');
      const refUploadContainer = document.getElementById('wc-ref-upload-container');
      const refSaveFirstNotice = document.getElementById('wc-ref-save-first-notice');
      
      if (refPreviewContainer && refPreview && refUploadContainer) {
        if (character?.reference_image_r2_url) {
          refPreview.src = character.reference_image_r2_url;
          refPreviewContainer.classList.remove('hidden');
          refUploadContainer.classList.add('hidden');
        } else {
          refPreviewContainer.classList.add('hidden');
          refUploadContainer.classList.remove('hidden');
          if (refSaveFirstNotice) {
            refSaveFirstNotice.classList.add('hidden');
          }
        }
      }

      // Bind all image-related events (with error handling)
      bindReferenceImageEvents();
      bindReferenceTabSwitching();
      bindImageGeneration();
    } catch (err) {
      console.error('[WorldCharacterModal] Failed to enable image UI:', err);
    }
  }

  /**
   * Preview voice using TTS API
   */
  async function previewVoice() {
    const voiceSelect = document.getElementById('wc-voice');
    const voiceId = voiceSelect?.value;
    
    if (!voiceId) {
      toast('音声プリセットを選択してください', 'warning');
      return;
    }
    
    const btn = document.getElementById('wc-voice-preview-btn');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    }
    
    try {
      // サンプルテキストで音声生成
      const sampleText = 'こんにちは、これはサンプル音声です。';
      
      const response = await fetch('/api/tts/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: sampleText,
          voice_id: voiceId
        })
      });
      
      if (!response.ok) {
        throw new Error('音声生成に失敗しました');
      }
      
      const data = await response.json();
      
      if (data.audio_url) {
        // 音声を再生
        const audio = new Audio(data.audio_url);
        audio.play();
        toast('音声を再生中...', 'success');
      } else {
        throw new Error('音声URLが取得できませんでした');
      }
    } catch (err) {
      console.error('[WorldCharacterModal] Voice preview failed:', err);
      toast('音声プレビューに失敗しました', 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-play"></i>';
      }
    }
  }

  // Expose API to global scope
  window.WorldCharacterModal = {
    open,
    close,
    ensureDom,
    openAssign,
    closeAssign,
    previewVoice,
    onSave: null, // Set by world-character-ui.js
    getPendingImageFile: () => state.pendingImage?.file || null,
    clearPendingImage: () => {
      state.pendingImage = null;
      if (state.pendingPreviewUrl) {
        URL.revokeObjectURL(state.pendingPreviewUrl);
        state.pendingPreviewUrl = null;
      }
    }
  };

  console.log('[WorldCharacterModal] Loaded');
})();
