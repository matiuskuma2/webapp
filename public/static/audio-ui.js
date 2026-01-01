// audio-ui.js - Audio UI management (Phase 3)
// Responsibility: DOM generation, state updates, preview replacement, history modal

window.AudioUI = {
  voicePresets: [],
  observer: null, // IntersectionObserver instance (Phase X-0)
  
  /**
   * Initialize audio UI for all scenes
   * @param {Array} scenes 
   */
  async initForScenes(scenes) {
    console.log('[AudioUI] Initializing for scenes:', scenes.length);
    
    // Load voice presets
    await this.loadVoicePresets();
    
    // Initialize each scene's audio section
    for (const scene of scenes) {
      this.initForScene(scene);
    }
  },
  
  /**
   * Initialize audio UI for visible scenes with lazy loading (Phase X-0)
   * Uses IntersectionObserver to initialize only when scene cards become visible
   * @param {Array} scenes 
   */
  async initForVisibleScenes(scenes) {
    console.log('[AudioUI] Initializing lazy loading for scenes:', scenes.length);
    
    // Load voice presets once
    await this.loadVoicePresets();
    
    // Create IntersectionObserver if not exists
    if (!this.observer) {
      this.observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            const sceneCard = entry.target;
            const sceneId = parseInt(sceneCard.dataset.sceneId);
            
            // Initialize if not already initialized
            if (!sceneCard.dataset.audioInitialized) {
              console.log(`[AudioUI] Lazy loading scene ${sceneId}`);
              
              // Find scene data
              const scene = window.lastLoadedScenes?.find(s => s.id === sceneId);
              if (scene) {
                this.initForScene(scene);
                sceneCard.dataset.audioInitialized = 'true';
              }
            }
            
            // Unobserve after initialization
            this.observer.unobserve(sceneCard);
          }
        });
      }, {
        root: null,
        rootMargin: '100px', // Load slightly ahead (100px before visible)
        threshold: 0.1
      });
    }
    
    // Observe all scene cards
    scenes.forEach(scene => {
      const sceneCard = document.querySelector(`[data-scene-id="${scene.id}"]`);
      if (sceneCard && !sceneCard.dataset.audioInitialized) {
        this.observer.observe(sceneCard);
      }
    });
  },

  /**
   * Load voice presets from JSON
   */
  async loadVoicePresets() {
    try {
      const response = await axios.get('/static/voice-presets.json');
      this.voicePresets = response.data.voice_presets || [];
      console.log('[AudioUI] Loaded voice presets:', this.voicePresets.length);
    } catch (error) {
      console.error('[AudioUI] Failed to load voice presets:', error);
      this.voicePresets = [];
    }
  },

  /**
   * Initialize audio UI for a single scene
   * @param {object} scene 
   */
  initForScene(scene) {
    const sceneId = scene.id;
    const container = document.querySelector(`[data-scene-id="${sceneId}"] .audio-section-content`);
    
    if (!container) {
      console.warn(`[AudioUI] Audio section container not found for scene ${sceneId}`);
      return;
    }
    
    // Generate audio section HTML (fixed DOM)
    container.innerHTML = this.generateAudioSectionHTML(scene);
    
    // Load initial state
    this.loadInitialState(sceneId);
  },

  /**
   * Generate audio section HTML (fixed DOM structure)
   * @param {object} scene 
   * @returns {string} HTML
   */
  generateAudioSectionHTML(scene) {
    const sceneId = scene.id;
    
    // Voice preset selector options
    const voiceOptions = this.voicePresets.map(preset => 
      `<option value="${preset.id}">${preset.name}</option>`
    ).join('');
    
    return `
      <!-- Voice Preset Selector -->
      <div class="mb-3">
        <label class="block text-sm font-semibold text-gray-700 mb-2">
          <i class="fas fa-microphone mr-1 text-purple-600"></i>音声タイプ
        </label>
        <select 
          id="voicePreset-${sceneId}"
          class="w-full px-3 py-2 border-2 border-gray-300 rounded-lg focus:border-purple-500 focus:ring-2 focus:ring-purple-200 text-sm"
        >
          ${voiceOptions}
        </select>
      </div>
      
      <!-- Audio Preview -->
      <div id="audioPreview-${sceneId}" class="mb-3 hidden">
        <!-- Audio player will be inserted here -->
      </div>
      
      <!-- Primary Button (Fixed DOM) -->
      <button
        id="audioPrimaryBtn-${sceneId}"
        onclick="window.AudioUI.handleGenerate(${sceneId})"
        class="w-full px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-semibold mb-2"
      >
        <i class="fas fa-volume-up mr-2"></i>音声生成
      </button>
      
      <!-- History Button (Fixed DOM) -->
      <button
        id="audioHistoryBtn-${sceneId}"
        onclick="window.AudioUI.viewHistory(${sceneId})"
        class="w-full px-4 py-2 bg-gray-300 text-gray-700 rounded-lg hover:bg-gray-400 transition-colors font-semibold text-sm"
      >
        <i class="fas fa-history mr-2"></i>履歴
      </button>
      
      <!-- Error Display -->
      <div id="audioError-${sceneId}" class="mt-2 text-sm text-red-600 hidden"></div>
    `;
  },

  /**
   * Load initial state for a scene (check for existing audio)
   * @param {number} sceneId 
   */
  async loadInitialState(sceneId) {
    try {
      const data = await window.AudioClient.list(sceneId);
      const activeAudio = data.active_audio;
      
      if (activeAudio && activeAudio.status === 'completed' && activeAudio.r2_url) {
        // Show preview and set button to "completed"
        this.updatePreview(sceneId, activeAudio);
        this.setButtonState(sceneId, 'completed', 100);
      }
      
      // Check if any audio is generating
      const generating = data.audio_generations?.find(a => a.status === 'generating');
      if (generating) {
        // Resume watch and polling
        this.setButtonState(sceneId, 'generating', 0);
        window.AudioState.startWatch(sceneId);
        window.AudioState.startPolling(sceneId);
      }
      
    } catch (error) {
      console.error(`[AudioUI] Failed to load initial state for scene ${sceneId}:`, error);
    }
  },

  /**
   * Handle generate button click
   * @param {number} sceneId 
   */
  async handleGenerate(sceneId) {
    // Block if bulk generation is running
    if (window.isBulkImageGenerating) {
      showToast('一括生成中です。完了後に音声を生成できます。', 'warning');
      return;
    }
    
    const voiceSelect = document.getElementById(`voicePreset-${sceneId}`);
    const voiceId = voiceSelect?.value;
    
    if (!voiceId) {
      showToast('音声タイプを選択してください', 'error');
      return;
    }
    
    try {
      // Set to generating state immediately
      this.setButtonState(sceneId, 'generating', 0);
      this.hideError(sceneId);
      
      // Call API
      const result = await window.AudioClient.generate(sceneId, {
        voice_id: voiceId,
        provider: 'google',
        format: 'mp3',
        sample_rate: 24000
      });
      
      console.log('[AudioUI] Generate started:', result);
      
      // Start watch and polling
      window.AudioState.startWatch(sceneId);
      window.AudioState.startPolling(sceneId);
      
    } catch (error) {
      console.error(`[AudioUI] Generate error for scene ${sceneId}:`, error);
      
      // Handle specific errors
      if (error.response?.status === 409) {
        this.showError(sceneId, '音声生成が既に進行中です');
      } else if (error.response?.data?.error?.code === 'NO_DIALOGUE') {
        this.showError(sceneId, 'このシーンにはセリフがありません');
      } else {
        this.showError(sceneId, '音声生成の開始に失敗しました');
      }
      
      this.setButtonState(sceneId, 'failed', 0);
    }
  },

  /**
   * Set button state (FIXED DOM - only update content/classes)
   * @param {number} sceneId 
   * @param {string} state - 'idle' | 'generating' | 'completed' | 'failed'
   * @param {number} percent - 0-100
   */
  setButtonState(sceneId, state, percent) {
    const btn = document.getElementById(`audioPrimaryBtn-${sceneId}`);
    if (!btn) return;
    
    // Remove all state classes
    btn.classList.remove('bg-blue-600', 'hover:bg-blue-700', 'bg-yellow-500', 'hover:bg-yellow-600', 
                         'bg-green-600', 'hover:bg-green-700', 'bg-red-600', 'hover:bg-red-700');
    
    // Apply state-specific styling
    switch (state) {
      case 'idle':
        btn.classList.add('bg-blue-600', 'hover:bg-blue-700');
        btn.innerHTML = '<i class="fas fa-volume-up mr-2"></i>音声生成';
        btn.disabled = false;
        break;
        
      case 'generating':
        btn.classList.add('bg-yellow-500', 'hover:bg-yellow-600');
        btn.innerHTML = `<i class="fas fa-spinner fa-spin mr-2"></i>生成中… ${percent}%`;
        btn.disabled = true;
        break;
        
      case 'completed':
        btn.classList.add('bg-green-600', 'hover:bg-green-700');
        btn.innerHTML = '<i class="fas fa-redo mr-2"></i>再生成';
        btn.disabled = false;
        break;
        
      case 'failed':
        btn.classList.add('bg-red-600', 'hover:bg-red-700');
        btn.innerHTML = '<i class="fas fa-exclamation-triangle mr-2"></i>再生成';
        btn.disabled = false;
        break;
    }
  },

  /**
   * Update audio preview (replace <audio> player)
   * @param {number} sceneId 
   * @param {object} audio - audio_generation object with r2_url
   */
  updatePreview(sceneId, audio) {
    const container = document.getElementById(`audioPreview-${sceneId}`);
    if (!container) return;
    
    if (audio && audio.r2_url) {
      container.innerHTML = `
        <audio controls class="w-full">
          <source src="${audio.r2_url}" type="audio/mpeg">
          Your browser does not support the audio element.
        </audio>
      `;
      container.classList.remove('hidden');
    } else {
      container.innerHTML = '';
      container.classList.add('hidden');
    }
  },

  /**
   * Show error message
   * @param {number} sceneId 
   * @param {string} message 
   */
  showError(sceneId, message) {
    const errorDiv = document.getElementById(`audioError-${sceneId}`);
    if (errorDiv) {
      errorDiv.textContent = message;
      errorDiv.classList.remove('hidden');
    }
  },

  /**
   * Hide error message
   * @param {number} sceneId 
   */
  hideError(sceneId) {
    const errorDiv = document.getElementById(`audioError-${sceneId}`);
    if (errorDiv) {
      errorDiv.classList.add('hidden');
    }
  },

  /**
   * View audio history modal
   * @param {number} sceneId 
   */
  async viewHistory(sceneId) {
    try {
      const data = await window.AudioClient.list(sceneId);
      const generations = data.audio_generations || [];
      
      if (generations.length === 0) {
        showToast('音声履歴はありません', 'info');
        return;
      }
      
      // Build modal content
      const modalContent = `
        <div class="space-y-3">
          ${generations.map(audio => this.generateHistoryItemHTML(audio)).join('')}
        </div>
      `;
      
      // Show modal (reuse existing image history modal structure)
      const modal = document.getElementById('imageHistoryModal');
      const title = modal?.querySelector('h3');
      const content = document.getElementById('imageHistoryContent');
      
      if (title) title.innerHTML = '<i class="fas fa-history mr-2 text-purple-600"></i>音声生成履歴';
      if (content) content.innerHTML = modalContent;
      if (modal) modal.classList.remove('hidden');
      
    } catch (error) {
      console.error(`[AudioUI] Failed to load history for scene ${sceneId}:`, error);
      showToast('履歴の読み込みに失敗しました', 'error');
    }
  },

  /**
   * Generate history item HTML
   * @param {object} audio 
   * @returns {string} HTML
   */
  generateHistoryItemHTML(audio) {
    const statusBadge = this.getStatusBadgeHTML(audio.status);
    const activeBadge = audio.is_active ? '<span class="ml-2 text-xs bg-green-100 text-green-800 px-2 py-1 rounded">採用中</span>' : '';
    const canDelete = !audio.is_active;
    
    return `
      <div class="border-2 ${audio.is_active ? 'border-green-400' : 'border-gray-200'} rounded-lg p-4">
        <div class="flex items-start justify-between mb-2">
          <div>
            <div class="font-semibold text-gray-800">
              音声 #${audio.id}
              ${statusBadge}
              ${activeBadge}
            </div>
            <div class="text-xs text-gray-500 mt-1">
              ${new Date(audio.created_at).toLocaleString('ja-JP')}
            </div>
          </div>
        </div>
        
        ${audio.status === 'completed' && audio.r2_url ? `
          <audio controls class="w-full mb-2">
            <source src="${audio.r2_url}" type="audio/mpeg">
          </audio>
        ` : ''}
        
        ${audio.error_message ? `
          <div class="text-sm text-red-600 mb-2">
            <i class="fas fa-exclamation-circle mr-1"></i>${audio.error_message}
          </div>
        ` : ''}
        
        <div class="flex gap-2">
          ${audio.status === 'completed' && !audio.is_active ? `
            <button
              onclick="window.AudioUI.handleActivate(${audio.id}, ${audio.scene_id})"
              class="flex-1 px-3 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors text-sm font-semibold"
            >
              <i class="fas fa-check mr-1"></i>採用
            </button>
          ` : ''}
          
          ${canDelete ? `
            <button
              onclick="window.AudioUI.handleDelete(${audio.id}, ${audio.scene_id})"
              class="px-3 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors text-sm font-semibold"
            >
              <i class="fas fa-trash mr-1"></i>削除
            </button>
          ` : ''}
        </div>
      </div>
    `;
  },

  /**
   * Get status badge HTML
   * @param {string} status 
   * @returns {string} HTML
   */
  getStatusBadgeHTML(status) {
    const badges = {
      pending: '<span class="text-xs bg-gray-100 text-gray-800 px-2 py-1 rounded">待機中</span>',
      generating: '<span class="text-xs bg-yellow-100 text-yellow-800 px-2 py-1 rounded">生成中</span>',
      completed: '<span class="text-xs bg-green-100 text-green-800 px-2 py-1 rounded">完了</span>',
      failed: '<span class="text-xs bg-red-100 text-red-800 px-2 py-1 rounded">失敗</span>'
    };
    return badges[status] || '';
  },

  /**
   * Handle activate button click in history modal
   * @param {number} audioId 
   * @param {number} sceneId 
   */
  async handleActivate(audioId, sceneId) {
    try {
      await window.AudioClient.activate(audioId);
      showToast('音声を採用しました', 'success');
      
      // Reload state and close modal
      await this.loadInitialState(sceneId);
      this.closeHistoryModal();
      
    } catch (error) {
      console.error('[AudioUI] Activate error:', error);
      showToast('音声の採用に失敗しました', 'error');
    }
  },

  /**
   * Handle delete button click in history modal
   * @param {number} audioId 
   * @param {number} sceneId 
   */
  async handleDelete(audioId, sceneId) {
    if (!confirm('この音声を削除しますか？')) return;
    
    try {
      await window.AudioClient.remove(audioId);
      showToast('音声を削除しました', 'success');
      
      // Reload history
      await this.viewHistory(sceneId);
      
    } catch (error) {
      console.error('[AudioUI] Delete error:', error);
      
      if (error.response?.data?.error?.code === 'ACTIVE_AUDIO_DELETE') {
        showToast('採用中の音声は削除できません', 'error');
      } else {
        showToast('音声の削除に失敗しました', 'error');
      }
    }
  },

  /**
   * Close history modal (reuse image history modal)
   */
  closeHistoryModal() {
    const modal = document.getElementById('imageHistoryModal');
    if (modal) modal.classList.add('hidden');
  }
};

console.log('[AudioUI] Loaded successfully');
