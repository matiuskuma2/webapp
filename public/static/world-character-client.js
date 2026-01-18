// public/static/world-character-client.js
// Responsibility: API calls only (Phase X-2 UI-2)
// Design pattern: Same as audio-client.js (separation of concerns)

(function () {
  'use strict';

  const API_BASE = '/api';

  /**
   * Generic JSON request wrapper with error handling
   * @param {string} url - API endpoint
   * @param {object} options - Fetch options
   * @returns {Promise<object>} Parsed JSON response
   * @throws {Error} HTTP error with code, status, and payload
   */
  async function requestJson(url, options = {}) {
    const res = await fetch(url, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_) {
      // Ignore parse errors for non-JSON responses
    }
    
    if (!res.ok) {
      const msg = json?.error?.message || json?.message || text || `HTTP ${res.status}`;
      const code = json?.error?.code || `HTTP_${res.status}`;
      const err = new Error(msg);
      err.code = code;
      err.status = res.status;
      err.payload = json;
      throw err;
    }
    
    return json;
  }

  /**
   * Fetch all characters for a project
   * @param {number} projectId - Project ID
   * @returns {Promise<{characters: Array}>}
   */
  async function fetchCharacters(projectId) {
    return requestJson(`${API_BASE}/projects/${projectId}/characters`, { method: 'GET' });
  }

  /**
   * Create a new character
   * @param {number} projectId - Project ID
   * @param {object} payload - Character data
   * @param {string} payload.character_key - Unique key (alphanumeric + underscore)
   * @param {string} payload.character_name - Character name (2+ chars)
   * @param {string[]|null} payload.aliases - Aliases (3+ chars each, optional)
   * @param {string|null} payload.appearance_description - Appearance (optional)
   * @param {string|null} payload.voice_preset_id - Voice preset ID (optional)
   * @returns {Promise<object>}
   */
  async function createCharacter(projectId, payload) {
    return requestJson(`${API_BASE}/projects/${projectId}/characters`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  /**
   * Update an existing character
   * @param {number} projectId - Project ID
   * @param {string} characterKey - Character key to update
   * @param {object} payload - Updated character data
   * @returns {Promise<object>}
   */
  async function updateCharacter(projectId, characterKey, payload) {
    return requestJson(`${API_BASE}/projects/${projectId}/characters/${encodeURIComponent(characterKey)}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  }

  /**
   * Delete a character
   * @param {number} projectId - Project ID
   * @param {string} characterKey - Character key to delete
   * @returns {Promise<object>}
   */
  async function deleteCharacter(projectId, characterKey) {
    return requestJson(`${API_BASE}/projects/${projectId}/characters/${encodeURIComponent(characterKey)}`, {
      method: 'DELETE',
    });
  }

  /**
   * Fetch dangerous words list (common nouns that cause false positives)
   * @returns {Promise<{dangerousWords: {ja: string[], en: string[]}}>}
   */
  async function fetchDangerousWords() {
    // TODO: 要確認 - Option A: Static file (current approach)
    // Alternative: Serve via API endpoint if access control is needed
    return requestJson(`/static/character-dangerous-words.json`, { method: 'GET' });
  }

  /**
   * Fetch voice presets for character registration
   * @returns {Promise<{voice_presets: Array}>}
   */
  async function fetchVoicePresets() {
    // Use shared voice presets file
    return requestJson(`/static/voice-presets.json`, { method: 'GET' });
  }

  /**
   * Fetch scene character assignments (UI-4)
   * @param {number} sceneId - Scene ID
   * @returns {Promise<{scene_characters: Array}>}
   */
  async function fetchSceneCharacters(sceneId) {
    const url = `${API_BASE}/scenes/${sceneId}/characters`;
    console.log('[WorldCharacterClient] fetchSceneCharacters URL:', url);
    return requestJson(url, { method: 'GET' });
  }

  /**
   * Batch update scene character assignments (UI-4)
   * Uses existing POST /scenes/:sceneId/characters/batch with new format
   * @param {number} sceneId - Scene ID
   * @param {object} payload - Batch assignment data
   * @param {Array} payload.assignments - Array of {character_key, is_primary}
   * @returns {Promise<object>}
   */
  async function batchUpdateSceneCharacters(sceneId, payload) {
    return requestJson(`${API_BASE}/scenes/${sceneId}/characters/batch`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  /**
   * Auto-assign characters to all scenes (UI-5)
   * @param {number} projectId - Project ID
   * @returns {Promise<object>} Response with assigned/scenes/skipped counts
   */
  async function autoAssignCharacters(projectId) {
    return requestJson(`${API_BASE}/projects/${projectId}/characters/auto-assign`, {
      method: 'POST',
    });
  }

  /**
   * Fetch scenes with character assignments (UI-5)
   * @param {number} projectId - Project ID
   * @returns {Promise<object>} Response with scenes array (including characters)
   */
  async function fetchScenesWithCharacters(projectId) {
    return requestJson(`${API_BASE}/projects/${projectId}/scenes?view=board`, {
      method: 'GET',
    });
  }

  /**
   * Upload character reference image (Phase X-4)
   * @param {number} projectId - Project ID
   * @param {string} characterKey - Character key
   * @param {File} imageFile - Image file (PNG/JPEG/WEBP, max 5MB)
   * @returns {Promise<object>} Response with r2_key, r2_url
   */
  async function uploadCharacterReferenceImage(projectId, characterKey, imageFile) {
    const formData = new FormData();
    formData.append('image', imageFile);

    const res = await fetch(`${API_BASE}/projects/${projectId}/characters/${encodeURIComponent(characterKey)}/reference-image`, {
      method: 'POST',
      body: formData,
    });

    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_) {
      // Ignore parse errors
    }

    if (!res.ok) {
      const msg = json?.error?.message || json?.message || text || `HTTP ${res.status}`;
      const code = json?.error?.code || `HTTP_${res.status}`;
      const err = new Error(msg);
      err.code = code;
      err.status = res.status;
      err.payload = json;
      throw err;
    }

    return json;
  }

  /**
   * Delete character reference image (Phase X-4)
   * @param {number} projectId - Project ID
   * @param {string} characterKey - Character key
   * @returns {Promise<object>}
   */
  async function deleteCharacterReferenceImage(projectId, characterKey) {
    return requestJson(`${API_BASE}/projects/${projectId}/characters/${encodeURIComponent(characterKey)}/reference-image`, {
      method: 'DELETE',
    });
  }

  /**
   * Generate character preview image (returns Blob)
   * @param {number} projectId - Project ID
   * @param {string} prompt - Image generation prompt
   * @returns {Promise<Blob>}
   */
  async function generateCharacterPreviewImage(projectId, prompt) {
    const res = await fetch(`${API_BASE}/projects/${projectId}/characters/generate-preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt })
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Generate preview failed: ${res.status} ${text}`);
    }
    return await res.blob();
  }

  /**
   * Update character with optional image (single API call)
   * @param {number} projectId - Project ID
   * @param {string} characterKey - Character key
   * @param {object} payload - Character data
   * @param {File|null} imageFileOrNull - Optional image file
   * @returns {Promise<object>}
   */
  async function updateCharacterWithOptionalImage(projectId, characterKey, payload, imageFileOrNull) {
    const fd = new FormData();
    fd.append('character_name', payload.character_name || '');
    fd.append('aliases_json', JSON.stringify(payload.aliases || []));
    fd.append('appearance_description', payload.appearance_description || '');
    fd.append('voice_preset_id', payload.voice_preset_id || '');

    if (imageFileOrNull) {
      fd.append('image', imageFileOrNull);
    }

    const res = await fetch(`${API_BASE}/projects/${projectId}/characters/${encodeURIComponent(characterKey)}/update`, {
      method: 'POST',
      body: fd
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error?.message || `Update failed: ${res.status}`);
    }
    return data;
  }

  /**
   * Create a new character with optional image (FormData)
   * @param {number} projectId - Project ID
   * @param {object} payload - Character data
   * @param {File|null} imageFileOrNull - Optional image file
   * @returns {Promise<object>}
   */
  async function createCharacterWithImage(projectId, payload, imageFileOrNull) {
    const fd = new FormData();
    fd.append('character_key', payload.character_key || '');
    fd.append('character_name', payload.character_name || '');
    fd.append('aliases_json', JSON.stringify(payload.aliases || []));
    fd.append('appearance_description', payload.appearance_description || '');
    fd.append('voice_preset_id', payload.voice_preset_id || '');

    if (imageFileOrNull) {
      fd.append('image', imageFileOrNull);
    }

    const res = await fetch(`${API_BASE}/projects/${projectId}/characters/create-with-image`, {
      method: 'POST',
      body: fd
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error?.message || `Create failed: ${res.status}`);
    }
    return data;
  }

  // Expose API client to global scope
  window.WorldCharacterClient = {
    fetchCharacters,
    createCharacter,
    updateCharacter,
    deleteCharacter,
    fetchDangerousWords,
    fetchVoicePresets,
    fetchSceneCharacters,
    batchUpdateSceneCharacters,
    autoAssignCharacters,
    fetchScenesWithCharacters,
    uploadCharacterReferenceImage, // Phase X-4
    deleteCharacterReferenceImage, // Phase X-4
    generateCharacterPreviewImage, // New: Preview generation
    updateCharacterWithOptionalImage, // New: Unified update
    createCharacterWithImage, // New: Create with image
  };

  console.log('[WorldCharacterClient] Loaded');
})();
