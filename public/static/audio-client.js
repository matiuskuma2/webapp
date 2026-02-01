// audio-client.js - Audio API client (Phase 3)
// Responsibility: API calls only (no UI, no state management)

window.AudioClient = {
  /**
   * Generate audio for a scene
   * @param {number} sceneId 
   * @param {object} payload - { voice_id, provider?, format?, sample_rate? }
   * @returns {Promise<object>} audio_generation object
   */
  async generate(sceneId, payload) {
    try {
      const response = await axios.post(
        `${API_BASE}/scenes/${sceneId}/generate-audio`,
        payload
      );
      return response.data;
    } catch (error) {
      console.error(`[AudioClient] generate error for scene ${sceneId}:`, error);
      throw error;
    }
  },

  /**
   * Get audio generation history for a scene
   * @param {number} sceneId 
   * @returns {Promise<object>} { audio_generations: [], active_audio: {} }
   */
  async list(sceneId) {
    try {
      const response = await axios.get(`${API_BASE}/scenes/${sceneId}/audio`);
      return response.data;
    } catch (error) {
      console.error(`[AudioClient] list error for scene ${sceneId}:`, error);
      throw error;
    }
  },

  /**
   * Activate an audio generation (set as active)
   * @param {number} audioId 
   * @returns {Promise<object>} { success: true, active_audio: {} }
   */
  async activate(audioId) {
    try {
      const response = await axios.post(`${API_BASE}/audio/${audioId}/activate`);
      return response.data;
    } catch (error) {
      console.error(`[AudioClient] activate error for audio ${audioId}:`, error);
      throw error;
    }
  },

  /**
   * Delete an audio generation
   * @param {number} audioId 
   * @param {object} options - { force: boolean } - force=true allows deleting active audio
   * @returns {Promise<object>} { success: true }
   */
  async remove(audioId, options = {}) {
    try {
      const params = options.force ? '?force=true' : '';
      const response = await axios.delete(`${API_BASE}/audio/${audioId}${params}`);
      return response.data;
    } catch (error) {
      console.error(`[AudioClient] remove error for audio ${audioId}:`, error);
      throw error;
    }
  }
};

console.log('[AudioClient] Loaded successfully');
