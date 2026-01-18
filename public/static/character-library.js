/**
 * Character Library Client (Phase A-3)
 * Handles user character library operations and import to projects
 * 
 * Note: This module now delegates modal UI to WorldCharacterUI
 * for import operations. It still provides saveToLibrary functionality.
 */

(function() {
  'use strict';

  /**
   * Show toast notification
   */
  function toast(msg, type = 'info') {
    if (typeof window.showToast === 'function') {
      return window.showToast(msg, type);
    }
    alert(msg);
  }

  const CharacterLibrary = {
    /**
     * Initialize library module
     */
    init() {
      console.log('[CharacterLibrary] Initializing...');
      // Note: Modal UI is handled by WorldCharacterUI
      // This module focuses on API operations
    },

    /**
     * Open library import modal
     * Delegates to WorldCharacterUI if available
     */
    open() {
      console.log('[CharacterLibrary] Opening modal (delegating to WorldCharacterUI)');
      if (window.WorldCharacterUI && typeof window.WorldCharacterUI.openLibraryImportModal === 'function') {
        window.WorldCharacterUI.openLibraryImportModal();
      } else {
        console.error('[CharacterLibrary] WorldCharacterUI not available');
        toast('キャラクターライブラリを開けません。ページを再読み込みしてください。', 'error');
      }
    },

    /**
     * Close library import modal
     * Delegates to WorldCharacterUI if available
     */
    close() {
      console.log('[CharacterLibrary] Closing modal (delegating to WorldCharacterUI)');
      if (window.WorldCharacterUI && typeof window.WorldCharacterUI.closeLibraryImportModal === 'function') {
        window.WorldCharacterUI.closeLibraryImportModal();
      }
    },

    /**
     * Save current project character to user's library
     * @param {number} projectId - Project ID
     * @param {string} characterKey - Character key
     * @returns {Promise<object>} Saved character data
     */
    async saveToLibrary(projectId, characterKey) {
      console.log(`[CharacterLibrary] Saving ${characterKey} from project ${projectId} to library`);

      try {
        const response = await fetch('/api/user/characters/from-project', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project_id: projectId,
            character_key: characterKey
          })
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error?.message || 'ライブラリへの保存に失敗しました');
        }

        const data = await response.json();
        toast(`${data.character?.character_name || characterKey} をライブラリに保存しました`, 'success');
        return data;
      } catch (error) {
        console.error('[CharacterLibrary] Save to library failed:', error);
        toast(error.message || '保存に失敗しました', 'error');
        throw error;
      }
    },

    /**
     * Get all characters from user's library
     * @returns {Promise<Array>} List of user characters
     */
    async getUserCharacters() {
      try {
        const response = await fetch('/api/user/characters');
        if (!response.ok) {
          throw new Error('ライブラリの取得に失敗しました');
        }
        const data = await response.json();
        return data.characters || [];
      } catch (error) {
        console.error('[CharacterLibrary] Get user characters failed:', error);
        throw error;
      }
    },

    /**
     * Create a new character in user's library
     * @param {object} characterData - Character data
     * @returns {Promise<object>} Created character
     */
    async createInLibrary(characterData) {
      try {
        const response = await fetch('/api/user/characters', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(characterData)
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error?.message || 'キャラクターの作成に失敗しました');
        }

        const data = await response.json();
        toast(`${data.character?.character_name} をライブラリに作成しました`, 'success');
        return data.character;
      } catch (error) {
        console.error('[CharacterLibrary] Create in library failed:', error);
        toast(error.message || '作成に失敗しました', 'error');
        throw error;
      }
    },

    /**
     * Update a character in user's library
     * @param {string} characterKey - Character key
     * @param {object} updateData - Update data
     * @returns {Promise<object>} Updated character
     */
    async updateInLibrary(characterKey, updateData) {
      try {
        const response = await fetch(`/api/user/characters/${encodeURIComponent(characterKey)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(updateData)
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error?.message || 'キャラクターの更新に失敗しました');
        }

        const data = await response.json();
        toast(`${data.character?.character_name} を更新しました`, 'success');
        return data.character;
      } catch (error) {
        console.error('[CharacterLibrary] Update in library failed:', error);
        toast(error.message || '更新に失敗しました', 'error');
        throw error;
      }
    },

    /**
     * Delete a character from user's library
     * @param {string} characterKey - Character key
     * @returns {Promise<boolean>} Success status
     */
    async deleteFromLibrary(characterKey) {
      try {
        const response = await fetch(`/api/user/characters/${encodeURIComponent(characterKey)}`, {
          method: 'DELETE'
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error?.message || 'キャラクターの削除に失敗しました');
        }

        toast('ライブラリから削除しました', 'success');
        return true;
      } catch (error) {
        console.error('[CharacterLibrary] Delete from library failed:', error);
        toast(error.message || '削除に失敗しました', 'error');
        throw error;
      }
    }
  };

  // Initialize on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => CharacterLibrary.init());
  } else {
    CharacterLibrary.init();
  }

  // Export to global scope
  window.CharacterLibrary = CharacterLibrary;
})();
