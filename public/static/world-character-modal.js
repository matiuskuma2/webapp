// public/static/world-character-modal.js
// Responsibility: Modal DOM + validation only (Phase X-2 UI-2)
// 
// キャラクター登録の必須項目:
// 1. Character Key - 内部識別子（英数字+アンダースコア）
// 2. Character Name - 表示名（シーン内でのマッチングにも使用）
// 3. 参照画像 - AIで生成 または アップロード（必須）
// 4. 音声 - Voice Preset または Fish Audio ID（必須）
// 
// オプション項目:
// - 外見・ビジュアル設定 - 画像生成時のプロンプトに追加
// - 別名・呼び名 - 自動割り当て時のマッチングに使用

(function () {
  'use strict';

  /**
   * XSS-safe HTML escaping
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
              placeholder="例: taro_main" />
            <p class="text-xs text-gray-500 mt-1">
              システム内部で使用する識別子です。英数字とアンダースコアのみ使用可能、プロジェクト内で重複不可。
              <span class="text-blue-600">キャラクターの管理・参照に使用されます。</span>
            </p>
          </div>

          <!-- Character Name -->
          <div>
            <label class="block text-sm font-semibold text-gray-700 mb-1">
              キャラクター名 <span class="text-red-500">*</span>
            </label>
            <input id="wc-name" type="text" 
              class="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500" 
              placeholder="例: 太郎" />
            <p class="text-xs text-gray-500 mt-1">シナリオ内でこの名前が出現すると自動でキャラクター割り当てされます</p>
            <p id="wc-danger-warning" class="text-xs text-orange-600 mt-1 hidden">
              <i class="fas fa-exclamation-triangle mr-1"></i>
              一般名詞の可能性が高く、自動割当で優先度が下がります
            </p>
          </div>

          <!-- ========== 参照画像（必須）========== -->
          <div class="bg-blue-50 border-2 border-blue-400 rounded-lg p-4">
            <label class="block text-sm font-bold text-gray-800 mb-2">
              <i class="fas fa-image mr-1 text-blue-600"></i>
              参照画像 <span class="text-red-500">*必須</span>
            </label>
            <p class="text-xs text-gray-600 mb-3">
              キャラクターの外見を固定するための画像です。全シーンでこの画像を参照して生成されます。
            </p>
            
            <!-- Tab Buttons -->
            <div class="flex gap-2 mb-3 border-b border-gray-200">
              <button id="wc-ref-tab-generate" class="px-4 py-2 text-sm font-semibold border-b-2 border-blue-600 text-blue-600">
                <i class="fas fa-wand-magic-sparkles mr-1"></i>AIで生成
              </button>
              <button id="wc-ref-tab-upload" class="px-4 py-2 text-sm font-semibold border-b-2 border-transparent text-gray-600 hover:text-gray-800">
                <i class="fas fa-upload mr-1"></i>アップロード
              </button>
            </div>

            <!-- Tab Content: AI Generation -->
            <div id="wc-ref-content-generate">
              <div class="mb-3">
                <label class="block text-xs font-semibold text-gray-700 mb-1">外見プロンプト</label>
                <textarea id="wc-appearance-prompt" 
                  class="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500" 
                  rows="2" 
                  placeholder="例: 30代の日本人男性、黒髪短髪、スーツ姿"></textarea>
              </div>
              <button id="wc-ref-generate-btn" class="px-4 py-2 rounded bg-purple-600 text-white hover:bg-purple-700 transition-colors">
                <i class="fas fa-wand-magic-sparkles mr-1"></i> 画像を生成
              </button>
              <div id="wc-ref-generated-container" class="hidden mt-3">
                <div class="w-48 h-48 bg-gray-100 rounded-lg overflow-hidden border border-gray-300 flex items-center justify-center">
                  <img id="wc-ref-generated-preview" src="" alt="" class="w-full h-full object-cover" style="display: block;" />
                </div>
                <div class="flex gap-2 mt-2">
                  <button id="wc-ref-regenerate-btn" class="px-3 py-1 text-sm rounded bg-gray-200 hover:bg-gray-300">
                    <i class="fas fa-rotate mr-1"></i> 再生成
                  </button>
                </div>
              </div>
            </div>

            <!-- Tab Content: Upload -->
            <div id="wc-ref-content-upload" class="hidden">
              <div id="wc-ref-preview-container" class="hidden mb-3">
                <div class="w-48 h-48 bg-gray-100 rounded-lg overflow-hidden border border-gray-300 flex items-center justify-center">
                  <img id="wc-ref-preview" src="" alt="" class="w-full h-full object-cover" style="display: block;" />
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
            
            <!-- Current image status -->
            <div id="wc-ref-status" class="mt-3 text-sm">
              <span id="wc-ref-status-none" class="text-red-600">
                <i class="fas fa-exclamation-circle mr-1"></i>参照画像が未設定です
              </span>
              <span id="wc-ref-status-set" class="text-green-600 hidden">
                <i class="fas fa-check-circle mr-1"></i>参照画像が設定されています
              </span>
            </div>
          </div>

          <!-- ========== 音声設定（必須）========== -->
          <div class="bg-green-50 border-2 border-green-400 rounded-lg p-4">
            <label class="block text-sm font-bold text-gray-800 mb-2">
              <i class="fas fa-microphone mr-1 text-green-600"></i>
              音声設定 <span class="text-red-500">*必須</span>
            </label>
            <p class="text-xs text-gray-600 mb-3">
              このキャラクターのセリフを読み上げる音声を選択してください。
            </p>
            
            <!-- Voice Type Selection -->
            <div class="flex gap-2 mb-3">
              <button id="wc-voice-type-preset" class="flex-1 px-3 py-2 text-sm font-semibold rounded-lg border-2 border-green-500 bg-green-100 text-green-700">
                Voice Preset
              </button>
              <button id="wc-voice-type-fish" class="flex-1 px-3 py-2 text-sm font-semibold rounded-lg border-2 border-gray-300 bg-white text-gray-600 hover:border-green-500">
                Fish Audio
              </button>
            </div>

            <!-- Google TTS -->
            <div id="wc-voice-preset-section">
              <div class="flex gap-2">
                <select id="wc-voice" 
                  class="flex-1 border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500">
                  <option value="">-- 音声を選択 --</option>
                </select>
                <button 
                  type="button"
                  id="wc-voice-preview-btn"
                  class="px-3 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors"
                  title="選択した音声をプレビュー"
                >
                  <i class="fas fa-play"></i>
                </button>
              </div>
            </div>

            <!-- Fish Audio -->
            <div id="wc-voice-fish-section" class="hidden">
              <input id="wc-fish-id" type="text" 
                class="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500" 
                placeholder="Fish Audio Character ID（例: 71bf4cb71cd44df6aa603d51db8f92ff）" />
              <p class="text-xs text-gray-500 mt-1">
                <a href="https://fish.audio/models" target="_blank" class="text-blue-600 hover:underline">Fish Audio</a>
                でキャラクターを探してIDをコピー
              </p>
            </div>
            
            <!-- Voice status -->
            <div id="wc-voice-status" class="mt-3 text-sm">
              <span id="wc-voice-status-none" class="text-red-600">
                <i class="fas fa-exclamation-circle mr-1"></i>音声が未設定です
              </span>
              <span id="wc-voice-status-set" class="text-green-600 hidden">
                <i class="fas fa-check-circle mr-1"></i>音声が設定されています
              </span>
            </div>
          </div>

          <!-- ========== 画像生成用の設定 ========== -->
          <details class="border border-gray-200 rounded-lg" open>
            <summary class="px-4 py-3 cursor-pointer hover:bg-gray-50 font-semibold text-gray-700">
              <i class="fas fa-image mr-2"></i>画像生成用の設定
            </summary>
            <div class="px-4 pb-4 space-y-4">
              <!-- A Layer: Base Appearance -->
              <div class="p-3 bg-gray-50 rounded-lg border-2 border-gray-300">
                <div class="flex items-center gap-2 mb-2">
                  <span class="inline-flex items-center justify-center w-6 h-6 rounded text-white font-bold text-sm bg-gray-500">A</span>
                  <label class="text-sm font-bold text-gray-700">
                    基本の外見（キャラ登録）
                  </label>
                </div>
                <textarea id="wc-appearance" 
                  class="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-gray-400" 
                  rows="2" 
                  placeholder="例: 32歳の日本人女性、黒髪ショートボブ、オフィスカジュアル"></textarea>
                <p class="text-xs text-gray-600 mt-1">
                  <i class="fas fa-info-circle mr-1"></i>
                  このキャラの基本的な外見。全シーンで適用されます。
                </p>
                <p class="text-xs text-orange-600 mt-1">
                  <i class="fas fa-exclamation-triangle mr-1"></i>
                  見た目のみ記載（セリフ・感情・行動は入れない）
                </p>
              </div>
              
              <!-- B Layer: Story Traits -->
              <div class="p-3 bg-purple-50 rounded-lg border-2 border-purple-300">
                <div class="flex items-center gap-2 mb-2">
                  <span class="inline-flex items-center justify-center w-6 h-6 rounded text-white font-bold text-sm bg-purple-500">B</span>
                  <label class="text-sm font-bold text-purple-700">
                    物語共通の特徴
                  </label>
                </div>
                <textarea id="wc-story-traits" 
                  class="w-full border border-purple-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-purple-400" 
                  rows="2" 
                  placeholder="例: 小さな妖精、キラキラ光る羽、銀色の髪"></textarea>
                <p class="text-xs text-purple-600 mt-1">
                  <i class="fas fa-info-circle mr-1"></i>
                  この物語で一貫した特徴。Aに追加して全シーンで適用。
                </p>
                <p class="text-xs text-orange-600 mt-1">
                  <i class="fas fa-exclamation-triangle mr-1"></i>
                  見た目のみ記載（セリフ・感情・行動は入れない）
                </p>
              </div>
              
              <!-- Note about C layer -->
              <div class="p-2 bg-yellow-50 rounded border border-yellow-200">
                <p class="text-xs text-yellow-700">
                  <span class="inline-flex items-center justify-center w-5 h-5 rounded text-white font-bold text-xs bg-yellow-500 mr-1">C</span>
                  <strong>シーン別の特徴</strong>は、各シーンの編集画面で設定します。
                  <br>（例: 変身シーンで「人間の姿、羽が消えている」など）
                </p>
              </div>
            </div>
          </details>
          
          <!-- ========== その他の設定（折りたたみ）========== -->
          <details class="border border-gray-200 rounded-lg">
            <summary class="px-4 py-3 cursor-pointer hover:bg-gray-50 font-semibold text-gray-700">
              <i class="fas fa-cog mr-2"></i>その他の設定
            </summary>
            <div class="px-4 pb-4 space-y-4">

              <!-- Aliases -->
              <div>
                <label class="block text-sm font-semibold text-gray-700 mb-1">
                  別名・呼び名（任意・改行区切り）
                </label>
                <textarea id="wc-aliases" 
                  class="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500" 
                  rows="2" 
                  placeholder="例:&#10;たろう&#10;タロウ"></textarea>
                <p class="text-xs text-gray-500 mt-1">
                  <i class="fas fa-info-circle mr-1 text-blue-500"></i>
                  シナリオ内でこれらの名前が出現した場合、自動的にこのキャラクターが割り当てられます。
                </p>
                <p class="text-xs text-orange-600 mt-1">
                  <i class="fas fa-exclamation-triangle mr-1"></i>
                  注意: <strong>3文字以上</strong>の別名のみ有効です。2文字以下は自動除外されます。
                </p>
                <p id="wc-alias-warning" class="text-xs text-orange-600 mt-1 hidden"></p>
              </div>
            </div>
          </details>

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
    referenceImageR2Url: null,
    pendingImage: null,
    pendingPreviewUrl: null,
    voiceType: 'preset', // 'preset' | 'fish'
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
      const allPresets = data.voice_presets || [];
      
      // v2互換: status='coming_soon' のプリセットは除外
      const presets = allPresets.filter(p => p.status !== 'coming_soon');

      // プロバイダー別にグループ化
      const googlePresets = presets.filter(p => p.provider === 'google');
      const elevenLabsPresets = presets.filter(p => p.provider === 'elevenlabs');
      
      const opts = ['<option value="">-- 音声を選択 --</option>'];
      
      // Google TTS
      if (googlePresets.length > 0) {
        opts.push('<optgroup label="Google TTS">');
        for (const p of googlePresets) {
          const id = escapeHtml(p.id);
          const name = escapeHtml(p.name);
          opts.push(`<option value="${id}" data-provider="google">${name}</option>`);
        }
        opts.push('</optgroup>');
      }
      
      // ElevenLabs
      if (elevenLabsPresets.length > 0) {
        opts.push('<optgroup label="ElevenLabs (Premium)">');
        for (const p of elevenLabsPresets) {
          const id = escapeHtml(p.id);
          const name = escapeHtml(p.name);
          const gender = p.gender === 'female' ? '♀' : '♂';
          opts.push(`<option value="${id}" data-provider="elevenlabs">${name} ${gender}</option>`);
        }
        opts.push('</optgroup>');
      }
      
      sel.innerHTML = opts.join('');
      console.log(`[WorldCharacterModal] Loaded ${presets.length} voice presets (filtered from ${allPresets.length})`);
    } catch (e) {
      console.error('[WorldCharacterModal] Failed to load voice presets:', e);
      sel.innerHTML = '<option value="">(プリセット取得失敗)</option>';
    }
  }

  /**
   * Setup voice type toggle
   */
  function setupVoiceTypeToggle() {
    const presetBtn = document.getElementById('wc-voice-type-preset');
    const fishBtn = document.getElementById('wc-voice-type-fish');
    const presetSection = document.getElementById('wc-voice-preset-section');
    const fishSection = document.getElementById('wc-voice-fish-section');
    
    if (!presetBtn || !fishBtn) return;
    
    presetBtn.addEventListener('click', () => {
      state.voiceType = 'preset';
      presetBtn.classList.remove('border-gray-300', 'bg-white', 'text-gray-600');
      presetBtn.classList.add('border-green-500', 'bg-green-100', 'text-green-700');
      fishBtn.classList.remove('border-green-500', 'bg-green-100', 'text-green-700');
      fishBtn.classList.add('border-gray-300', 'bg-white', 'text-gray-600');
      presetSection.classList.remove('hidden');
      fishSection.classList.add('hidden');
      updateVoiceStatus();
    });
    
    fishBtn.addEventListener('click', () => {
      state.voiceType = 'fish';
      fishBtn.classList.remove('border-gray-300', 'bg-white', 'text-gray-600');
      fishBtn.classList.add('border-green-500', 'bg-green-100', 'text-green-700');
      presetBtn.classList.remove('border-green-500', 'bg-green-100', 'text-green-700');
      presetBtn.classList.add('border-gray-300', 'bg-white', 'text-gray-600');
      fishSection.classList.remove('hidden');
      presetSection.classList.add('hidden');
      updateVoiceStatus();
    });
    
    // Update status on input change
    document.getElementById('wc-voice')?.addEventListener('change', updateVoiceStatus);
    document.getElementById('wc-fish-id')?.addEventListener('input', updateVoiceStatus);
  }

  /**
   * Update voice status indicator
   */
  function updateVoiceStatus() {
    const statusNone = document.getElementById('wc-voice-status-none');
    const statusSet = document.getElementById('wc-voice-status-set');
    
    let hasVoice = false;
    if (state.voiceType === 'preset') {
      const voiceVal = document.getElementById('wc-voice')?.value;
      hasVoice = !!voiceVal;
    } else {
      const fishId = document.getElementById('wc-fish-id')?.value?.trim();
      hasVoice = !!fishId;
    }
    
    if (hasVoice) {
      statusNone?.classList.add('hidden');
      statusSet?.classList.remove('hidden');
    } else {
      statusNone?.classList.remove('hidden');
      statusSet?.classList.add('hidden');
    }
  }

  /**
   * Update reference image status indicator
   */
  function updateRefImageStatus() {
    const statusNone = document.getElementById('wc-ref-status-none');
    const statusSet = document.getElementById('wc-ref-status-set');
    
    const hasImage = state.referenceImageR2Url || state.pendingImage;
    
    if (hasImage) {
      statusNone?.classList.add('hidden');
      statusSet?.classList.remove('hidden');
    } else {
      statusNone?.classList.remove('hidden');
      statusSet?.classList.add('hidden');
    }
  }

  /**
   * Setup reference image tab toggle
   */
  function setupRefImageTabs() {
    const generateTab = document.getElementById('wc-ref-tab-generate');
    const uploadTab = document.getElementById('wc-ref-tab-upload');
    const generateContent = document.getElementById('wc-ref-content-generate');
    const uploadContent = document.getElementById('wc-ref-content-upload');

    if (!generateTab || !uploadTab) return;

    generateTab.addEventListener('click', () => {
      generateTab.classList.add('border-blue-600', 'text-blue-600');
      generateTab.classList.remove('border-transparent', 'text-gray-600');
      uploadTab.classList.remove('border-blue-600', 'text-blue-600');
      uploadTab.classList.add('border-transparent', 'text-gray-600');
      generateContent.classList.remove('hidden');
      uploadContent.classList.add('hidden');
    });

    uploadTab.addEventListener('click', () => {
      uploadTab.classList.add('border-blue-600', 'text-blue-600');
      uploadTab.classList.remove('border-transparent', 'text-gray-600');
      generateTab.classList.remove('border-blue-600', 'text-blue-600');
      generateTab.classList.add('border-transparent', 'text-gray-600');
      uploadContent.classList.remove('hidden');
      generateContent.classList.add('hidden');
    });
  }

  /**
   * Bind reference image events
   */
  function bindReferenceImageEvents() {
    const fileInput = document.getElementById('wc-ref-file');
    const uploadBtn = document.getElementById('wc-ref-upload-btn');
    const deleteBtn = document.getElementById('wc-ref-delete');

    if (!fileInput || !uploadBtn) return;

    // Clone to remove old listeners
    const newUploadBtn = uploadBtn.cloneNode(true);
    uploadBtn.parentNode.replaceChild(newUploadBtn, uploadBtn);
    
    const newFileInput = fileInput.cloneNode(true);
    fileInput.parentNode.replaceChild(newFileInput, fileInput);

    newUploadBtn.addEventListener('click', () => {
      newFileInput.click();
    });

    newFileInput.addEventListener('change', async () => {
      const file = newFileInput.files?.[0];
      if (!file) return;

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

      if (state.pendingPreviewUrl) {
        URL.revokeObjectURL(state.pendingPreviewUrl);
      }
      state.pendingPreviewUrl = URL.createObjectURL(file);
      state.pendingImage = { file };

      const refPreview = document.getElementById('wc-ref-preview');
      const refPreviewContainer = document.getElementById('wc-ref-preview-container');
      const refUploadContainer = document.getElementById('wc-ref-upload-container');
      
      if (refPreview) refPreview.src = state.pendingPreviewUrl;
      if (refPreviewContainer) refPreviewContainer.classList.remove('hidden');
      if (refUploadContainer) refUploadContainer.classList.add('hidden');

      updateRefImageStatus();
      toast('画像を選択しました', 'success');
      newFileInput.value = '';
    });

    if (deleteBtn) {
      const newDeleteBtn = deleteBtn.cloneNode(true);
      deleteBtn.parentNode.replaceChild(newDeleteBtn, deleteBtn);
      
      newDeleteBtn.addEventListener('click', async () => {
        const projectId = window.PROJECT_ID;
        const characterKey = state.originalKey;
        
        if (state.pendingImage) {
          // Just clear pending
          state.pendingImage = null;
          if (state.pendingPreviewUrl) {
            URL.revokeObjectURL(state.pendingPreviewUrl);
            state.pendingPreviewUrl = null;
          }
        } else if (projectId && characterKey && state.referenceImageR2Url) {
          // Delete from server
          if (!confirm('参照画像を削除しますか？')) return;
          try {
            await window.WorldCharacterClient.deleteCharacterReferenceImage(projectId, characterKey);
            state.referenceImageR2Url = null;
            toast('削除しました', 'success');
          } catch (err) {
            toast(`削除失敗: ${err.message}`, 'error');
            return;
          }
        }

        const refPreviewContainer = document.getElementById('wc-ref-preview-container');
        const refUploadContainer = document.getElementById('wc-ref-upload-container');
        refPreviewContainer?.classList.add('hidden');
        refUploadContainer?.classList.remove('hidden');
        updateRefImageStatus();
      });
    }
  }

  /**
   * Bind image generation button (with deduplication)
   */
  function bindImageGeneration() {
    const generateBtn = document.getElementById('wc-ref-generate-btn');
    const regenerateBtn = document.getElementById('wc-ref-regenerate-btn');
    const generatedContainer = document.getElementById('wc-ref-generated-container');
    const generatedPreview = document.getElementById('wc-ref-generated-preview');
    const promptEl = document.getElementById('wc-appearance-prompt');

    if (!generateBtn) return;

    // Remove existing listener to prevent duplicates
    const newGenerateBtn = generateBtn.cloneNode(true);
    generateBtn.parentNode.replaceChild(newGenerateBtn, generateBtn);

    const generateImage = async () => {
      // Prevent double-click
      if (newGenerateBtn.disabled) return;
      
      const prompt = promptEl?.value?.trim();
      if (!prompt) {
        toast('外見プロンプトを入力してください', 'warning');
        return;
      }

      const projectId = window.PROJECT_ID;
      if (!projectId) {
        toast('プロジェクトIDが取得できません', 'error');
        return;
      }

      try {
        toast('画像生成中...（30秒ほどかかります）', 'info');
        newGenerateBtn.disabled = true;
        newGenerateBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i> 生成中...';
        if (regenerateBtn) regenerateBtn.disabled = true;

        const blob = await window.WorldCharacterClient.generateCharacterPreviewImage(projectId, prompt);
        
        if (state.pendingPreviewUrl) {
          URL.revokeObjectURL(state.pendingPreviewUrl);
        }
        state.pendingPreviewUrl = URL.createObjectURL(blob);
        state.pendingImage = {
          file: new File([blob], 'generated.png', { type: 'image/png' })
        };
        
        if (generatedPreview) generatedPreview.src = state.pendingPreviewUrl;
        if (generatedContainer) generatedContainer.classList.remove('hidden');
        
        updateRefImageStatus();
        toast('画像を生成しました', 'success');
      } catch (err) {
        console.error('[WorldCharacterModal] Image generation failed:', err);
        toast(`生成失敗: ${err.message}`, 'error');
      } finally {
        newGenerateBtn.disabled = false;
        newGenerateBtn.innerHTML = '<i class="fas fa-wand-magic-sparkles mr-1"></i> 画像を生成';
        if (regenerateBtn) regenerateBtn.disabled = false;
      }
    };

    newGenerateBtn.addEventListener('click', generateImage);
    
    // Also handle regenerate button
    if (regenerateBtn) {
      const newRegenerateBtn = regenerateBtn.cloneNode(true);
      regenerateBtn.parentNode.replaceChild(newRegenerateBtn, regenerateBtn);
      newRegenerateBtn.addEventListener('click', generateImage);
    }
  }

  /**
   * Open modal for character creation or editing
   */
  function open(character = null) {
    try {
      ensureDom();

      state.mode = character ? 'edit' : 'create';
      state.originalKey = character?.character_key || null;
      state.referenceImageR2Url = character?.reference_image_r2_url || null;
      state.pendingImage = null;
      state.voiceType = 'preset';
      
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
    const appearancePromptEl = document.getElementById('wc-appearance-prompt');
    const voiceEl = document.getElementById('wc-voice');
    const fishIdEl = document.getElementById('wc-fish-id');

    // Populate form fields
    keyEl.value = character?.character_key || '';
    nameEl.value = character?.character_name || '';
    appearanceEl.value = character?.appearance_description || '';
    if (appearancePromptEl) appearancePromptEl.value = character?.appearance_description || '';
    
    // B layer: Story traits
    const storyTraitsEl = document.getElementById('wc-story-traits');
    if (storyTraitsEl) storyTraitsEl.value = character?.story_traits || '';
    
    // Voice handling
    const voicePresetId = character?.voice_preset_id || '';
    if (voicePresetId.startsWith('fish:')) {
      state.voiceType = 'fish';
      fishIdEl.value = voicePresetId.substring(5);
      voiceEl.value = '';
      // Switch to Fish tab
      document.getElementById('wc-voice-type-fish')?.click();
    } else {
      state.voiceType = 'preset';
      voiceEl.value = voicePresetId;
      fishIdEl.value = '';
      // Switch to Preset tab
      document.getElementById('wc-voice-type-preset')?.click();
    }

    // Aliases
    let aliases = [];
    try {
      aliases = character?.aliases_json ? JSON.parse(character.aliases_json) : [];
      if (!Array.isArray(aliases)) aliases = [];
    } catch (_) {
      aliases = [];
    }
    aliasesEl.value = aliases.join('\n');

    // Key field: disable in edit mode
    keyEl.disabled = !!character;
    if (character) {
      keyEl.classList.add('bg-gray-100', 'cursor-not-allowed');
    } else {
      keyEl.classList.remove('bg-gray-100', 'cursor-not-allowed');
    }

    // Setup reference image UI
    const refPreview = document.getElementById('wc-ref-preview');
    const refPreviewContainer = document.getElementById('wc-ref-preview-container');
    const refUploadContainer = document.getElementById('wc-ref-upload-container');
    const generatedContainer = document.getElementById('wc-ref-generated-container');
    const generateTab = document.getElementById('wc-ref-tab-generate');
    const uploadTab = document.getElementById('wc-ref-tab-upload');
    const generateContent = document.getElementById('wc-ref-content-generate');
    const uploadContent = document.getElementById('wc-ref-content-upload');
    
    // Reset generated container
    if (generatedContainer) generatedContainer.classList.add('hidden');
    
    if (character?.reference_image_r2_url) {
      // Show upload tab when editing with existing image
      if (uploadTab && generateTab && uploadContent && generateContent) {
        uploadTab.classList.add('border-blue-600', 'text-blue-600');
        uploadTab.classList.remove('border-transparent', 'text-gray-600');
        generateTab.classList.remove('border-blue-600', 'text-blue-600');
        generateTab.classList.add('border-transparent', 'text-gray-600');
        uploadContent.classList.remove('hidden');
        generateContent.classList.add('hidden');
      }
      
      if (refPreview) {
        refPreview.src = character.reference_image_r2_url;
        refPreview.style.display = 'block';
        // Add error handler for broken images
        refPreview.onerror = () => {
          console.warn('[WorldCharacterModal] Failed to load reference image:', character.reference_image_r2_url);
          refPreviewContainer?.classList.add('hidden');
          refUploadContainer?.classList.remove('hidden');
          updateRefImageStatus();
          // Clear the broken URL from state
          state.referenceImageR2Url = null;
        };
        refPreview.onload = () => {
          console.log('[WorldCharacterModal] Reference image loaded successfully');
        };
      }
      refPreviewContainer?.classList.remove('hidden');
      refUploadContainer?.classList.add('hidden');
    } else {
      // Show generate tab for new characters
      if (generateTab && uploadTab && generateContent && uploadContent) {
        generateTab.classList.add('border-blue-600', 'text-blue-600');
        generateTab.classList.remove('border-transparent', 'text-gray-600');
        uploadTab.classList.remove('border-blue-600', 'text-blue-600');
        uploadTab.classList.add('border-transparent', 'text-gray-600');
        generateContent.classList.remove('hidden');
        uploadContent.classList.add('hidden');
      }
      refPreviewContainer?.classList.add('hidden');
      refUploadContainer?.classList.remove('hidden');
    }

    // Setup event handlers
    setupVoiceTypeToggle();
    setupRefImageTabs();
    bindReferenceImageEvents();
    bindImageGeneration();

    // Update status indicators
    updateRefImageStatus();
    updateVoiceStatus();

    // Reset warnings
    document.getElementById('wc-alias-warning')?.classList.add('hidden');
    document.getElementById('wc-danger-warning')?.classList.add('hidden');

    // Bind save button
    const saveBtn = document.getElementById('wc-save');
    saveBtn.onclick = async () => {
      const payload = collectAndValidate();
      if (!payload) return;
      
      if (window.WorldCharacterModal.onSave) {
        window.WorldCharacterModal.onSave(payload, state);
      }
    };

    // Bind voice preview
    const voicePreviewBtn = document.getElementById('wc-voice-preview-btn');
    if (voicePreviewBtn) {
      voicePreviewBtn.onclick = () => previewVoice();
    }

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
      const n = (nameEl.value || '').trim().toLowerCase();
      if (n && state.dangerousWordsSet.has(n)) {
        document.getElementById('wc-danger-warning')?.classList.remove('hidden');
      }
    });
    loadVoicePresetsIntoSelect().then(() => {
      // Set voice value after presets are loaded
      if (voicePresetId && !voicePresetId.startsWith('fish:')) {
        voiceEl.value = voicePresetId;
        updateVoiceStatus();
      }
    });

    // Real-time warnings
    nameEl.onblur = () => {
      const n = (nameEl.value || '').trim().toLowerCase();
      const w = document.getElementById('wc-danger-warning');
      if (n && state.dangerousWordsSet.has(n)) {
        w?.classList.remove('hidden');
      } else {
        w?.classList.add('hidden');
      }
    };

    aliasesEl.onblur = () => {
      const { invalid } = parseAliases(aliasesEl.value);
      const w = document.getElementById('wc-alias-warning');
      if (invalid.length > 0) {
        w.textContent = `⚠️ 2文字以下の別名は除外されます: ${invalid.join(', ')}`;
        w?.classList.remove('hidden');
      } else {
        w?.classList.add('hidden');
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
    
    if (window.WorldCharacterUI && window.WorldCharacterUI.loadCharactersList) {
      window.WorldCharacterUI.loadCharactersList();
    }
    
    console.log('[WorldCharacterModal] Closed');
  }

  /**
   * Collect form data and validate
   */
  function collectAndValidate() {
    const key = document.getElementById('wc-key').value.trim();
    const name = document.getElementById('wc-name').value.trim();
    const aliasesText = document.getElementById('wc-aliases').value;
    const appearance = document.getElementById('wc-appearance').value.trim();
    const storyTraits = document.getElementById('wc-story-traits')?.value?.trim() || '';
    
    // Get voice value
    let voice = null;
    if (state.voiceType === 'preset') {
      voice = document.getElementById('wc-voice').value || null;
    } else {
      const fishId = document.getElementById('wc-fish-id').value.trim();
      if (fishId) {
        voice = `fish:${fishId}`;
      }
    }

    // === 必須項目のバリデーション ===
    
    // Character Key
    if (!key) {
      toast('Character Key は必須です', 'warning');
      return null;
    }
    if (!isValidKey(key)) {
      toast('Character Key は英数字+アンダースコアのみです', 'warning');
      return null;
    }
    
    // Character Name
    if (!name) {
      toast('キャラクター名は必須です', 'warning');
      return null;
    }
    if (name.length < 2) {
      toast('キャラクター名は2文字以上です', 'warning');
      return null;
    }
    
    // 参照画像（必須）
    const hasImage = state.referenceImageR2Url || state.pendingImage;
    if (!hasImage) {
      toast('参照画像は必須です。AIで生成するかアップロードしてください。', 'warning');
      return null;
    }
    
    // 音声（必須）
    if (!voice) {
      toast('音声設定は必須です。Google TTSまたはFish Audioを選択してください。', 'warning');
      return null;
    }

    // Aliases validation (optional)
    const { valid } = parseAliases(aliasesText);

    const payload = {
      character_key: key,
      character_name: name,
      aliases: valid.length > 0 ? valid : null,
      appearance_description: appearance || null,
      story_traits: storyTraits || null,
      voice_preset_id: voice,
    };

    console.log('[WorldCharacterModal] Validated payload:', payload);
    return payload;
  }

  /**
   * Preview voice using TTS API
   */
  async function previewVoice() {
    const voiceSelect = document.getElementById('wc-voice');
    const voiceId = voiceSelect?.value;
    
    if (!voiceId) {
      toast('音声を選択してください', 'warning');
      return;
    }
    
    const btn = document.getElementById('wc-voice-preview-btn');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    }
    
    try {
      const sampleText = 'こんにちは、これはサンプル音声です。';
      
      const response = await fetch('/api/tts/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: sampleText,
          voice_id: voiceId
        })
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        // Extract error message from API response
        const errorMsg = data?.error || data?.message || '音声生成に失敗しました';
        throw new Error(errorMsg);
      }
      
      if (data.audio_url) {
        const audio = new Audio(data.audio_url);
        audio.play();
        toast('音声を再生中...', 'success');
      } else {
        throw new Error('音声URLが取得できませんでした');
      }
    } catch (err) {
      console.error('[WorldCharacterModal] Voice preview failed:', err);
      // Show detailed error message to user
      const errorMessage = err.message || '音声プレビューに失敗しました';
      toast(errorMessage, 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<i class="fas fa-play"></i>';
      }
    }
  }

  // =============================
  // Scene Character Assignment (UI-4)
  // =============================

  /**
   * Open scene character assignment modal
   */
  async function openAssign(sceneId) {
    console.log('[WorldCharacterModal] openAssign called with sceneId:', sceneId);
    
    if (!sceneId) {
      toast('Scene ID が不正です', 'error');
      return;
    }

    ensureAssignDom();

    const projectId = window.PROJECT_ID;
    if (!projectId) {
      toast('プロジェクトIDが取得できません', 'error');
      return;
    }

    try {
      const [charactersData, assignmentsData] = await Promise.all([
        window.WorldCharacterClient.fetchCharacters(projectId),
        window.WorldCharacterClient.fetchSceneCharacters(sceneId),
      ]);
      
      const characters = charactersData.characters || [];
      const assignments = assignmentsData.scene_characters || [];

      const modal = document.getElementById('wc-assign-modal');
      document.getElementById('wc-assign-title').textContent = `シーン #${sceneId} のキャラ割当`;
      modal.classList.remove('hidden');
      modal.classList.add('flex');

      populateAssignSlots(characters, assignments);

      const saveBtn = document.getElementById('wc-assign-save');
      let isSaving = false;
      
      saveBtn.onclick = async () => {
        if (isSaving) return;
        
        const payload = collectAssignments();
        if (payload === null) return;

        try {
          isSaving = true;
          saveBtn.disabled = true;
          saveBtn.textContent = '保存中...';
          
          await window.WorldCharacterClient.batchUpdateSceneCharacters(sceneId, payload);
          toast('割当を保存しました', 'success');
          closeAssign();

          if (typeof window.initBuilderTab === 'function') {
            await window.initBuilderTab();
          } else if (typeof window.loadScenes === 'function') {
            await window.loadScenes();
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
      toast(`データの読み込みに失敗しました: ${e.message}`, 'error');
    }
  }

  /**
   * Ensure assignment modal DOM exists
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
          <div class="border border-blue-200 rounded-lg p-4 bg-blue-50/30">
            <h4 class="text-sm font-bold text-blue-800 mb-2 flex items-center">
              <i class="fas fa-image mr-2"></i>画像キャラクター（最大3人）
            </h4>
            <p class="text-xs text-blue-600 mb-3">画像生成時に登場するキャラクター</p>
            <div id="wc-image-chars-container" class="space-y-2"></div>
          </div>

          <div class="border border-green-200 rounded-lg p-4 bg-green-50/30">
            <h4 class="text-sm font-bold text-green-800 mb-2 flex items-center">
              <i class="fas fa-microphone mr-2"></i>音声キャラクター（1人）
            </h4>
            <p class="text-xs text-green-600 mb-3">このシーンのセリフを喋るキャラクター</p>
            <select id="wc-voice-char" class="w-full border border-green-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500 bg-white">
              <option value="">-- ナレーター（キャラなし） --</option>
            </select>
          </div>

          <div class="flex gap-3 justify-end pt-2">
            <button id="wc-assign-cancel" class="px-4 py-2 rounded-lg bg-gray-200 hover:bg-gray-300 transition-colors font-semibold">
              キャンセル
            </button>
            <button id="wc-assign-save" class="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors font-semibold">
              保存
            </button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);

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
  }

  /**
   * Populate assignment slots
   */
  function populateAssignSlots(characters, assignments) {
    const currentImageChars = assignments.map(a => a.character_key);
    const currentVoiceChar = assignments.find(a => a.is_primary === 1)?.character_key || '';

    const imageContainer = document.getElementById('wc-image-chars-container');
    if (imageContainer) {
      if (characters.length === 0) {
        imageContainer.innerHTML = '<p class="text-sm text-gray-500 italic">キャラクターが登録されていません。</p>';
      } else {
        imageContainer.innerHTML = characters.map(ch => {
          const key = escapeHtml(ch.character_key);
          const name = escapeHtml(ch.character_name);
          const checked = currentImageChars.includes(ch.character_key) ? 'checked' : '';
          const hasRef = ch.reference_image_r2_url ? '📷' : '';
          return `
            <label class="flex items-center gap-3 p-2 rounded-lg hover:bg-blue-100 cursor-pointer transition-colors">
              <input type="checkbox" class="wc-image-char-cb w-4 h-4 text-blue-600 rounded" value="${key}" ${checked} />
              <span class="text-sm">${hasRef} ${name}</span>
              <span class="text-xs text-gray-400">(${key})</span>
            </label>
          `;
        }).join('');

        imageContainer.querySelectorAll('.wc-image-char-cb').forEach(cb => {
          cb.addEventListener('change', () => {
            const checked = document.querySelectorAll('.wc-image-char-cb:checked');
            if (checked.length > 3) {
              toast('画像キャラクターは最大3人までです', 'warning');
              cb.checked = false;
            }
          });
        });
      }
    }

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
   * Collect assignments
   */
  function collectAssignments() {
    const imageCheckboxes = document.querySelectorAll('.wc-image-char-cb:checked');
    const imageCharacters = Array.from(imageCheckboxes).map(cb => cb.value);

    if (imageCharacters.length > 3) {
      toast('画像キャラクターは最大3人までです', 'warning');
      return null;
    }

    const voiceSelect = document.getElementById('wc-voice-char');
    const voiceCharacter = voiceSelect?.value?.trim() || null;

    return {
      image_characters: imageCharacters,
      voice_character: voiceCharacter
    };
  }

  // Expose API to global scope
  window.WorldCharacterModal = {
    open,
    close,
    ensureDom,
    openAssign,
    closeAssign,
    previewVoice,
    onSave: null,
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
