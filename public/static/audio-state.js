// audio-state.js - Audio state management (Phase 3)
// Responsibility: Fake progress timers, polling, state tracking only

window.AudioState = {
  // Fake progress timers (per scene)
  audioTimers: {},
  audioProgress: {},
  
  // Polling timers (per scene)
  audioPollTimers: {},

  /**
   * Start fake progress for a scene (0 → 100%)
   * @param {number} sceneId 
   */
  startWatch(sceneId) {
    console.log(`[AudioState] Starting watch for scene ${sceneId}`);
    
    // Clear existing timer if any
    this.stopWatch(sceneId);
    
    // Initialize progress
    this.audioProgress[sceneId] = 0;
    
    // Update progress every 1 second
    this.audioTimers[sceneId] = setInterval(() => {
      const current = this.audioProgress[sceneId] || 0;
      
      // Increment pattern: fast at start, slow near end
      let increment;
      if (current < 10) {
        increment = 1; // 0-10%: +1% per second
      } else if (current < 30) {
        increment = 2; // 10-30%: +2% per second
      } else if (current < 60) {
        increment = 3; // 30-60%: +3% per second
      } else if (current < 80) {
        increment = 2; // 60-80%: +2% per second
      } else if (current < 95) {
        increment = 1; // 80-95%: +1% per second
      } else {
        // 95-99%: Stay at 95% (wait for completion signal)
        increment = 0;
      }
      
      const next = Math.min(current + increment, 95);
      this.audioProgress[sceneId] = next;
      
      // Update UI via AudioUI
      if (window.AudioUI) {
        window.AudioUI.setButtonState(sceneId, 'generating', next);
      }
    }, 1000);
  },

  /**
   * Stop fake progress for a scene
   * @param {number} sceneId 
   */
  stopWatch(sceneId) {
    if (this.audioTimers[sceneId]) {
      console.log(`[AudioState] Stopping watch for scene ${sceneId}`);
      clearInterval(this.audioTimers[sceneId]);
      delete this.audioTimers[sceneId];
      delete this.audioProgress[sceneId];
    }
  },

  /**
   * Start polling for audio completion
   * @param {number} sceneId 
   */
  async startPolling(sceneId) {
    console.log(`[AudioState] Starting polling for scene ${sceneId}`);
    
    // Clear existing poll timer if any
    this.stopPolling(sceneId);
    
    // Poll immediately
    await this.pollOnce(sceneId);
    
    // Then poll every 3 seconds
    this.audioPollTimers[sceneId] = setInterval(async () => {
      await this.pollOnce(sceneId);
    }, 3000);
  },

  /**
   * Stop polling for a scene
   * @param {number} sceneId 
   */
  stopPolling(sceneId) {
    if (this.audioPollTimers[sceneId]) {
      console.log(`[AudioState] Stopping polling for scene ${sceneId}`);
      clearInterval(this.audioPollTimers[sceneId]);
      delete this.audioPollTimers[sceneId];
    }
  },

  /**
   * Poll once for audio status
   * @param {number} sceneId 
   */
  async pollOnce(sceneId) {
    try {
      const data = await window.AudioClient.list(sceneId);
      const latest = data.audio_generations?.[0];
      
      if (!latest) {
        console.warn(`[AudioState] No audio generations found for scene ${sceneId}`);
        return;
      }
      
      console.log(`[AudioState] Poll result for scene ${sceneId}: status=${latest.status}`);
      
      if (latest.status === 'completed') {
        // Stop watch and polling
        this.stopWatch(sceneId);
        this.stopPolling(sceneId);
        
        // Set to 100% briefly
        if (window.AudioUI) {
          window.AudioUI.setButtonState(sceneId, 'generating', 100);
        }
        
        // Also update character voice button if exists (pass audio data for preview)
        this.updateCharAudioButton(sceneId, 'completed', null, latest);
        
        // Wait 500ms, then update preview and button
        setTimeout(() => {
          if (window.AudioUI) {
            window.AudioUI.updatePreview(sceneId, latest);
            window.AudioUI.setButtonState(sceneId, 'completed', 100);
            
            // Phase 4: Refresh TTS usage display after generation
            window.AudioUI.refreshTTSUsage();
          }
          // Show toast for character voice generation
          if (window.showToast) {
            window.showToast('音声生成が完了しました', 'success');
          }
        }, 500);
        
      } else if (latest.status === 'failed') {
        // Stop watch and polling
        this.stopWatch(sceneId);
        this.stopPolling(sceneId);
        
        // Show failed state
        if (window.AudioUI) {
          window.AudioUI.setButtonState(sceneId, 'failed', 0);
          window.AudioUI.showError(sceneId, latest.error_message || '音声生成に失敗しました');
        }
        
        // Also update character voice button if exists
        this.updateCharAudioButton(sceneId, 'failed', latest.error_message);
        
        // Show toast for failure
        if (window.showToast) {
          window.showToast('音声生成に失敗しました: ' + (latest.error_message || '不明なエラー'), 'error');
        }
      }
      // If generating: keep watching and polling
      
    } catch (error) {
      console.error(`[AudioState] Poll error for scene ${sceneId}:`, error);
      
      // On 524 or network error: keep polling (generation might still be running)
      if (error.response?.status === 524 || error.code === 'ECONNABORTED') {
        console.log(`[AudioState] 524/timeout - continuing poll for scene ${sceneId}`);
        // Keep progress at 95% (stall indicator)
        if (this.audioProgress[sceneId] > 95) {
          this.audioProgress[sceneId] = 95;
        }
      } else {
        // Other errors: stop
        this.stopWatch(sceneId);
        this.stopPolling(sceneId);
        if (window.AudioUI) {
          window.AudioUI.setButtonState(sceneId, 'failed', 0);
        }
      }
    }
  },

  /**
   * Update character voice button state (charAudioBtn-{sceneId})
   * @param {number} sceneId 
   * @param {string} state - 'completed' | 'failed'
   * @param {string} errorMessage - optional error message
   * @param {object} audioData - audio generation data (for completed state)
   */
  updateCharAudioButton(sceneId, state, errorMessage, audioData) {
    const btn = document.getElementById(`charAudioBtn-${sceneId}`);
    
    if (state === 'completed') {
      // Update audio preview (this will hide the generate button)
      this.updateCharAudioPreview(sceneId, audioData);
      
    } else if (state === 'failed') {
      if (!btn) return;
      
      btn.disabled = false;
      btn.classList.remove('hidden');
      btn.innerHTML = '<i class="fas fa-exclamation-triangle mr-2"></i>失敗 - 再試行';
      btn.classList.remove('bg-green-600', 'hover:bg-green-700');
      btn.classList.add('bg-red-500', 'hover:bg-red-600');
      
      // Reset to normal state after 5 seconds
      setTimeout(() => {
        if (btn) {
          btn.innerHTML = '<i class="fas fa-volume-up mr-2"></i>キャラ音声で生成';
          btn.classList.remove('bg-red-500', 'hover:bg-red-600');
          btn.classList.add('bg-green-600', 'hover:bg-green-700');
        }
      }, 5000);
    }
  },

  /**
   * Update character audio preview player
   * @param {number} sceneId 
   * @param {object} audioData - audio generation data with r2_url
   */
  updateCharAudioPreview(sceneId, audioData) {
    const container = document.getElementById(`charAudioPreview-${sceneId}`);
    const btnContainer = document.getElementById(`charVoiceSettings-${sceneId}`);
    if (!container) return;
    
    if (audioData && audioData.r2_url) {
      // Show audio player with playback controls
      container.innerHTML = `
        <div class="bg-green-50 border border-green-200 rounded-lg p-3">
          <div class="flex items-center gap-2 mb-2">
            <i class="fas fa-check-circle text-green-600"></i>
            <span class="text-sm font-semibold text-green-800">音声生成済み</span>
          </div>
          <audio controls class="w-full" id="charAudio-${sceneId}">
            <source src="${audioData.r2_url}" type="audio/mpeg">
            お使いのブラウザは音声再生に対応していません。
          </audio>
        </div>
      `;
      container.classList.remove('hidden');
      
      // Hide the generate button when audio exists (user can use 履歴 to regenerate if needed)
      const btn = document.getElementById(`charAudioBtn-${sceneId}`);
      if (btn) {
        btn.classList.add('hidden');
      }
    } else {
      container.innerHTML = '';
      container.classList.add('hidden');
      
      // Show generate button when no audio
      const btn = document.getElementById(`charAudioBtn-${sceneId}`);
      if (btn) {
        btn.classList.remove('hidden');
      }
    }
  },

  /**
   * Load and display existing audio for a scene (called on page load)
   * @param {number} sceneId 
   */
  async loadExistingAudio(sceneId) {
    try {
      const data = await window.AudioClient.list(sceneId);
      const activeAudio = data.active_audio;
      const latestCompleted = data.audio_generations?.find(a => a.status === 'completed');
      
      // If there's active audio or at least one completed, show preview
      const audioToShow = activeAudio || latestCompleted;
      if (audioToShow && audioToShow.r2_url) {
        this.updateCharAudioPreview(sceneId, audioToShow);
      }
    } catch (error) {
      console.warn(`[AudioState] Failed to load existing audio for scene ${sceneId}:`, error);
    }
  },

  /**
   * Load existing audio for multiple scenes (called after scene cards are rendered)
   * @param {Array<number>} sceneIds 
   */
  async loadExistingAudioForScenes(sceneIds) {
    console.log('[AudioState] Loading existing audio for', sceneIds.length, 'scenes');
    
    // Load in parallel with a small delay between batches to avoid overwhelming the API
    const batchSize = 5;
    for (let i = 0; i < sceneIds.length; i += batchSize) {
      const batch = sceneIds.slice(i, i + batchSize);
      await Promise.all(batch.map(id => this.loadExistingAudio(id)));
    }
  },

  /**
   * Clean up all timers (for scene deletion, etc.)
   */
  cleanupAll() {
    console.log('[AudioState] Cleaning up all timers');
    Object.keys(this.audioTimers).forEach(sceneId => this.stopWatch(parseInt(sceneId)));
    Object.keys(this.audioPollTimers).forEach(sceneId => this.stopPolling(parseInt(sceneId)));
  }
};

console.log('[AudioState] Loaded successfully');
