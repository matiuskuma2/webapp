/**
 * Fix-3: Audio List Edit Page
 * 
 * Project-level audio management overlay:
 * - View all utterances grouped by scene
 * - Edit text inline
 * - Play/stop audio
 * - Regenerate audio per utterance
 * - Bulk generate missing audio
 * - See audio status (completed/failed/pending/generating)
 */
(function() {
  'use strict';

  const API_BASE = window.API_BASE || '/api';

  const AudioListPage = {
    // State
    projectId: null,
    scenes: [],
    summary: {},
    isLoading: false,
    isOpen: false,
    currentAudio: null,
    currentPlayingId: null,
    generatingIds: new Set(),
    editingId: null,
    filterStatus: 'all', // 'all' | 'completed' | 'failed' | 'missing'

    /**
     * Open the audio list page
     */
    async open(projectId) {
      this.projectId = projectId || window.currentProjectId || window.PROJECT_ID;
      if (!this.projectId) {
        console.error('[AudioList] No project ID');
        return;
      }
      this.isOpen = true;
      this.filterStatus = 'all';
      this.renderOverlay();
      await this.loadData();
    },

    /**
     * Close the overlay
     */
    close() {
      this.isOpen = false;
      this.stopAudio();
      this.editingId = null;
      const overlay = document.getElementById('audioListOverlay');
      if (overlay) overlay.remove();
    },

    /**
     * Load all utterances from API
     */
    async loadData() {
      this.isLoading = true;
      this.renderContent();

      try {
        const response = await axios.get(`${API_BASE}/projects/${this.projectId}/utterances`);
        this.scenes = response.data.scenes || [];
        this.summary = response.data.summary || {};
        console.log(`[AudioList] Loaded ${this.summary.total_utterances} utterances across ${this.summary.total_scenes} scenes`);
      } catch (error) {
        console.error('[AudioList] Failed to load:', error);
        this.scenes = [];
        this.summary = {};
      } finally {
        this.isLoading = false;
        this.renderContent();
      }
    },

    /**
     * Render the overlay container
     */
    renderOverlay() {
      // Remove existing
      const existing = document.getElementById('audioListOverlay');
      if (existing) existing.remove();

      const overlay = document.createElement('div');
      overlay.id = 'audioListOverlay';
      overlay.className = 'fixed inset-0 z-50 bg-black bg-opacity-50 flex items-start justify-center overflow-y-auto';
      overlay.style.padding = '2rem 1rem';
      overlay.innerHTML = `
        <div class="bg-white rounded-xl shadow-2xl w-full max-w-5xl relative" style="min-height: 60vh; max-height: 90vh; display: flex; flex-direction: column;">
          <!-- Header -->
          <div class="flex items-center justify-between p-5 border-b bg-gradient-to-r from-purple-50 to-blue-50 rounded-t-xl flex-shrink-0">
            <div>
              <h2 class="text-xl font-bold text-gray-800">
                <i class="fas fa-list-music mr-2 text-purple-600"></i>
                音声一覧・編集
              </h2>
              <p class="text-sm text-gray-500 mt-1" id="audioListSubtitle">読み込み中...</p>
            </div>
            <button onclick="window.AudioListPage.close()" class="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors">
              <i class="fas fa-times text-xl"></i>
            </button>
          </div>

          <!-- Toolbar -->
          <div class="flex items-center gap-3 p-4 border-b bg-gray-50 flex-shrink-0 flex-wrap" id="audioListToolbar">
          </div>

          <!-- Content -->
          <div class="flex-1 overflow-y-auto p-4" id="audioListContent">
          </div>
        </div>
      `;

      // Close on backdrop click
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) this.close();
      });

      document.body.appendChild(overlay);
    },

    /**
     * Render toolbar with filters and actions
     */
    renderToolbar() {
      const toolbar = document.getElementById('audioListToolbar');
      if (!toolbar) return;

      const s = this.summary;
      const filters = [
        { key: 'all', label: `全て (${s.total_utterances || 0})`, icon: 'fa-list' },
        { key: 'completed', label: `完了 (${s.completed || 0})`, icon: 'fa-check-circle', color: 'text-green-600' },
        { key: 'failed', label: `失敗 (${s.failed || 0})`, icon: 'fa-times-circle', color: 'text-red-600' },
        { key: 'missing', label: `未生成 (${s.pending || 0})`, icon: 'fa-clock', color: 'text-orange-600' },
      ];

      toolbar.innerHTML = `
        <div class="flex items-center gap-2 flex-wrap">
          ${filters.map(f => `
            <button
              class="px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${
                this.filterStatus === f.key 
                  ? 'bg-purple-600 text-white' 
                  : 'bg-white text-gray-600 border border-gray-300 hover:bg-gray-100'
              }"
              onclick="window.AudioListPage.setFilter('${f.key}')"
            >
              <i class="fas ${f.icon} mr-1 ${f.color || ''}"></i>${f.label}
            </button>
          `).join('')}
        </div>
        <div class="flex items-center gap-2 ml-auto">
          <span class="text-xs text-gray-500">
            <i class="fas fa-clock mr-1"></i>合計: ${((s.total_duration_ms || 0) / 1000).toFixed(1)}秒
          </span>
          ${(s.pending || 0) + (s.failed || 0) > 0 ? `
            <button
              onclick="window.AudioListPage.bulkGenerateMissing()"
              class="px-3 py-1.5 bg-purple-600 text-white rounded-lg text-xs font-semibold hover:bg-purple-700 transition-colors"
            >
              <i class="fas fa-magic mr-1"></i>未生成を一括生成
            </button>
          ` : ''}
          <button
            onclick="window.AudioListPage.loadData()"
            class="px-3 py-1.5 bg-gray-200 text-gray-700 rounded-lg text-xs font-semibold hover:bg-gray-300 transition-colors"
          >
            <i class="fas fa-sync-alt mr-1"></i>更新
          </button>
        </div>
      `;
    },

    /**
     * Set filter and re-render
     */
    setFilter(status) {
      this.filterStatus = status;
      this.renderContent();
    },

    /**
     * Get filtered utterances
     */
    getFilteredScenes() {
      if (this.filterStatus === 'all') return this.scenes;

      return this.scenes.map(scene => {
        const filtered = scene.utterances.filter(u => {
          switch (this.filterStatus) {
            case 'completed': return u.audio_status === 'completed';
            case 'failed': return u.audio_status === 'failed';
            case 'missing': return !u.audio_status || u.audio_status === 'pending' || !u.audio_generation_id;
            default: return true;
          }
        });
        return { ...scene, utterances: filtered };
      }).filter(scene => scene.utterances.length > 0);
    },

    /**
     * Render the main content area
     */
    renderContent() {
      const content = document.getElementById('audioListContent');
      const subtitle = document.getElementById('audioListSubtitle');
      if (!content) return;

      // Update toolbar
      this.renderToolbar();

      if (this.isLoading) {
        content.innerHTML = `
          <div class="p-12 text-center">
            <i class="fas fa-spinner fa-spin text-4xl text-purple-600 mb-4"></i>
            <p class="text-gray-600">音声データを読み込み中...</p>
          </div>
        `;
        return;
      }

      const filteredScenes = this.getFilteredScenes();
      const s = this.summary;

      if (subtitle) {
        subtitle.textContent = `${s.total_scenes || 0}シーン / ${s.total_utterances || 0}発話 / 音声完了: ${s.completed || 0}/${s.total_utterances || 0}`;
      }

      if (filteredScenes.length === 0) {
        content.innerHTML = `
          <div class="p-12 text-center">
            <i class="fas fa-microphone-slash text-4xl text-gray-300 mb-4"></i>
            <p class="text-gray-500">${this.filterStatus === 'all' ? '発話がありません' : '該当する発話がありません'}</p>
          </div>
        `;
        return;
      }

      content.innerHTML = filteredScenes.map(scene => this.renderSceneGroup(scene)).join('');
    },

    /**
     * Render a scene group with its utterances
     */
    renderSceneGroup(scene) {
      const completedCount = scene.utterances.filter(u => u.audio_status === 'completed').length;
      const totalCount = scene.utterances.length;
      const allDone = completedCount === totalCount;

      return `
        <div class="mb-4 border border-gray-200 rounded-lg overflow-hidden">
          <!-- Scene Header -->
          <div class="flex items-center justify-between px-4 py-2.5 ${allDone ? 'bg-green-50' : 'bg-gray-50'} border-b">
            <div class="flex items-center gap-2">
              <span class="w-7 h-7 flex items-center justify-center ${allDone ? 'bg-green-200 text-green-800' : 'bg-gray-200 text-gray-700'} rounded-full font-bold text-xs">
                ${scene.scene_idx}
              </span>
              <span class="text-sm font-semibold text-gray-700">シーン ${scene.scene_idx}</span>
              <span class="text-xs ${allDone ? 'text-green-600' : 'text-orange-600'}">
                (${completedCount}/${totalCount})
              </span>
            </div>
            <button
              onclick="window.AudioListPage.openSceneEdit(${scene.scene_id})"
              class="text-xs text-blue-600 hover:text-blue-800 hover:underline"
            >
              <i class="fas fa-external-link-alt mr-1"></i>シーン編集
            </button>
          </div>

          <!-- Utterances -->
          <div class="divide-y divide-gray-100">
            ${scene.utterances.map(u => this.renderUtteranceRow(u)).join('')}
          </div>
        </div>
      `;
    },

    /**
     * Render a single utterance row
     */
    renderUtteranceRow(u) {
      const isNarration = u.role === 'narration';
      const isGenerating = this.generatingIds.has(u.id);
      const isEditing = this.editingId === u.id;
      const isPlaying = this.currentPlayingId === u.id;

      const statusIcon = u.audio_status === 'completed' ? 'fa-check-circle text-green-500'
        : u.audio_status === 'failed' ? 'fa-times-circle text-red-500'
        : u.audio_status === 'generating' ? 'fa-spinner fa-spin text-blue-500'
        : 'fa-circle text-gray-300';

      const roleBadge = isNarration
        ? '<span class="px-1.5 py-0.5 bg-purple-100 text-purple-700 rounded text-[10px] font-bold">ナレ</span>'
        : `<span class="px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded text-[10px] font-bold">${this.escapeHtml(u.character_name || u.character_key || 'セリフ')}</span>`;

      if (isEditing) {
        return this.renderEditRow(u);
      }

      return `
        <div class="flex items-start gap-3 px-4 py-3 hover:bg-gray-50 transition-colors group" data-utterance-id="${u.id}">
          <!-- Status -->
          <div class="flex-shrink-0 pt-1">
            <i class="fas ${statusIcon}"></i>
          </div>

          <!-- Role + Text -->
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2 mb-1">
              ${roleBadge}
              ${u.duration_ms ? `<span class="text-[10px] text-gray-400">${(u.duration_ms / 1000).toFixed(1)}s</span>` : ''}
              ${u.audio_status === 'failed' && u.audio_error ? `
                <span class="text-[10px] text-red-500 truncate max-w-[200px]" title="${this.escapeHtml(u.audio_error)}">
                  <i class="fas fa-exclamation-triangle mr-0.5"></i>${this.escapeHtml(u.audio_error.substring(0, 50))}
                </span>
              ` : ''}
            </div>
            <p class="text-sm text-gray-700 line-clamp-2">${this.escapeHtml(u.text || '(テキストなし)')}</p>
          </div>

          <!-- Actions -->
          <div class="flex items-center gap-1.5 flex-shrink-0 opacity-60 group-hover:opacity-100 transition-opacity">
            ${u.audio_status === 'completed' && u.audio_url ? `
              <button
                onclick="window.AudioListPage.toggleAudio(${u.id}, '${this.escapeHtml(u.audio_url)}')"
                class="p-1.5 rounded ${isPlaying ? 'bg-red-100 text-red-600' : 'bg-blue-100 text-blue-600'} hover:opacity-80 transition-colors"
                title="${isPlaying ? '停止' : '再生'}"
              >
                <i class="fas ${isPlaying ? 'fa-stop' : 'fa-play'} text-xs"></i>
              </button>
            ` : ''}
            <button
              onclick="window.AudioListPage.startEdit(${u.id})"
              class="p-1.5 rounded bg-gray-100 text-gray-600 hover:bg-gray-200 transition-colors"
              title="テキスト編集"
            >
              <i class="fas fa-edit text-xs"></i>
            </button>
            <button
              onclick="window.AudioListPage.regenerateAudio(${u.id})"
              class="p-1.5 rounded ${isGenerating ? 'bg-gray-200 text-gray-400 cursor-wait' : 'bg-purple-100 text-purple-600 hover:bg-purple-200'} transition-colors"
              title="${u.audio_status === 'completed' ? '再生成' : '音声生成'}"
              ${isGenerating ? 'disabled' : ''}
            >
              <i class="fas ${isGenerating ? 'fa-spinner fa-spin' : 'fa-microphone'} text-xs"></i>
            </button>
          </div>
        </div>
      `;
    },

    /**
     * Render inline edit row
     */
    renderEditRow(u) {
      return `
        <div class="px-4 py-3 bg-blue-50 border-l-4 border-blue-400" data-utterance-id="${u.id}">
          <div class="flex items-center gap-2 mb-2">
            <span class="text-xs font-bold text-blue-700"><i class="fas fa-edit mr-1"></i>テキスト編集</span>
            <span class="text-[10px] text-gray-500">シーン${u.scene_idx} #${u.order_no}</span>
          </div>
          <textarea
            id="audioListEditText-${u.id}"
            rows="2"
            class="w-full px-3 py-2 border border-blue-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none"
          >${this.escapeHtml(u.text || '')}</textarea>
          <div class="flex gap-2 mt-2">
            <button
              onclick="window.AudioListPage.saveEdit(${u.id})"
              class="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-semibold hover:bg-blue-700"
            >
              <i class="fas fa-save mr-1"></i>保存
            </button>
            <button
              onclick="window.AudioListPage.saveEditAndRegenerate(${u.id})"
              class="px-3 py-1.5 bg-purple-600 text-white rounded-lg text-xs font-semibold hover:bg-purple-700"
            >
              <i class="fas fa-microphone mr-1"></i>保存して再生成
            </button>
            <button
              onclick="window.AudioListPage.cancelEdit()"
              class="px-3 py-1.5 bg-gray-300 text-gray-700 rounded-lg text-xs font-semibold hover:bg-gray-400"
            >
              キャンセル
            </button>
          </div>
        </div>
      `;
    },

    /**
     * Start editing an utterance
     */
    startEdit(utteranceId) {
      this.editingId = utteranceId;
      this.renderContent();
      setTimeout(() => {
        const el = document.getElementById(`audioListEditText-${utteranceId}`);
        if (el) el.focus();
      }, 50);
    },

    /**
     * Cancel editing
     */
    cancelEdit() {
      this.editingId = null;
      this.renderContent();
    },

    /**
     * Save edited text
     */
    async saveEdit(utteranceId) {
      const textarea = document.getElementById(`audioListEditText-${utteranceId}`);
      if (!textarea) return;

      const newText = textarea.value.trim();
      if (!newText) {
        alert('テキストを入力してください');
        return;
      }

      try {
        await axios.put(`${API_BASE}/utterances/${utteranceId}`, { text: newText });
        this.editingId = null;
        // Update local state
        for (const scene of this.scenes) {
          const utt = scene.utterances.find(u => u.id === utteranceId);
          if (utt) {
            utt.text = newText;
            break;
          }
        }
        this.renderContent();
        this.showToast('テキストを更新しました', 'success');
      } catch (error) {
        console.error('[AudioList] Save failed:', error);
        alert('保存に失敗しました: ' + (error.response?.data?.error?.message || error.message));
      }
    },

    /**
     * Save text and regenerate audio
     */
    async saveEditAndRegenerate(utteranceId) {
      await this.saveEdit(utteranceId);
      await this.regenerateAudio(utteranceId);
    },

    /**
     * Regenerate audio for an utterance
     */
    async regenerateAudio(utteranceId) {
      if (this.generatingIds.has(utteranceId)) return;

      this.generatingIds.add(utteranceId);
      this.renderContent();

      try {
        const response = await axios.post(`${API_BASE}/utterances/${utteranceId}/generate-audio`, {
          force: true
        });
        console.log(`[AudioList] Audio generation started for utterance ${utteranceId}:`, response.data);

        // Poll for completion
        this.pollAudioStatus(utteranceId, response.data.audio_generation_id);

      } catch (error) {
        console.error('[AudioList] Regenerate failed:', error);
        this.generatingIds.delete(utteranceId);
        this.renderContent();
        
        const msg = error.response?.data?.error?.message || error.message;
        this.showToast(`音声生成失敗: ${msg}`, 'error');
      }
    },

    /**
     * Poll audio generation status
     */
    async pollAudioStatus(utteranceId, audioGenId) {
      const maxPolls = 30; // 30 * 3s = 90s max
      let polls = 0;

      const poll = async () => {
        polls++;
        if (polls > maxPolls) {
          this.generatingIds.delete(utteranceId);
          this.showToast(`音声生成がタイムアウトしました (utterance ${utteranceId})`, 'warning');
          await this.loadData();
          return;
        }

        try {
          // Reload data to get fresh status
          const response = await axios.get(`${API_BASE}/projects/${this.projectId}/utterances`);
          this.scenes = response.data.scenes || [];
          this.summary = response.data.summary || {};

          // Find the utterance
          let found = null;
          for (const scene of this.scenes) {
            found = scene.utterances.find(u => u.id === utteranceId);
            if (found) break;
          }

          if (found && found.audio_status === 'completed') {
            this.generatingIds.delete(utteranceId);
            this.renderContent();
            this.showToast('音声生成が完了しました', 'success');
            return;
          }

          if (found && found.audio_status === 'failed') {
            this.generatingIds.delete(utteranceId);
            this.renderContent();
            this.showToast(`音声生成失敗: ${found.audio_error || 'unknown error'}`, 'error');
            return;
          }

          // Still generating, poll again
          this.renderContent();
          setTimeout(poll, 3000);

        } catch (error) {
          console.error('[AudioList] Poll failed:', error);
          setTimeout(poll, 5000);
        }
      };

      setTimeout(poll, 2000);
    },

    /**
     * Bulk generate missing audio
     */
    async bulkGenerateMissing() {
      const missing = (this.summary.pending || 0) + (this.summary.failed || 0);
      if (missing === 0) {
        this.showToast('すべての音声が生成済みです', 'success');
        return;
      }

      if (!confirm(`${missing}件の未生成/失敗音声を一括生成します。\n\n続行しますか？`)) {
        return;
      }

      try {
        const response = await axios.post(`${API_BASE}/projects/${this.projectId}/audio/bulk-generate`, {
          mode: 'missing',
          force_regenerate: false
        });

        if (response.data.success) {
          this.showToast(`一括音声生成を開始しました (${response.data.total_utterances || missing}件)`, 'success');
          // Start polling for completion
          this.pollBulkStatus();
        }
      } catch (error) {
        if (error.response?.status === 409) {
          this.showToast('既に一括生成が実行中です', 'warning');
          this.pollBulkStatus();
        } else {
          this.showToast('一括生成の開始に失敗しました', 'error');
        }
      }
    },

    /**
     * Poll bulk generation status
     */
    pollBulkStatus() {
      const poll = async () => {
        try {
          const response = await axios.get(`${API_BASE}/projects/${this.projectId}/audio/bulk-status`);
          const data = response.data;

          // Reload data
          await this.loadData();

          if (data.status === 'completed' || data.status === 'failed') {
            this.showToast(
              data.status === 'completed' ? '一括音声生成が完了しました' : '一括音声生成が失敗しました',
              data.status === 'completed' ? 'success' : 'error'
            );
            return;
          }

          // Still processing
          setTimeout(poll, 5000);
        } catch {
          setTimeout(poll, 10000);
        }
      };

      setTimeout(poll, 3000);
    },

    /**
     * Toggle audio playback
     */
    toggleAudio(utteranceId, url) {
      if (this.currentPlayingId === utteranceId && this.currentAudio) {
        this.stopAudio();
        this.renderContent();
        return;
      }

      this.stopAudio();

      const fullUrl = url.startsWith('http') ? url : url;
      this.currentAudio = new Audio(fullUrl);
      this.currentPlayingId = utteranceId;
      this.renderContent();

      this.currentAudio.play().catch(err => {
        console.error('[AudioList] Play failed:', err);
        this.stopAudio();
        this.renderContent();
      });

      this.currentAudio.addEventListener('ended', () => {
        this.stopAudio();
        this.renderContent();
      });
    },

    /**
     * Stop audio
     */
    stopAudio() {
      if (this.currentAudio) {
        this.currentAudio.pause();
        this.currentAudio.currentTime = 0;
        this.currentAudio = null;
      }
      this.currentPlayingId = null;
    },

    /**
     * Open scene edit modal
     */
    openSceneEdit(sceneId) {
      this.close();
      if (window.SceneEditModal && typeof window.SceneEditModal.open === 'function') {
        window.SceneEditModal.open(sceneId, { source: 'audio_list' });
        setTimeout(() => {
          if (window.SceneEditModal.switchTab) {
            window.SceneEditModal.switchTab('utterances');
          }
        }, 300);
      } else if (typeof window.openSceneEditModal === 'function') {
        window.openSceneEditModal(sceneId, 'audio');
      }
    },

    /**
     * Show toast notification
     */
    showToast(message, type = 'success') {
      if (typeof window.showToast === 'function') {
        window.showToast(message, type);
      } else {
        console.log(`[AudioList] ${type}: ${message}`);
      }
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

  // Export
  window.AudioListPage = AudioListPage;
})();
