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
     * @param {string} tab - 'characters' | 'traits'
     */
    switchTab(tab) {
      this.activeTab = tab;
      
      // Update tab button styles
      document.querySelectorAll('.scene-edit-tab-btn').forEach(btn => {
        const isActive = btn.dataset.sceneEditTab === tab;
        btn.classList.toggle('border-blue-500', isActive && tab === 'characters');
        btn.classList.toggle('text-blue-600', isActive && tab === 'characters');
        btn.classList.toggle('border-indigo-500', isActive && tab === 'traits');
        btn.classList.toggle('text-indigo-600', isActive && tab === 'traits');
        btn.classList.toggle('border-transparent', !isActive);
        btn.classList.toggle('text-gray-500', !isActive);
      });
      
      // Show/hide tab content
      const charTab = document.getElementById('scene-edit-tab-characters');
      const traitTab = document.getElementById('scene-edit-tab-traits');
      
      if (charTab) charTab.classList.toggle('hidden', tab !== 'characters');
      if (traitTab) traitTab.classList.toggle('hidden', tab !== 'traits');
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
        <!-- Warning about traits -->
        <div class="mb-4 p-3 bg-amber-50 border border-amber-200 rounded-lg">
          <p class="text-amber-800 text-sm font-semibold">
            <i class="fas fa-exclamation-triangle mr-1"></i>
            特徴は視覚的特徴のみ入力してください
          </p>
          <p class="text-amber-700 text-xs mt-1">
            セリフ・感情・行動を入れると画像にテキストが表示されてしまいます。
          </p>
        </div>
        
        <!-- Trait layers explanation -->
        <div class="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg">
          <p class="text-blue-800 text-sm font-semibold mb-2">
            <i class="fas fa-layer-group mr-1"></i>特徴の3層構造
          </p>
          <div class="text-xs space-y-1">
            <div class="flex items-center gap-2">
              <span class="inline-block w-3 h-3 bg-yellow-400 rounded"></span>
              <span><strong>C: シーン別</strong>（このシーンのみ）→ 最優先</span>
            </div>
            <div class="flex items-center gap-2">
              <span class="inline-block w-3 h-3 bg-purple-400 rounded"></span>
              <span><strong>B: 物語共通</strong>（全シーン）</span>
            </div>
            <div class="flex items-center gap-2">
              <span class="inline-block w-3 h-3 bg-gray-400 rounded"></span>
              <span><strong>A: キャラ登録</strong>（基礎設定）</span>
            </div>
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
     */
    renderCharacterTraitEditor(char) {
      const currentTrait = this.currentState.sceneTraits[char.character_key] || '';
      const hasOverride = currentTrait && currentTrait.trim();
      
      return `
        <div class="p-4 border border-gray-200 rounded-lg ${hasOverride ? 'bg-yellow-50 border-yellow-300' : ''}">
          <div class="flex items-center gap-3 mb-3">
            ${char.reference_image_r2_url 
              ? `<img src="${char.reference_image_r2_url}" class="w-10 h-10 rounded-full object-cover border-2 border-indigo-200" />`
              : `<div class="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center">
                   <i class="fas fa-user text-gray-400"></i>
                 </div>`
            }
            <div class="flex-1">
              <h4 class="font-semibold text-gray-800">${this.escapeHtml(char.character_name)}</h4>
              ${hasOverride 
                ? '<span class="text-xs bg-yellow-400 text-yellow-800 px-2 py-0.5 rounded">シーン別特徴あり</span>' 
                : ''
              }
            </div>
          </div>
          
          <!-- Current composite traits (read-only) -->
          <div class="mb-3">
            <label class="block text-xs font-semibold text-gray-500 mb-1">
              現在適用される特徴（C > B > A）
            </label>
            <div class="text-sm text-gray-700 bg-white p-2 rounded border border-gray-200">
              ${hasOverride 
                ? `<span class="text-yellow-700"><i class="fas fa-exchange-alt mr-1"></i><strong>C:</strong> ${this.escapeHtml(currentTrait)}</span>`
                : char.story_traits 
                  ? `<span class="text-purple-700"><strong>B:</strong> ${this.escapeHtml(char.story_traits)}</span>`
                  : char.appearance_description 
                    ? `<span class="text-gray-600"><strong>A:</strong> ${this.escapeHtml(char.appearance_description)}</span>`
                    : '<span class="italic text-gray-400">特徴未設定</span>'
              }
            </div>
          </div>
          
          <!-- Scene-specific trait input -->
          <div>
            <label class="block text-xs font-semibold text-indigo-700 mb-1">
              <i class="fas fa-layer-group mr-1"></i>
              このシーンでの特徴変化（C層）
            </label>
            <textarea 
              class="scene-trait-input w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 text-sm"
              data-character-key="${this.escapeHtml(char.character_key)}"
              rows="2"
              placeholder="例: 人間の姿に変身。妖精の羽は消え、普通の少女の姿"
            >${this.escapeHtml(currentTrait)}</textarea>
            <p class="text-xs text-gray-500 mt-1">
              空欄にすると共通特徴（B）またはキャラ登録（A）が適用されます
            </p>
          </div>
        </div>
      `;
    },
    
    /**
     * Bind trait input events
     */
    bindTraitEvents() {
      document.querySelectorAll('.scene-trait-input').forEach(input => {
        input.addEventListener('input', (e) => {
          const key = e.target.dataset.characterKey;
          this.currentState.sceneTraits[key] = e.target.value;
          this.updateSaveButtonState();
        });
      });
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
