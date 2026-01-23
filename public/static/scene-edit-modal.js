/**
 * Phase X-6: Scene Edit Modal (Unified Edition)
 * 
 * Handles scene editing with unified tabs:
 * - Tab A: Character Assignment (image + voice)
 * - Tab B: Character Traits (scene-specific overrides)
 * 
 * SSOT Principles:
 * 1. Single save button saves EVERYTHING (no partial saves = no accidents)
 * 2. Dirty state tracking (save disabled when no changes)
 * 3. Confirmation on close with unsaved changes
 * 4. Trait sanitization (no dialogue/emotions → no text on images)
 */

(function() {
  'use strict';

  const SceneEditModal = {
    // State
    currentSceneId: null,
    currentSceneIdx: null,
    characters: [], // All project characters
    sceneData: null, // Scene dialogue/prompt for AI extraction
    
    // Original state for dirty checking (SSOT)
    originalState: {
      imageCharacterKeys: [],
      voiceCharacterKey: null,
      sceneTraits: {} // { character_key: trait_description }
    },
    
    // Current state
    currentState: {
      imageCharacterKeys: [],
      voiceCharacterKey: null,
      sceneTraits: {} // { character_key: trait_description }
    },
    
    // AI candidates (not saved until user clicks "use")
    aiCandidates: {}, // { character_key: extracted_traits }
    aiLoading: {}, // { character_key: boolean }
    
    // R2-C: Motion state (separate from SSOT save)
    motionPresets: [], // Cached presets from API
    motionState: {
      original: null,  // { preset_id, is_default }
      current: null,
      hasChanges: false
    },
    
    // Active tab
    activeTab: 'characters', // 'characters' | 'traits'
    
    /**
     * Initialize the modal
     */
    init() {
      console.log('[SceneEditModal] Initializing unified modal...');
      this.bindEvents();
    },
    
    /**
     * Bind event listeners
     */
    bindEvents() {
      const saveBtn = document.getElementById('save-edit-scene');
      const cancelBtn = document.getElementById('cancel-edit-scene');
      const modal = document.getElementById('scene-edit-modal');
      
      // R2-C: Motion preset change handler (delegated)
      document.addEventListener('change', (e) => {
        if (e.target.id === 'edit-motion-preset') {
          this.onMotionPresetChange(e.target.value);
        }
      });
      
      // R2-C: Motion save button
      document.addEventListener('click', (e) => {
        if (e.target.closest('#save-motion-btn')) {
          this.saveMotion();
        }
        if (e.target.closest('#reset-motion-btn')) {
          this.resetMotionToDefault();
        }
      });
      
      if (saveBtn) {
        saveBtn.addEventListener('click', () => this.save());
      }
      
      if (cancelBtn) {
        cancelBtn.addEventListener('click', () => this.closeWithConfirm());
      }
      
      // Close on background click (with confirmation)
      if (modal) {
        modal.addEventListener('click', (e) => {
          if (e.target === modal) {
            this.closeWithConfirm();
          }
        });
      }
      
      // Tab switching
      document.addEventListener('click', (e) => {
        const tabBtn = e.target.closest('[data-scene-edit-tab]');
        if (tabBtn) {
          const tab = tabBtn.dataset.sceneEditTab;
          this.switchTab(tab);
        }
      });
    },
    
    /**
     * Open modal with scene data
     * @param {number} sceneId 
     */
    async open(sceneId) {
      console.log(`[SceneEditModal] Opening for scene ${sceneId}`);
      this.currentSceneId = sceneId;
      
      try {
        // Show loading state
        const modal = document.getElementById('scene-edit-modal');
        if (modal) {
          modal.classList.remove('hidden');
        }
        
        // Fetch complete edit context via SSOT API
        const response = await axios.get(`/api/scenes/${sceneId}/edit-context`);
        const ctx = response.data;
        
        this.currentSceneIdx = ctx.scene.idx;
        this.characters = ctx.project_characters || [];
        this.sceneData = ctx.scene; // Store scene for AI extraction
        
        // Reset AI candidates
        this.aiCandidates = {};
        this.aiLoading = {};
        
        // Store original state for dirty checking
        this.originalState = {
          imageCharacterKeys: [...(ctx.assigned_image_character_keys || [])],
          voiceCharacterKey: ctx.voice_character_key || null,
          sceneTraits: {}
        };
        
        // Build scene traits map
        for (const trait of (ctx.scene_traits || [])) {
          this.originalState.sceneTraits[trait.character_key] = trait.trait_description || '';
        }
        
        // Initialize current state as copy of original
        this.currentState = {
          imageCharacterKeys: [...this.originalState.imageCharacterKeys],
          voiceCharacterKey: this.originalState.voiceCharacterKey,
          sceneTraits: { ...this.originalState.sceneTraits }
        };
        
        // Populate form (basic fields from existing scene data)
        document.getElementById('edit-scene-id').value = sceneId;
        document.getElementById('edit-dialogue').value = ctx.scene.dialogue || '';
        document.getElementById('edit-image-prompt').value = ctx.scene.image_prompt || '';
        
        // Update header with scene index
        this.updateModalHeader();
        
        // R2-C: Load motion presets and current motion
        await this.loadMotionData();
        
        // R2-C: Render rendering result preview (what will be output)
        this.renderRenderingPreview();
        
        // R2-C: Render motion selector UI
        this.renderMotionSelector();
        
        // R3-A: Render duration override UI
        this.renderDurationOverride();
        
        // Render tabs
        this.renderTabs();
        
        // Render both tab contents
        this.renderCharactersTab();
        this.renderTraitsTab();
        
        // Switch to default tab
        this.switchTab('characters');
        
        // Update save button state
        this.updateSaveButtonState();
        
      } catch (error) {
        console.error('[SceneEditModal] Failed to open:', error);
        this.showToast('シーン情報の読み込みに失敗しました', 'error');
        this.close();
      }
    },
    
    /**
     * Update modal header with scene index
     */
    updateModalHeader() {
      const header = document.querySelector('#scene-edit-modal h2');
      if (header) {
        header.innerHTML = `<i class="fas fa-edit mr-2"></i>シーン #${this.currentSceneIdx} 編集`;
      }
    },
    
    // ========================================
    // R2-C: Motion Preset Functions
    // ========================================
    
    /**
     * Load motion presets and current scene motion
     */
    async loadMotionData() {
      try {
        // Load presets (cache if already loaded)
        if (this.motionPresets.length === 0) {
          const presetsRes = await axios.get('/api/settings/motion-presets');
          this.motionPresets = presetsRes.data.presets || [];
          console.log(`[SceneEditModal] Loaded ${this.motionPresets.length} motion presets`);
        }
        
        // Load current scene motion
        const motionRes = await axios.get(`/api/scenes/${this.currentSceneId}/motion`);
        const motionData = motionRes.data;
        
        this.motionState = {
          original: {
            preset_id: motionData.motion_preset_id,
            is_default: motionData.is_default
          },
          current: motionData.motion_preset_id,
          hasChanges: false
        };
        
        console.log(`[SceneEditModal] Scene motion: ${motionData.motion_preset_id} (default: ${motionData.is_default})`);
        
      } catch (error) {
        console.error('[SceneEditModal] Failed to load motion data:', error);
        // Fallback to defaults
        this.motionState = {
          original: { preset_id: 'kenburns_soft', is_default: true },
          current: 'kenburns_soft',
          hasChanges: false
        };
      }
    },
    
    /**
     * R2-C: Render rendering result preview
     * Shows what will actually be output - the most important info for users
     */
    renderRenderingPreview() {
      const container = document.getElementById('rendering-preview-container');
      if (!container) return;
      
      const displayType = this.sceneData?.display_asset_type || 'image';
      const textRenderMode = this.sceneData?.text_render_mode || (displayType === 'comic' ? 'baked' : 'remotion');
      const motionPresetId = this.motionState?.current || (displayType === 'comic' ? 'none' : 'kenburns_soft');
      
      // Find current motion preset info
      const currentPreset = this.motionPresets.find(p => p.id === motionPresetId);
      const motionName = currentPreset?.name || motionPresetId;
      
      // Utterance status
      const utteranceTotal = this.sceneData?.utterance_status?.total || 0;
      const utteranceWithAudio = this.sceneData?.utterance_status?.with_audio || 0;
      const audioReady = utteranceTotal > 0 && utteranceWithAudio === utteranceTotal;
      
      // Build description lines
      const lines = [];
      
      // 1. Asset type explanation
      if (displayType === 'comic') {
        lines.push({
          icon: '📙',
          text: 'このシーンは「漫画」です',
          detail: '画像に吹き出し・文字が焼き込まれています',
          class: 'text-orange-700 bg-orange-50'
        });
      } else if (displayType === 'video') {
        lines.push({
          icon: '🎬',
          text: 'このシーンは「動画」です',
          detail: '動画クリップがそのまま使用されます',
          class: 'text-blue-700 bg-blue-50'
        });
      } else {
        lines.push({
          icon: '🖼️',
          text: 'このシーンは「静止画」です',
          detail: 'AI生成画像が使用されます',
          class: 'text-green-700 bg-green-50'
        });
      }
      
      // 2. Text rendering explanation
      if (textRenderMode === 'baked') {
        lines.push({
          icon: '🔥',
          text: '文字は「焼き込み」です',
          detail: '画像内の文字をそのまま表示（Remotion文字はOFF）',
          class: 'text-orange-700 bg-orange-50'
        });
      } else if (textRenderMode === 'none') {
        lines.push({
          icon: '⛔',
          text: '文字は「表示なし」です',
          detail: 'このシーンでは文字を表示しません',
          class: 'text-gray-600 bg-gray-50'
        });
      } else {
        lines.push({
          icon: '🧾',
          text: '文字は「Remotion描画」です',
          detail: '動画生成時にRemotionがテロップ/字幕を重ねます',
          class: 'text-purple-700 bg-purple-50'
        });
      }
      
      // 3. Audio status
      if (utteranceTotal === 0) {
        lines.push({
          icon: '🔇',
          text: '音声：発話が設定されていません',
          detail: '音声を追加するには「音声」タブで設定してください',
          class: 'text-gray-600 bg-gray-50'
        });
      } else if (audioReady) {
        lines.push({
          icon: '✅',
          text: `音声：${utteranceTotal}件すべて生成完了`,
          detail: '動画生成が可能です',
          class: 'text-green-700 bg-green-50'
        });
      } else {
        lines.push({
          icon: '⚠️',
          text: `音声：${utteranceWithAudio}/${utteranceTotal}件生成済み`,
          detail: '未生成の音声があります。「音声」タブで生成してください',
          class: 'text-red-700 bg-red-50'
        });
      }
      
      // 4. Duration (R3-A)
      const durationOverride = this.sceneData?.duration_override_ms;
      const totalDurationMs = utteranceStatus?.total_duration_ms || 0;
      let durationMs = 3000;
      let durationSource = 'デフォルト';
      let durationIcon = '⏱️';
      let durationClass = 'text-gray-600 bg-gray-50';
      
      if (durationOverride && durationOverride > 0) {
        durationMs = durationOverride;
        durationSource = '手動設定';
        durationIcon = '✏️';
        durationClass = 'text-yellow-700 bg-yellow-50';
      } else if (audioReady && totalDurationMs > 0) {
        durationMs = totalDurationMs + 500;
        durationSource = '音声尺';
        durationIcon = '🎙️';
        durationClass = 'text-green-700 bg-green-50';
      } else if (utteranceTotal === 0) {
        durationSource = '無音/要設定';
        durationIcon = '⚠️';
        durationClass = 'text-orange-700 bg-orange-50';
      }
      
      const durationSec = (durationMs / 1000).toFixed(1);
      lines.push({
        icon: durationIcon,
        text: `尺：${durationSec}秒`,
        detail: `(${durationSource})`,
        class: durationClass
      });
      
      // 5. Motion
      const motionIcon = motionPresetId === 'none' ? '⏸️' : '🎥';
      lines.push({
        icon: motionIcon,
        text: `動き：${motionName}`,
        detail: motionPresetId === 'none' ? '静止表示（動きなし）' : `カメラワークが適用されます`,
        class: motionPresetId === 'none' ? 'text-gray-600 bg-gray-50' : 'text-purple-700 bg-purple-50'
      });
      
      // Render the preview
      container.innerHTML = `
        <div class="mb-4 p-4 border-2 border-indigo-300 rounded-lg bg-gradient-to-r from-indigo-50 to-purple-50">
          <div class="flex items-center gap-2 mb-3">
            <span class="text-lg">🎬</span>
            <span class="font-bold text-indigo-800">最終レンダリング結果</span>
            <span class="text-xs text-indigo-600 bg-indigo-100 px-2 py-0.5 rounded">このシーンはこう出力されます</span>
          </div>
          
          <div class="space-y-2">
            ${lines.map(line => `
              <div class="flex items-start gap-2 p-2 rounded ${line.class}">
                <span class="text-lg flex-shrink-0">${line.icon}</span>
                <div class="flex-1">
                  <span class="font-semibold text-sm">${line.text}</span>
                  <span class="text-xs opacity-75 ml-2">→ ${line.detail}</span>
                </div>
              </div>
            `).join('')}
          </div>
          
          ${displayType === 'comic' && textRenderMode !== 'baked' ? `
            <div class="mt-3 p-2 bg-red-100 border border-red-300 rounded-lg">
              <span class="text-red-800 text-sm font-bold">
                <i class="fas fa-exclamation-triangle mr-1"></i>
                注意：漫画なのにRemotionで文字を重ねると二重表示になる可能性があります
              </span>
            </div>
          ` : ''}
        </div>
      `;
    },
    
    /**
     * Render motion selector UI (called after basic info section)
     */
    renderMotionSelector() {
      const container = document.getElementById('motion-selector-container');
      if (!container) return;
      
      const currentPreset = this.motionPresets.find(p => p.id === this.motionState.current);
      const isDefault = this.motionState.original?.is_default ?? true;
      const displayType = this.sceneData?.display_asset_type || 'image';
      
      // Recommendation based on display_asset_type
      const recommendedId = displayType === 'comic' ? 'none' : 'kenburns_soft';
      const recommendedPreset = this.motionPresets.find(p => p.id === recommendedId);
      
      container.innerHTML = `
        <div class="p-4 border border-gray-200 rounded-lg bg-gray-50">
          <label class="block text-sm font-semibold text-gray-700 mb-2">
            <i class="fas fa-video mr-1 text-purple-600"></i>モーション設定
            ${displayType === 'comic' ? '<span class="ml-2 text-xs text-orange-600">※漫画は「静止」推奨</span>' : ''}
          </label>
          
          <!-- Preset selector -->
          <div class="flex items-center gap-2 mb-2">
            <select 
              id="edit-motion-preset"
              class="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 text-sm"
            >
              ${this.motionPresets.map(preset => `
                <option 
                  value="${this.escapeHtml(preset.id)}" 
                  ${preset.id === this.motionState.current ? 'selected' : ''}
                >
                  ${this.escapeHtml(preset.name)}
                  ${preset.id === recommendedId ? ' ★推奨' : ''}
                </option>
              `).join('')}
            </select>
            
            <!-- Save/Reset buttons -->
            <button 
              type="button"
              id="save-motion-btn"
              class="px-3 py-2 text-sm font-semibold rounded-lg transition-colors ${this.motionState.hasChanges ? 'bg-purple-600 text-white hover:bg-purple-700' : 'bg-gray-200 text-gray-400 cursor-not-allowed'}"
              ${!this.motionState.hasChanges ? 'disabled' : ''}
            >
              <i class="fas fa-check mr-1"></i>保存
            </button>
            ${!isDefault ? `
              <button 
                type="button"
                id="reset-motion-btn"
                class="px-3 py-2 text-sm text-gray-600 hover:text-red-600 transition-colors"
                title="デフォルトに戻す"
              >
                <i class="fas fa-undo"></i>
              </button>
            ` : ''}
          </div>
          
          <!-- Description -->
          <div class="text-xs text-gray-500">
            ${currentPreset ? `
              <span class="font-medium">${this.escapeHtml(currentPreset.name)}:</span>
              <span class="ml-1">${this.escapeHtml(currentPreset.description || '')}</span>
            ` : ''}
            ${isDefault ? '<span class="ml-2 text-purple-500">(デフォルト)</span>' : '<span class="ml-2 text-yellow-600">(カスタム設定)</span>'}
          </div>
          
          <!-- Status message -->
          <div id="motion-status-msg" class="mt-2 text-xs hidden"></div>
        </div>
      `;
    },
    
    /**
     * Handle motion preset change
     */
    onMotionPresetChange(presetId) {
      this.motionState.current = presetId;
      this.motionState.hasChanges = presetId !== this.motionState.original?.preset_id;
      
      // Re-render to update button state
      this.renderMotionSelector();
      console.log(`[SceneEditModal] Motion changed to: ${presetId}, hasChanges: ${this.motionState.hasChanges}`);
    },
    
    /**
     * Save motion preset (separate from main save)
     */
    async saveMotion() {
      if (!this.currentSceneId || !this.motionState.hasChanges) return;
      
      const saveBtn = document.getElementById('save-motion-btn');
      const statusMsg = document.getElementById('motion-status-msg');
      
      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>保存中...';
      }
      
      try {
        const response = await axios.put(`/api/scenes/${this.currentSceneId}/motion`, {
          motion_preset_id: this.motionState.current
        });
        
        if (response.data.success) {
          // Update original state
          this.motionState.original = {
            preset_id: this.motionState.current,
            is_default: false
          };
          this.motionState.hasChanges = false;
          
          // Show success
          if (statusMsg) {
            statusMsg.className = 'mt-2 text-xs text-green-600';
            statusMsg.innerHTML = '<i class="fas fa-check-circle mr-1"></i>モーションを更新しました';
            statusMsg.classList.remove('hidden');
            setTimeout(() => statusMsg.classList.add('hidden'), 3000);
          }
          
          this.showToast('モーションを更新しました', 'success');
          this.renderRenderingPreview(); // Update preview with new motion
          this.renderMotionSelector();
        } else {
          throw new Error(response.data.error?.message || 'Save failed');
        }
      } catch (error) {
        console.error('[SceneEditModal] Failed to save motion:', error);
        
        if (statusMsg) {
          statusMsg.className = 'mt-2 text-xs text-red-600';
          statusMsg.innerHTML = '<i class="fas fa-exclamation-circle mr-1"></i>更新に失敗しました';
          statusMsg.classList.remove('hidden');
        }
        
        this.showToast('モーション更新に失敗しました', 'error');
      } finally {
        if (saveBtn) {
          saveBtn.disabled = false;
          saveBtn.innerHTML = '<i class="fas fa-check mr-1"></i>保存';
        }
        this.renderMotionSelector();
      }
    },
    
    // ========================================
    // R3-A: Duration Override Functions
    // ========================================
    
    /**
     * R3-A: Render duration override UI
     * For scenes without audio (silent scenes), allows manual duration setting
     */
    renderDurationOverride() {
      const container = document.getElementById('duration-override-container');
      if (!container) return;
      
      const utteranceStatus = this.sceneData?.utterance_status || { total: 0, with_audio: 0, total_duration_ms: 0 };
      const hasAudio = utteranceStatus.total > 0;
      const currentOverride = this.sceneData?.duration_override_ms || null;
      
      // Calculate estimated duration
      let estimatedDurationMs = 3000; // Default 3 seconds
      let durationSource = 'デフォルト';
      
      if (currentOverride && currentOverride > 0) {
        estimatedDurationMs = currentOverride;
        durationSource = '手動設定';
      } else if (utteranceStatus.total_duration_ms > 0) {
        estimatedDurationMs = utteranceStatus.total_duration_ms + 500;
        durationSource = '音声尺';
      }
      
      const estimatedDurationSec = (estimatedDurationMs / 1000).toFixed(1);
      
      // Only show UI for scenes without audio or with manual override
      if (hasAudio && !currentOverride) {
        // Has audio, no override - show info only
        container.innerHTML = `
          <div class="p-3 border border-gray-200 rounded-lg bg-gray-50">
            <div class="flex items-center gap-2 text-sm text-gray-600">
              <span class="text-lg">⏱️</span>
              <span>シーン尺: <span class="font-semibold">${estimatedDurationSec}秒</span></span>
              <span class="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded">音声から自動計算</span>
            </div>
            <p class="text-xs text-gray-500 mt-1">
              <i class="fas fa-info-circle mr-1"></i>
              音声がある場合、尺は自動的に音声の長さ+0.5秒になります
            </p>
          </div>
        `;
        return;
      }
      
      // Show editable duration override UI
      const currentSec = currentOverride ? (currentOverride / 1000).toFixed(1) : '';
      
      container.innerHTML = `
        <div class="p-4 border border-orange-200 rounded-lg bg-orange-50">
          <label class="block text-sm font-semibold text-orange-800 mb-2">
            <i class="fas fa-clock mr-1"></i>無音シーン尺設定
            ${!hasAudio ? '<span class="ml-2 text-xs bg-orange-200 text-orange-700 px-2 py-0.5 rounded">音声なし</span>' : ''}
          </label>
          
          <div class="flex items-center gap-3 mb-2">
            <input 
              type="number"
              id="edit-duration-override"
              class="w-24 px-3 py-2 border border-orange-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500 text-sm"
              placeholder="秒"
              step="0.5"
              min="0.5"
              max="60"
              value="${currentSec}"
            />
            <span class="text-sm text-orange-700">秒</span>
            
            <button 
              type="button"
              id="save-duration-btn"
              class="px-3 py-2 text-sm font-semibold rounded-lg bg-orange-500 text-white hover:bg-orange-600 transition-colors"
            >
              <i class="fas fa-check mr-1"></i>保存
            </button>
            
            ${currentOverride ? `
              <button 
                type="button"
                id="clear-duration-btn"
                class="px-3 py-2 text-sm text-gray-600 hover:text-red-600 transition-colors"
                title="手動設定をクリア"
              >
                <i class="fas fa-times"></i>
              </button>
            ` : ''}
          </div>
          
          <p class="text-xs text-orange-700">
            <i class="fas fa-info-circle mr-1"></i>
            音声がないシーンの表示時間を手動で設定できます（0.5～60秒）
          </p>
          
          <div class="mt-2 text-xs text-gray-600 flex items-center gap-2">
            <span>現在の予測尺:</span>
            <span class="font-semibold">${estimatedDurationSec}秒</span>
            <span class="text-gray-400">(${durationSource})</span>
          </div>
          
          <div id="duration-status-msg" class="mt-2 text-xs hidden"></div>
        </div>
      `;
      
      // Bind events
      this.bindDurationEvents();
    },
    
    /**
     * Bind duration override events
     */
    bindDurationEvents() {
      const saveBtn = document.getElementById('save-duration-btn');
      const clearBtn = document.getElementById('clear-duration-btn');
      
      if (saveBtn) {
        saveBtn.addEventListener('click', () => this.saveDurationOverride());
      }
      
      if (clearBtn) {
        clearBtn.addEventListener('click', () => this.clearDurationOverride());
      }
    },
    
    /**
     * Save duration override
     */
    async saveDurationOverride() {
      const input = document.getElementById('edit-duration-override');
      const statusMsg = document.getElementById('duration-status-msg');
      const saveBtn = document.getElementById('save-duration-btn');
      
      if (!input || !this.currentSceneId) return;
      
      const seconds = parseFloat(input.value);
      
      // Validate
      if (isNaN(seconds) || seconds < 0.5 || seconds > 60) {
        if (statusMsg) {
          statusMsg.className = 'mt-2 text-xs text-red-600';
          statusMsg.innerHTML = '<i class="fas fa-exclamation-circle mr-1"></i>0.5～60秒の範囲で入力してください';
          statusMsg.classList.remove('hidden');
        }
        return;
      }
      
      const durationMs = Math.round(seconds * 1000);
      
      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>保存中...';
      }
      
      try {
        const response = await axios.put(`/api/scenes/${this.currentSceneId}`, {
          duration_override_ms: durationMs
        });
        
        if (response.data) {
          // Update local state
          this.sceneData.duration_override_ms = durationMs;
          
          if (statusMsg) {
            statusMsg.className = 'mt-2 text-xs text-green-600';
            statusMsg.innerHTML = '<i class="fas fa-check-circle mr-1"></i>尺を保存しました';
            statusMsg.classList.remove('hidden');
            setTimeout(() => statusMsg.classList.add('hidden'), 3000);
          }
          
          this.showToast(`シーン尺を${seconds}秒に設定しました`, 'success');
          
          // Re-render to show clear button
          this.renderDurationOverride();
          this.renderRenderingPreview();
        }
      } catch (error) {
        console.error('[SceneEditModal] Failed to save duration:', error);
        
        if (statusMsg) {
          statusMsg.className = 'mt-2 text-xs text-red-600';
          statusMsg.innerHTML = '<i class="fas fa-exclamation-circle mr-1"></i>保存に失敗しました';
          statusMsg.classList.remove('hidden');
        }
        
        this.showToast('尺の保存に失敗しました', 'error');
      } finally {
        if (saveBtn) {
          saveBtn.disabled = false;
          saveBtn.innerHTML = '<i class="fas fa-check mr-1"></i>保存';
        }
      }
    },
    
    /**
     * Clear duration override
     */
    async clearDurationOverride() {
      if (!this.currentSceneId) return;
      
      if (!confirm('手動設定をクリアして、デフォルトの尺に戻しますか？')) {
        return;
      }
      
      try {
        await axios.put(`/api/scenes/${this.currentSceneId}`, {
          duration_override_ms: null
        });
        
        // Update local state
        this.sceneData.duration_override_ms = null;
        
        this.showToast('尺をデフォルトに戻しました', 'success');
        
        // Re-render
        this.renderDurationOverride();
        this.renderRenderingPreview();
      } catch (error) {
        console.error('[SceneEditModal] Failed to clear duration:', error);
        this.showToast('クリアに失敗しました', 'error');
      }
    },
    
    /**
     * Reset motion to default
     */
    async resetMotionToDefault() {
      if (!this.currentSceneId) return;
      
      if (!confirm('モーション設定をデフォルトに戻しますか？')) {
        return;
      }
      
      try {
        await axios.delete(`/api/scenes/${this.currentSceneId}/motion`);
        
        // Reload motion data
        await this.loadMotionData();
        this.renderRenderingPreview(); // Update preview with default motion
        this.renderMotionSelector();
        
        this.showToast('デフォルトに戻しました', 'success');
      } catch (error) {
        console.error('[SceneEditModal] Failed to reset motion:', error);
        this.showToast('リセットに失敗しました', 'error');
      }
    },
    
    /**
     * Render tab navigation
     */
    renderTabs() {
      const container = document.getElementById('scene-edit-tabs');
      if (!container) return;
      
      container.innerHTML = `
        <div class="flex gap-2 mb-4 border-b border-gray-200">
          <button 
            data-scene-edit-tab="characters"
            class="px-4 py-2 font-semibold text-sm border-b-2 transition-colors scene-edit-tab-btn ${this.activeTab === 'characters' ? 'border-blue-500 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}"
          >
            <i class="fas fa-users mr-1"></i>キャラ割り当て
          </button>
          <button 
            data-scene-edit-tab="utterances"
            class="px-4 py-2 font-semibold text-sm border-b-2 transition-colors scene-edit-tab-btn ${this.activeTab === 'utterances' ? 'border-purple-500 text-purple-600' : 'border-transparent text-gray-500 hover:text-gray-700'}"
          >
            <i class="fas fa-microphone-alt mr-1"></i>音声
          </button>
          <button 
            data-scene-edit-tab="traits"
            class="px-4 py-2 font-semibold text-sm border-b-2 transition-colors scene-edit-tab-btn ${this.activeTab === 'traits' ? 'border-indigo-500 text-indigo-600' : 'border-transparent text-gray-500 hover:text-gray-700'}"
          >
            <i class="fas fa-user-tag mr-1"></i>特徴変化
            ${this.hasSceneTraits() ? '<span class="ml-1 bg-yellow-400 text-yellow-800 text-xs px-1.5 py-0.5 rounded-full">!</span>' : ''}
          </button>
        </div>
      `;
    },
    
    /**
     * Check if any scene traits exist
     */
    hasSceneTraits() {
      return Object.values(this.currentState.sceneTraits).some(t => t && t.trim());
    },
    
    /**
     * Switch between tabs
     * @param {string} tab - 'characters' | 'traits' | 'utterances'
     */
    switchTab(tab) {
      this.activeTab = tab;
      
      // Update tab button styles
      document.querySelectorAll('.scene-edit-tab-btn').forEach(btn => {
        const isActive = btn.dataset.sceneEditTab === tab;
        btn.classList.toggle('border-blue-500', isActive && tab === 'characters');
        btn.classList.toggle('text-blue-600', isActive && tab === 'characters');
        btn.classList.toggle('border-purple-500', isActive && tab === 'utterances');
        btn.classList.toggle('text-purple-600', isActive && tab === 'utterances');
        btn.classList.toggle('border-indigo-500', isActive && tab === 'traits');
        btn.classList.toggle('text-indigo-600', isActive && tab === 'traits');
        btn.classList.toggle('border-transparent', !isActive);
        btn.classList.toggle('text-gray-500', !isActive);
      });
      
      // Show/hide tab content
      const charTab = document.getElementById('scene-edit-tab-characters');
      const traitTab = document.getElementById('scene-edit-tab-traits');
      const uttTab = document.getElementById('scene-edit-tab-utterances');
      
      if (charTab) charTab.classList.toggle('hidden', tab !== 'characters');
      if (traitTab) traitTab.classList.toggle('hidden', tab !== 'traits');
      if (uttTab) uttTab.classList.toggle('hidden', tab !== 'utterances');
      
      // Load utterances when switching to that tab
      if (tab === 'utterances' && window.UtterancesTab && this.currentSceneId) {
        window.UtterancesTab.load(this.currentSceneId);
      }
    },
    
    /**
     * Render Characters Tab (Tab A)
     */
    renderCharactersTab() {
      const container = document.getElementById('scene-edit-tab-characters');
      if (!container) return;
      
      if (this.characters.length === 0) {
        container.innerHTML = `
          <div class="p-4 bg-amber-50 border border-amber-200 rounded-lg">
            <p class="text-amber-800 text-sm">
              <i class="fas fa-exclamation-triangle mr-2"></i>
              キャラクターが登録されていません。
            </p>
            <p class="text-amber-700 text-xs mt-2">
              先に「Styles」タブの「Characters」セクションでキャラクターを登録してください。
            </p>
          </div>
        `;
        return;
      }
      
      container.innerHTML = `
        <!-- Image Characters -->
        <div class="mb-6">
          <label class="block text-sm font-semibold text-gray-700 mb-3">
            <i class="fas fa-image mr-1 text-blue-600"></i>画像キャラクター（最大3人）
          </label>
          <div class="space-y-2" id="edit-image-char-list">
            ${this.characters.map(char => this.renderCharacterCheckbox(char)).join('')}
          </div>
          <p class="text-xs text-gray-500 mt-2">
            <i class="fas fa-info-circle mr-1"></i>
            画像に登場するキャラクターを選択してください
          </p>
        </div>
        
        <!-- Voice Character -->
        <div>
          <label class="block text-sm font-semibold text-gray-700 mb-3">
            <i class="fas fa-microphone mr-1 text-green-600"></i>音声キャラクター（1人）
          </label>
          <select 
            id="edit-voice-char-select"
            class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
          >
            <option value="">-- 音声キャラクターを選択 --</option>
            ${this.currentState.imageCharacterKeys.map(key => {
              const char = this.characters.find(c => c.character_key === key);
              return char ? `<option value="${this.escapeHtml(key)}" ${key === this.currentState.voiceCharacterKey ? 'selected' : ''}>${this.escapeHtml(char.character_name)}</option>` : '';
            }).join('')}
          </select>
          <p class="text-xs text-gray-500 mt-2">
            <i class="fas fa-info-circle mr-1"></i>
            セリフを喋るキャラクターを選択（画像キャラから選択）
          </p>
        </div>
      `;
      
      // Bind events for character checkboxes
      this.bindCharacterEvents();
    },
    
    /**
     * Render a single character checkbox
     */
    renderCharacterCheckbox(char) {
      const isChecked = this.currentState.imageCharacterKeys.includes(char.character_key);
      const hasImage = !!char.reference_image_r2_url;
      
      return `
        <label class="flex items-center gap-3 p-3 border border-gray-200 rounded-lg hover:bg-gray-50 cursor-pointer ${isChecked ? 'bg-blue-50 border-blue-300' : ''}">
          <input 
            type="checkbox" 
            class="image-char-check w-5 h-5 text-blue-600" 
            data-character-key="${this.escapeHtml(char.character_key)}"
            ${isChecked ? 'checked' : ''}
          />
          ${hasImage 
            ? `<img src="${char.reference_image_r2_url}" class="w-10 h-10 rounded-full object-cover border-2 border-gray-200" />`
            : `<div class="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center">
                 <i class="fas fa-user text-gray-400"></i>
               </div>`
          }
          <div class="flex-1">
            <span class="font-medium text-gray-800">${this.escapeHtml(char.character_name)}</span>
            ${char.story_traits 
              ? `<p class="text-xs text-gray-500 truncate">${this.escapeHtml(char.story_traits.substring(0, 40))}${char.story_traits.length > 40 ? '...' : ''}</p>`
              : ''
            }
          </div>
        </label>
      `;
    },
    
    /**
     * Bind events for character selection
     */
    bindCharacterEvents() {
      // Image character checkboxes
      document.querySelectorAll('.image-char-check').forEach(checkbox => {
        checkbox.addEventListener('change', (e) => {
          const key = e.target.dataset.characterKey;
          const checked = e.target.checked;
          
          if (checked) {
            // Check max 3
            if (this.currentState.imageCharacterKeys.length >= 3) {
              e.target.checked = false;
              this.showToast('画像キャラクターは最大3人まで選択できます', 'warning');
              return;
            }
            this.currentState.imageCharacterKeys.push(key);
          } else {
            this.currentState.imageCharacterKeys = this.currentState.imageCharacterKeys.filter(k => k !== key);
            // Also remove from voice if it was the voice character
            if (this.currentState.voiceCharacterKey === key) {
              this.currentState.voiceCharacterKey = this.currentState.imageCharacterKeys[0] || null;
            }
          }
          
          // Update voice character dropdown
          this.updateVoiceCharacterDropdown();
          // Update save button
          this.updateSaveButtonState();
          // Update traits tab (available characters changed)
          this.renderTraitsTab();
          this.renderTabs();
          // Update checkbox styling
          this.renderCharactersTab();
          this.bindCharacterEvents();
        });
      });
      
      // Voice character dropdown
      const voiceSelect = document.getElementById('edit-voice-char-select');
      if (voiceSelect) {
        voiceSelect.addEventListener('change', (e) => {
          this.currentState.voiceCharacterKey = e.target.value || null;
          this.updateSaveButtonState();
        });
      }
    },
    
    /**
     * Update voice character dropdown options
     */
    updateVoiceCharacterDropdown() {
      const select = document.getElementById('edit-voice-char-select');
      if (!select) return;
      
      select.innerHTML = `
        <option value="">-- 音声キャラクターを選択 --</option>
        ${this.currentState.imageCharacterKeys.map(key => {
          const char = this.characters.find(c => c.character_key === key);
          const isSelected = key === this.currentState.voiceCharacterKey;
          return char ? `<option value="${this.escapeHtml(key)}" ${isSelected ? 'selected' : ''}>${this.escapeHtml(char.character_name)}</option>` : '';
        }).join('')}
      `;
      
      // Auto-select first if current is not in list
      if (!this.currentState.imageCharacterKeys.includes(this.currentState.voiceCharacterKey) && this.currentState.imageCharacterKeys.length > 0) {
        this.currentState.voiceCharacterKey = this.currentState.imageCharacterKeys[0];
        select.value = this.currentState.voiceCharacterKey;
      }
    },
    
    /**
     * Render Traits Tab (Tab B)
     */
    renderTraitsTab() {
      const container = document.getElementById('scene-edit-tab-traits');
      if (!container) return;
      
      // Only show assigned characters
      const assignedChars = this.characters.filter(c => 
        this.currentState.imageCharacterKeys.includes(c.character_key)
      );
      
      if (assignedChars.length === 0) {
        container.innerHTML = `
          <div class="p-4 bg-gray-50 border border-gray-200 rounded-lg text-center">
            <i class="fas fa-users-slash text-gray-400 text-3xl mb-2"></i>
            <p class="text-gray-600">
              先に「キャラ割り当て」タブでキャラクターを選択してください
            </p>
          </div>
        `;
        return;
      }
      
      container.innerHTML = `
        <!-- Simple explanation -->
        <div class="mb-4 p-4 bg-gradient-to-r from-yellow-100 to-yellow-50 border-2 border-yellow-400 rounded-lg">
          <p class="text-yellow-800 font-bold text-sm mb-2">
            <i class="fas fa-star mr-1"></i>ここでできること
          </p>
          <p class="text-yellow-700 text-sm">
            <strong>変身・衣装変更・状態変化</strong>など、<strong>このシーンだけ</strong>普段と違う見た目にしたい場合に設定します。
          </p>
          <p class="text-yellow-600 text-xs mt-2">
            ⚠️ セリフ・感情・行動は入れないでください（画像に文字が表示されます）
          </p>
        </div>
        
        <!-- Quick legend -->
        <div class="mb-4 flex flex-wrap gap-3 text-xs">
          <div class="flex items-center gap-1">
            <span class="inline-flex items-center justify-center w-5 h-5 rounded text-white font-bold bg-gray-500">A</span>
            <span class="text-gray-600">キャラ登録（Stylesで設定）</span>
          </div>
          <div class="flex items-center gap-1">
            <span class="inline-flex items-center justify-center w-5 h-5 rounded text-white font-bold bg-purple-500">B</span>
            <span class="text-purple-600">物語共通（Stylesで設定）</span>
          </div>
          <div class="flex items-center gap-1">
            <span class="inline-flex items-center justify-center w-5 h-5 rounded text-white font-bold bg-yellow-500">C</span>
            <span class="text-yellow-700 font-bold">このシーン専用 ← ここで編集</span>
          </div>
        </div>
        
        <!-- Character trait editors -->
        <div class="space-y-4">
          ${assignedChars.map(char => this.renderCharacterTraitEditor(char)).join('')}
        </div>
      `;
      
      // Bind trait input events
      this.bindTraitEvents();
    },
    
    /**
     * Render trait editor for a single character
     * Clearer UI: Show what's editable here vs what needs Styles tab
     */
    renderCharacterTraitEditor(char) {
      const currentTrait = this.currentState.sceneTraits[char.character_key] || '';
      const hasOverride = currentTrait && currentTrait.trim();
      const aiCandidate = this.aiCandidates[char.character_key] || null;
      const isLoading = this.aiLoading[char.character_key] || false;
      
      return `
        <div class="p-4 border-2 rounded-lg ${hasOverride ? 'bg-yellow-50 border-yellow-400' : 'bg-white border-gray-200'}" data-trait-card="${this.escapeHtml(char.character_key)}">
          <!-- Header -->
          <div class="flex items-center gap-3 mb-4">
            ${char.reference_image_r2_url 
              ? `<img src="${char.reference_image_r2_url}" class="w-12 h-12 rounded-full object-cover border-2 border-indigo-300 shadow" />`
              : `<div class="w-12 h-12 rounded-full bg-gray-200 flex items-center justify-center">
                   <i class="fas fa-user text-gray-400 text-lg"></i>
                 </div>`
            }
            <div class="flex-1">
              <h4 class="font-bold text-gray-800 text-lg">${this.escapeHtml(char.character_name)}</h4>
              ${hasOverride 
                ? '<span class="text-xs bg-yellow-500 text-white px-2 py-0.5 rounded font-semibold">⚡ このシーン専用の特徴あり</span>' 
                : '<span class="text-xs text-gray-500">通常の特徴を使用中</span>'
              }
            </div>
          </div>
          
          <!-- Reference Info: A & B (Read-only, set in Styles tab) -->
          <div class="mb-4 p-3 bg-gray-100 rounded-lg border border-gray-300 opacity-70">
            <div class="flex items-center justify-between mb-2">
              <span class="text-xs font-bold text-gray-600">
                <i class="fas fa-lock mr-1"></i>参照情報（Stylesタブで変更）
              </span>
              <span class="text-xs text-gray-400">編集不可</span>
            </div>
            <div class="text-xs space-y-2">
              <div class="flex items-start gap-2">
                <span class="inline-flex items-center justify-center w-6 h-5 rounded text-white font-bold text-xs bg-gray-500">A</span>
                <div class="flex-1">
                  <span class="text-gray-500 font-semibold">キャラ登録:</span>
                  <span class="text-gray-600 ml-1">${char.appearance_description ? this.escapeHtml(char.appearance_description.substring(0, 50)) + (char.appearance_description.length > 50 ? '...' : '') : '<i class="text-gray-400">未設定</i>'}</span>
                </div>
              </div>
              <div class="flex items-start gap-2">
                <span class="inline-flex items-center justify-center w-6 h-5 rounded text-white font-bold text-xs bg-purple-500">B</span>
                <div class="flex-1">
                  <span class="text-purple-600 font-semibold">物語共通:</span>
                  <span class="text-purple-700 ml-1">${char.story_traits ? this.escapeHtml(char.story_traits.substring(0, 50)) + (char.story_traits.length > 50 ? '...' : '') : '<i class="text-gray-400">未設定</i>'}</span>
                </div>
              </div>
            </div>
          </div>
          
          <!-- Editable Section: C (Scene-specific) -->
          <div class="p-3 bg-yellow-50 rounded-lg border-2 border-yellow-400">
            <div class="flex items-center gap-2 mb-2">
              <span class="inline-flex items-center justify-center w-6 h-5 rounded text-white font-bold text-xs bg-yellow-500">C</span>
              <span class="text-sm font-bold text-yellow-700">
                <i class="fas fa-edit mr-1"></i>このシーンだけの特徴
              </span>
              <span class="text-xs text-yellow-600 bg-yellow-200 px-2 py-0.5 rounded">ここで編集</span>
            </div>
            
            <!-- AI Assist -->
            <div class="mb-3 p-2 bg-white rounded border border-yellow-300">
              <div class="flex items-center justify-between mb-1">
                <span class="text-xs text-blue-600 font-semibold">
                  <i class="fas fa-robot mr-1"></i>AI補助
                </span>
                <button 
                  type="button"
                  class="ai-extract-btn text-xs px-2 py-1 bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors ${isLoading ? 'opacity-50 cursor-wait' : ''}"
                  data-character-key="${this.escapeHtml(char.character_key)}"
                  ${isLoading ? 'disabled' : ''}
                >
                  ${isLoading 
                    ? '<i class="fas fa-spinner fa-spin mr-1"></i>抽出中...'
                    : '<i class="fas fa-magic mr-1"></i>セリフから抽出'
                  }
                </button>
              </div>
              <div class="ai-candidate-area text-sm min-h-[28px]" data-candidate-area="${this.escapeHtml(char.character_key)}">
                ${aiCandidate !== null 
                  ? aiCandidate 
                    ? `<div class="flex items-center justify-between gap-2 p-1 bg-blue-50 rounded">
                         <span class="text-blue-800">${this.escapeHtml(aiCandidate)}</span>
                         <button 
                           type="button"
                           class="use-candidate-btn text-xs px-2 py-1 bg-green-500 text-white rounded hover:bg-green-600 transition-colors flex-shrink-0"
                           data-character-key="${this.escapeHtml(char.character_key)}"
                         >
                           <i class="fas fa-arrow-down mr-1"></i>入力欄へ
                         </button>
                       </div>`
                    : '<span class="text-gray-400 italic">特徴が見つかりませんでした</span>'
                  : '<span class="text-gray-400 italic">セリフから特徴を自動抽出できます</span>'
                }
              </div>
            </div>
            
            <!-- Input Field -->
            <div>
              <textarea 
                class="scene-trait-input w-full px-3 py-2 border-2 border-yellow-400 rounded-lg focus:outline-none focus:ring-2 focus:ring-yellow-500 text-sm bg-white"
                data-character-key="${this.escapeHtml(char.character_key)}"
                rows="2"
                placeholder="例: 人間に変身して羽が消えた / 戦闘で傷だらけ / 正装を着ている"
              >${this.escapeHtml(currentTrait)}</textarea>
              <p class="text-xs text-yellow-700 mt-1 font-medium">
                <i class="fas fa-lightbulb mr-1"></i>
                空欄 → 通常の特徴（B or A）を使用 ／ 入力 → このシーンだけ上書き
              </p>
            </div>
          </div>
        </div>
      `;
    },
    
    /**
     * Bind trait input events
     */
    bindTraitEvents() {
      // Text input events
      document.querySelectorAll('.scene-trait-input').forEach(input => {
        input.addEventListener('input', (e) => {
          const key = e.target.dataset.characterKey;
          this.currentState.sceneTraits[key] = e.target.value;
          this.updateSaveButtonState();
        });
      });
      
      // AI extract buttons
      document.querySelectorAll('.ai-extract-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const key = e.target.closest('.ai-extract-btn').dataset.characterKey;
          this.extractAiCandidate(key);
        });
      });
      
      // Use candidate buttons
      document.querySelectorAll('.use-candidate-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const key = e.target.closest('.use-candidate-btn').dataset.characterKey;
          this.useCandidate(key);
        });
      });
    },
    
    /**
     * Extract AI candidate from scene dialogue
     * @param {string} characterKey 
     */
    async extractAiCandidate(characterKey) {
      if (this.aiLoading[characterKey]) return;
      
      const char = this.characters.find(c => c.character_key === characterKey);
      if (!char) return;
      
      console.log(`[SceneEditModal] Extracting AI candidate for ${characterKey}`);
      
      // Set loading state
      this.aiLoading[characterKey] = true;
      this.renderTraitsTab();
      this.bindTraitEvents();
      
      try {
        // Extract traits from scene dialogue (client-side extraction)
        const dialogue = this.sceneData?.dialogue || '';
        const imagePrompt = this.sceneData?.image_prompt || '';
        const text = `${dialogue} ${imagePrompt}`;
        
        // Extract visual traits for this character
        const candidate = this.extractVisualTraitsFromText(text, char.character_name);
        
        // Store candidate
        this.aiCandidates[characterKey] = candidate;
        
        if (!candidate) {
          this.showToast('視覚的特徴が見つかりませんでした', 'info');
        }
      } catch (error) {
        console.error('[SceneEditModal] AI extraction failed:', error);
        this.aiCandidates[characterKey] = '';
        this.showToast('特徴の抽出に失敗しました', 'error');
      } finally {
        this.aiLoading[characterKey] = false;
        this.renderTraitsTab();
        this.bindTraitEvents();
      }
    },
    
    /**
     * Extract visual traits from text (client-side, no AI API call)
     * @param {string} text - Scene text
     * @param {string} characterName - Character name to find
     * @returns {string} Extracted visual traits
     */
    extractVisualTraitsFromText(text, characterName) {
      if (!text || !characterName) return '';
      
      // Remove dialogue in 「」 to avoid text on images
      let cleanText = text.replace(/「[^」]*」/g, '');
      
      // Patterns for visual traits to look for
      const visualPatterns = [
        // Species/type
        /(?:小さな)?(?:妖精|精霊|人間|少女|少年|女性|男性|エルフ|魔女|魔法使い)/g,
        // Physical features
        /(?:透明な|キラキラ(?:と)?光る|大きな|小さな|長い|短い)?(?:羽|翼|しっぽ|尻尾|耳|角|目|瞳|髪)/g,
        // Clothing/items
        /(?:青い|赤い|白い|黒い|緑の|金色の)?(?:ドレス|服|衣装|マント|帽子|杖|剣)/g,
        // Transformation
        /(?:人間の姿|妖精の姿|変身し|姿を変え)/g,
        // State changes
        /(?:羽が消え|羽が現れ|光を放|輝き)/g,
      ];
      
      // Exclude patterns (emotions, actions, speech)
      const excludePatterns = [
        /[泣笑怒叫言答驚悲喜思考願祈呼聞見][いきくけこっ]*/g,
        /ありがとう|ごめん|すみません|一緒に|来い|行こう|待って|お願い/g,
        /という|と言って|と答え|と叫|驚きを隠せなかっ|故郷を救/g,
        /涙を浮かべ|笑顔で/g,
      ];
      
      // Find sentences containing the character name
      const sentences = cleanText.split(/[。！？\n]/);
      const relevantSentences = sentences.filter(s => s.includes(characterName));
      
      if (relevantSentences.length === 0) {
        // Try to find any visual traits in the text
        let traits = [];
        for (const pattern of visualPatterns) {
          const matches = cleanText.match(pattern);
          if (matches) {
            traits.push(...matches);
          }
        }
        // Remove duplicates and limit
        traits = [...new Set(traits)].slice(0, 5);
        return traits.length > 0 ? traits.join('、') : '';
      }
      
      // Extract traits from relevant sentences
      let traits = [];
      for (const sentence of relevantSentences) {
        // Apply exclude patterns
        let cleaned = sentence;
        for (const pattern of excludePatterns) {
          cleaned = cleaned.replace(pattern, '');
        }
        
        // Find visual traits
        for (const pattern of visualPatterns) {
          const matches = cleaned.match(pattern);
          if (matches) {
            traits.push(...matches);
          }
        }
      }
      
      // Remove duplicates and clean up
      traits = [...new Set(traits)]
        .filter(t => t.length > 1)
        .slice(0, 5);
      
      return traits.length > 0 ? traits.join('、') : '';
    },
    
    /**
     * Use AI candidate - copy to input field
     * @param {string} characterKey 
     */
    useCandidate(characterKey) {
      const candidate = this.aiCandidates[characterKey];
      
      if (!candidate || !candidate.trim()) {
        this.showToast('候補がありません', 'warning');
        return;
      }
      
      // Set to current state
      this.currentState.sceneTraits[characterKey] = candidate;
      
      // Update input field
      const input = document.querySelector(`.scene-trait-input[data-character-key="${characterKey}"]`);
      if (input) {
        input.value = candidate;
      }
      
      // Update save button state (now dirty)
      this.updateSaveButtonState();
      
      this.showToast('候補を入力欄にコピーしました', 'success');
    },
    
    /**
     * Check if there are unsaved changes (dirty state)
     */
    isDirty() {
      // Check image characters
      const origChars = [...this.originalState.imageCharacterKeys].sort();
      const currChars = [...this.currentState.imageCharacterKeys].sort();
      if (JSON.stringify(origChars) !== JSON.stringify(currChars)) {
        return true;
      }
      
      // Check voice character
      if (this.originalState.voiceCharacterKey !== this.currentState.voiceCharacterKey) {
        return true;
      }
      
      // Check traits
      const allKeys = new Set([
        ...Object.keys(this.originalState.sceneTraits),
        ...Object.keys(this.currentState.sceneTraits)
      ]);
      
      for (const key of allKeys) {
        const orig = (this.originalState.sceneTraits[key] || '').trim();
        const curr = (this.currentState.sceneTraits[key] || '').trim();
        if (orig !== curr) {
          return true;
        }
      }
      
      return false;
    },
    
    /**
     * Update save button state based on dirty check
     */
    updateSaveButtonState() {
      const saveBtn = document.getElementById('save-edit-scene');
      if (!saveBtn) return;
      
      const dirty = this.isDirty();
      
      if (dirty) {
        saveBtn.disabled = false;
        saveBtn.classList.remove('opacity-50', 'cursor-not-allowed');
        saveBtn.classList.add('hover:bg-blue-700');
        saveBtn.innerHTML = '<i class="fas fa-save mr-2"></i>保存';
      } else {
        saveBtn.disabled = true;
        saveBtn.classList.add('opacity-50', 'cursor-not-allowed');
        saveBtn.classList.remove('hover:bg-blue-700');
        saveBtn.innerHTML = '<i class="fas fa-check mr-2"></i>変更なし';
      }
    },
    
    /**
     * Close with confirmation if dirty
     */
    closeWithConfirm() {
      if (this.isDirty()) {
        if (!confirm('変更が保存されていません。破棄しますか？')) {
          return;
        }
      }
      this.close();
    },
    
    /**
     * Close modal
     */
    close() {
      console.log('[SceneEditModal] Closing');
      const modal = document.getElementById('scene-edit-modal');
      if (modal) {
        modal.classList.add('hidden');
      }
      this.currentSceneId = null;
      this.currentSceneIdx = null;
      this.activeTab = 'characters';
    },
    
    /**
     * Save all changes (SSOT: single save for everything)
     */
    async save() {
      if (!this.currentSceneId) return;
      
      if (!this.isDirty()) {
        this.showToast('変更がありません', 'info');
        return;
      }
      
      console.log(`[SceneEditModal] Saving scene ${this.currentSceneId}`);
      
      const saveBtn = document.getElementById('save-edit-scene');
      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>保存中...';
      }
      
      try {
        // Build scene_traits array (only non-empty)
        const sceneTraits = [];
        for (const [key, value] of Object.entries(this.currentState.sceneTraits)) {
          sceneTraits.push({
            character_key: key,
            override_traits: (value || '').trim()
          });
        }
        
        // Call SSOT save API
        const response = await axios.post(`/api/scenes/${this.currentSceneId}/save-edit-context`, {
          image_character_keys: this.currentState.imageCharacterKeys,
          voice_character_key: this.currentState.voiceCharacterKey,
          scene_traits: sceneTraits
        });
        
        if (response.data.success) {
          // Update original state to match current (no longer dirty)
          this.originalState = {
            imageCharacterKeys: [...this.currentState.imageCharacterKeys],
            voiceCharacterKey: this.currentState.voiceCharacterKey,
            sceneTraits: { ...this.currentState.sceneTraits }
          };
          
          this.showToast('保存しました', 'success');
          this.close();
          
          // Reload scenes list
          if (typeof window.renderBuilderScenes === 'function') {
            window.renderBuilderScenes(window.lastLoadedScenes, window.builderPagination?.currentPage || 1);
          } else if (typeof loadScenes === 'function') {
            loadScenes();
          }
          
          // Refresh character traits summary if visible
          if (typeof window.loadCharacterTraitsSummary === 'function') {
            window.loadCharacterTraitsSummary();
          }
        } else {
          throw new Error(response.data.error?.message || 'Save failed');
        }
      } catch (error) {
        console.error('[SceneEditModal] Save failed:', error);
        this.showToast('保存に失敗しました', 'error');
      } finally {
        if (saveBtn) {
          saveBtn.disabled = false;
          saveBtn.innerHTML = '<i class="fas fa-save mr-2"></i>保存';
        }
        this.updateSaveButtonState();
      }
    },
    
    /**
     * Show toast notification
     * @param {string} message 
     * @param {string} type - 'success' | 'error' | 'warning' | 'info'
     */
    showToast(message, type = 'success') {
      if (typeof window.showToast === 'function') {
        window.showToast(message, type);
      } else if (typeof toast === 'function') {
        toast(message, type);
      } else {
        alert(message);
      }
    },
    
    /**
     * Escape HTML to prevent XSS
     * @param {string} str 
     * @returns {string}
     */
    escapeHtml(str) {
      if (!str) return '';
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }
  };
  
  // Initialize on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => SceneEditModal.init());
  } else {
    SceneEditModal.init();
  }
  
  // Export to global scope
  window.SceneEditModal = SceneEditModal;
})();
