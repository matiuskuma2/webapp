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
        
        // Wait 500ms, then update preview and button
        setTimeout(() => {
          if (window.AudioUI) {
            window.AudioUI.updatePreview(sceneId, latest);
            window.AudioUI.setButtonState(sceneId, 'completed', 100);
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
   * Clean up all timers (for scene deletion, etc.)
   */
  cleanupAll() {
    console.log('[AudioState] Cleaning up all timers');
    Object.keys(this.audioTimers).forEach(sceneId => this.stopWatch(parseInt(sceneId)));
    Object.keys(this.audioPollTimers).forEach(sceneId => this.stopPolling(parseInt(sceneId)));
  }
};

console.log('[AudioState] Loaded successfully');
