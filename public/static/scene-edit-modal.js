/**
 * Phase 2-3: Scene Edit Modal
 * Handles scene editing including character assignment (image + voice)
 */

(function() {
  'use strict';

  const SceneEditModal = {
    currentSceneId: null,
    characters: [], // All project characters
    
    /**
     * Initialize the modal
     */
    init() {
      console.log('[SceneEditModal] Initializing...');
      this.bindEvents();
    },
    
    /**
     * Bind event listeners
     */
    bindEvents() {
      const saveBtn = document.getElementById('save-edit-scene');
      const cancelBtn = document.getElementById('cancel-edit-scene');
      
      if (saveBtn) {
        saveBtn.addEventListener('click', () => this.saveScene());
      }
      
      if (cancelBtn) {
        cancelBtn.addEventListener('click', () => this.close());
      }
      
      // Close on background click
      const modal = document.getElementById('scene-edit-modal');
      if (modal) {
        modal.addEventListener('click', (e) => {
          if (e.target === modal) {
            this.close();
          }
        });
      }
    },
    
    /**
     * Open modal with scene data
     * @param {number} sceneId 
     */
    async open(sceneId) {
      console.log(`[SceneEditModal] Opening for scene ${sceneId}`);
      this.currentSceneId = sceneId;
      
      try {
        // Fetch scene data
        const scene = await this.fetchScene(sceneId);
        
        // Fetch project characters
        await this.fetchCharacters();
        
        // Populate form
        this.populateForm(scene);
        
        // Show modal
        const modal = document.getElementById('scene-edit-modal');
        if (modal) {
          modal.classList.remove('hidden');
        }
      } catch (error) {
        console.error('[SceneEditModal] Failed to open:', error);
        this.showToast('シーン情報の読み込みに失敗しました', 'error');
      }
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
    },
    
    /**
     * Fetch scene data
     * @param {number} sceneId 
     * @returns {Promise<object>}
     */
    async fetchScene(sceneId) {
      const response = await axios.get(`/api/projects/${window.PROJECT_ID}/scenes?view=board`);
      // API returns { scenes: [...] } or directly [...]
      const scenes = response.data.scenes || response.data || [];
      
      if (!Array.isArray(scenes)) {
        throw new Error('Invalid scenes data format');
      }
      
      const scene = scenes.find(s => s.id === sceneId);
      
      if (!scene) {
        throw new Error(`Scene ${sceneId} not found`);
      }
      
      return scene;
    },
    
    /**
     * Fetch project characters
     */
    async fetchCharacters() {
      try {
        const response = await axios.get(`/api/projects/${window.PROJECT_ID}/characters`);
        // API returns { characters: [...] }
        this.characters = response.data?.characters || response.data || [];
        // Ensure it's an array
        if (!Array.isArray(this.characters)) {
          console.warn('[SceneEditModal] Characters data is not an array:', this.characters);
          this.characters = [];
        }
        console.log(`[SceneEditModal] Loaded ${this.characters.length} characters`);
      } catch (error) {
        console.error('[SceneEditModal] Failed to fetch characters:', error);
        this.characters = [];
      }
    },
    
    /**
     * Populate form with scene data
     * @param {object} scene 
     */
    populateForm(scene) {
      // Basic fields
      document.getElementById('edit-scene-id').value = scene.id;
      document.getElementById('edit-dialogue').value = scene.dialogue || '';
      document.getElementById('edit-bullets').value = (scene.bullets || []).join('\n');
      document.getElementById('edit-image-prompt').value = scene.image_prompt || '';
      
      // Phase1.7: 漫画モード時のセリフ編集を制御
      const displayAssetType = scene.display_asset_type || 'image';
      const isComicMode = displayAssetType === 'comic';
      const hasComicUtterances = scene.comic_data?.published?.utterances?.length > 0;
      
      const dialogueTextarea = document.getElementById('edit-dialogue');
      const dialogueLabel = dialogueTextarea?.previousElementSibling;
      
      if (isComicMode && hasComicUtterances) {
        // 漫画モード時: セリフ欄を読み取り専用にし、警告を表示
        if (dialogueTextarea) {
          dialogueTextarea.disabled = true;
          dialogueTextarea.classList.add('bg-gray-100', 'cursor-not-allowed');
          dialogueTextarea.title = '漫画モードでは発話は漫画エディタで編集してください';
        }
        
        // 警告メッセージを追加
        const warningId = 'comic-mode-dialogue-warning';
        let warningEl = document.getElementById(warningId);
        if (!warningEl && dialogueTextarea) {
          warningEl = document.createElement('div');
          warningEl.id = warningId;
          warningEl.className = 'mt-2 p-3 bg-orange-50 border border-orange-200 rounded-lg';
          warningEl.innerHTML = `
            <p class="text-orange-700 text-sm">
              <i class="fas fa-info-circle mr-2"></i>
              <strong>漫画モード:</strong> 発話は「漫画化」ボタンから編集してください。
            </p>
            <p class="text-orange-600 text-xs mt-1">
              現在 ${scene.comic_data?.published?.utterances?.length || 0} 件の発話が設定されています。
            </p>
          `;
          dialogueTextarea.parentNode.appendChild(warningEl);
        }
      } else {
        // 画像モード時: 通常編集可能
        if (dialogueTextarea) {
          dialogueTextarea.disabled = false;
          dialogueTextarea.classList.remove('bg-gray-100', 'cursor-not-allowed');
          dialogueTextarea.title = '';
        }
        
        // 警告メッセージを削除
        const warningEl = document.getElementById('comic-mode-dialogue-warning');
        if (warningEl) {
          warningEl.remove();
        }
      }
      
      // Character assignment
      this.renderImageCharacters(scene.characters || []);
      this.renderVoiceCharacter(scene.voice_character);
      
      // Phase X-5: Load and display character traits
      this.loadCharacterTraits(scene.id, scene.characters || []);
    },
    
    /**
     * Phase X-5: Load character traits for the scene
     * @param {number} sceneId 
     * @param {Array} assignedChars 
     */
    async loadCharacterTraits(sceneId, assignedChars) {
      const section = document.getElementById('edit-character-traits-section');
      const listContainer = document.getElementById('edit-character-traits-list');
      
      if (!section || !listContainer) return;
      
      if (!assignedChars || assignedChars.length === 0) {
        section.classList.add('hidden');
        return;
      }
      
      try {
        // Get scene-specific trait overrides
        const traitsResponse = await axios.get(`/api/scenes/${sceneId}/character-traits`);
        const sceneTraits = traitsResponse.data.scene_traits || [];
        const traitMap = new Map(sceneTraits.map(t => [t.character_key, t]));
        
        // Build display
        const html = assignedChars.map(char => {
          const override = traitMap.get(char.character_key);
          // Fetch base traits from characters array
          const fullChar = this.characters.find(c => c.character_key === char.character_key);
          const baseTraits = fullChar?.story_traits || fullChar?.appearance_description || null;
          
          return `
            <div class="flex items-start gap-2 py-1 ${override ? 'bg-yellow-50 px-2 rounded' : ''}">
              <span class="font-semibold text-indigo-700 text-sm">${this.escapeHtml(char.character_name || char.character_key)}:</span>
              <span class="flex-1 text-sm ${override ? 'text-yellow-700' : 'text-gray-600'}">
                ${override 
                  ? `<i class="fas fa-exchange-alt mr-1" title="シーン別オーバーライド"></i>${this.escapeHtml(override.trait_description)}`
                  : baseTraits 
                    ? this.escapeHtml(baseTraits) 
                    : '<span class="italic text-gray-400">特徴未設定</span>'
                }
              </span>
            </div>
          `;
        }).join('');
        
        listContainer.innerHTML = html || '<span class="text-gray-400 italic text-sm">特徴情報なし</span>';
        section.classList.remove('hidden');
      } catch (error) {
        console.warn('[SceneEditModal] Failed to load character traits:', error);
        section.classList.add('hidden');
      }
    },
    
    /**
     * Escape HTML for safe display
     * @param {string} str 
     * @returns {string}
     */
    escapeHtml(str) {
      if (!str) return '';
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    },
    
    /**
     * Render image character checkboxes
     * @param {Array} assignedChars - Currently assigned characters
     */
    renderImageCharacters(assignedChars) {
      const container = document.getElementById('edit-image-characters');
      if (!container) return;
      
      // キャラクターが0件の場合のメッセージ表示
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
      
      const assignedKeys = new Set(assignedChars.map(c => c.character_key));
      
      container.innerHTML = this.characters.map(char => `
        <label class="flex items-center gap-2 p-2 border border-gray-200 rounded hover:bg-gray-50 cursor-pointer">
          <input 
            type="checkbox" 
            class="image-char-checkbox" 
            value="${this.escapeHtml(char.character_key)}"
            ${assignedKeys.has(char.character_key) ? 'checked' : ''}
          />
          <span class="text-sm font-medium">${this.escapeHtml(char.character_name)}</span>
        </label>
      `).join('');
      
      // Add limit validation
      const checkboxes = container.querySelectorAll('.image-char-checkbox');
      checkboxes.forEach(cb => {
        cb.addEventListener('change', () => {
          const checked = container.querySelectorAll('.image-char-checkbox:checked');
          if (checked.length > 3) {
            cb.checked = false;
            this.showToast('画像キャラクターは最大3人まで選択できます', 'warning');
          }
        });
      });
    },
    
    /**
     * Render voice character dropdown
     * @param {object|null} voiceChar - Currently assigned voice character
     */
    renderVoiceCharacter(voiceChar) {
      const select = document.getElementById('edit-voice-character');
      if (!select) return;
      
      const currentKey = voiceChar?.character_key || '';
      
      // キャラクターが0件の場合は無効化
      if (this.characters.length === 0) {
        select.innerHTML = `<option value="">-- キャラクター未登録 --</option>`;
        select.disabled = true;
        return;
      }
      
      select.disabled = false;
      select.innerHTML = `
        <option value="">-- 音声キャラクターを選択 --</option>
        ${this.characters.map(char => `
          <option 
            value="${this.escapeHtml(char.character_key)}"
            ${char.character_key === currentKey ? 'selected' : ''}
          >
            ${this.escapeHtml(char.character_name)}
          </option>
        `).join('')}
      `;
    },
    
    /**
     * Save scene changes
     */
    async saveScene() {
      const sceneId = this.currentSceneId;
      if (!sceneId) return;
      
      console.log(`[SceneEditModal] Saving scene ${sceneId}`);
      
      try {
        // Collect form data
        const dialogue = document.getElementById('edit-dialogue').value.trim();
        const bulletsText = document.getElementById('edit-bullets').value.trim();
        const bullets = bulletsText ? bulletsText.split('\n').filter(b => b.trim()) : [];
        const imagePrompt = document.getElementById('edit-image-prompt').value.trim();
        
        // Collect character assignments
        const imageChars = Array.from(document.querySelectorAll('.image-char-checkbox:checked'))
          .map(cb => cb.value);
        const voiceChar = document.getElementById('edit-voice-character').value || null;
        
        console.log('[SceneEditModal] Data:', {
          dialogue,
          bullets,
          imagePrompt,
          imageChars,
          voiceChar
        });
        
        // Update scene basic data (dialogue, bullets, image_prompt)
        await this.updateScene(sceneId, { dialogue, bullets, image_prompt: imagePrompt });
        
        // Update character assignments
        await this.updateCharacters(sceneId, imageChars, voiceChar);
        
        // Success
        this.showToast('保存しました', 'success');
        this.close();
        
        // Reload scenes list
        if (typeof loadScenes === 'function') {
          loadScenes();
        }
      } catch (error) {
        console.error('[SceneEditModal] Save failed:', error);
        this.showToast('保存に失敗しました', 'error');
      }
    },
    
    /**
     * Update scene basic data
     * @param {number} sceneId 
     * @param {object} data - { dialogue, bullets, image_prompt }
     */
    async updateScene(sceneId, data) {
      const response = await axios.put(`/api/scenes/${sceneId}`, data);
      console.log('[SceneEditModal] Scene updated:', response.data);
    },
    
    /**
     * Update character assignments
     * @param {number} sceneId 
     * @param {Array<string>} imageChars 
     * @param {string|null} voiceChar 
     */
    async updateCharacters(sceneId, imageChars, voiceChar) {
      const response = await axios.post(`/api/scenes/${sceneId}/characters/batch`, {
        image_characters: imageChars,
        voice_character: voiceChar
      });
      
      console.log('[SceneEditModal] Characters updated:', response.data);
    },
    
    /**
     * Show toast notification
     * @param {string} message 
     * @param {string} type - 'success' | 'error' | 'warning'
     */
    showToast(message, type = 'success') {
      // Use existing toast function if available
      if (typeof toast === 'function') {
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
