/**
 * Phase X-5: Character Trait Edit Modal (Improved)
 * Proper modal UI for editing character traits (story-wide and scene-specific)
 * - Step 1: Character selection for scene overrides
 * - Step 2: Trait editing with AI suggestions
 */

(function() {
  'use strict';

  const CharacterTraitModal = {
    // State
    currentMode: null, // 'story', 'scene', or 'select'
    currentCharacterKey: null,
    currentCharacterName: null,
    currentSceneId: null,
    currentSceneIdx: null,
    sceneDialogue: null,
    sceneImagePrompt: null,
    sceneCharacters: [], // Characters assigned to current scene
    
    /**
     * Initialize the modal
     */
    init() {
      console.log('[CharacterTraitModal] Initializing improved modal...');
      this.bindEvents();
    },
    
    /**
     * Bind event listeners
     */
    bindEvents() {
      const modal = document.getElementById('character-trait-modal');
      const cancelBtn = document.getElementById('trait-modal-cancel');
      const saveBtn = document.getElementById('trait-modal-save');
      const aiDetectBtn = document.getElementById('trait-modal-ai-detect');
      const useAiBtn = document.getElementById('trait-modal-use-ai');
      
      if (cancelBtn) {
        cancelBtn.addEventListener('click', () => this.close());
      }
      
      if (saveBtn) {
        saveBtn.addEventListener('click', () => this.save());
      }
      
      if (aiDetectBtn) {
        aiDetectBtn.addEventListener('click', () => this.detectTraitsFromDialogue());
      }
      
      if (useAiBtn) {
        useAiBtn.addEventListener('click', () => this.useAiSuggestion());
      }
      
      // Close on background click
      if (modal) {
        modal.addEventListener('click', (e) => {
          if (e.target === modal) {
            this.close();
          }
        });
      }
    },
    
    /**
     * Open modal for editing story-wide traits
     */
    openForStoryTraits(characterKey, characterName, currentTraits, imageUrl) {
      this.currentMode = 'story';
      this.currentCharacterKey = characterKey;
      this.currentCharacterName = characterName;
      this.currentSceneId = null;
      
      // Show edit step, hide select step
      this.showStep('edit');
      
      // Update UI
      document.getElementById('trait-modal-mode').value = 'story';
      document.getElementById('trait-modal-character-key').value = characterKey;
      document.getElementById('trait-modal-title').innerHTML = 
        `<i class="fas fa-user-tag mr-2"></i>「${this.escapeHtml(characterName)}」の共通特徴`;
      
      // Character image
      this.setCharacterImage(imageUrl);
      
      document.getElementById('trait-modal-char-name').textContent = characterName;
      document.getElementById('trait-modal-char-subtitle').textContent = '共通特徴を編集（全シーンに適用）';
      
      // Description
      document.getElementById('trait-modal-description').innerHTML = `
        <p class="text-sm text-blue-700">
          <i class="fas fa-info-circle mr-1"></i>
          <strong>共通特徴</strong>は全シーンの画像生成に適用されます。<br>
          特定シーンで異なる描写が必要な場合は、シーン分割タブで「シーン別特徴を追加」してください。
        </p>
      `;
      
      // Hide scene-specific sections
      document.getElementById('trait-modal-ai-section').classList.add('hidden');
      document.getElementById('trait-modal-examples').classList.add('hidden');
      document.getElementById('trait-modal-current').classList.add('hidden');
      
      // Set current value
      document.getElementById('trait-modal-input').value = currentTraits || '';
      document.getElementById('trait-modal-input').placeholder = 
        '例: 小さな妖精、キラキラと光る羽を持つ、青いドレスを着ている';
      
      this.showModal();
    },
    
    /**
     * Open modal for scene character selection (Step 1)
     */
    async openForSceneOverrideSelection(sceneId, sceneIdx) {
      this.currentMode = 'select';
      this.currentSceneId = sceneId;
      this.currentSceneIdx = sceneIdx;
      
      // Show select step, hide edit step
      this.showStep('select');
      
      document.getElementById('trait-modal-title').innerHTML = 
        `<i class="fas fa-layer-group mr-2"></i>シーン #${sceneIdx} のキャラクター特徴設定`;
      
      // Hide save button in select mode
      document.getElementById('trait-modal-save').classList.add('hidden');
      
      this.showModal();
      
      // Load characters for this scene
      await this.loadSceneCharacters(sceneId);
    },
    
    /**
     * Load characters assigned to a scene
     */
    async loadSceneCharacters(sceneId) {
      const listEl = document.getElementById('trait-modal-character-list');
      if (!listEl) return;
      
      listEl.innerHTML = '<div class="text-center py-4"><i class="fas fa-spinner fa-spin mr-2"></i>読み込み中...</div>';
      
      try {
        const response = await axios.get(`/api/scenes/${sceneId}/characters`);
        const characters = response.data.scene_characters || [];
        this.sceneCharacters = characters;
        
        if (characters.length === 0) {
          listEl.innerHTML = `
            <div class="text-center py-6 bg-yellow-50 rounded-lg border border-yellow-200">
              <i class="fas fa-exclamation-triangle text-yellow-500 text-2xl mb-2"></i>
              <p class="text-yellow-700 font-semibold">キャラクターが割り当てられていません</p>
              <p class="text-sm text-yellow-600 mt-1">
                先にシーン編集でキャラクターを割り当ててください。
              </p>
            </div>
          `;
          return;
        }
        
        // Also get scene data for AI detection
        const scenesResp = await axios.get(`/api/projects/${window.PROJECT_ID}/scenes?view=board`);
        const scenes = scenesResp.data.scenes || [];
        const scene = scenes.find(s => s.id === sceneId);
        if (scene) {
          this.sceneDialogue = scene.dialogue || '';
          this.sceneImagePrompt = scene.image_prompt || '';
        }
        
        // Render character selection cards
        listEl.innerHTML = characters.map(char => {
          const hasImage = !!char.reference_image_r2_url;
          const traits = char.story_traits || char.appearance_description || '';
          
          return `
            <div class="p-4 bg-white border-2 border-gray-200 rounded-lg hover:border-indigo-400 hover:bg-indigo-50 cursor-pointer transition-all group"
                 onclick="CharacterTraitModal.selectCharacterForOverride('${char.character_key}', '${this.escapeHtml(char.character_name || char.character_key)}', '${this.escapeHtml(traits)}', '${char.reference_image_r2_url || ''}')">
              <div class="flex items-center gap-3">
                ${hasImage 
                  ? `<img src="${char.reference_image_r2_url}" class="w-12 h-12 rounded-full object-cover border-2 border-indigo-200" />`
                  : `<div class="w-12 h-12 rounded-full bg-gray-200 flex items-center justify-center">
                       <i class="fas fa-user text-gray-400"></i>
                     </div>`
                }
                <div class="flex-1">
                  <h4 class="font-bold text-gray-800 group-hover:text-indigo-700">
                    ${this.escapeHtml(char.character_name || char.character_key)}
                    ${char.is_primary ? '<span class="ml-2 text-xs bg-indigo-100 text-indigo-600 px-2 py-0.5 rounded">メイン</span>' : ''}
                  </h4>
                  <p class="text-sm text-gray-500 truncate">
                    ${traits ? this.escapeHtml(traits.substring(0, 50)) + (traits.length > 50 ? '...' : '') : '<span class="italic">特徴未設定</span>'}
                  </p>
                </div>
                <i class="fas fa-chevron-right text-gray-400 group-hover:text-indigo-600"></i>
              </div>
            </div>
          `;
        }).join('');
        
      } catch (error) {
        console.error('[CharacterTraitModal] Failed to load characters:', error);
        listEl.innerHTML = `
          <div class="text-center py-4 text-red-500">
            <i class="fas fa-exclamation-circle mr-1"></i>読み込みエラー
          </div>
        `;
      }
    },
    
    /**
     * Select a character and proceed to trait editing (Step 2)
     */
    async selectCharacterForOverride(characterKey, characterName, currentTraits, imageUrl) {
      this.currentMode = 'scene';
      this.currentCharacterKey = characterKey;
      this.currentCharacterName = characterName;
      
      // Switch to edit step
      this.showStep('edit');
      
      // Show save button
      document.getElementById('trait-modal-save').classList.remove('hidden');
      
      // Update UI
      document.getElementById('trait-modal-mode').value = 'scene';
      document.getElementById('trait-modal-character-key').value = characterKey;
      document.getElementById('trait-modal-scene-id').value = this.currentSceneId;
      document.getElementById('trait-modal-title').innerHTML = 
        `<i class="fas fa-layer-group mr-2"></i>シーン #${this.currentSceneIdx}「${this.escapeHtml(characterName)}」`;
      
      // Character image
      this.setCharacterImage(imageUrl);
      
      document.getElementById('trait-modal-char-name').textContent = characterName;
      document.getElementById('trait-modal-char-subtitle').textContent = `シーン #${this.currentSceneIdx} での特徴オーバーライド`;
      
      // Description
      document.getElementById('trait-modal-description').innerHTML = `
        <p class="text-sm text-blue-700">
          <i class="fas fa-info-circle mr-1"></i>
          <strong>シーン別オーバーライド</strong>はこのシーンの画像生成のみに適用されます。<br>
          変身・衣装変更・状態変化など、共通特徴と異なる描写が必要な場合に設定してください。
        </p>
      `;
      
      // Show scene-specific sections
      document.getElementById('trait-modal-ai-section').classList.remove('hidden');
      document.getElementById('trait-modal-examples').classList.remove('hidden');
      
      // Show current story traits
      const currentSection = document.getElementById('trait-modal-current');
      const currentValue = document.getElementById('trait-modal-current-value');
      if (currentTraits) {
        currentValue.textContent = currentTraits;
        currentValue.classList.remove('italic', 'text-gray-400');
        currentSection.classList.remove('hidden');
      } else {
        currentValue.textContent = '未設定';
        currentValue.classList.add('italic', 'text-gray-400');
        currentSection.classList.remove('hidden');
      }
      
      // Clear and set placeholder
      document.getElementById('trait-modal-input').value = '';
      document.getElementById('trait-modal-input').placeholder = 
        '例: 人間の姿に変身した。妖精の羽は消え、普通の少女の姿になっている';
      
      // Auto-detect traits from dialogue
      await this.detectTraitsFromDialogue();
    },
    
    /**
     * Open modal for editing existing scene-specific trait override
     */
    async openForSceneOverride(sceneId, sceneIdx, characterKey, characterName, dialogue, currentStoryTraits, imageUrl) {
      this.currentMode = 'scene';
      this.currentCharacterKey = characterKey;
      this.currentCharacterName = characterName;
      this.currentSceneId = sceneId;
      this.currentSceneIdx = sceneIdx;
      this.sceneDialogue = dialogue;
      
      // Show edit step directly
      this.showStep('edit');
      
      // Show save button
      document.getElementById('trait-modal-save').classList.remove('hidden');
      
      // Update UI
      document.getElementById('trait-modal-mode').value = 'scene';
      document.getElementById('trait-modal-character-key').value = characterKey;
      document.getElementById('trait-modal-scene-id').value = sceneId;
      document.getElementById('trait-modal-title').innerHTML = 
        `<i class="fas fa-layer-group mr-2"></i>シーン #${sceneIdx}「${this.escapeHtml(characterName)}」`;
      
      // Character image
      this.setCharacterImage(imageUrl);
      
      document.getElementById('trait-modal-char-name').textContent = characterName;
      document.getElementById('trait-modal-char-subtitle').textContent = `シーン #${sceneIdx} の特徴オーバーライド`;
      
      // Description
      document.getElementById('trait-modal-description').innerHTML = `
        <p class="text-sm text-blue-700">
          <i class="fas fa-info-circle mr-1"></i>
          <strong>シーン別オーバーライド</strong>はこのシーンの画像生成のみに適用されます。<br>
          変身・衣装変更・状態変化など、共通特徴と異なる描写が必要な場合に設定してください。
        </p>
      `;
      
      // Show scene-specific sections
      document.getElementById('trait-modal-ai-section').classList.remove('hidden');
      document.getElementById('trait-modal-examples').classList.remove('hidden');
      
      // Show current story traits
      const currentSection = document.getElementById('trait-modal-current');
      const currentValue = document.getElementById('trait-modal-current-value');
      if (currentStoryTraits) {
        currentValue.textContent = currentStoryTraits;
        currentValue.classList.remove('italic', 'text-gray-400');
        currentSection.classList.remove('hidden');
      } else {
        currentValue.textContent = '未設定';
        currentValue.classList.add('italic', 'text-gray-400');
        currentSection.classList.remove('hidden');
      }
      
      // Clear and set placeholder
      document.getElementById('trait-modal-input').value = '';
      document.getElementById('trait-modal-input').placeholder = 
        '例: 人間の姿に変身した。妖精の羽は消え、普通の少女の姿になっている';
      
      this.showModal();
      
      // Auto-detect traits from dialogue
      await this.detectTraitsFromDialogue();
    },
    
    /**
     * Show/hide steps
     */
    showStep(step) {
      const selectStep = document.getElementById('trait-modal-step-select');
      const editStep = document.getElementById('trait-modal-step-edit');
      
      if (step === 'select') {
        selectStep?.classList.remove('hidden');
        editStep?.classList.add('hidden');
      } else {
        selectStep?.classList.add('hidden');
        editStep?.classList.remove('hidden');
      }
    },
    
    /**
     * Set character image
     */
    setCharacterImage(imageUrl) {
      const img = document.getElementById('trait-modal-char-image');
      const placeholder = document.getElementById('trait-modal-char-placeholder');
      if (imageUrl) {
        img.src = imageUrl;
        img.classList.remove('hidden');
        placeholder.classList.add('hidden');
      } else {
        img.classList.add('hidden');
        placeholder.classList.remove('hidden');
      }
    },
    
    /**
     * Show the modal
     */
    showModal() {
      const modal = document.getElementById('character-trait-modal');
      if (modal) {
        modal.classList.remove('hidden');
      }
    },
    
    /**
     * Close the modal
     */
    close() {
      const modal = document.getElementById('character-trait-modal');
      if (modal) {
        modal.classList.add('hidden');
      }
      this.currentMode = null;
      this.currentCharacterKey = null;
      this.currentSceneId = null;
      this.sceneCharacters = [];
    },
    
    /**
     * Detect traits from scene dialogue using AI patterns
     */
    async detectTraitsFromDialogue() {
      const suggestionsEl = document.getElementById('trait-modal-ai-suggestions');
      if (!suggestionsEl) return;
      
      suggestionsEl.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>ダイアログを分析中...';
      
      try {
        // Get scene dialogue if not already loaded
        if (!this.sceneDialogue && this.currentSceneId) {
          const response = await axios.get(`/api/projects/${window.PROJECT_ID}/scenes?view=board`);
          const scenes = response.data.scenes || [];
          const scene = scenes.find(s => s.id === this.currentSceneId);
          if (scene) {
            this.sceneDialogue = scene.dialogue || '';
            this.sceneImagePrompt = scene.image_prompt || '';
          }
        }
        
        const textToAnalyze = [this.sceneDialogue, this.sceneImagePrompt].filter(Boolean).join('\n');
        
        if (!textToAnalyze) {
          suggestionsEl.innerHTML = '<span class="text-gray-400">ダイアログがありません</span>';
          return;
        }
        
        // Extract traits using improved patterns
        const traits = this.extractTraitsFromText(textToAnalyze, this.currentCharacterName);
        
        if (traits.length > 0) {
          suggestionsEl.innerHTML = `
            <div class="space-y-1">
              ${traits.map(t => `<div class="flex items-center gap-2">
                <i class="fas fa-check text-purple-500"></i>
                <span>${this.escapeHtml(t)}</span>
              </div>`).join('')}
            </div>
          `;
          // Store for use
          suggestionsEl.dataset.traits = traits.join('、');
          
          // Auto-fill if input is empty
          const inputEl = document.getElementById('trait-modal-input');
          if (inputEl && !inputEl.value) {
            inputEl.value = traits.join('、');
            this.showToast('ダイアログから特徴を自動抽出しました', 'info');
          }
        } else {
          suggestionsEl.innerHTML = `
            <span class="text-gray-500">
              <i class="fas fa-search mr-1"></i>
              このシーンのダイアログから「${this.escapeHtml(this.currentCharacterName)}」の特徴変化を自動検出できませんでした。<br>
              <span class="text-xs">手動で入力するか、下の例を参考にしてください。</span>
            </span>
          `;
          suggestionsEl.dataset.traits = '';
        }
      } catch (error) {
        console.error('[CharacterTraitModal] Failed to detect traits:', error);
        suggestionsEl.innerHTML = '<span class="text-red-500">検出エラー</span>';
      }
    },
    
    /**
     * Extract traits from text using pattern matching
     */
    extractTraitsFromText(text, characterName) {
      if (!text || !characterName) return [];
      
      const traits = [];
      const normalizedName = characterName.toLowerCase();
      
      // Split into sentences
      const sentences = text.split(/[。！？\n]/);
      
      // Patterns for character state/appearance changes
      const transformPatterns = [
        // Transformation
        { pattern: /(?:変身|変化|変わ|なっ)(?:した|て|る|ている)/, type: 'transform' },
        // Appearance
        { pattern: /(?:姿|形|様子|表情|顔)(?:が|は|に|を)/, type: 'appearance' },
        // Body parts
        { pattern: /(?:羽|翼|尻尾|角|髪|目|手|足)(?:が|は|を)?(?:消え|現れ|生え|伸び|縮ん|光っ|輝い)/, type: 'body' },
        // Clothing
        { pattern: /(?:着替え|着て|纏っ|身に|脱い|装備|鎧|服|ドレス|衣装)/, type: 'clothing' },
        // State
        { pattern: /(?:傷|怪我|疲れ|疲弊|元気|回復|泣|笑|怒|喜)/, type: 'state' },
        // Age/Growth
        { pattern: /(?:成長|大人|子供|幼|老|若|年齢)/, type: 'age' },
      ];
      
      for (const sentence of sentences) {
        const trimmedSentence = sentence.trim();
        if (!trimmedSentence || trimmedSentence.length < 5) continue;
        
        // Check if character is mentioned (or if it's a general description)
        const mentionsCharacter = trimmedSentence.toLowerCase().includes(normalizedName);
        
        for (const { pattern, type } of transformPatterns) {
          if (pattern.test(trimmedSentence)) {
            // Extract the relevant part
            let extracted = trimmedSentence;
            
            // If character is mentioned, try to extract just the description part
            if (mentionsCharacter) {
              extracted = trimmedSentence
                .replace(new RegExp(characterName, 'gi'), '')
                .replace(/^[はがをにでと、。\s]+/, '')
                .trim();
            }
            
            if (extracted.length > 5 && extracted.length < 100 && !traits.includes(extracted)) {
              traits.push(extracted);
            }
            break;
          }
        }
        
        // Also check for direct descriptions after character name
        if (mentionsCharacter) {
          const directPattern = new RegExp(`${characterName}(?:は|が|の)([^。、]{5,50})`, 'gi');
          let match;
          while ((match = directPattern.exec(trimmedSentence)) !== null) {
            const desc = match[1]?.trim();
            if (desc && desc.length > 5 && !traits.includes(desc)) {
              traits.push(desc);
            }
          }
        }
      }
      
      // Return unique traits (max 3)
      return [...new Set(traits)].slice(0, 3);
    },
    
    /**
     * Use AI suggestion
     */
    useAiSuggestion() {
      const suggestionsEl = document.getElementById('trait-modal-ai-suggestions');
      const inputEl = document.getElementById('trait-modal-input');
      
      if (suggestionsEl && inputEl && suggestionsEl.dataset.traits) {
        inputEl.value = suggestionsEl.dataset.traits;
        this.showToast('AI検出した特徴を入力欄にコピーしました', 'success');
      }
    },
    
    /**
     * Save the trait
     */
    async save() {
      const inputEl = document.getElementById('trait-modal-input');
      const traitValue = inputEl?.value?.trim() || '';
      
      if (!traitValue) {
        this.showToast('特徴を入力してください', 'warning');
        return;
      }
      
      const saveBtn = document.getElementById('trait-modal-save');
      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>保存中...';
      }
      
      try {
        if (this.currentMode === 'story') {
          // Save story-wide traits
          await axios.put(
            `/api/projects/${window.PROJECT_ID}/characters/${this.currentCharacterKey}/story-traits`,
            { story_traits: traitValue }
          );
          this.showToast('共通特徴を保存しました', 'success');
          
          // Refresh traits summary if visible
          if (typeof window.loadCharacterTraitsSummary === 'function') {
            window.loadCharacterTraitsSummary();
          }
        } else if (this.currentMode === 'scene') {
          // Save scene-specific override
          await axios.post(
            `/api/scenes/${this.currentSceneId}/character-traits`,
            {
              character_key: this.currentCharacterKey,
              trait_description: traitValue,
              override_type: 'transform',
              source: 'manual'
            }
          );
          this.showToast(`シーン #${this.currentSceneIdx} の特徴を保存しました`, 'success');
          
          // Refresh traits summary if visible
          if (typeof window.loadCharacterTraitsSummary === 'function') {
            window.loadCharacterTraitsSummary();
          }
          
          // Refresh builder scene traits if visible
          if (typeof window.loadBuilderSceneCharTraits === 'function') {
            window.loadBuilderSceneCharTraits(this.currentSceneId);
          }
        }
        
        this.close();
      } catch (error) {
        console.error('[CharacterTraitModal] Save failed:', error);
        this.showToast('保存に失敗しました', 'error');
      } finally {
        if (saveBtn) {
          saveBtn.disabled = false;
          saveBtn.innerHTML = '<i class="fas fa-save mr-2"></i>保存';
        }
      }
    },
    
    /**
     * Show toast notification
     */
    showToast(message, type) {
      if (typeof window.showToast === 'function') {
        window.showToast(message, type);
      } else {
        console.log(`[Toast] ${type}: ${message}`);
      }
    },
    
    /**
     * Escape HTML
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
    document.addEventListener('DOMContentLoaded', () => CharacterTraitModal.init());
  } else {
    CharacterTraitModal.init();
  }
  
  // Expose globally
  window.CharacterTraitModal = CharacterTraitModal;
})();
