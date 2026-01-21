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
          ${this.utterances.length === 0 
            ? this.renderEmptyState() 
            : this.utterances.map((u, idx) => this.renderUtteranceCard(u, idx)).join('')}
        </div>
        
        <!-- Add Button -->
        <div class="mt-4">
          <button 
            id="btn-add-utterance"
            class="w-full px-4 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-semibold"
          >
            <i class="fas fa-plus mr-2"></i>発話を追加
          </button>
        </div>
        
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
     */
    renderUtteranceCard(utterance, idx) {
      const isNarration = utterance.role === 'narration';
      const hasAudio = !!utterance.audio_url;
      const isGenerating = this.audioGeneratingIds.has(utterance.id);
      
      const characterName = isNarration 
        ? 'ナレーション' 
        : (utterance.character_name || utterance.character_key || '未設定');
      
      const roleColor = isNarration ? 'bg-purple-100 text-purple-800' : 'bg-blue-100 text-blue-800';
      const audioStatusColor = hasAudio ? 'text-green-600' : 'text-gray-400';
      
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
                class="btn-play-audio px-3 py-1 bg-green-100 text-green-700 rounded text-sm hover:bg-green-200"
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
      
      // Play audio
      document.querySelectorAll('.btn-play-audio').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const url = e.currentTarget.dataset.audioUrl;
          this.playAudio(url);
        });
      });
    },
    
    /**
     * Show modal to add a new utterance
     */
    showAddUtteranceModal() {
      this.showUtteranceModal(null);
    },
    
    /**
     * Show modal to edit an utterance
     */
    showEditUtteranceModal(utteranceId) {
      const utterance = this.utterances.find(u => u.id === utteranceId);
      if (!utterance) {
        console.error('[UtterancesTab] Utterance not found:', utteranceId);
        return;
      }
      this.showUtteranceModal(utterance);
    },
    
    /**
     * Show utterance edit modal
     * @param {Object|null} utterance - null for new, object for edit
     */
    showUtteranceModal(utterance) {
      const isEdit = !!utterance;
      
      // Build character options (only for dialogue)
      const characterOptions = this.assignedCharacters.map(c => 
        `<option value="${this.escapeHtml(c.character_key)}" ${utterance?.character_key === c.character_key ? 'selected' : ''}>${this.escapeHtml(c.name)}</option>`
      ).join('');
      
      const modalHtml = `
        <div id="utterance-modal" class="fixed inset-0 bg-black bg-opacity-50 z-[60] flex items-center justify-center p-4">
          <div class="bg-white rounded-lg shadow-xl max-w-lg w-full max-h-[80vh] overflow-hidden">
            <div class="bg-gradient-to-r from-purple-600 to-blue-600 px-6 py-4">
              <h3 class="text-lg font-bold text-white">
                <i class="fas fa-microphone-alt mr-2"></i>
                ${isEdit ? '発話を編集' : '新しい発話を追加'}
              </h3>
            </div>
            
            <form id="utterance-form" class="p-6 space-y-4">
              <!-- Role -->
              <div>
                <label class="block text-sm font-semibold text-gray-700 mb-2">種類</label>
                <div class="flex gap-4">
                  <label class="flex items-center cursor-pointer">
                    <input type="radio" name="utterance-role" value="narration" class="mr-2" ${!isEdit || utterance?.role === 'narration' ? 'checked' : ''}>
                    <span class="text-sm">ナレーション</span>
                  </label>
                  <label class="flex items-center cursor-pointer ${this.assignedCharacters.length === 0 ? 'opacity-50' : ''}">
                    <input type="radio" name="utterance-role" value="dialogue" class="mr-2" ${utterance?.role === 'dialogue' ? 'checked' : ''} ${this.assignedCharacters.length === 0 ? 'disabled' : ''}>
                    <span class="text-sm">キャラセリフ</span>
                  </label>
                </div>
                ${this.assignedCharacters.length === 0 ? '<p class="text-xs text-orange-500 mt-1">セリフを使うには先にキャラクターを割り当ててください</p>' : ''}
              </div>
              
              <!-- Character (only for dialogue) -->
              <div id="utterance-character-section" class="${!isEdit || utterance?.role !== 'dialogue' ? 'hidden' : ''}">
                <label class="block text-sm font-semibold text-gray-700 mb-2">キャラクター</label>
                <select id="utterance-character" class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500">
                  <option value="">-- 選択 --</option>
                  ${characterOptions}
                </select>
              </div>
              
              <!-- Text -->
              <div>
                <label class="block text-sm font-semibold text-gray-700 mb-2">テキスト（字幕にも使用）</label>
                <textarea 
                  id="utterance-text"
                  rows="4"
                  class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 text-sm"
                  placeholder="発話テキストを入力..."
                >${this.escapeHtml(utterance?.text || '')}</textarea>
              </div>
              
              <!-- Hidden ID -->
              <input type="hidden" id="utterance-id" value="${utterance?.id || ''}">
              
              <!-- Actions -->
              <div class="flex gap-3 pt-4">
                <button type="submit" class="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-semibold">
                  <i class="fas fa-save mr-2"></i>${isEdit ? '更新' : '追加'}
                </button>
                <button type="button" id="btn-cancel-utterance" class="px-4 py-2 bg-gray-300 text-gray-700 rounded-lg hover:bg-gray-400 font-semibold">
                  キャンセル
                </button>
              </div>
            </form>
          </div>
        </div>
      `;
      
      // Insert modal
      document.body.insertAdjacentHTML('beforeend', modalHtml);
      
      // Bind events
      const modal = document.getElementById('utterance-modal');
      const form = document.getElementById('utterance-form');
      const roleInputs = document.querySelectorAll('input[name="utterance-role"]');
      const characterSection = document.getElementById('utterance-character-section');
      
      // Role change handler
      roleInputs.forEach(input => {
        input.addEventListener('change', (e) => {
          characterSection.classList.toggle('hidden', e.target.value === 'narration');
        });
      });
      
      // Cancel
      document.getElementById('btn-cancel-utterance').addEventListener('click', () => {
        modal.remove();
      });
      
      // Submit
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const id = document.getElementById('utterance-id').value;
        const role = document.querySelector('input[name="utterance-role"]:checked').value;
        const characterKey = role === 'dialogue' ? document.getElementById('utterance-character').value : null;
        const text = document.getElementById('utterance-text').value.trim();
        
        if (!text) {
          alert('テキストを入力してください');
          return;
        }
        
        if (role === 'dialogue' && !characterKey) {
          alert('キャラクターを選択してください');
          return;
        }
        
        try {
          if (id) {
            // Update
            await axios.put(`/api/utterances/${id}`, { role, character_key: characterKey, text });
          } else {
            // Create
            await axios.post(`/api/scenes/${this.currentSceneId}/utterances`, { role, character_key: characterKey, text });
          }
          
          modal.remove();
          await this.load(this.currentSceneId); // Reload
        } catch (error) {
          console.error('[UtterancesTab] Save failed:', error);
          alert('保存に失敗しました: ' + (error.response?.data?.error?.message || error.message));
        }
      });
      
      // Close on background click
      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          modal.remove();
        }
      });
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
      
      this.audioGeneratingIds.add(utteranceId);
      this.render();
      
      try {
        const response = await axios.post(`/api/utterances/${utteranceId}/generate-audio`);
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
     * Play audio
     */
    playAudio(url) {
      if (!url) return;
      
      const audio = new Audio(url);
      audio.play().catch(err => {
        console.error('[UtterancesTab] Audio play failed:', err);
        alert('音声の再生に失敗しました');
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
