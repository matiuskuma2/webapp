// public/static/world-character-ui.js
// Responsibility: World & Characters tab switching + panel skeleton (UI-1 only)
// Phase X-2 UI-1: Tabs + Panel structure with DOM separation

(function () {
  'use strict';

  const UI = {
    currentTab: 'builder', // 'builder' | 'world' (DEPRECATED: moved to Styles tab)

    /**
     * Ensure DOM elements are created (idempotent)
     * Returns true if DOM is ready, false if panel not found
     * 
     * ⚠️ PHASE X-5: World & Characters panel moved to Styles tab
     * This function now validates that Styles tab panel exists
     */
    ensureDom() {
      // Check if World & Characters panel exists in Styles tab
      const panel = document.getElementById('world-characters-panel-styles');
      const charactersList = document.getElementById('characters-list');
      
      if (!panel || !charactersList) {
        return false;
      }

      console.log('[WorldCharacterUI] Styles tab panel found - ready for initialization');
      return true;
    },

    /**
     * Switch between Builder and World & Characters tabs (DEPRECATED)
     * @param {string} tab - 'builder' or 'world'
     * 
     * ⚠️ PHASE X-5: DEPRECATED - Tab switching disabled
     * World & Characters moved to Styles tab
     */
    switchTab(tab) {
      console.warn('[WorldCharacterUI] switchTab() is deprecated - World & Characters moved to Styles tab');
      return;
    },

    /**
     * Load characters list for current project
     * UI-2: Display character cards with edit/delete buttons
     */
    async loadCharactersList() {
      const projectId = window.PROJECT_ID;
      if (!projectId) {
        console.warn('[WorldCharacterUI] No PROJECT_ID found');
        return;
      }

      const listEl = document.getElementById('characters-list');
      if (!listEl) return;

      listEl.innerHTML = '<div class="text-gray-500 text-sm">読み込み中...</div>';

      try {
        const data = await window.WorldCharacterClient.fetchCharacters(projectId);
        const chars = data.characters || [];
        
        // Phase F-7: キャラクターリストをグローバルに保存（音声生成UIで使用）
        window.lastLoadedCharacters = chars;
        console.log('[WorldCharacterUI] Stored lastLoadedCharacters:', chars.length);

        if (chars.length === 0) {
          listEl.innerHTML = '<div class="text-gray-500 text-sm">キャラクター未登録</div>';
          return;
        }

        // Render character cards (XSS-safe with textContent)
        listEl.innerHTML = '';
        for (const c of chars) {
          console.log('[WorldCharacterUI] Character:', {
            key: c.character_key,
            name: c.character_name,
            reference_image_r2_url: c.reference_image_r2_url
          });
          
          const card = document.createElement('div');
          card.className = 'border border-gray-300 rounded-lg p-4 bg-white hover:shadow-md transition-shadow';

          // Create flex container for thumbnail and info
          const flexContainer = document.createElement('div');
          flexContainer.className = 'flex gap-3';

          // Thumbnail (if reference_image exists)
          if (c.reference_image_r2_url) {
            console.log('[WorldCharacterUI] Rendering thumbnail for:', c.character_name);
            const thumbnailContainer = document.createElement('div');
            thumbnailContainer.className = 'w-16 h-16 flex-shrink-0 overflow-hidden rounded-lg bg-gray-100 border border-gray-300';
            thumbnailContainer.style.minWidth = '64px';
            thumbnailContainer.style.minHeight = '64px';
            thumbnailContainer.style.width = '64px';
            thumbnailContainer.style.height = '64px';
            
            const thumbnail = document.createElement('img');
            thumbnail.src = c.reference_image_r2_url;
            thumbnail.alt = c.character_name;
            thumbnail.className = 'w-full h-full object-cover';
            thumbnail.style.width = '100%';
            thumbnail.style.height = '100%';
            thumbnail.style.objectFit = 'cover';
            
            // Add error handler
            thumbnail.onerror = () => {
              console.error('[WorldCharacterUI] Failed to load thumbnail:', c.reference_image_r2_url);
              thumbnailContainer.innerHTML = '<div class="w-full h-full flex items-center justify-center text-gray-400 text-2xl">?</div>';
            };
            
            thumbnail.onload = () => {
              console.log('[WorldCharacterUI] Thumbnail loaded successfully:', c.character_name);
            };
            
            thumbnailContainer.appendChild(thumbnail);
            flexContainer.appendChild(thumbnailContainer);
          } else {
            console.log('[WorldCharacterUI] No thumbnail for:', c.character_name, '(reference_image_r2_url is empty)');
          }

          // Info container
          const infoContainer = document.createElement('div');
          infoContainer.className = 'flex-1 min-w-0';

          const title = document.createElement('div');
          title.className = 'font-semibold text-gray-800 text-base';
          title.textContent = c.character_name;

          const key = document.createElement('div');
          key.className = 'text-xs text-gray-500 mt-1';
          key.textContent = `key: ${c.character_key}`;

          const aliases = document.createElement('div');
          aliases.className = 'text-xs text-gray-600 mt-1';
          let arr = [];
          try {
            arr = c.aliases_json ? JSON.parse(c.aliases_json) : [];
            if (!Array.isArray(arr)) arr = [];
          } catch (_) {
            arr = [];
          }
          aliases.textContent = arr.length ? `aliases: ${arr.join(', ')}` : 'aliases: (none)';

          const voice = document.createElement('div');
          voice.className = 'text-xs text-gray-600 mt-1';
          voice.textContent = c.voice_preset_id ? `voice: ${c.voice_preset_id}` : 'voice: (none)';

          infoContainer.appendChild(title);
          infoContainer.appendChild(key);
          infoContainer.appendChild(aliases);
          infoContainer.appendChild(voice);

          flexContainer.appendChild(infoContainer);

          const btnRow = document.createElement('div');
          btnRow.className = 'flex gap-2 mt-3';

          const editBtn = document.createElement('button');
          editBtn.className = 'px-3 py-1 rounded bg-gray-200 hover:bg-gray-300 text-sm font-semibold transition-colors';
          editBtn.textContent = '編集';
          editBtn.onclick = () => {
            if (window.WorldCharacterModal) {
              try {
                window.WorldCharacterModal.open(c);
              } catch (err) {
                console.error('[WorldCharacterUI] Modal open() failed:', err);
                if (window.showToast) {
                  window.showToast(`エラー: ${err.message}`, 'error');
                } else {
                  alert(`モーダルを開けませんでした: ${err.message}`);
                }
              }
            } else {
              console.error('[WorldCharacterUI] WorldCharacterModal not loaded');
              if (window.showToast) {
                window.showToast('モーダルが読み込まれていません', 'error');
              } else {
                alert('モーダルが読み込まれていません。ページを再読み込みしてください。');
              }
            }
          };

          const delBtn = document.createElement('button');
          delBtn.className = 'px-3 py-1 rounded bg-red-600 hover:bg-red-700 text-white text-sm font-semibold transition-colors';
          delBtn.textContent = '削除';
          delBtn.onclick = async () => {
            if (!confirm(`本当に削除しますか？\n\nキャラクター: ${c.character_name}\nKey: ${c.character_key}`)) return;
            
            try {
              await window.WorldCharacterClient.deleteCharacter(projectId, c.character_key);
              if (window.showToast) window.showToast('削除しました', 'success');
              this.loadCharactersList();
            } catch (e) {
              if (window.showToast) window.showToast(e.message || '削除失敗', 'error');
              else alert(e.message || '削除失敗');
            }
          };

          // F-5: ライブラリに保存ボタン
          const saveToLibBtn = document.createElement('button');
          saveToLibBtn.className = 'px-3 py-1 rounded bg-green-600 hover:bg-green-700 text-white text-sm font-semibold transition-colors';
          saveToLibBtn.innerHTML = '<i class="fas fa-bookmark mr-1"></i>保存';
          saveToLibBtn.title = 'ユーザーライブラリに保存（他プロジェクトで再利用可能）';
          saveToLibBtn.onclick = async () => {
            if (!confirm(`「${c.character_name}」をライブラリに保存しますか？\n\n保存すると、他のプロジェクトでも再利用できます。`)) return;
            
            try {
              const response = await fetch('/api/user/characters/from-project', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  project_id: projectId,
                  character_key: c.character_key
                })
              });
              
              if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'ライブラリへの保存に失敗');
              }
              
              if (window.showToast) window.showToast(`「${c.character_name}」をライブラリに保存しました`, 'success');
            } catch (e) {
              if (window.showToast) window.showToast(e.message || 'ライブラリ保存失敗', 'error');
              else alert(e.message || 'ライブラリ保存失敗');
            }
          };

          btnRow.appendChild(editBtn);
          btnRow.appendChild(saveToLibBtn);
          btnRow.appendChild(delBtn);

          card.appendChild(flexContainer);
          card.appendChild(btnRow);

          listEl.appendChild(card);
        }

        console.log(`[WorldCharacterUI] Loaded ${chars.length} characters`);
      } catch (e) {
        console.error('[WorldCharacterUI] Failed to load characters:', e);
        listEl.innerHTML = `<div class="text-red-600 text-sm">読み込み失敗: ${e.message}</div>`;
      }
    },

    /**
     * Initialize UI-2 specific features (called after DOM is ready)
     */
    initUI2Features() {
      // Ensure modal DOM exists
      if (window.WorldCharacterModal && typeof window.WorldCharacterModal.ensureDom === 'function') {
        window.WorldCharacterModal.ensureDom();
      }

      // Hook modal save callback
      if (window.WorldCharacterModal) {
        window.WorldCharacterModal.onSave = async (payload, st) => {
          try {
            const projectId = window.PROJECT_ID;
            if (!projectId) throw new Error('PROJECT_ID not found');

            if (st.mode === 'edit') {
              // Use unified update API with optional image
              const imageFile = window.WorldCharacterModal.getPendingImageFile?.() || null;
              await window.WorldCharacterClient.updateCharacterWithOptionalImage(
                projectId,
                st.originalKey,
                payload,
                imageFile
              );
              if (window.showToast) window.showToast('更新しました', 'success');
            } else {
              // Create mode: no image support (set image in edit mode)
              await window.WorldCharacterClient.createCharacter(projectId, payload);
              if (window.showToast) window.showToast('追加しました（画像は編集で設定）', 'success');
            }

            window.WorldCharacterModal.close();
            this.loadCharactersList();
          } catch (e) {
            console.error('[WorldCharacterUI] Save error:', e);
            const msg = e.message || '保存失敗';
            if (window.showToast) window.showToast(msg, 'error');
            else alert(msg);
          }
        };
      }

      // Bind Add Character button
      const addBtn = document.getElementById('btnAddCharacter');
      if (addBtn) {
        addBtn.onclick = () => {
          if (window.WorldCharacterModal) {
            window.WorldCharacterModal.open(null);
          } else {
            alert('Modal not loaded');
          }
        };
      }

      // F-5: Bind Import from Library button
      const importBtn = document.getElementById('btnImportFromLibrary');
      if (importBtn) {
        importBtn.onclick = () => this.openLibraryImportModal();
      }

      // Bind Auto-Assign Rerun button (UI-5)
      const rerunBtn = document.getElementById('btnAutoAssignRerun');
      if (rerunBtn) {
        rerunBtn.onclick = () => this.openAutoAssignConfirmModal();
      }

      // Phase X-3: Bind scene split settings buttons
      this.initSplitSettingsUI();

      // Load characters list on initial display
      this.loadCharactersList();
      console.log('[WorldCharacterUI] UI-2 features initialized');
    },

    /**
     * F-5: Open library import modal
     */
    async openLibraryImportModal() {
      this.ensureLibraryImportModalDom();
      const modal = document.getElementById('wc-library-import-modal');
      if (!modal) return;

      modal.classList.remove('hidden');
      modal.classList.add('flex');

      // Load available characters
      await this.loadLibraryCharacters();
    },

    /**
     * F-5: Load characters available for import from library
     */
    async loadLibraryCharacters() {
      const listEl = document.getElementById('wc-library-import-list');
      if (!listEl) return;

      listEl.innerHTML = '<div class="text-gray-500 text-sm text-center py-4">読み込み中...</div>';

      try {
        const projectId = window.PROJECT_ID;
        if (!projectId) throw new Error('PROJECT_ID not found');

        const response = await fetch(`/api/projects/${projectId}/characters/library-available`);
        if (!response.ok) throw new Error('ライブラリの取得に失敗');

        const data = await response.json();
        const chars = data.characters || [];

        if (chars.length === 0) {
          listEl.innerHTML = `
            <div class="text-gray-500 text-sm text-center py-8">
              <i class="fas fa-book text-4xl mb-3 text-gray-300"></i>
              <p>インポート可能なキャラクターがありません</p>
              <p class="text-xs mt-2">ライブラリにキャラクターを保存すると、ここに表示されます</p>
            </div>
          `;
          return;
        }

        listEl.innerHTML = '';
        for (const c of chars) {
          const card = document.createElement('div');
          card.className = 'flex items-center gap-3 p-3 border border-gray-200 rounded-lg hover:bg-gray-50 cursor-pointer transition-colors';
          card.dataset.characterId = c.id;
          card.dataset.characterKey = c.character_key;
          card.dataset.characterName = c.character_name;

          // Thumbnail
          if (c.reference_image_r2_url) {
            const thumb = document.createElement('div');
            thumb.className = 'w-12 h-12 flex-shrink-0 overflow-hidden rounded-lg bg-gray-100';
            thumb.innerHTML = `<img src="${c.reference_image_r2_url}" alt="${c.character_name}" class="w-full h-full object-cover">`;
            card.appendChild(thumb);
          } else {
            const placeholder = document.createElement('div');
            placeholder.className = 'w-12 h-12 flex-shrink-0 bg-gray-200 rounded-lg flex items-center justify-center text-gray-400';
            placeholder.innerHTML = '<i class="fas fa-user text-lg"></i>';
            card.appendChild(placeholder);
          }

          // Info
          const info = document.createElement('div');
          info.className = 'flex-1 min-w-0';
          info.innerHTML = `
            <div class="font-semibold text-gray-800 truncate">${this.escapeHtml(c.character_name)}</div>
            <div class="text-xs text-gray-500">key: ${this.escapeHtml(c.character_key)}</div>
            ${c.is_favorite ? '<span class="inline-block px-2 py-0.5 bg-yellow-100 text-yellow-700 text-xs rounded-full mt-1"><i class="fas fa-star mr-1"></i>お気に入り</span>' : ''}
          `;
          card.appendChild(info);

          // Import button
          const importBtn = document.createElement('button');
          importBtn.className = 'px-3 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm font-semibold flex-shrink-0';
          importBtn.innerHTML = '<i class="fas fa-plus mr-1"></i>追加';
          importBtn.onclick = async (e) => {
            e.stopPropagation();
            await this.importCharacterFromLibrary(c.id, c.character_name);
          };
          card.appendChild(importBtn);

          listEl.appendChild(card);
        }

        console.log(`[WorldCharacterUI] Loaded ${chars.length} library characters for import`);
      } catch (e) {
        console.error('[WorldCharacterUI] Failed to load library characters:', e);
        listEl.innerHTML = `<div class="text-red-600 text-sm text-center py-4">読み込み失敗: ${e.message}</div>`;
      }
    },

    /**
     * F-5: Import a character from library to project
     */
    async importCharacterFromLibrary(userCharacterId, characterName) {
      try {
        const projectId = window.PROJECT_ID;
        if (!projectId) throw new Error('PROJECT_ID not found');

        const response = await fetch(`/api/projects/${projectId}/characters/import`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_character_id: userCharacterId })
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error || 'インポートに失敗');
        }

        if (window.showToast) window.showToast(`「${characterName}」をインポートしました`, 'success');

        // Refresh lists
        await this.loadLibraryCharacters();
        await this.loadCharactersList();
      } catch (e) {
        console.error('[WorldCharacterUI] Import failed:', e);
        if (window.showToast) window.showToast(e.message || 'インポート失敗', 'error');
        else alert(e.message || 'インポート失敗');
      }
    },

    /**
     * F-5: Ensure library import modal DOM exists
     */
    ensureLibraryImportModalDom() {
      if (document.getElementById('wc-library-import-modal')) return;

      const modal = document.createElement('div');
      modal.id = 'wc-library-import-modal';
      modal.className = 'fixed inset-0 hidden items-center justify-center z-50';
      modal.innerHTML = `
        <div class="absolute inset-0 bg-black/40" id="wc-library-import-backdrop"></div>
        <div class="relative bg-white rounded-xl shadow-xl w-[min(600px,94vw)] max-h-[80vh] flex flex-col">
          <div class="flex items-center justify-between p-4 border-b">
            <h3 class="text-lg font-bold">
              <i class="fas fa-book mr-2 text-green-600"></i>
              マイキャラから追加
            </h3>
            <button id="wc-library-import-close" class="px-3 py-2 rounded hover:bg-gray-100 transition-colors">
              <i class="fas fa-times"></i>
            </button>
          </div>

          <div class="p-4 overflow-y-auto flex-1">
            <p class="text-sm text-gray-600 mb-4">
              ライブラリに保存したキャラクターをこのプロジェクトに追加できます。
            </p>
            <div id="wc-library-import-list" class="space-y-2">
              <!-- Characters will be loaded here -->
            </div>
          </div>

          <div class="p-4 border-t bg-gray-50 rounded-b-xl">
            <button id="wc-library-import-done" 
              class="w-full px-4 py-2 rounded-lg bg-gray-200 hover:bg-gray-300 transition-colors font-semibold">
              閉じる
            </button>
          </div>
        </div>
      `;

      document.body.appendChild(modal);

      // Bind close events
      document.getElementById('wc-library-import-close').addEventListener('click', () => this.closeLibraryImportModal());
      document.getElementById('wc-library-import-done').addEventListener('click', () => this.closeLibraryImportModal());
      document.getElementById('wc-library-import-backdrop').addEventListener('click', () => this.closeLibraryImportModal());
    },

    /**
     * F-5: Close library import modal
     */
    closeLibraryImportModal() {
      const modal = document.getElementById('wc-library-import-modal');
      if (!modal) return;
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    },

    /**
     * F-5: Escape HTML helper
     */
    escapeHtml(text) {
      const s = String(text ?? '');
      return s.replace(/[&<>"']/g, (m) => {
        switch (m) {
          case '&': return '&amp;';
          case '<': return '&lt;';
          case '>': return '&gt;';
          case '"': return '&quot;';
          case "'": return '&#039;';
          default: return m;
        }
      });
    },

    /**
     * Phase X-3: Initialize Scene Split Settings UI
     */
    initSplitSettingsUI() {
      // Load settings on init
      this.loadSplitSettings();

      // Bind preset buttons
      document.querySelectorAll('.split-preset').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const preset = parseInt(e.target.dataset.preset);
          document.getElementById('targetSceneCount').value = preset;

          // Phase X-3.1 + F-4: Auto-adjust min/max_chars based on preset
          // F-4: Added 60 and 100 scene presets for large texts (10,000+ chars)
          const presetSettings = {
            15: { min: 1000, max: 2000 },  // Fewer, longer chunks → fewer scenes
            20: { min: 800, max: 1500 },   // Balanced (default)
            30: { min: 600, max: 1200 },   // More, shorter chunks → more scenes
            45: { min: 400, max: 900 },    // Many, short chunks → many scenes
            60: { min: 300, max: 600 },    // F-4: High scene count for long texts
            100: { min: 150, max: 400 }    // F-4: Very high scene count for 10k+ chars
          };

          if (presetSettings[preset]) {
            document.getElementById('minChars').value = presetSettings[preset].min;
            document.getElementById('maxChars').value = presetSettings[preset].max;
          }

          // Update active state
          document.querySelectorAll('.split-preset').forEach(b => {
            b.classList.remove('bg-blue-500', 'text-white');
            b.classList.add('bg-gray-200');
          });
          e.target.classList.remove('bg-gray-200');
          e.target.classList.add('bg-blue-500', 'text-white');
        });
      });

      // Bind pacing buttons
      document.querySelectorAll('.pacing-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          // Update active state
          document.querySelectorAll('.pacing-btn').forEach(b => {
            b.classList.remove('bg-green-500', 'text-white');
            b.classList.add('bg-gray-200');
          });
          e.target.classList.remove('bg-gray-200');
          e.target.classList.add('bg-green-500', 'text-white');
        });
      });

      // Bind save button
      const saveBtn = document.getElementById('btnSaveSplitSettings');
      if (saveBtn) {
        saveBtn.addEventListener('click', () => this.saveSplitSettings());
      }
    },

    /**
     * Phase X-3: Load scene split settings from API
     */
    async loadSplitSettings() {
      try {
        const projectId = window.PROJECT_ID;
        if (!projectId) return;

        const response = await fetch(`/api/projects/${projectId}/scene-split-settings`);
        if (!response.ok) throw new Error('Failed to load settings');

        const data = await response.json();

        // Update UI
        document.getElementById('targetSceneCount').value = data.target_scene_count || 20;
        document.getElementById('minChars').value = data.min_chars || 800;
        document.getElementById('maxChars').value = data.max_chars || 1500;

        // Update preset button active state
        document.querySelectorAll('.split-preset').forEach(btn => {
          const preset = parseInt(btn.dataset.preset);
          if (preset === data.target_scene_count) {
            btn.classList.remove('bg-gray-200');
            btn.classList.add('bg-blue-500', 'text-white');
          } else {
            btn.classList.remove('bg-blue-500', 'text-white');
            btn.classList.add('bg-gray-200');
          }
        });

        // Update pacing button active state
        document.querySelectorAll('.pacing-btn').forEach(btn => {
          const pacing = btn.dataset.pacing;
          if (pacing === data.pacing) {
            btn.classList.remove('bg-gray-200');
            btn.classList.add('bg-green-500', 'text-white');
          } else {
            btn.classList.remove('bg-green-500', 'text-white');
            btn.classList.add('bg-gray-200');
          }
        });

        console.log('[WorldCharacterUI] Split settings loaded:', data);
      } catch (error) {
        console.error('[WorldCharacterUI] Failed to load split settings:', error);
      }
    },

    /**
     * Phase X-3: Save scene split settings to API
     */
    async saveSplitSettings() {
      try {
        const projectId = window.PROJECT_ID;
        if (!projectId) throw new Error('PROJECT_ID not found');

        // Collect values
        const targetSceneCount = parseInt(document.getElementById('targetSceneCount').value);
        const minChars = parseInt(document.getElementById('minChars').value);
        const maxChars = parseInt(document.getElementById('maxChars').value);
        
        // Get active pacing
        const activePacingBtn = document.querySelector('.pacing-btn.bg-green-500');
        const pacing = activePacingBtn ? activePacingBtn.dataset.pacing : 'normal';

        // Validate
        if (targetSceneCount < 5 || targetSceneCount > 200) {
          throw new Error('Target scene count must be between 5 and 200');
        }
        if (minChars < 200 || minChars > 3000) {
          throw new Error('Min chars must be between 200 and 3000');
        }
        if (maxChars < 500 || maxChars > 5000) {
          throw new Error('Max chars must be between 500 and 5000');
        }
        if (minChars >= maxChars) {
          throw new Error('Min chars must be less than max chars');
        }

        // Save to API
        const response = await fetch(`/api/projects/${projectId}/scene-split-settings`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            target_scene_count: targetSceneCount,
            min_chars: minChars,
            max_chars: maxChars,
            pacing,
            use_world_bible: 1
          })
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error || 'Failed to save settings');
        }

        if (window.showToast) {
          window.showToast('Scene Split Settings saved successfully', 'success');
        } else {
          alert('Settings saved');
        }

        console.log('[WorldCharacterUI] Split settings saved');
      } catch (error) {
        console.error('[WorldCharacterUI] Failed to save split settings:', error);
        if (window.showToast) {
          window.showToast(error.message || 'Failed to save settings', 'error');
        } else {
          alert(error.message || 'Failed to save settings');
        }
      }
    },

    /**
     * UI-5: Open confirmation modal for auto-assign re-run
     */
    openAutoAssignConfirmModal() {
      this.ensureAutoAssignModalDom();
      const modal = document.getElementById('wc-auto-assign-modal');
      if (!modal) return;

      modal.classList.remove('hidden');
      modal.classList.add('flex');
    },

    /**
     * UI-5: Ensure auto-assign confirmation modal DOM exists (idempotent)
     */
    ensureAutoAssignModalDom() {
      if (document.getElementById('wc-auto-assign-modal')) return;

      const modal = document.createElement('div');
      modal.id = 'wc-auto-assign-modal';
      modal.className = 'fixed inset-0 hidden items-center justify-center z-50';
      modal.innerHTML = `
        <div class="absolute inset-0 bg-black/40" id="wc-auto-assign-backdrop"></div>
        <div class="relative bg-white rounded-xl shadow-xl w-[min(480px,94vw)] p-6">
          <div class="flex items-center justify-between mb-4">
            <h3 class="text-lg font-bold">自動キャラ割当の再実行</h3>
            <button id="wc-auto-assign-close" class="px-3 py-2 rounded hover:bg-gray-100 transition-colors">
              <i class="fas fa-times"></i>
            </button>
          </div>

          <div class="space-y-4">
            <p class="text-sm text-gray-700">
              全シーンのキャラクター割当を再計算します。<br>
              既存の手動割当は上書きされます。
            </p>
            <p class="text-sm text-gray-600">
              ⚠️ この操作は取り消せません。
            </p>

            <div class="flex gap-3 justify-end pt-2">
              <button id="wc-auto-assign-cancel" 
                class="px-4 py-2 rounded-lg bg-gray-200 hover:bg-gray-300 transition-colors font-semibold">
                キャンセル
              </button>
              <button id="wc-auto-assign-execute" 
                class="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors font-semibold">
                実行
              </button>
            </div>
          </div>
        </div>
      `;

      document.body.appendChild(modal);

      // Bind close events
      document.getElementById('wc-auto-assign-close').addEventListener('click', () => this.closeAutoAssignModal());
      document.getElementById('wc-auto-assign-cancel').addEventListener('click', () => this.closeAutoAssignModal());
      document.getElementById('wc-auto-assign-backdrop').addEventListener('click', () => this.closeAutoAssignModal());
      document.getElementById('wc-auto-assign-execute').addEventListener('click', () => this.executeAutoAssign());
    },

    /**
     * UI-5: Close auto-assign confirmation modal
     */
    closeAutoAssignModal() {
      const modal = document.getElementById('wc-auto-assign-modal');
      if (!modal) return;
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    },

    /**
     * UI-5: Execute auto-assign and refresh visible scene tags
     */
    async executeAutoAssign() {
      const projectId = window.PROJECT_ID;
      if (!projectId) {
        alert('PROJECT_ID が取得できません');
        return;
      }

      this.closeAutoAssignModal();

      // Disable button during execution
      const btn = document.getElementById('btnAutoAssignRerun');
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>実行中...';
      }

      try {
        // Execute auto-assign
        const result = await window.WorldCharacterClient.autoAssignCharacters(projectId);

        // ✅ SSOT fallback (API response format may vary)
        // TODO: 要確認 - APIレスポンス形式を統一できるなら統一したい
        const assigned = result?.assigned || result?.assignedCount || 0;
        const scenes = result?.scenes || result?.totalScenes || 0;
        const skipped = result?.skipped || result?.skippedCount || 0;

        // Show success toast
        const msg = `割当完了: ${assigned}件 / ${scenes}シーン (スキップ: ${skipped}件)`;
        if (window.showToast) {
          window.showToast(msg, 'success');
        } else {
          alert(msg);
        }

        // Refresh visible scene tags (no full rerender)
        await this.refreshAllVisibleSceneTags();

        console.log('[WorldCharacterUI] Auto-assign completed:', result);
      } catch (e) {
        console.error('[WorldCharacterUI] Auto-assign failed:', e);
        const msg = `割当失敗: ${e.message}`;
        if (window.showToast) {
          window.showToast(msg, 'error');
        } else {
          alert(msg);
        }
      } finally {
        // Re-enable button
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = '<i class="fas fa-sync-alt mr-2"></i>Auto-Assign 再実行';
        }
      }
    },

    /**
     * UI-5: Refresh all visible scene tags (no full rerender)
     * - Fetch scenes with characters from API (single call)
     * - Update only visible scene cards in DOM
     * - Skip non-visible scenes (pagination/filter)
     */
    async refreshAllVisibleSceneTags() {
      const projectId = window.PROJECT_ID;
      if (!projectId) return;

      try {
        // Fetch all scenes with characters (single API call)
        const data = await window.WorldCharacterClient.fetchScenesWithCharacters(projectId);
        const scenes = data?.scenes || [];

        let updated = 0;
        let skipped = 0;

        for (const scene of scenes) {
          const card = document.getElementById(`builder-scene-${scene.id}`);
          if (!card) {
            skipped++;
            continue; // Scene not in DOM (pagination/filter)
          }

          const tagsContainer = card.querySelector('.scene-character-tags');
          if (!tagsContainer) {
            skipped++;
            continue;
          }

          // Use same tag generation logic as UI-4
          // TODO: 要確認 - generateCharacterTagsInnerHTML を world-character-modal.js から参照できない
          // 暫定: ここでローカル実装
          tagsContainer.innerHTML = this.generateTagsInnerHTML(scene.id, scene.characters || []);
          updated++;
        }

        console.log(`[WorldCharacterUI] Refreshed ${updated} scene tags, skipped ${skipped} (not in DOM)`);
      } catch (e) {
        console.warn('[WorldCharacterUI] Failed to refresh scene tags:', e);
        // Fail silently: next renderBuilderScenes will reflect changes
      }
    },

    /**
     * UI-5: Generate character tags inner HTML (local copy from world-character-modal.js)
     * TODO: 要確認 - 将来は共通ユーティリティに統一したい
     * @param {number} sceneId - Scene ID
     * @param {Array} assignments - Character assignments
     * @returns {string} Inner HTML string for character tags
     */
    generateTagsInnerHTML(sceneId, assignments) {
      const escapeHtml = (text) => {
        const s = String(text ?? '');
        return s.replace(/[&<>"']/g, (m) => {
          switch (m) {
            case '&': return '&amp;';
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '"': return '&quot;';
            case "'": return '&#039;';
            default: return m;
          }
        });
      };

      const arr = Array.isArray(assignments) ? assignments : [];
      const top = arr
        .filter((a) => a && a.character_name)
        .slice(0, 3);

      if (top.length === 0) {
        return `
          <span class="inline-flex items-center px-3 py-1 rounded-full bg-gray-100 text-gray-500 text-xs font-semibold">
            <i class="fas fa-user-slash mr-1"></i>
            キャラ未割当
          </span>
        `;
      }

      return top.map((ch) => {
        const name = escapeHtml(ch.character_name);
        const key = escapeHtml(ch.character_key || '');
        const star = ch.is_primary ? '★ ' : '';
        return `
          <button
            type="button"
            class="char-tag inline-flex items-center px-3 py-1 rounded-full bg-blue-50 text-blue-700 text-xs font-semibold hover:bg-blue-100 transition-colors border border-blue-200"
            data-action="open-character-assign"
            data-scene-id="${sceneId}"
            data-character-key="${key}"
            title="クリックで割当編集"
          >
            ${star}${name}
          </button>
        `;
      }).join('');
    },

    /**
     * Initialize UI with retry mechanism
     * Builder screen may render after initBuilderTab, so retry up to 2 seconds
     */
    init() {
      let tries = 0;
      const timer = setInterval(() => {
        tries++;
        if (this.ensureDom()) {
          clearInterval(timer);
          this.initUI2Features();
          console.log('[WorldCharacterUI] Initialization complete');
        }
        if (tries >= 20) {
          clearInterval(timer);
          console.warn('[WorldCharacterUI] Failed to find builderScenesList after 2s');
        }
      }, 100);
    }
  };

  // Expose to global scope
  window.WorldCharacterUI = UI;
  console.log('[WorldCharacterUI] Module loaded');
})();
