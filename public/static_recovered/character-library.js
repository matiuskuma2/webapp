/**
 * Character Library Client (Phase A-3)
 * Handles user character library operations and import to projects
 */

(function() {
  'use strict';

  /**
   * XSS-safe HTML escaping
   */
  function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

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
    // State
    availableCharacters: [],
    filteredCharacters: [],
    searchQuery: '',

    /**
     * Initialize library modal
     */
    init() {
      console.log('[CharacterLibrary] Initializing...');
      this.bindEvents();
    },

    /**
     * Bind event listeners
     */
    bindEvents() {
      // Import button (in Styles > Characters)
      const importBtn = document.getElementById('btnImportFromLibrary');
      if (importBtn) {
        importBtn.addEventListener('click', () => this.open());
      }

      // Close button
      const closeBtn = document.getElementById('close-library-modal');
      if (closeBtn) {
        closeBtn.addEventListener('click', () => this.close());
      }

      // Search input
      const searchInput = document.getElementById('library-search');
      if (searchInput) {
        searchInput.addEventListener('input', (e) => {
          this.searchQuery = e.target.value.trim().toLowerCase();
          this.filterAndRender();
        });
      }

      // Background click to close
      const modal = document.getElementById('library-import-modal');
      if (modal) {
        modal.addEventListener('click', (e) => {
          if (e.target === modal) {
            this.close();
          }
        });
      }
    },

    /**
     * Open library modal and load available characters
     */
    async open() {
      console.log('[CharacterLibrary] Opening modal');
      const modal = document.getElementById('library-import-modal');
      if (!modal) return;

      modal.classList.remove('hidden');
      this.searchQuery = '';
      const searchInput = document.getElementById('library-search');
      if (searchInput) searchInput.value = '';

      await this.loadAvailableCharacters();
    },

    /**
     * Close library modal
     */
    close() {
      console.log('[CharacterLibrary] Closing modal');
      const modal = document.getElementById('library-import-modal');
      if (modal) {
        modal.classList.add('hidden');
      }
    },

    /**
     * Load available characters from library (not yet imported)
     */
    async loadAvailableCharacters() {
      const listEl = document.getElementById('library-characters-list');
      const emptyEl = document.getElementById('library-empty-message');
      
      if (listEl) {
        listEl.innerHTML = '<div class="text-gray-500 text-sm">読み込み中...</div>';
      }
      if (emptyEl) emptyEl.classList.add('hidden');

      const projectId = window.PROJECT_ID;
      if (!projectId) {
        console.error('[CharacterLibrary] No PROJECT_ID');
        if (listEl) listEl.innerHTML = '<div class="text-red-500 text-sm">プロジェクトIDが見つかりません</div>';
        return;
      }

      try {
        const response = await axios.get(`/api/projects/${projectId}/characters/library-available`);
        this.availableCharacters = response.data.characters || [];
        console.log(`[CharacterLibrary] Loaded ${this.availableCharacters.length} available characters`);
        
        this.filterAndRender();
      } catch (error) {
        console.error('[CharacterLibrary] Load failed:', error);
        if (listEl) {
          listEl.innerHTML = `<div class="text-red-500 text-sm">読み込み失敗: ${error.message}</div>`;
        }
      }
    },

    /**
     * Filter characters by search query and render
     */
    filterAndRender() {
      if (this.searchQuery) {
        this.filteredCharacters = this.availableCharacters.filter(c => 
          c.character_name.toLowerCase().includes(this.searchQuery) ||
          c.character_key.toLowerCase().includes(this.searchQuery)
        );
      } else {
        this.filteredCharacters = [...this.availableCharacters];
      }

      this.render();
    },

    /**
     * Render character list
     */
    render() {
      const listEl = document.getElementById('library-characters-list');
      const emptyEl = document.getElementById('library-empty-message');
      
      if (!listEl) return;

      if (this.filteredCharacters.length === 0) {
        listEl.innerHTML = '';
        if (emptyEl) emptyEl.classList.remove('hidden');
        return;
      }

      if (emptyEl) emptyEl.classList.add('hidden');

      listEl.innerHTML = this.filteredCharacters.map(char => `
        <div class="border border-gray-200 rounded-lg p-4 hover:bg-gray-50 transition-colors flex items-center justify-between gap-4"
             data-character-id="${char.id}">
          <div class="flex items-center gap-3 flex-1 min-w-0">
            ${char.reference_image_r2_url 
              ? `<div class="w-12 h-12 flex-shrink-0 overflow-hidden rounded-lg bg-gray-100 border border-gray-300">
                   <img src="${escapeHtml(char.reference_image_r2_url)}" alt="${escapeHtml(char.character_name)}" 
                        class="w-full h-full object-cover" 
                        onerror="this.parentNode.innerHTML='<div class=\\'w-full h-full flex items-center justify-center text-gray-400 text-lg\\'>?</div>'" />
                 </div>`
              : `<div class="w-12 h-12 flex-shrink-0 rounded-lg bg-gray-100 border border-gray-300 flex items-center justify-center">
                   <i class="fas fa-user text-gray-400"></i>
                 </div>`
            }
            <div class="min-w-0">
              <div class="font-semibold text-gray-800 truncate">
                ${escapeHtml(char.character_name)}
                ${char.is_favorite ? '<i class="fas fa-star text-yellow-500 ml-1"></i>' : ''}
              </div>
              <div class="text-xs text-gray-500 truncate">key: ${escapeHtml(char.character_key)}</div>
              ${char.description ? `<div class="text-xs text-gray-600 truncate mt-1">${escapeHtml(char.description)}</div>` : ''}
            </div>
          </div>
          <button 
            class="library-import-btn px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-semibold flex-shrink-0"
            data-character-id="${char.id}"
            data-character-name="${escapeHtml(char.character_name)}"
          >
            <i class="fas fa-plus mr-1"></i>
            追加
          </button>
        </div>
      `).join('');

      // Bind import buttons
      listEl.querySelectorAll('.library-import-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const charId = parseInt(btn.dataset.characterId);
          const charName = btn.dataset.characterName;
          this.importCharacter(charId, charName, btn);
        });
      });
    },

    /**
     * Import a character to the project
     */
    async importCharacter(userCharacterId, characterName, buttonEl) {
      const projectId = window.PROJECT_ID;
      if (!projectId) {
        toast('プロジェクトIDが見つかりません', 'error');
        return;
      }

      console.log(`[CharacterLibrary] Importing character ${userCharacterId} to project ${projectId}`);

      // Disable button during import
      if (buttonEl) {
        buttonEl.disabled = true;
        buttonEl.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>追加中...';
      }

      try {
        await axios.post(`/api/projects/${projectId}/characters/import`, {
          user_character_id: userCharacterId
        });

        toast(`${characterName} をプロジェクトに追加しました`, 'success');

        // Remove from available list
        this.availableCharacters = this.availableCharacters.filter(c => c.id !== userCharacterId);
        this.filterAndRender();

        // Refresh main character list
        if (window.WorldCharacterUI && typeof window.WorldCharacterUI.loadCharactersList === 'function') {
          window.WorldCharacterUI.loadCharactersList();
        }

      } catch (error) {
        console.error('[CharacterLibrary] Import failed:', error);
        const msg = error.response?.data?.error?.message || error.message || 'インポートに失敗しました';
        toast(msg, 'error');

        // Re-enable button
        if (buttonEl) {
          buttonEl.disabled = false;
          buttonEl.innerHTML = '<i class="fas fa-plus mr-1"></i>追加';
        }
      }
    },

    /**
     * Save current project character to library
     */
    async saveToLibrary(projectId, characterKey) {
      console.log(`[CharacterLibrary] Saving ${characterKey} from project ${projectId} to library`);

      try {
        const response = await axios.post('/api/user/characters/from-project', {
          project_id: projectId,
          character_key: characterKey
        });

        toast(`${response.data.character?.character_name || characterKey} をライブラリに保存しました`, 'success');
        return response.data;
      } catch (error) {
        console.error('[CharacterLibrary] Save to library failed:', error);
        const msg = error.response?.data?.error?.message || error.message || '保存に失敗しました';
        toast(msg, 'error');
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
