/**
 * R1.5: Utterances Tab for Scene Edit Modal
 * 
 * Handles utterance management within scene editing:
 * - List utterances with role, character, text, audio status
 * - Add/edit/delete utterances
 * - Generate audio per utterance
 * - Reorder utterances
 * 
 * SSOT: scene_utterances table is the source of truth
 */

(function() {
  'use strict';

  const UtterancesTab = {
    // State
    currentSceneId: null,
    projectId: null,
    utterances: [],
    assignedCharacters: [], // Characters assigned to this scene
    isLoading: false,
    audioGeneratingIds: new Set(), // utterance IDs currently generating audio
    currentAudio: null, // Currently playing audio element
    currentPlayingUtteranceId: null, // ID of utterance currently playing
    
    /**
     * Initialize the utterances tab
     */
    init() {
      console.log('[UtterancesTab] Initialized');
      this.bindGlobalEvents();
    },
    
    /**
     * Bind global event listeners
     */
    bindGlobalEvents() {
      // Will be called when tab is activated
    },
    
    /**
     * Load utterances for a scene
     * @param {number} sceneId 
     */
    async load(sceneId) {
      this.currentSceneId = sceneId;
      this.isLoading = true;
      this.render();
      
      try {
        const response = await axios.get(`/api/scenes/${sceneId}/utterances`);
        const data = response.data;
        
        this.utterances = data.utterances || [];
        this.assignedCharacters = data.assigned_characters || [];
        this.projectId = data.project_id;
        
        console.log(`[UtterancesTab] Loaded ${this.utterances.length} utterances for scene ${sceneId}`);
      } catch (error) {
        console.error('[UtterancesTab] Failed to load utterances:', error);
        this.utterances = [];
        this.assignedCharacters = [];
      } finally {
        this.isLoading = false;
        this.render();
      }
    },
    
    /**
     * Render the utterances tab content
     */
    render() {
      const container = document.getElementById('scene-edit-tab-utterances');
      if (!container) {
        console.warn('[UtterancesTab] Container not found');
        return;
      }
      
      if (this.isLoading) {
        container.innerHTML = `
          <div class="p-8 text-center">
            <i class="fas fa-spinner fa-spin text-3xl text-blue-600 mb-3"></i>
            <p class="text-gray-600">読み込み中...</p>
          </div>
        `;
        return;
      }
      
      // Phase2-PR2c: Show new utterance form if adding
      const newFormHtml = this.isAddingNew ? this.renderNewUtteranceForm() : '';
      
      container.innerHTML = `
        <!-- Guide -->
        <div class="mb-4 p-3 bg-blue-50 border border-blue-200 rounded-lg">
          <p class="text-sm text-blue-800">
            <i class="fas fa-info-circle mr-2"></i>
            <strong>音声タブ</strong>：「読む順番」「誰が読むか」「何を読むか」を設定します。
            <br><span class="text-xs">※ 外見設定（キャラ割り当てタブ）とは独立しています。</span>
          </p>
        </div>
        
        <!-- Utterance List -->
        <div class="space-y-3" id="utterances-list">
          ${this.utterances.length === 0 && !this.isAddingNew
            ? this.renderEmptyState() 
            : this.utterances.map((u, idx) => this.renderUtteranceCard(u, idx)).join('')}
          ${newFormHtml}
        </div>
        
        <!-- Add Button (hidden when adding new) -->
        ${this.isAddingNew ? '' : `
          <div class="mt-4">
            <button 
              id="btn-add-utterance"
              class="w-full px-4 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-semibold"
            >
              <i class="fas fa-plus mr-2"></i>発話を追加
            </button>
          </div>
        `}
        
        <!-- Audio Summary -->
        <div class="mt-4 pt-4 border-t border-gray-200">
          ${this.renderAudioSummary()}
        </div>
      `;
      
      this.bindEvents();
    },
    
    /**
     * Render empty state
     */
    renderEmptyState() {
      return `
        <div class="p-6 text-center bg-gray-50 rounded-lg border border-dashed border-gray-300">
          <i class="fas fa-microphone-slash text-4xl text-gray-300 mb-3"></i>
          <p class="text-gray-500">発話がありません</p>
          <p class="text-sm text-gray-400 mt-1">下のボタンで追加してください</p>
        </div>
      `;
    },
    
    /**
     * Render a single utterance card
     * Phase2-PR2c: Support inline editing mode
     */
    renderUtteranceCard(utterance, idx) {
      const isNarration = utterance.role === 'narration';
      const hasAudio = !!utterance.audio_url;
      const isGenerating = this.audioGeneratingIds.has(utterance.id);
      const isEditing = this.editingUtteranceId === utterance.id;
      
      const characterName = isNarration 
        ? 'ナレーション' 
        : (utterance.character_name || utterance.character_key || '未設定');
      
      const roleColor = isNarration ? 'bg-purple-100 text-purple-800' : 'bg-blue-100 text-blue-800';
      const audioStatusColor = hasAudio ? 'text-green-600' : 'text-gray-400';
      
      // Phase2-PR2c: If editing, show inline edit form
      if (isEditing) {
        return this.renderInlineEditForm(utterance, idx);
      }
      
      return `
        <div class="utterance-card p-4 bg-white border border-gray-200 rounded-lg shadow-sm hover:shadow-md transition-shadow" data-utterance-id="${utterance.id}">
          <!-- Header: Order, Role, Character -->
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-2">
              <!-- Order Number -->
              <span class="w-8 h-8 flex items-center justify-center bg-gray-100 text-gray-700 rounded-full font-bold text-sm">
                ${idx + 1}
              </span>
              
              <!-- Role Badge -->
              <span class="px-2 py-1 rounded-full text-xs font-semibold ${roleColor}">
                ${isNarration ? 'ナレ' : 'セリフ'}
              </span>
              
              <!-- Character Name -->
              <span class="text-sm font-semibold text-gray-800">
                ${this.escapeHtml(characterName)}
              </span>
            </div>
            
            <!-- Actions -->
            <div class="flex items-center gap-2">
              <!-- Audio Status -->
              <span class="text-sm ${audioStatusColor}" title="${hasAudio ? '音声あり' : '音声なし'}">
                <i class="fas ${hasAudio ? 'fa-volume-up' : 'fa-volume-mute'}"></i>
                ${utterance.duration_ms ? `(${(utterance.duration_ms / 1000).toFixed(1)}s)` : ''}
              </span>
              
              <!-- Reorder buttons -->
              <button 
                class="btn-move-up p-1 text-gray-400 hover:text-gray-600 ${idx === 0 ? 'invisible' : ''}"
                data-utterance-id="${utterance.id}"
                title="上へ移動"
              >
                <i class="fas fa-chevron-up"></i>
              </button>
              <button 
                class="btn-move-down p-1 text-gray-400 hover:text-gray-600 ${idx === this.utterances.length - 1 ? 'invisible' : ''}"
                data-utterance-id="${utterance.id}"
                title="下へ移動"
              >
                <i class="fas fa-chevron-down"></i>
              </button>
              
              <!-- Edit -->
              <button 
                class="btn-edit-utterance p-1 text-blue-500 hover:text-blue-700"
                data-utterance-id="${utterance.id}"
                title="編集"
              >
                <i class="fas fa-edit"></i>
              </button>
              
              <!-- Delete -->
              <button 
                class="btn-delete-utterance p-1 text-red-400 hover:text-red-600"
                data-utterance-id="${utterance.id}"
                title="削除"
              >
                <i class="fas fa-trash"></i>
              </button>
            </div>
          </div>
          
          <!-- Text -->
          <div class="mb-3 p-2 bg-gray-50 rounded text-sm text-gray-700 max-h-24 overflow-y-auto">
            ${this.escapeHtml(utterance.text || '（テキストなし）')}
          </div>
          
          <!-- Audio Actions -->
          <div class="flex items-center gap-2">
            ${hasAudio ? `
              <button 
                class="btn-play-audio px-3 py-1 bg-blue-100 text-blue-700 rounded text-sm hover:bg-blue-200"
                data-utterance-id="${utterance.id}"
                data-audio-url="${utterance.audio_url}"
              >
                <i class="fas fa-play mr-1"></i>再生
              </button>
            ` : ''}
            
            <button 
              class="btn-generate-audio px-3 py-1 ${isGenerating ? 'bg-gray-200 text-gray-500 cursor-wait' : 'bg-purple-100 text-purple-700 hover:bg-purple-200'} rounded text-sm"
              data-utterance-id="${utterance.id}"
              ${isGenerating ? 'disabled' : ''}
            >
              <i class="fas ${isGenerating ? 'fa-spinner fa-spin' : 'fa-microphone'} mr-1"></i>
              ${hasAudio ? '再生成' : '音声生成'}
            </button>
          </div>
        </div>
      `;
    },
    
    /**
     * Phase2-PR2c: Render inline edit form for an utterance
     */
    renderInlineEditForm(utterance, idx) {
      const isNarration = utterance.role === 'narration';
      const characterOptions = this.assignedCharacters.map(c => 
        `<option value="${this.escapeHtml(c.character_key)}" ${utterance.character_key === c.character_key ? 'selected' : ''}>${this.escapeHtml(c.name)}</option>`
      ).join('');
      
      return `
        <div class="utterance-card p-4 bg-blue-50 border-2 border-blue-400 rounded-lg shadow-md" data-utterance-id="${utterance.id}">
          <div class="flex items-center gap-2 mb-3">
            <span class="w-8 h-8 flex items-center justify-center bg-blue-100 text-blue-700 rounded-full font-bold text-sm">
              ${idx + 1}
            </span>
            <span class="text-sm font-bold text-blue-800">
              <i class="fas fa-edit mr-1"></i>編集中
            </span>
          </div>
          
          <!-- Role Selection -->
          <div class="mb-3">
            <label class="block text-xs font-semibold text-gray-600 mb-1">種類</label>
            <div class="flex gap-4">
              <label class="flex items-center cursor-pointer">
                <input type="radio" name="inline-edit-role-${utterance.id}" value="narration" class="mr-2" ${isNarration ? 'checked' : ''}>
                <span class="text-sm">ナレーション</span>
              </label>
              <label class="flex items-center cursor-pointer ${this.assignedCharacters.length === 0 ? 'opacity-50' : ''}">
                <input type="radio" name="inline-edit-role-${utterance.id}" value="dialogue" class="mr-2" ${!isNarration ? 'checked' : ''} ${this.assignedCharacters.length === 0 ? 'disabled' : ''}>
                <span class="text-sm">キャラセリフ</span>
              </label>
            </div>
          </div>
          
          <!-- Character Selection (shown for dialogue) -->
          <div id="inline-edit-char-section-${utterance.id}" class="mb-3 ${isNarration ? 'hidden' : ''}">
            <label class="block text-xs font-semibold text-gray-600 mb-1">キャラクター</label>
            <select id="inline-edit-char-${utterance.id}" class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">
              <option value="">-- 選択 --</option>
              ${characterOptions}
            </select>
          </div>
          
          <!-- Text -->
          <div class="mb-3">
            <label class="block text-xs font-semibold text-gray-600 mb-1">テキスト</label>
            <textarea 
              id="inline-edit-text-${utterance.id}"
              rows="3"
              class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500"
            >${this.escapeHtml(utterance.text || '')}</textarea>
          </div>
          
          <!-- Actions -->
          <div class="flex gap-2">
            <button 
              class="btn-save-inline-edit flex-1 px-3 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-semibold"
              data-utterance-id="${utterance.id}"
            >
              <i class="fas fa-save mr-1"></i>保存
            </button>
            <button 
              class="btn-cancel-inline-edit px-3 py-2 bg-gray-300 text-gray-700 rounded-lg hover:bg-gray-400 text-sm font-semibold"
            >
              キャンセル
            </button>
          </div>
        </div>
      `;
    },
    
    /**
     * Phase2-PR2c: Render inline form for new utterance
     */
    renderNewUtteranceForm() {
      const characterOptions = this.assignedCharacters.map(c => 
        `<option value="${this.escapeHtml(c.character_key)}">${this.escapeHtml(c.name)}</option>`
      ).join('');
      
      return `
        <div class="utterance-card p-4 bg-green-50 border-2 border-green-400 rounded-lg shadow-md">
          <div class="flex items-center gap-2 mb-3">
            <span class="w-8 h-8 flex items-center justify-center bg-green-100 text-green-700 rounded-full font-bold text-sm">
              <i class="fas fa-plus"></i>
            </span>
            <span class="text-sm font-bold text-green-800">
              <i class="fas fa-plus-circle mr-1"></i>新しい発話を追加
            </span>
          </div>
          
          <!-- Role Selection -->
          <div class="mb-3">
            <label class="block text-xs font-semibold text-gray-600 mb-1">種類</label>
            <div class="flex gap-4">
              <label class="flex items-center cursor-pointer">
                <input type="radio" name="inline-new-role" value="narration" class="mr-2" checked>
                <span class="text-sm">ナレーション</span>
              </label>
              <label class="flex items-center cursor-pointer ${this.assignedCharacters.length === 0 ? 'opacity-50' : ''}">
                <input type="radio" name="inline-new-role" value="dialogue" class="mr-2" ${this.assignedCharacters.length === 0 ? 'disabled' : ''}>
                <span class="text-sm">キャラセリフ</span>
              </label>
            </div>
          </div>
          
          <!-- Character Selection -->
          <div id="inline-new-char-section" class="mb-3 hidden">
            <label class="block text-xs font-semibold text-gray-600 mb-1">キャラクター</label>
            <select id="inline-new-char" class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm">
              <option value="">-- 選択 --</option>
              ${characterOptions}
            </select>
          </div>
          
          <!-- Text -->
          <div class="mb-3">
            <label class="block text-xs font-semibold text-gray-600 mb-1">テキスト</label>
            <textarea 
              id="inline-utterance-text"
              rows="3"
              class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-green-500"
              placeholder="発話テキストを入力..."
            ></textarea>
          </div>
          
          <!-- Actions -->
          <div class="flex gap-2">
            <button 
              id="btn-save-new-utterance"
              class="flex-1 px-3 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 text-sm font-semibold"
            >
              <i class="fas fa-plus mr-1"></i>追加
            </button>
            <button 
              id="btn-cancel-new-utterance"
              class="px-3 py-2 bg-gray-300 text-gray-700 rounded-lg hover:bg-gray-400 text-sm font-semibold"
            >
              キャンセル
            </button>
          </div>
        </div>
      `;
    },
    
    /**
     * Render audio summary
     */
    renderAudioSummary() {
      const totalUtterances = this.utterances.length;
      const withAudio = this.utterances.filter(u => u.audio_url).length;
      const totalDuration = this.utterances.reduce((sum, u) => sum + (u.duration_ms || 0), 0);
      
      return `
        <div class="flex items-center justify-between text-sm">
          <div class="text-gray-600">
            <i class="fas fa-list-ol mr-1"></i>
            発話数: <span class="font-semibold">${totalUtterances}</span>
          </div>
          <div class="text-gray-600">
            <i class="fas fa-volume-up mr-1"></i>
            音声: <span class="font-semibold ${withAudio === totalUtterances ? 'text-green-600' : 'text-orange-500'}">${withAudio}/${totalUtterances}</span>
          </div>
          <div class="text-gray-600">
            <i class="fas fa-clock mr-1"></i>
            合計: <span class="font-semibold">${(totalDuration / 1000).toFixed(1)}秒</span>
          </div>
        </div>
      `;
    },
    
    /**
     * Bind event listeners
     */
    bindEvents() {
      // Add utterance
      const addBtn = document.getElementById('btn-add-utterance');
      if (addBtn) {
        addBtn.addEventListener('click', () => this.showAddUtteranceModal());
      }
      
      // Edit utterance
      document.querySelectorAll('.btn-edit-utterance').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const id = parseInt(e.currentTarget.dataset.utteranceId);
          this.showEditUtteranceModal(id);
        });
      });
      
      // Delete utterance
      document.querySelectorAll('.btn-delete-utterance').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const id = parseInt(e.currentTarget.dataset.utteranceId);
          this.deleteUtterance(id);
        });
      });
      
      // Move up/down
      document.querySelectorAll('.btn-move-up').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const id = parseInt(e.currentTarget.dataset.utteranceId);
          this.moveUtterance(id, -1);
        });
      });
      document.querySelectorAll('.btn-move-down').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const id = parseInt(e.currentTarget.dataset.utteranceId);
          this.moveUtterance(id, 1);
        });
      });
      
      // Generate audio
      document.querySelectorAll('.btn-generate-audio').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const id = parseInt(e.currentTarget.dataset.utteranceId);
          this.generateAudio(id);
        });
      });
      
      // Play/Stop audio toggle
      document.querySelectorAll('.btn-play-audio').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const utteranceId = parseInt(e.currentTarget.dataset.utteranceId);
          const url = e.currentTarget.dataset.audioUrl;
          this.toggleAudio(utteranceId, url);
        });
      });
      
      // Phase2-PR2c: Inline edit save
      document.querySelectorAll('.btn-save-inline-edit').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const id = parseInt(e.currentTarget.dataset.utteranceId);
          this.saveInlineEdit(id);
        });
      });
      
      // Phase2-PR2c: Inline edit cancel
      document.querySelectorAll('.btn-cancel-inline-edit').forEach(btn => {
        btn.addEventListener('click', () => this.cancelInlineEdit());
      });
      
      // Phase2-PR2c: New utterance save
      const saveNewBtn = document.getElementById('btn-save-new-utterance');
      if (saveNewBtn) {
        saveNewBtn.addEventListener('click', () => this.saveNewUtterance());
      }
      
      // Phase2-PR2c: New utterance cancel
      const cancelNewBtn = document.getElementById('btn-cancel-new-utterance');
      if (cancelNewBtn) {
        cancelNewBtn.addEventListener('click', () => this.cancelInlineEdit());
      }
      
      // Phase2-PR2c: Role change handler for inline forms
      document.querySelectorAll('input[name^="inline-edit-role-"]').forEach(input => {
        input.addEventListener('change', (e) => {
          const utteranceId = e.target.name.replace('inline-edit-role-', '');
          const charSection = document.getElementById(`inline-edit-char-section-${utteranceId}`);
          if (charSection) {
            charSection.classList.toggle('hidden', e.target.value === 'narration');
          }
        });
      });
      
      // Phase2-PR2c: Role change handler for new form
      document.querySelectorAll('input[name="inline-new-role"]').forEach(input => {
        input.addEventListener('change', (e) => {
          const charSection = document.getElementById('inline-new-char-section');
          if (charSection) {
            charSection.classList.toggle('hidden', e.target.value === 'narration');
          }
        });
      });
    },
    
    /**
     * Phase2-PR2c: State for inline editing
     */
    editingUtteranceId: null,
    isAddingNew: false,
    
    /**
     * Show inline form to add a new utterance
     * Phase2-PR2c: No modal - inline form at the end
     */
    showAddUtteranceModal() {
      // Close any existing edit
      this.cancelInlineEdit();
      
      // Show inline add form
      this.isAddingNew = true;
      this.render();
      
      // Focus the text input
      setTimeout(() => {
        const textInput = document.getElementById('inline-utterance-text');
        if (textInput) textInput.focus();
      }, 100);
    },
    
    /**
     * Show inline edit for an utterance
     * Phase2-PR2c: No modal - edit in place
     */
    showEditUtteranceModal(utteranceId) {
      const utterance = this.utterances.find(u => u.id === utteranceId);
      if (!utterance) {
        console.error('[UtterancesTab] Utterance not found:', utteranceId);
        return;
      }
      
      // Close any existing edit
      this.cancelInlineEdit();
      
      // Start editing this utterance
      this.editingUtteranceId = utteranceId;
      this.render();
      
      // Focus the text input
      setTimeout(() => {
        const textInput = document.getElementById(`inline-edit-text-${utteranceId}`);
        if (textInput) textInput.focus();
      }, 100);
    },
    
    /**
     * Cancel inline editing
     */
    cancelInlineEdit() {
      this.editingUtteranceId = null;
      this.isAddingNew = false;
      this.render();
    },
    
    /**
     * Save inline edit for existing utterance
     */
    async saveInlineEdit(utteranceId) {
      const textInput = document.getElementById(`inline-edit-text-${utteranceId}`);
      const roleInput = document.querySelector(`input[name="inline-edit-role-${utteranceId}"]:checked`);
      const charSelect = document.getElementById(`inline-edit-char-${utteranceId}`);
      
      if (!textInput || !roleInput) {
        console.error('[UtterancesTab] Form elements not found');
        return;
      }
      
      const text = textInput.value.trim();
      const role = roleInput.value;
      const characterKey = role === 'dialogue' ? charSelect?.value || null : null;
      
      if (!text) {
        alert('テキストを入力してください');
        return;
      }
      
      if (role === 'dialogue' && !characterKey) {
        alert('キャラクターを選択してください');
        return;
      }
      
      try {
        await axios.put(`/api/utterances/${utteranceId}`, { role, character_key: characterKey, text });
        this.editingUtteranceId = null;
        await this.load(this.currentSceneId);
      } catch (error) {
        console.error('[UtterancesTab] Save failed:', error);
        alert('保存に失敗しました: ' + (error.response?.data?.error?.message || error.message));
      }
    },
    
    /**
     * Save new utterance from inline form
     */
    async saveNewUtterance() {
      const textInput = document.getElementById('inline-utterance-text');
      const roleInput = document.querySelector('input[name="inline-new-role"]:checked');
      const charSelect = document.getElementById('inline-new-char');
      
      if (!textInput || !roleInput) {
        console.error('[UtterancesTab] Form elements not found');
        return;
      }
      
      const text = textInput.value.trim();
      const role = roleInput.value;
      const characterKey = role === 'dialogue' ? charSelect?.value || null : null;
      
      if (!text) {
        alert('テキストを入力してください');
        return;
      }
      
      if (role === 'dialogue' && !characterKey) {
        alert('キャラクターを選択してください');
        return;
      }
      
      try {
        await axios.post(`/api/scenes/${this.currentSceneId}/utterances`, { role, character_key: characterKey, text });
        this.isAddingNew = false;
        await this.load(this.currentSceneId);
      } catch (error) {
        console.error('[UtterancesTab] Create failed:', error);
        alert('追加に失敗しました: ' + (error.response?.data?.error?.message || error.message));
      }
    },
    
    /**
     * Delete an utterance
     */
    async deleteUtterance(utteranceId) {
      if (!confirm('この発話を削除しますか？')) {
        return;
      }
      
      try {
        await axios.delete(`/api/utterances/${utteranceId}`);
        await this.load(this.currentSceneId);
      } catch (error) {
        console.error('[UtterancesTab] Delete failed:', error);
        alert('削除に失敗しました');
      }
    },
    
    /**
     * Move utterance up or down
     * @param {number} utteranceId 
     * @param {number} direction - -1 for up, 1 for down
     */
    async moveUtterance(utteranceId, direction) {
      const currentIndex = this.utterances.findIndex(u => u.id === utteranceId);
      if (currentIndex === -1) return;
      
      const newIndex = currentIndex + direction;
      if (newIndex < 0 || newIndex >= this.utterances.length) return;
      
      // Swap in array
      const newOrder = this.utterances.map(u => u.id);
      [newOrder[currentIndex], newOrder[newIndex]] = [newOrder[newIndex], newOrder[currentIndex]];
      
      try {
        await axios.put(`/api/scenes/${this.currentSceneId}/utterances/reorder`, { order: newOrder });
        await this.load(this.currentSceneId);
      } catch (error) {
        console.error('[UtterancesTab] Reorder failed:', error);
        alert('並び替えに失敗しました');
      }
    },
    
    /**
     * Generate audio for an utterance
     */
    async generateAudio(utteranceId) {
      if (this.audioGeneratingIds.has(utteranceId)) return;
      
      // If currently editing this utterance, save first
      if (this.editingUtteranceId === utteranceId) {
        console.log('[UtterancesTab] Saving edited text before regeneration');
        await this.saveInlineEdit(utteranceId);
        // Wait for state to update
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      
      // Check if this utterance already has audio (means regeneration)
      const utterance = this.utterances.find(u => u.id === utteranceId);
      const hasExistingAudio = utterance && utterance.audio_generation_id;
      
      // Confirm regeneration if already has audio
      if (hasExistingAudio) {
        const confirmRegenerate = confirm(
          '音声を再生成しますか？\n\n' +
          '※セリフを変更した場合は、新しいテキストで音声が生成されます。'
        );
        if (!confirmRegenerate) return;
      }
      
      this.audioGeneratingIds.add(utteranceId);
      this.render();
      
      try {
        // ALWAYS send force: true to ensure fresh generation with current text
        // This prevents any caching issues where old text might be used
        console.log(`[UtterancesTab] Generating audio for utterance ${utteranceId} with force: true`);
        const response = await axios.post(`/api/utterances/${utteranceId}/generate-audio`, {
          force: true  // Always force to use latest text from DB
        });
        console.log('[UtterancesTab] Audio generation started:', response.data);
        
        // Poll for completion (simple approach)
        // In production, you might use WebSocket or polling
        setTimeout(async () => {
          await this.load(this.currentSceneId);
          this.audioGeneratingIds.delete(utteranceId);
          this.render();
        }, 5000); // Wait 5 seconds and reload
        
      } catch (error) {
        console.error('[UtterancesTab] Audio generation failed:', error);
        alert('音声生成に失敗しました: ' + (error.response?.data?.error?.message || error.message));
        this.audioGeneratingIds.delete(utteranceId);
        this.render();
      }
    },
    
    /**
     * Play or stop audio
     */
    toggleAudio(utteranceId, url) {
      if (!url) return;
      
      // If clicking the same utterance that's playing, stop it
      if (this.currentPlayingUtteranceId === utteranceId && this.currentAudio) {
        this.stopAudio();
        return;
      }
      
      // Stop any currently playing audio
      this.stopAudio();
      
      // Play new audio
      this.currentAudio = new Audio(url);
      this.currentPlayingUtteranceId = utteranceId;
      
      // Update UI to show playing state
      this.updatePlayButtonState(utteranceId, true);
      
      this.currentAudio.play().catch(err => {
        console.error('[UtterancesTab] Audio play failed:', err);
        alert('音声の再生に失敗しました');
        this.stopAudio();
      });
      
      // When audio ends, reset state
      this.currentAudio.addEventListener('ended', () => {
        this.stopAudio();
      });
    },
    
    /**
     * Stop currently playing audio
     */
    stopAudio() {
      if (this.currentAudio) {
        this.currentAudio.pause();
        this.currentAudio.currentTime = 0;
        this.currentAudio = null;
      }
      
      if (this.currentPlayingUtteranceId) {
        this.updatePlayButtonState(this.currentPlayingUtteranceId, false);
        this.currentPlayingUtteranceId = null;
      }
    },
    
    /**
     * Update play button appearance
     */
    updatePlayButtonState(utteranceId, isPlaying) {
      const btn = document.querySelector(`[data-utterance-id="${utteranceId}"].btn-play-audio`);
      if (btn) {
        if (isPlaying) {
          btn.innerHTML = '<i class="fas fa-stop mr-1"></i>停止';
          btn.classList.remove('bg-blue-100', 'text-blue-700', 'hover:bg-blue-200');
          btn.classList.add('bg-red-100', 'text-red-700', 'hover:bg-red-200');
        } else {
          btn.innerHTML = '<i class="fas fa-play mr-1"></i>再生';
          btn.classList.remove('bg-red-100', 'text-red-700', 'hover:bg-red-200');
          btn.classList.add('bg-blue-100', 'text-blue-700', 'hover:bg-blue-200');
        }
      }
    },
    
    /**
     * Legacy play audio (for backward compatibility)
     */
    playAudio(url) {
      if (!url) return;
      this.stopAudio();
      this.currentAudio = new Audio(url);
      this.currentAudio.play().catch(err => {
        console.error('[UtterancesTab] Audio play failed:', err);
        alert('音声の再生に失敗しました');
      });
      this.currentAudio.addEventListener('ended', () => {
        this.currentAudio = null;
      });
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
  
  // Initialize
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => UtterancesTab.init());
  } else {
    UtterancesTab.init();
  }
  
  // Export to global scope
  window.UtterancesTab = UtterancesTab;
})();
