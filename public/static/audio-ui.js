// audio-ui.js - Audio UI management (Phase 3)
// Responsibility: DOM generation, state updates, preview replacement, history modal

window.AudioUI = {
  voicePresets: [],
  observer: null, // IntersectionObserver instance (Phase X-0)
  ttsUsage: null, // Phase 4: TTS usage cache
  ttsUsageLastFetch: null, // Last fetch timestamp
  
  /**
   * Initialize audio UI for all scenes
   * @param {Array} scenes 
   */
  async initForScenes(scenes) {
    console.log('[AudioUI] Initializing for scenes:', scenes.length);
    
    // Load voice presets and TTS usage (Phase 4)
    await Promise.all([
      this.loadVoicePresets(),
      this.loadTTSUsage()
    ]);
    
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
    
    // Load voice presets and TTS usage once (Phase 4)
    await Promise.all([
      this.loadVoicePresets(),
      this.loadTTSUsage()
    ]);
    
    // Create IntersectionObserver if not exists
    if (!this.observer) {
      this.observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            const sceneCard = entry.target;
            // Extract scene ID from builder-scene-{id} format (Phase X-0: Fix)
            const sceneId = parseInt(sceneCard.id.replace('builder-scene-', ''));
            
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
    
    // Observe all scene cards (Phase X-0: Fix - use fixed DOM ID instead of data-scene-id)
    scenes.forEach(scene => {
      const sceneCard = document.getElementById(`builder-scene-${scene.id}`);
      if (sceneCard && !sceneCard.dataset.audioInitialized) {
        this.observer.observe(sceneCard);
      }
    });
  },

  /**
   * Load voice presets from JSON
   * v2互換: status='coming_soon' のプリセットは除外
   */
  async loadVoicePresets() {
    try {
      const response = await axios.get('/static/voice-presets.json');
      const allPresets = response.data.voice_presets || [];
      
      // Filter out 'coming_soon' presets (ElevenLabs等の準備中ボイス)
      this.voicePresets = allPresets.filter(preset => preset.status !== 'coming_soon');
      
      console.log('[AudioUI] Loaded voice presets:', this.voicePresets.length, '(filtered from', allPresets.length, ')');
    } catch (error) {
      console.error('[AudioUI] Failed to load voice presets:', error);
      this.voicePresets = [];
    }
  },

  // ===== Phase 4: TTS Usage Tracking =====
  
  /**
   * Load TTS usage data from API (with cache)
   * キャッシュは5分間有効
   */
  async loadTTSUsage() {
    const now = Date.now();
    const cacheExpiry = 5 * 60 * 1000; // 5 minutes
    
    if (this.ttsUsage && this.ttsUsageLastFetch && (now - this.ttsUsageLastFetch < cacheExpiry)) {
      return this.ttsUsage;
    }
    
    try {
      const response = await axios.get('/api/tts/usage');
      this.ttsUsage = response.data;
      this.ttsUsageLastFetch = now;
      console.log('[AudioUI] TTS usage loaded:', this.ttsUsage.monthly.percentage + '%');
      return this.ttsUsage;
    } catch (error) {
      console.error('[AudioUI] Failed to load TTS usage:', error);
      return null;
    }
  },
  
  /**
   * Generate TTS usage bar HTML
   */
  generateTTSUsageBarHTML() {
    const usage = this.ttsUsage;
    if (!usage) return '';
    
    const percentage = usage.monthly.percentage;
    const warningLevel = usage.warning_level;
    
    // Color by warning level
    let barColor = 'bg-green-500';
    let textColor = 'text-green-700';
    let warningIcon = '';
    let warningMessage = '';
    
    if (warningLevel === 'limit_reached') {
      barColor = 'bg-red-500';
      textColor = 'text-red-700';
      warningIcon = '<i class="fas fa-ban mr-1"></i>';
      warningMessage = '<span class="text-red-600 text-xs font-bold ml-2">上限到達</span>';
    } else if (warningLevel === 'warning_95') {
      barColor = 'bg-red-500';
      textColor = 'text-red-700';
      warningIcon = '<i class="fas fa-exclamation-triangle mr-1 text-red-500"></i>';
      warningMessage = '<span class="text-red-600 text-xs ml-2">残りわずか!</span>';
    } else if (warningLevel === 'warning_85') {
      barColor = 'bg-orange-500';
      textColor = 'text-orange-700';
      warningIcon = '<i class="fas fa-exclamation-circle mr-1 text-orange-500"></i>';
      warningMessage = '<span class="text-orange-600 text-xs ml-2">注意</span>';
    } else if (warningLevel === 'warning_70') {
      barColor = 'bg-yellow-500';
      textColor = 'text-yellow-700';
    }
    
    return `
      <div class="mb-3 p-2 bg-gray-50 rounded-lg border border-gray-200">
        <div class="flex items-center justify-between mb-1">
          <span class="text-xs text-gray-600">
            ${warningIcon}今月の使用量
          </span>
          <span class="text-xs ${textColor} font-semibold">
            $${usage.monthly.used_usd.toFixed(2)} / $${usage.monthly.limit_usd}
            ${warningMessage}
          </span>
        </div>
        <div class="w-full bg-gray-200 rounded-full h-2">
          <div class="${barColor} h-2 rounded-full transition-all duration-300" style="width: ${Math.min(100, percentage)}%"></div>
        </div>
        <div class="flex justify-between mt-1">
          <span class="text-xs text-gray-500">${usage.monthly.characters_used.toLocaleString()} 文字</span>
          <span class="text-xs text-gray-500">${percentage}%</span>
        </div>
      </div>
    `;
  },
  
  /**
   * Update TTS usage display (can be called after generation)
   */
  async refreshTTSUsage() {
    // Clear cache to force reload
    this.ttsUsageLastFetch = null;
    await this.loadTTSUsage();
    
    // Update all usage bars
    document.querySelectorAll('.tts-usage-bar').forEach(bar => {
      bar.innerHTML = this.generateTTSUsageBarHTML();
    });
  },

  /**
   * Initialize audio UI for a single scene
   * @param {object} scene 
   */
  initForScene(scene) {
    const sceneId = scene.id;
    const container = document.querySelector(`#builder-scene-${sceneId} .audio-section-content`);
    
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
    
    // Voice preset selector options (Phase X-1: Add data-provider)
    const voiceOptions = this.voicePresets.map(preset => 
      `<option value="${preset.id}" data-provider="${preset.provider || 'google'}">${preset.name}</option>`
    ).join('');
    
    return `
      <!-- Phase 4: TTS Usage Bar -->
      <div class="tts-usage-bar">${this.generateTTSUsageBarHTML()}</div>
      
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
  async handleGenerate(sceneId, forceRegenerate = false) {
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
    
    // Phase X-1: Determine provider from voice preset
    const selectedOption = voiceSelect?.options[voiceSelect.selectedIndex];
    const provider = selectedOption?.dataset?.provider || 'google';
    
    // 連打防止: 既存音声がある場合、同じ voice_id なら確認ダイアログを表示
    if (!forceRegenerate) {
      try {
        const existingAudio = await window.AudioClient.fetchAudioForScene(sceneId);
        const completedAudio = existingAudio?.audio_generations?.find(a => a.status === 'completed');
        
        if (completedAudio && completedAudio.voice_id === voiceId) {
          // 同じ音声タイプで既に生成済み
          const confirmRegenerate = confirm(
            '同じ音声タイプで既に生成済みです。\n\n' +
            '再生成するとコストがかかります。続行しますか？\n\n' +
            '※セリフを変更した場合は「保存」してから再生成してください。'
          );
          if (!confirmRegenerate) {
            return;
          }
        }
      } catch (e) {
        // 取得失敗は無視して続行
        console.warn('[AudioUI] Failed to check existing audio:', e);
      }
    }
    
    try {
      // Set to generating state immediately
      this.setButtonState(sceneId, 'generating', 0);
      this.hideError(sceneId);
      
      // Call API with provider
      const result = await window.AudioClient.generate(sceneId, {
        voice_id: voiceId,
        provider: provider,
        format: 'mp3',
        sample_rate: provider === 'fish' ? 44100 : 24000
      });
      
      console.log('[AudioUI] Generate started:', result);
      
      // Start watch and polling
      window.AudioState.startWatch(sceneId);
      window.AudioState.startPolling(sceneId);
      
    } catch (error) {
      console.error(`[AudioUI] Generate error for scene ${sceneId}:`, error);
      
      // Handle specific errors with detailed messages
      const errorCode = error.response?.data?.error?.code;
      const errorMessage = error.response?.data?.error?.message || error.message || '';
      
      if (error.response?.status === 409) {
        this.showError(sceneId, '音声生成が既に進行中です');
      } else if (errorCode === 'NO_DIALOGUE') {
        this.showError(sceneId, 'このシーンにはセリフがありません');
      } else if (errorCode === 'TTS_FAILED' || errorCode === 'ELEVENLABS_ERROR') {
        // Show detailed error for TTS failures (including API key issues)
        this.showError(sceneId, errorMessage || 'TTS生成に失敗しました');
      } else if (errorMessage.includes('Invalid API key') || errorMessage.includes('quota')) {
        this.showError(sceneId, errorMessage);
      } else {
        this.showError(sceneId, errorMessage || '音声生成の開始に失敗しました');
      }
      
      this.setButtonState(sceneId, 'failed', 0);
    }
  },

  /**
   * Set button state (FIXED DOM - only update content/classes)
   * @param {number} sceneId 
   * @param {string} state - 'idle' | 'generating' | 'completed' | 'failed' | 'limit_reached'
   * @param {number} percent - 0-100
   */
  setButtonState(sceneId, state, percent) {
    const btn = document.getElementById(`audioPrimaryBtn-${sceneId}`);
    if (!btn) return;
    
    // Phase 4: Check if limit reached
    if (this.ttsUsage?.warning_level === 'limit_reached' && state !== 'generating') {
      state = 'limit_reached';
    }
    
    // Remove all state classes
    btn.classList.remove('bg-blue-600', 'hover:bg-blue-700', 'bg-yellow-500', 'hover:bg-yellow-600', 
                         'bg-green-600', 'hover:bg-green-700', 'bg-red-600', 'hover:bg-red-700',
                         'bg-gray-400', 'cursor-not-allowed');
    
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
        
      // Phase 4: Limit reached state
      case 'limit_reached':
        btn.classList.add('bg-gray-400', 'cursor-not-allowed');
        btn.innerHTML = '<i class="fas fa-ban mr-2"></i>上限到達';
        btn.disabled = true;
        btn.title = '月間使用量の上限に達しました。来月までお待ちください。';
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
