// API Base URL
const API_BASE = '/api';

// Debug flags (set window.DEBUG_VIDEO_BUILD = true in console to enable verbose logging)
window.DEBUG_VIDEO_BUILD = window.DEBUG_VIDEO_BUILD || false;

// Global state (SSOT: currentProjectはwindow.currentProjectに一本化)
// これにより reset-to-input 等で片方だけ更新される事故を防止
window.currentProject = window.currentProject || null;
// currentProject参照はwindow.currentProjectを使用するgetterを定義
Object.defineProperty(window, 'currentProjectRef', {
  get: function() { return window.currentProject; },
  set: function(value) { window.currentProject = value; }
});
// 後方互換のため、letでもcurrentProjectを使えるようにする（代入時は両方更新）
let currentProject = null;
// currentProjectへの代入を検知してwindow.currentProjectも更新するラッパー
const updateCurrentProject = (project) => {
  currentProject = project;
  window.currentProject = project;
};
let isProcessing = false; // ボタン連打防止用フラグ（グローバル処理用）
window.isBulkImageGenerating = false; // Global flag for bulk image generation (window scope for template access)
window.sceneProcessing = {}; // Global flag for individual scene processing (window scope)
window.generatingSceneWatch = window.generatingSceneWatch || {}; // { [sceneId]: { startedAt:number, attempts:number, timerId:number } }
let mediaRecorder = null;
let audioChunks = [];
let recordingStartTime = 0;
let recordingTimer = null;

// Pagination state (Phase X-0: DOM Performance Optimization)
window.builderPagination = {
  currentPage: 1,
  pageSize: 20,
  totalScenes: 0
};

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
  // ⚠️ FIX: loadProjectを待ってからタブ復元する
  await loadProject();
  
  // Text character counter and paragraph counter
  const sourceText = document.getElementById('sourceText');
  if (sourceText) {
    sourceText.addEventListener('input', () => {
      const charCount = sourceText.value.length;
      document.getElementById('textCharCount').textContent = charCount;
      // Update paragraph count for format section
      updateParagraphCount(sourceText.value);
    });
  }
  
  // Split mode radio change handler
  document.addEventListener('change', (e) => {
    if (e.target.name === 'splitMode') {
      updateSplitModeHint(e.target.value);
    }
  });
  
  // Restore last active tab from localStorage (after project is loaded)
  const lastTab = localStorage.getItem('lastActiveTab');
  if (lastTab && ['input', 'sceneSplit', 'builder', 'export', 'videoBuild', 'styles'].includes(lastTab)) {
    switchTab(lastTab);
  }
  
  // ⚠️ PHASE X-5: Disabled tab click handler (event delegation)
  // Show toast when user clicks a disabled tab button
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('button[onclick^="switchTab("]');
    if (!btn || !btn.disabled) return;
    
    e.preventDefault();
    e.stopPropagation();
    
    // Determine which tab and show appropriate message
    const tabId = btn.id;
    let message = '';
    
    if (tabId === 'tabSceneSplit') {
      message = 'Scene Split は Parse 完了後に利用できます';
    } else if (tabId === 'tabBuilder') {
      message = 'Builder は Format 完了後に利用できます';
    } else if (tabId === 'tabExport') {
      message = 'Export は全ての画像生成完了後に利用できます';
    }
    
    if (message) {
      showToast(message, 'warning');
    }
  });
});

// Load project details
async function loadProject() {
  try {
    const response = await axios.get(`${API_BASE}/projects/${PROJECT_ID}`);
    updateCurrentProject(response.data);
    
    // Update UI
    document.getElementById('projectTitle').textContent = currentProject.title;
    updateStatusBadge(currentProject.status);
    
    // Show next step guide if uploaded
    if (currentProject.status === 'uploaded' || currentProject.status === 'transcribed') {
      document.getElementById('nextStepGuide').classList.remove('hidden');
    }
    
    // Pre-fill source_text if exists
    if (currentProject.source_type === 'text' && currentProject.source_text) {
      document.getElementById('sourceText').value = currentProject.source_text;
      document.getElementById('textCharCount').textContent = currentProject.source_text.length;
      // Update paragraph count for format section
      updateParagraphCount(currentProject.source_text);
    }
    
    // SSOT: split_mode を読み込んでUIに反映
    initializeSplitModeUI();
    
    // Enable/disable tabs based on status
    updateTabsAvailability();
    
    // Also update tab states for Export button
    updateTabStates(currentProject.status);
    
    // 改善: preflightを取得して正確な進捗表示
    // formatted以降のステータスではシーン準備状況も考慮
    if (['formatted', 'generating_images', 'completed'].includes(currentProject.status)) {
      try {
        const preflightResponse = await axios.get(`${API_BASE}/projects/${PROJECT_ID}/video-builds/preflight`);
        window.videoBuildPreflightCache = preflightResponse.data;
        console.log('[LoadProject] Preflight loaded:', preflightResponse.data);
      } catch (preflightError) {
        console.warn('[LoadProject] Preflight fetch failed:', preflightError.message);
      }
    }
    
    // Update progress bar (now uses preflight cache if available)
    updateProgressBar(currentProject.status);
    
    // R3-A: Load BGM status
    loadBgmStatus();
    
    // Load output_preset selection
    loadOutputPreset();
    
    // Phase 2-1: Load comic telop settings
    loadComicTelopSettings();
    
    // PR-Remotion-Telop-DefaultSave: Load Remotion telop settings
    loadRemotionTelopSettings();
    
    // P0-1: Load narration voice settings
    loadNarrationVoiceSettings();
    
    // Safe Chat v1: Refresh Builder Wizard
    refreshBuilderWizard();
  } catch (error) {
    console.error('Load project error:', error);
    showToast('プロジェクトの読み込みに失敗しました', 'error');
  }
}

// Update tabs availability based on project status
function updateTabsAvailability() {
  const sceneSplitTab = document.getElementById('tabSceneSplit');
  const builderTab = document.getElementById('tabBuilder');
  const exportTab = document.getElementById('tabExport');
  
  // Scene Split tab: enabled if:
  // - (source_type='text' AND source_text exists) OR
  // - (source_type='audio' AND status='uploaded'/'transcribed' or later)
  const hasTextSource = currentProject.source_type === 'text' && currentProject.source_text;
  const hasAudioSource = currentProject.source_type === 'audio' && 
    (currentProject.status === 'uploaded' || currentProject.status === 'transcribed' || 
     currentProject.status === 'formatted' || currentProject.status === 'generating_images' || 
     currentProject.status === 'completed');
  
  if (hasTextSource || hasAudioSource) {
    sceneSplitTab.disabled = false;
    sceneSplitTab.classList.remove('opacity-50', 'cursor-not-allowed', 'pointer-events-none');
  } else {
    // ⚠️ PHASE X-5: Strengthen disabled visual feedback
    sceneSplitTab.classList.add('opacity-50', 'cursor-not-allowed', 'pointer-events-none');
  }
  
  // Builder tab: enabled if formatted or later
  if (currentProject.status === 'formatted' || currentProject.status === 'generating_images' || 
      currentProject.status === 'completed') {
    builderTab.disabled = false;
    builderTab.classList.remove('opacity-50', 'cursor-not-allowed', 'pointer-events-none');
  } else {
    // ⚠️ PHASE X-5: Strengthen disabled visual feedback
    builderTab.classList.add('opacity-50', 'cursor-not-allowed', 'pointer-events-none');
  }
  
  // Export tab: enabled if completed
  if (currentProject.status === 'completed') {
    exportTab.disabled = false;
    exportTab.classList.remove('opacity-50', 'cursor-not-allowed', 'pointer-events-none');
  } else {
    // ⚠️ PHASE X-5: Strengthen disabled visual feedback
    exportTab.classList.add('opacity-50', 'cursor-not-allowed', 'pointer-events-none');
  }
  
  // Video Build tab: enabled if completed (all scenes have images)
  const videoBuildTab = document.getElementById('tabVideoBuild');
  if (videoBuildTab) {
    if (currentProject.status === 'completed') {
      videoBuildTab.disabled = false;
      videoBuildTab.classList.remove('opacity-50', 'cursor-not-allowed', 'pointer-events-none');
    } else {
      videoBuildTab.classList.add('opacity-50', 'cursor-not-allowed', 'pointer-events-none');
    }
  }
}

// Update status badge
function updateStatusBadge(status) {
  const badge = document.getElementById('projectStatus');
  const statusText = document.getElementById('statusText');
  
  const statusConfig = {
    'created': { text: '作成済み', color: 'bg-gray-100 text-gray-800' },
    'uploaded': { text: '入力済み', color: 'bg-blue-100 text-blue-800' },
    'transcribing': { text: '文字起こし中', color: 'bg-yellow-100 text-yellow-800' },
    'transcribed': { text: '文字起こし完了', color: 'bg-blue-100 text-blue-800' },
    'formatting': { text: 'フォーマット中', color: 'bg-yellow-100 text-yellow-800' },
    'formatted': { text: 'フォーマット完了', color: 'bg-blue-100 text-blue-800' },
    'generating_images': { text: '画像生成中', color: 'bg-yellow-100 text-yellow-800' },
    'completed': { text: '完了', color: 'bg-green-100 text-green-800' },
    'failed': { text: 'エラー', color: 'bg-red-100 text-red-800' }
  };
  
  const config = statusConfig[status] || statusConfig['created'];
  badge.className = `inline-block mt-2 px-3 py-1 rounded-full text-sm font-semibold ${config.color}`;
  statusText.textContent = config.text;
  
  // Also update progress bar
  updateProgressBar(status);
}

// Show toast notification
function showToast(message, type = 'success') {
  const toast = document.getElementById('toast');
  const icon = document.getElementById('toastIcon');
  const messageEl = document.getElementById('toastMessage');
  
  // Set icon and color
  const iconConfig = {
    'success': 'fas fa-check-circle text-green-500',
    'error': 'fas fa-exclamation-circle text-red-500',
    'info': 'fas fa-info-circle text-blue-500',
    'warning': 'fas fa-exclamation-triangle text-yellow-500'
  };
  
  icon.className = `${iconConfig[type] || iconConfig['success']} text-2xl mr-3`;
  messageEl.textContent = message;
  toast.classList.remove('hidden');
  
  setTimeout(() => {
    toast.classList.add('hidden');
  }, 3000);
}

// Disable/Enable button with loading state
function setButtonLoading(buttonId, isLoading) {
  const button = document.getElementById(buttonId);
  if (!button) return;
  
  if (isLoading) {
    button.disabled = true;
    button.classList.add('opacity-50', 'cursor-not-allowed');
    const originalText = button.innerHTML;
    button.dataset.originalText = originalText;
    button.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>処理中...';
  } else {
    button.disabled = false;
    button.classList.remove('opacity-50', 'cursor-not-allowed');
    if (button.dataset.originalText) {
      button.innerHTML = button.dataset.originalText;
    }
  }
}

// ========== Tab Switching ==========
function switchTab(tabName) {
  // ⚠️ PHASE X-6: Enforce tab access based on project status
  // This is the SINGLE SOURCE OF TRUTH for tab access control
  if (currentProject) {
    const status = currentProject.status;
    const statusOrder = ['created', 'uploaded', 'transcribing', 'transcribed', 
                         'parsing', 'parsed', 'formatting', 'formatted', 
                         'generating_images', 'completed'];
    const currentIndex = statusOrder.indexOf(status);
    
    // Define minimum status index for each tab
    const tabRequirements = {
      'sceneSplit': statusOrder.indexOf('uploaded'),  // Need at least 'uploaded'
      'builder': statusOrder.indexOf('formatted'),     // Need at least 'formatted'
      'export': statusOrder.indexOf('completed'),      // Need 'completed'
      'videoBuild': statusOrder.indexOf('completed'),  // Need 'completed'
      'styles': -1,  // Always accessible
      'input': -1    // Always accessible
    };
    
    const requiredIndex = tabRequirements[tabName];
    if (requiredIndex !== undefined && requiredIndex >= 0 && currentIndex < requiredIndex) {
      // Tab not allowed - show appropriate message
      let message = '';
      if (tabName === 'builder') {
        message = 'Builder タブはFormat（シーン分割）完了後に利用できます。Scene Splitタブでフォーマットを実行してください。';
      } else if (tabName === 'sceneSplit') {
        message = 'Scene Split タブはテキスト入力または音声アップロード後に利用できます。';
      } else if (tabName === 'export' || tabName === 'videoBuild') {
        message = 'このタブは全ての画像生成完了後に利用できます。';
      }
      
      if (message) {
        showToast(message, 'warning');
      }
      return; // Don't switch tab
    }
  }
  
  // Stop all audio when switching tabs
  if (typeof stopAllAudioPreviews === 'function') {
    stopAllAudioPreviews();
  }
  
  // Remove active class from all tabs
  const tabs = ['Input', 'SceneSplit', 'Builder', 'Export', 'VideoBuild', 'Styles'];
  tabs.forEach(tab => {
    const tabEl = document.getElementById(`tab${tab}`);
    const contentEl = document.getElementById(`content${tab}`);
    if (tabEl) {
      tabEl.classList.remove('tab-active');
      tabEl.classList.add('tab-inactive');
    }
    if (contentEl) {
      contentEl.classList.add('hidden');
    }
  });
  
  // Add active class to selected tab
  const targetTab = tabName.charAt(0).toUpperCase() + tabName.slice(1);
  const targetTabEl = document.getElementById(`tab${targetTab}`);
  const targetContentEl = document.getElementById(`content${targetTab}`);
  
  if (targetTabEl) {
    targetTabEl.classList.add('tab-active');
    targetTabEl.classList.remove('tab-inactive');
  }
  if (targetContentEl) {
    targetContentEl.classList.remove('hidden');
  }
  
  // Initialize tab content based on tab type (遅延実行 + キャッシュ確認)
  if (tabName === 'sceneSplit') {
    // キャッシュがあればスキップ（高速表示）
    if (!window.sceneSplitInitialized) {
      initSceneSplitTab();
      window.sceneSplitInitialized = true;
    }
  } else if (tabName === 'builder') {
    // Builderは常に最新データが必要なので毎回初期化
    initBuilderTab();
  } else if (tabName === 'export') {
    initExportTab();
  } else if (tabName === 'styles') {
    initStylesTab();
  } else if (tabName === 'videoBuild') {
    initVideoBuildTab();
  }
  
  // ✅ Save last active tab to localStorage (for auto-restore on reload)
  localStorage.setItem('lastActiveTab', tabName);
}

// ✅ Export switchTab to global scope for onclick handlers
window.switchTab = switchTab;

// Initialize Scene Split tab
async function initSceneSplitTab() {
  // ⚠️ FIX: currentProjectがまだロードされていない場合は何もしない
  if (!currentProject) {
    console.warn('[SceneSplit] currentProject is null, skipping init');
    return;
  }
  
  // Check if project has valid source
  const hasTextSource = currentProject.source_type === 'text' && currentProject.source_text;
  const hasAudioSource = currentProject.source_type === 'audio' && 
    (currentProject.status === 'uploaded' || currentProject.status === 'transcribed' || 
     currentProject.status === 'formatted' || currentProject.status === 'generating_images' || 
     currentProject.status === 'completed');
  
  if (!hasTextSource && !hasAudioSource) {
    // Show guide to go back to Input tab
    document.getElementById('formatSection').classList.add('hidden');
    document.getElementById('scenesSection').classList.add('hidden');
    document.getElementById('scenesEmptyState').classList.add('hidden');
    document.getElementById('sceneSplitGuide').classList.remove('hidden');
    document.getElementById('characterWarningSection')?.classList.add('hidden');
    return;
  }
  
  document.getElementById('sceneSplitGuide').classList.add('hidden');
  
  // ===== AUTO-RESUME: If status is 'formatting', resume polling =====
  if (currentProject.status === 'formatting') {
    console.log('Detected formatting status, auto-resuming polling...');
    document.getElementById('formatSection').classList.add('hidden');
    document.getElementById('scenesSection').classList.add('hidden');
    document.getElementById('characterWarningSection')?.classList.add('hidden');
    showFormatProgressUI();
    startFormatPolling();
    return;
  }
  
  // ローディング表示（初回のみ）
  const scenesList = document.getElementById('scenesList');
  if (!window.sceneSplitLoaded) {
    scenesList.innerHTML = `
      <div class="flex items-center justify-center py-8">
        <div class="text-center">
          <i class="fas fa-spinner fa-spin text-3xl text-purple-600 mb-3"></i>
          <p class="text-gray-600 text-sm">シーンを確認中...</p>
        </div>
      </div>
    `;
  }
  
  // Check if scenes already exist（キャラクター情報含む）
  const scenesResponse = await axios.get(`${API_BASE}/projects/${PROJECT_ID}/scenes?view=board`);
  const scenes = scenesResponse.data.scenes || [];
  window.sceneSplitLoaded = true;
  
  // Phase F-5: Check character registration and show warning
  await updateCharacterWarning();
  
  if (scenes.length === 0) {
    // Show format button
    document.getElementById('formatSection').classList.remove('hidden');
    document.getElementById('scenesSection').classList.add('hidden');
    document.getElementById('scenesEmptyState').classList.add('hidden');
    // Note: resetToInputSection removed - using only resetToInputBtnSmall in scenes header
  } else {
    // Show scenes with character info
    document.getElementById('formatSection').classList.add('hidden');
    document.getElementById('scenesSection').classList.remove('hidden');
    document.getElementById('scenesEmptyState').classList.add('hidden');
    
    // Only show Builder button when format is completed (formatted status or later)
    const builderAllowedStatuses = ['formatted', 'generating_images', 'completed'];
    const goToBuilderBtn = document.getElementById('goToBuilderBtn');
    if (goToBuilderBtn) {
      if (builderAllowedStatuses.includes(currentProject?.status)) {
        goToBuilderBtn.classList.remove('hidden');
      } else {
        goToBuilderBtn.classList.add('hidden');
      }
    }
    // Hide character warning if scenes already exist
    document.getElementById('characterWarningSection')?.classList.add('hidden');
    renderScenes(scenes);
    document.getElementById('scenesCount').textContent = scenes.length;
    
    // PR-Comic-Rebake-DiffBadge: シーン描画後に非同期でバッジを読み込み
    setTimeout(() => refreshAllRebakeBadges(), 100);
    
    // Phase X-5: Show character traits summary section
    document.getElementById('characterTraitsSummarySection')?.classList.remove('hidden');
    
    // Phase F-3: Show reset to input option
    updateResetToInputVisibility(currentProject.status);
  }
}

/**
 * Phase F-5: Update character registration warning
 * Shows warning if no characters are registered before scene split
 */
async function updateCharacterWarning() {
  const warningSection = document.getElementById('characterWarningSection');
  const countBadge = document.getElementById('registeredCharacterCount');
  
  if (!warningSection) return;
  
  try {
    // Fetch registered characters count (with cache busting)
    const response = await axios.get(`${API_BASE}/projects/${PROJECT_ID}/characters`, {
      params: { _t: Date.now() }
    });
    const characters = response.data.characters || [];
    const count = characters.length;
    console.log('[SceneSplit] Fetched characters:', count, characters.map(c => c.character_name));
    
    // Update count display
    if (countBadge) {
      countBadge.textContent = count;
    }
    
    // Show warning if no characters registered
    if (count === 0) {
      warningSection.classList.remove('hidden');
    } else {
      // Still show but with less emphasis if some characters exist
      warningSection.classList.remove('hidden');
      warningSection.querySelector('h3').innerHTML = `
        <i class="fas fa-check-circle mr-2 text-green-600"></i>キャラクター登録済み
      `;
      warningSection.classList.remove('border-amber-400', 'bg-amber-50');
      warningSection.classList.add('border-green-400', 'bg-green-50');
      warningSection.querySelector('p').textContent = `${count}人のキャラクターが登録されています。シーン分割後に自動割り当てされます。`;
    }
  } catch (error) {
    console.warn('Failed to fetch characters for warning:', error);
    warningSection.classList.add('hidden');
  }
}

/**
 * Phase X-5: Load and display character traits summary
 * Shows base traits and scene-specific overrides
 */
async function loadCharacterTraitsSummary() {
  const section = document.getElementById('characterTraitsSummarySection');
  const listContainer = document.getElementById('characterTraitsList');
  
  if (!section || !listContainer) return;
  
  try {
    const response = await axios.get(`${API_BASE}/projects/${PROJECT_ID}/character-traits-summary`);
    const characters = response.data.characters || [];
    
    if (characters.length === 0) {
      section.classList.add('hidden');
      return;
    }
    
    // Show section
    section.classList.remove('hidden');
    
    // Render character traits
    listContainer.innerHTML = characters.map(char => {
      const hasOverrides = char.scene_overrides && char.scene_overrides.length > 0;
      
      return `
        <div class="bg-white rounded-lg p-3 border border-gray-200">
          <div class="flex items-center gap-3 mb-2">
            ${char.reference_image ? `
              <img src="${char.reference_image}" alt="${escapeHtml(char.character_name)}" 
                   class="w-10 h-10 rounded-full object-cover border-2 border-indigo-200">
            ` : `
              <div class="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center">
                <i class="fas fa-user text-gray-400"></i>
              </div>
            `}
            <div class="flex-1">
              <span class="font-semibold text-gray-800">${escapeHtml(char.character_name)}</span>
              ${hasOverrides ? `
                <span class="ml-2 text-xs px-2 py-0.5 bg-yellow-100 text-yellow-700 rounded-full">
                  <i class="fas fa-layer-group mr-1"></i>${char.scene_overrides.length}件のシーン別設定
                </span>
              ` : ''}
            </div>
            <button 
              onclick="openCharacterTraitEdit('${char.character_key}', '${escapeHtml(char.character_name)}')"
              class="text-xs px-2 py-1 bg-indigo-100 text-indigo-700 rounded hover:bg-indigo-200"
            >
              <i class="fas fa-edit"></i>
            </button>
          </div>
          
          <div class="ml-13 space-y-2">
            <!-- Base Traits -->
            <div class="flex items-start gap-2">
              <span class="text-xs font-semibold text-gray-500 w-16 flex-shrink-0">共通特徴:</span>
              <span class="text-sm text-gray-700">
                ${char.base_traits ? escapeHtml(char.base_traits) : '<span class="text-gray-400 italic">未設定</span>'}
              </span>
            </div>
            
            ${hasOverrides ? `
              <div class="mt-2 pt-2 border-t border-gray-100">
                <span class="text-xs font-semibold text-yellow-700 block mb-1">
                  <i class="fas fa-exchange-alt mr-1"></i>シーン別オーバーライド:
                </span>
                <div class="space-y-1">
                  ${char.scene_overrides.map(o => `
                    <div class="flex items-center gap-2 text-xs bg-yellow-50 p-2 rounded">
                      <span class="px-2 py-0.5 bg-yellow-200 text-yellow-800 rounded font-mono">
                        #${o.scene_idx}
                      </span>
                      <span class="text-gray-600">${escapeHtml(o.trait_description)}</span>
                      <button 
                        onclick="removeSceneCharacterTrait(${o.scene_id}, '${char.character_key}')"
                        class="ml-auto text-red-500 hover:text-red-700"
                        title="削除"
                      >
                        <i class="fas fa-times"></i>
                      </button>
                    </div>
                  `).join('')}
                </div>
              </div>
            ` : ''}
          </div>
        </div>
      `;
    }).join('');
    
    console.log('[CharacterTraits] Loaded summary for', characters.length, 'characters');
  } catch (error) {
    console.warn('Failed to load character traits summary:', error);
    section.classList.add('hidden');
  }
}

/**
 * Toggle character traits summary visibility
 */
function toggleCharacterTraitsSummary() {
  const content = document.getElementById('characterTraitsSummaryContent');
  const btn = document.getElementById('toggleTraitsSummaryBtn');
  
  if (!content || !btn) return;
  
  const isHidden = content.classList.contains('hidden');
  
  if (isHidden) {
    content.classList.remove('hidden');
    btn.innerHTML = '<i class="fas fa-chevron-up mr-1"></i>閉じる';
    // Load data when expanding
    loadCharacterTraitsSummary();
  } else {
    content.classList.add('hidden');
    btn.innerHTML = '<i class="fas fa-chevron-down mr-1"></i>詳細';
  }
}

/**
 * Open modal to edit character's story traits
 * Uses CharacterTraitModal for proper UI
 */
async function openCharacterTraitEdit(characterKey, characterName) {
  if (!window.CharacterTraitModal) {
    console.error('[CharacterTraitEdit] CharacterTraitModal not loaded');
    showToast('モーダルの読み込みに失敗しました', 'error');
    return;
  }
  
  try {
    // Get current traits and image
    const response = await axios.get(`${API_BASE}/projects/${PROJECT_ID}/characters/${characterKey}`);
    const char = response.data.character || {};
    const currentTraits = char.story_traits || char.appearance_description || '';
    const imageUrl = char.reference_image_r2_url || null;
    
    window.CharacterTraitModal.openForStoryTraits(
      characterKey,
      characterName,
      currentTraits,
      imageUrl
    );
  } catch (error) {
    console.error('Failed to open character trait edit:', error);
    showToast('キャラクター情報の取得に失敗しました', 'error');
  }
}

/**
 * Get current traits for a character
 */
async function getCharacterCurrentTraits(characterKey) {
  try {
    const response = await axios.get(`${API_BASE}/projects/${PROJECT_ID}/characters/${characterKey}`);
    return response.data.character?.story_traits || response.data.character?.appearance_description || '';
  } catch (error) {
    console.warn('Failed to get character traits:', error);
    return '';
  }
}

/**
 * Remove scene-specific character trait override
 */
async function removeSceneCharacterTrait(sceneId, characterKey) {
  if (!confirm('このシーン別オーバーライドを削除しますか？')) return;
  
  try {
    await axios.delete(`${API_BASE}/scenes/${sceneId}/character-traits/${characterKey}`);
    showToast('シーン別設定を削除しました', 'success');
    loadCharacterTraitsSummary();
  } catch (error) {
    console.error('Failed to remove scene trait:', error);
    showToast('削除に失敗しました', 'error');
  }
}

/**
 * Open modal to add scene-specific trait override
 * Phase X-6: Now uses unified SceneEditModal with tabs
 */
async function openAddSceneTraitOverride(sceneId, sceneIdx) {
  // Use unified SceneEditModal instead of CharacterTraitModal
  if (window.SceneEditModal) {
    // P3-5: Pass source='builder' for SSOT control
    await window.SceneEditModal.open(sceneId, { source: 'builder' });
    // Switch to traits tab after opening
    setTimeout(() => {
      if (window.SceneEditModal.switchTab) {
        window.SceneEditModal.switchTab('traits');
      }
    }, 100);
  } else if (window.CharacterTraitModal) {
    // Fallback to old modal if SceneEditModal not loaded
    window.CharacterTraitModal.openForSceneOverrideSelection(sceneId, sceneIdx);
  } else {
    console.error('[SceneTraitOverride] No modal available');
    showToast('モーダルの読み込みに失敗しました', 'error');
  }
}

/**
 * Load character traits for a specific scene in Builder
 */
async function loadBuilderSceneCharTraits(sceneId) {
  const container = document.getElementById(`builderCharTraitsList-${sceneId}`);
  if (!container) return;
  
  try {
    // Get characters for this scene (with timeout to prevent freeze)
    const response = await axios.get(`${API_BASE}/scenes/${sceneId}/characters`, { timeout: 10000 });
    const characters = response.data.scene_characters || [];
    
    if (characters.length === 0) {
      container.innerHTML = '<span class="text-gray-400 italic">キャラクター未割当</span>';
      return;
    }
    
    // Get scene-specific overrides (with timeout)
    const traitsResponse = await axios.get(`${API_BASE}/scenes/${sceneId}/character-traits`, { timeout: 10000 });
    const sceneTraits = traitsResponse.data.scene_traits || [];
    const traitMap = new Map(sceneTraits.map(t => [t.character_key, t]));
    
    // Render character traits with A/B/C labels
    const html = characters.map(char => {
      const override = traitMap.get(char.character_key);
      const hasStoryTraits = char.story_traits && char.story_traits.trim();
      const hasAppearance = char.appearance_description && char.appearance_description.trim();
      
      // Determine which layer is active
      let activeLayer = 'none';
      let displayTraits = '';
      let layerLabel = '';
      
      if (override && override.trait_description) {
        activeLayer = 'C';
        displayTraits = override.trait_description;
        layerLabel = '<span class="inline-flex items-center justify-center w-4 h-4 rounded text-white font-bold text-xs bg-yellow-500 mr-1">C</span>';
      } else if (hasStoryTraits) {
        activeLayer = 'B';
        displayTraits = char.story_traits;
        layerLabel = '<span class="inline-flex items-center justify-center w-4 h-4 rounded text-white font-bold text-xs bg-purple-500 mr-1">B</span>';
      } else if (hasAppearance) {
        activeLayer = 'A';
        displayTraits = char.appearance_description;
        layerLabel = '<span class="inline-flex items-center justify-center w-4 h-4 rounded text-white font-bold text-xs bg-gray-500 mr-1">A</span>';
      }
      
      const bgClass = activeLayer === 'C' ? 'bg-yellow-50' : activeLayer === 'B' ? 'bg-purple-50' : '';
      const textClass = activeLayer === 'C' ? 'text-yellow-700' : activeLayer === 'B' ? 'text-purple-700' : 'text-gray-600';
      
      return `
        <div class="flex items-start gap-2 py-1 ${bgClass} px-2 rounded">
          <span class="font-semibold text-indigo-700">${escapeHtml(char.character_name || char.character_key)}:</span>
          <span class="flex-1 ${textClass}">
            ${displayTraits 
              ? `${layerLabel}${escapeHtml(displayTraits.length > 60 ? displayTraits.substring(0, 60) + '...' : displayTraits)}`
              : '<span class="italic text-gray-400">特徴未設定</span>'
            }
          </span>
        </div>
      `;
    }).join('');
    
    container.innerHTML = html || '<span class="text-gray-400 italic">特徴情報なし</span>';
  } catch (error) {
    console.warn('Failed to load scene character traits:', error);
    container.innerHTML = '<span class="text-red-500">読み込みエラー</span>';
  }
}

/**
 * Load character traits for all visible scenes in Builder
 */
function loadAllBuilderCharTraits(scenes) {
  if (!Array.isArray(scenes)) return;
  scenes.forEach(scene => {
    loadBuilderSceneCharTraits(scene.id);
  });
}

// Make functions globally accessible
window.toggleCharacterTraitsSummary = toggleCharacterTraitsSummary;
window.openCharacterTraitEdit = openCharacterTraitEdit;
window.removeSceneCharacterTrait = removeSceneCharacterTrait;
window.openAddSceneTraitOverride = openAddSceneTraitOverride;
window.loadBuilderSceneCharTraits = loadBuilderSceneCharTraits;
window.loadAllBuilderCharTraits = loadAllBuilderCharTraits;

// ========== A) Microphone Recording ==========
async function startRecording() {
  if (isProcessing) {
    showToast('処理中です。しばらくお待ちください', 'warning');
    return;
  }
  
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    
    // Initialize MediaRecorder
    mediaRecorder = new MediaRecorder(stream);
    audioChunks = [];
    recordingStartTime = Date.now();
    
    mediaRecorder.ondataavailable = (event) => {
      audioChunks.push(event.data);
    };
    
    mediaRecorder.onstop = async () => {
      const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
      const audioFile = new File([audioBlob], `recording_${Date.now()}.webm`, { type: 'audio/webm' });
      
      // Stop all tracks
      stream.getTracks().forEach(track => track.stop());
      
      // Auto upload
      await uploadAudioFile(audioFile);
    };
    
    mediaRecorder.start();
    
    // UI updates
    document.getElementById('startRecordBtn').classList.add('hidden');
    document.getElementById('stopRecordBtn').classList.remove('hidden');
    document.getElementById('recordingStatus').classList.remove('hidden');
    
    // Update recording time
    recordingTimer = setInterval(() => {
      if (!mediaRecorder || mediaRecorder.state !== 'recording') {
        clearInterval(recordingTimer);
        return;
      }
      
      const elapsed = Math.floor((Date.now() - recordingStartTime) / 1000);
      const minutes = Math.floor(elapsed / 60);
      const seconds = elapsed % 60;
      document.getElementById('recordingTime').textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;
      
      // Progress bar (max 5 minutes)
      const progress = Math.min((elapsed / 300) * 100, 100);
      document.getElementById('recordingProgress').style.width = `${progress}%`;
    }, 1000);
    
    showToast('録音を開始しました', 'info');
  } catch (error) {
    console.error('Start recording error:', error);
    showToast('マイクへのアクセスが拒否されました。ブラウザ設定を確認してください', 'error');
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    clearInterval(recordingTimer);
    
    // UI updates
    document.getElementById('startRecordBtn').classList.remove('hidden');
    document.getElementById('stopRecordBtn').classList.add('hidden');
    document.getElementById('recordingStatus').classList.add('hidden');
    
    showToast('録音を停止しました。アップロード中...', 'info');
  }
}

// ========== B) File Upload ==========
async function uploadAudio() {
  if (isProcessing) {
    showToast('処理中です。しばらくお待ちください', 'warning');
    return;
  }
  
  const fileInput = document.getElementById('audioFile');
  const file = fileInput.files[0];
  
  if (!file) {
    showToast('音声ファイルを選択してください', 'error');
    return;
  }
  
  await uploadAudioFile(file);
}

async function uploadAudioFile(file) {
  isProcessing = true;
  setButtonLoading('uploadAudioBtn', true);
  setButtonLoading('startRecordBtn', true);
  
  try {
    const formData = new FormData();
    formData.append('audio', file);
    
    const response = await axios.post(`${API_BASE}/projects/${PROJECT_ID}/upload`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    });
    
    if (response.data.id) {
      showToast('音声ファイルがアップロードされました', 'success');
      await loadProject(); // Reload project to update status
      document.getElementById('nextStepGuide').classList.remove('hidden');
    } else {
      showToast(response.data.error?.message || 'アップロードに失敗しました', 'error');
    }
  } catch (error) {
    console.error('Upload audio error:', error);
    showToast('アップロード中にエラーが発生しました', 'error');
  } finally {
    isProcessing = false;
    setButtonLoading('uploadAudioBtn', false);
    setButtonLoading('startRecordBtn', false);
  }
}

// ========== C) Text Paste ==========
async function saveSourceText() {
  if (isProcessing) {
    showToast('処理中です。しばらくお待ちください', 'warning');
    return;
  }
  
  const sourceText = document.getElementById('sourceText').value.trim();
  
  if (!sourceText) {
    showToast('テキストを入力してください', 'error');
    return;
  }
  
  isProcessing = true;
  setButtonLoading('saveTextBtn', true);
  
  try {
    const response = await axios.post(`${API_BASE}/projects/${PROJECT_ID}/source/text`, {
      text: sourceText
    });
    
    if (response.data.id) {
      showToast('テキストが保存されました。Scene Splitタブでシーン分割を実行してください。', 'success');
      await loadProject(); // Reload project to update status
      document.getElementById('nextStepGuide').classList.remove('hidden');
      
      // 自動でScene Splitタブに遷移
      switchTab('sceneSplit');
    } else {
      showToast(response.data.error?.message || 'テキスト保存に失敗しました', 'error');
    }
  } catch (error) {
    console.error('Save source text error:', error);
    showToast('テキスト保存中にエラーが発生しました', 'error');
  } finally {
    isProcessing = false;
    setButtonLoading('saveTextBtn', false);
  }
}

// ========== Scene Split Functions ==========

// Global split settings (SSOT: raw / optimized)
let currentSplitMode = null; // null = 未選択, 'raw' = 原文そのまま, 'optimized' = AI整形
let currentTargetSceneCount = 5; // Default target scene count
let savedSplitMode = null; // プロジェクトに保存されているモード（変更検知用）

/**
 * SSOT: split_mode のノーマライズ
 * preserve → raw, ai → optimized, その他 → null
 */
function normalizeSplitMode(mode) {
  if (mode === 'preserve' || mode === 'raw') return 'raw';
  if (mode === 'ai' || mode === 'optimized') return 'optimized';
  return null;
}

/**
 * モード表示名を取得
 */
function getSplitModeDisplayName(mode) {
  if (mode === 'raw') return '原文そのまま（Raw）';
  if (mode === 'optimized') return 'AIで整形（Optimized）';
  return '未選択';
}

/**
 * SSOT: プロジェクト読み込み時にsplit_modeをUIに反映
 * - currentProject.split_mode から初期値を設定
 * - savedSplitMode に保存して変更検知用に使用
 * - UIのラジオボタンと表示を更新
 */
function initializeSplitModeUI() {
  if (!currentProject) {
    console.log('[SplitMode] No project loaded, skipping initialization');
    return;
  }
  
  // プロジェクトからsplit_modeを取得してノーマライズ
  const projectMode = normalizeSplitMode(currentProject.split_mode);
  
  console.log('[SplitMode] Initializing with project mode:', currentProject.split_mode, '→', projectMode);
  
  // 保存モードとして記録（変更検知用）
  savedSplitMode = projectMode;
  currentSplitMode = projectMode; // 現在選択中のモードも初期化
  
  // UI更新: ラジオボタンの選択状態
  const rawRadio = document.querySelector('input[name="splitMode"][value="raw"]');
  const optimizedRadio = document.querySelector('input[name="splitMode"][value="optimized"]');
  
  if (rawRadio) rawRadio.checked = (projectMode === 'raw');
  if (optimizedRadio) optimizedRadio.checked = (projectMode === 'optimized');
  
  // UI更新: ラベルのハイライト
  const rawLabel = document.getElementById('splitModeRawLabel');
  const optimizedLabel = document.getElementById('splitModeOptimizedLabel');
  
  if (rawLabel && optimizedLabel) {
    // リセット
    rawLabel.classList.remove('border-green-500', 'bg-green-50');
    rawLabel.classList.add('border-gray-200');
    optimizedLabel.classList.remove('border-amber-500', 'bg-amber-50');
    optimizedLabel.classList.add('border-gray-200');
    
    // 選択中のモードをハイライト
    if (projectMode === 'raw') {
      rawLabel.classList.remove('border-gray-200');
      rawLabel.classList.add('border-green-500', 'bg-green-50');
    } else if (projectMode === 'optimized') {
      optimizedLabel.classList.remove('border-gray-200');
      optimizedLabel.classList.add('border-amber-500', 'bg-amber-50');
    }
  }
  
  // UI更新: 前回の分割モード表示
  const savedModeDisplay = document.getElementById('savedSplitModeDisplay');
  const savedModeContainer = document.getElementById('savedSplitModeContainer');
  if (savedModeDisplay && savedModeContainer) {
    if (projectMode) {
      savedModeDisplay.textContent = getSplitModeDisplayName(projectMode);
      savedModeContainer.classList.remove('hidden');
    } else {
      savedModeContainer.classList.add('hidden');
    }
  }
  
  // UI更新: target_scene_count
  if (currentProject.target_scene_count) {
    const targetInput = document.getElementById('targetSceneCount');
    if (targetInput) {
      targetInput.value = currentProject.target_scene_count;
      currentTargetSceneCount = currentProject.target_scene_count;
    }
  }
  
  // 説明文を更新
  updateSplitModeDescription();
}

/**
 * Render format section UI with mode selection
 */
function renderFormatSectionUI() {
  // 段落数を計算
  const paragraphCount = countParagraphs();
  
  return `
    <div class="p-6 bg-purple-50 border-l-4 border-purple-600 rounded-lg">
      <h3 class="font-bold text-gray-800 mb-4">シーン分割設定</h3>
      
      <!-- Paragraph Count Info -->
      <div id="paragraphInfo" class="mb-4 p-3 bg-blue-50 rounded border border-blue-200">
        <p class="text-sm text-blue-800">
          <i class="fas fa-align-left mr-2"></i>
          <strong>現在の段落数:</strong> <span id="currentParagraphCount">${paragraphCount}</span> 段落
        </p>
      </div>
      
      <!-- Mode Selection -->
      <div class="mb-4">
        <label class="block text-sm font-medium text-gray-700 mb-2">分割モード</label>
        <div class="flex gap-4">
          <label class="flex items-center cursor-pointer">
            <input type="radio" name="splitMode" value="ai" checked 
                   onchange="updateSplitMode('ai')"
                   class="mr-2 text-purple-600 focus:ring-purple-500">
            <span class="text-sm">
              <strong>AI整理</strong>
              <span class="text-gray-500 block text-xs">意図を読み取り、省略せず整理</span>
            </span>
          </label>
          <label class="flex items-center cursor-pointer">
            <input type="radio" name="splitMode" value="preserve"
                   onchange="updateSplitMode('preserve')"
                   class="mr-2 text-purple-600 focus:ring-purple-500">
            <span class="text-sm">
              <strong>原文維持（台本モード）</strong>
              <span class="text-gray-500 block text-xs">文章は一切変更しない</span>
            </span>
          </label>
        </div>
      </div>
      
      <!-- Target Scene Count -->
      <div class="mb-4">
        <label class="block text-sm font-medium text-gray-700 mb-2">目標シーン数</label>
        <div class="flex items-center gap-2">
          <input type="number" id="targetSceneCount" value="5" min="1" max="200"
                 onchange="updateTargetSceneCount(this.value)"
                 class="w-24 px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500">
          <span class="text-sm text-gray-500">シーン（1〜200）</span>
        </div>
      </div>
      
      <!-- Mode Description (動的更新) -->
      <div id="splitModeDescription" class="mb-4 p-3 bg-white rounded border border-gray-200">
        <p class="text-sm text-gray-600">
          <i class="fas fa-robot text-purple-600 mr-2"></i>
          <strong>AI整理モード:</strong> 元の文章を省略せず、AIが意図を読み取って適切にシーン分割します。
        </p>
      </div>
      
      <!-- Execute Button -->
      <button 
        id="formatBtn"
        onclick="confirmAndFormatSplit()"
        class="w-full px-6 py-3 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors font-semibold touch-manipulation"
      >
        <i class="fas fa-magic mr-2"></i>シーン分割を実行
      </button>
      
      <p class="text-xs text-red-500 mt-2 text-center font-medium">
        ⚠️ やり直し＝全リセット（シーン・画像・音声・バブル・SFX等は全削除、BGM設定・キャラ定義は保持）
      </p>
    </div>
  `;
}

/**
 * Count paragraphs in current source text
 */
function countParagraphs() {
  const textArea = document.getElementById('sourceText');
  if (!textArea) return 0;
  
  const text = textArea.value || '';
  if (!text.trim()) return 0;
  
  // 空行で分割して段落数をカウント
  return text.split(/\n\s*\n/).filter(p => p.trim().length > 0).length;
}

/**
 * Update target scene count and refresh description
 */
function updateTargetSceneCount(value) {
  currentTargetSceneCount = parseInt(value) || 5;
  updateSplitModeDescription();
}

/**
 * Update split mode and description
 * @deprecated Use onSplitModeChange instead
 */
function updateSplitMode(mode) {
  onSplitModeChange(normalizeSplitMode(mode));
}

/**
 * SSOT: Split mode change handler
 * - モード変更時にUIを更新
 * - savedSplitModeとの差分を検知
 */
window.onSplitModeChange = function(mode) {
  const normalizedMode = normalizeSplitMode(mode);
  currentSplitMode = normalizedMode;
  
  // UI更新: 選択状態のハイライト
  const rawLabel = document.getElementById('splitModeRawLabel');
  const optimizedLabel = document.getElementById('splitModeOptimizedLabel');
  
  if (rawLabel && optimizedLabel) {
    if (normalizedMode === 'raw') {
      rawLabel.classList.remove('border-gray-200');
      rawLabel.classList.add('border-green-500', 'bg-green-50');
      optimizedLabel.classList.remove('border-amber-500', 'bg-amber-50');
      optimizedLabel.classList.add('border-gray-200');
    } else if (normalizedMode === 'optimized') {
      optimizedLabel.classList.remove('border-gray-200');
      optimizedLabel.classList.add('border-amber-500', 'bg-amber-50');
      rawLabel.classList.remove('border-green-500', 'bg-green-50');
      rawLabel.classList.add('border-gray-200');
    }
  }
  
  // 警告非表示
  const warningEl = document.getElementById('splitModeNotSelectedWarning');
  if (warningEl) warningEl.classList.add('hidden');
  
  // モード変更の検知（保存モードと異なる場合）
  if (savedSplitMode && savedSplitMode !== normalizedMode) {
    console.log('[SplitMode] Mode changed from', savedSplitMode, 'to', normalizedMode);
  }
  
  updateSplitModeDescription();
  updateSplitModeHint(normalizedMode);
}

/**
 * Update split mode description with paragraph/target comparison
 */
function updateSplitModeDescription() {
  const descEl = document.getElementById('splitModeDescription');
  if (!descEl) return;
  
  const paragraphCount = countParagraphs();
  const target = currentTargetSceneCount;
  
  if (currentSplitMode === 'preserve') {
    // preserve モードの説明（段落数と目標の比較）
    let adjustmentText = '';
    if (paragraphCount > target) {
      adjustmentText = `<span class="text-orange-600"><i class="fas fa-compress-arrows-alt mr-1"></i>${paragraphCount}段落 → ${target}シーン（段落を結合、改変なし）</span>`;
    } else if (paragraphCount < target) {
      adjustmentText = `<span class="text-blue-600"><i class="fas fa-expand-arrows-alt mr-1"></i>${paragraphCount}段落 → ${target}シーン（文境界で分割、改変なし）</span>`;
    } else {
      adjustmentText = `<span class="text-green-600"><i class="fas fa-check mr-1"></i>${paragraphCount}段落 = ${target}シーン（そのまま）</span>`;
    }
    
    descEl.innerHTML = `
      <div class="text-sm">
        <p class="text-gray-600 mb-2">
          <i class="fas fa-file-alt text-green-600 mr-2"></i>
          <strong>原文維持モード:</strong> 文章は一切変更しません
        </p>
        <p class="mt-1">${adjustmentText}</p>
      </div>
    `;
  } else {
    // AI 整理モードの説明
    descEl.innerHTML = `
      <div class="text-sm">
        <p class="text-gray-600">
          <i class="fas fa-robot text-purple-600 mr-2"></i>
          <strong>AI整理モード:</strong> 元の文章を省略せず、AIが意図を読み取って適切にシーン分割します。
        </p>
        <p class="text-gray-500 mt-1 text-xs">
          目標: 約${target}シーン（AIが内容に応じて調整）
        </p>
      </div>
    `;
  }
}

/**
 * Confirm and execute format split (with reset warning)
 * SSOT: モード未選択の場合は実行不可
 * SSOT: モード変更の場合は2段階確認
 */
async function confirmAndFormatSplit() {
  // SSOT: モード未選択チェック
  if (!currentSplitMode) {
    const warningEl = document.getElementById('splitModeNotSelectedWarning');
    if (warningEl) warningEl.classList.remove('hidden');
    showToast('分割モードを選択してください', 'warning');
    return;
  }
  
  // Get target scene count from input
  const targetInput = document.getElementById('targetSceneCount');
  if (targetInput) {
    currentTargetSceneCount = parseInt(targetInput.value) || 5;
    console.log('[confirmAndFormatSplit] targetInput.value:', targetInput.value, '→ currentTargetSceneCount:', currentTargetSceneCount);
  } else {
    console.warn('[confirmAndFormatSplit] targetInput not found, using default:', currentTargetSceneCount);
  }
  
  const modeText = getSplitModeDisplayName(currentSplitMode);
  const isModeChanged = savedSplitMode && savedSplitMode !== currentSplitMode;
  
  // SSOT: モード変更の場合は2段階確認
  if (isModeChanged) {
    const confirmChange = confirm(
      `⚠️ 分割モードを変更して再分割しますか？\n\n` +
      `変更前: ${getSplitModeDisplayName(savedSplitMode)}\n` +
      `変更後: ${modeText}\n\n` +
      `この操作は取り消せません。\n` +
      `続行するには「OK」を押してください。`
    );
    if (!confirmChange) return;
  }
  
  // 最終確認
  const confirmed = confirm(
    `シーン分割を実行しますか？\n\n` +
    `分割モード: ${modeText}\n` +
    `目標シーン数: ${currentTargetSceneCount}\n\n` +
    `⚠️ リセットされる制作物:\n` +
    `  ・原文由来シーン（chunk_id≠NULL）\n` +
    `  ・上記シーンの画像・音声・吹き出し\n` +
    `  ・SFX・テロップ・モーション・キャラ割当\n\n` +
    `✅ 保持されるもの:\n` +
    `  ・手動追加シーン（chunk_id=NULL）\n` +
    `  ・BGM設定・キャラクター定義\n` +
    `  ・ビルド履歴（監査用）`
  );
  
  if (!confirmed) return;
  
  // Execute format split
  await formatAndSplit();
}

/**
 * Update paragraph count display
 * Counts paragraphs separated by empty lines (\n\n)
 */
function updateParagraphCount(text) {
  const paragraphCountInfo = document.getElementById('paragraphCountInfo');
  if (!paragraphCountInfo) return;
  
  if (!text || text.trim() === '') {
    paragraphCountInfo.textContent = '';
    return;
  }
  
  // Count paragraphs (split by double newline)
  const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim() !== '');
  paragraphCountInfo.textContent = `（現在の段落数: ${paragraphs.length}）`;
}

/**
 * Update split mode hint text
 */
function updateSplitModeHint(mode) {
  const hintEl = document.getElementById('splitModeHint');
  if (!hintEl) return;
  
  if (mode === 'preserve') {
    hintEl.textContent = '原文維持モード: 段落数より多い場合は文境界で分割、少ない場合は結合（省略なし）';
  } else {
    hintEl.textContent = 'AI整理モード: AIが最適なシーン数に調整します（元の表現をできるだけ維持）';
  }
}

// Global polling state
let formatPollingInterval = null;
let formatPollingStartTime = null;
let currentFormatRunNo = null; // サポート用: 現在のrun_no
let currentFormatRunId = null; // SSOT: 監視中のrun_id（mismatch検出用）
const FORMAT_TIMEOUT_MS = 10 * 60 * 1000; // 10分タイムアウト

// Format and split scenes with progress monitoring
// Note: Called from confirmAndFormatSplit() which handles the confirmation dialog
// SSOT: split_mode は raw/optimized → preserve/ai に変換してAPIへ送信
async function formatAndSplit() {
  if (isProcessing) {
    showToast('処理中です。しばらくお待ちください', 'warning');
    return;
  }
  
  // SSOT: モード未選択チェック
  if (!currentSplitMode) {
    showToast('分割モードを選択してください', 'error');
    return;
  }
  
  // Get split mode and target scene count from global state (set by confirmAndFormatSplit)
  // SSOT: raw → preserve, optimized → ai に変換（バックエンド互換）
  const apiSplitMode = currentSplitMode === 'raw' ? 'preserve' : 'ai';
  const targetSceneCount = currentTargetSceneCount || 5;
  
  console.log('[Format] currentTargetSceneCount:', currentTargetSceneCount);
  console.log('[Format] Split mode:', currentSplitMode, '(API:', apiSplitMode, ') Target scene count:', targetSceneCount);
  
  isProcessing = true;
  setButtonLoading('formatBtn', true);
  
  // Show progress UI
  showFormatProgressUI();
  
  try {
    // For audio projects, ensure transcribe → parse → format flow
    if (currentProject.source_type === 'audio') {
      // Step 1: Transcribe if status='uploaded' (not transcribed yet)
      if (currentProject.status === 'uploaded') {
        try {
          const transcribeResponse = await axios.post(`${API_BASE}/projects/${PROJECT_ID}/transcribe`);
          
          if (transcribeResponse.data.error) {
            showToast(transcribeResponse.data.error.message || '文字起こしに失敗しました', 'error');
            document.getElementById('formatSection').classList.remove('hidden');
            isProcessing = false;
            setButtonLoading('formatBtn', false);
            return;
          }
          
          // Wait for transcribe to complete
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
          console.error('Transcribe error:', error);
          showToast('文字起こし中にエラーが発生しました', 'error');
          document.getElementById('formatSection').classList.remove('hidden');
          isProcessing = false;
          setButtonLoading('formatBtn', false);
          return;
        }
      }
      
      // Step 2: Parse (for both 'uploaded' and 'transcribed' status)
      if (currentProject.status === 'uploaded' || currentProject.status === 'transcribed') {
        try {
          const parseResponse = await axios.post(`${API_BASE}/projects/${PROJECT_ID}/parse`);
          
          if (parseResponse.data.error) {
            showToast(parseResponse.data.error.message || 'テキスト分割に失敗しました', 'error');
            document.getElementById('formatSection').classList.remove('hidden');
            isProcessing = false;
            setButtonLoading('formatBtn', false);
            return;
          }
          
          // Wait for parse to complete
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
          console.error('Parse error:', error);
          console.error('Parse error response data:', error.response?.data);
          const errMsg = error.response?.data?.error?.message || 
                         error.response?.data?.error?.details?.error_message ||
                         'テキスト分割中にエラーが発生しました';
          showToast(errMsg, 'error');
          document.getElementById('formatSection').classList.remove('hidden');
          isProcessing = false;
          setButtonLoading('formatBtn', false);
          return;
        }
      }
    }
    
    // For text projects, ensure parse → format flow
    if (currentProject.source_type === 'text') {
      // Parse if status='uploaded' (text saved but not parsed yet)
      if (currentProject.status === 'uploaded') {
        try {
          const parseResponse = await axios.post(`${API_BASE}/projects/${PROJECT_ID}/parse`);
          
          if (parseResponse.data.error) {
            showToast(parseResponse.data.error.message || 'テキスト分割に失敗しました', 'error');
            document.getElementById('formatSection').classList.remove('hidden');
            isProcessing = false;
            setButtonLoading('formatBtn', false);
            return;
          }
          
          // Wait for parse to complete
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
          console.error('Parse error:', error);
          console.error('Parse error response data:', error.response?.data);
          const errMsg = error.response?.data?.error?.message || 
                         error.response?.data?.error?.details?.error_message ||
                         'テキスト分割中にエラーが発生しました';
          showToast(errMsg, 'error');
          document.getElementById('formatSection').classList.remove('hidden');
          isProcessing = false;
          setButtonLoading('formatBtn', false);
          return;
        }
      }
    }
    
    // Initial format call with split mode parameters
    // SSOT: apiSplitMode を使用（raw → preserve, optimized → ai）
    const formatPayload = {
      split_mode: apiSplitMode,
      target_scene_count: targetSceneCount,
      reset: true  // Always full reset (Phase S-1)
    };
    console.log('[Format] Sending format request with payload:', formatPayload);
    const response = await axios.post(`${API_BASE}/projects/${PROJECT_ID}/format`, formatPayload);
    
    if (response.data.error) {
      // INVALID_STATUS (failed) の場合、復帰導線を表示
      if (response.data.error.code === 'INVALID_STATUS' &&
          response.data.error.details?.current_status === 'failed') {
        showFailedProjectRecoveryUI();
      } else {
        showToast(response.data.error.message || 'シーン分割に失敗しました', 'error');
        document.getElementById('formatSection').classList.remove('hidden');
      }
      isProcessing = false;
      setButtonLoading('formatBtn', false);
      return;
    }
    
    // Check if preserve mode completed immediately (raw mode)
    if (response.data.status === 'formatted' && (response.data.split_mode === 'preserve' || response.data.split_mode === 'raw')) {
      // Preserve mode completed immediately - no polling needed
      console.log('[Format] Raw mode completed:', response.data);
      
      // SSOT: integrity_check の結果を表示
      const integrityCheck = response.data.integrity_check;
      if (integrityCheck) {
        if (integrityCheck.status === 'passed') {
          showToast(`原文そのままモードで ${response.data.total_scenes} シーンを生成しました（整合性OK: ${integrityCheck.preserved_chars}文字保持）`, 'success');
        } else {
          // integrity_check failed は通常 400/422 で返るが念のため
          showToast(`警告: 原文の整合性チェックに問題が発生しました`, 'warning');
        }
      } else {
        showToast(`原文そのままモードで ${response.data.total_scenes} シーンを生成しました`, 'success');
      }
      
      // 保存モードを更新（次回の変更検知用）
      savedSplitMode = 'raw';
      
      // CRITICAL FIX: Reset formatSection to original UI before loadProject
      // showFormatProgressUI() replaces formatSection.innerHTML with progress spinner
      // We need to restore the original format section UI
      const formatSection = document.getElementById('formatSection');
      if (formatSection) {
        formatSection.innerHTML = renderFormatSectionUI();
        formatSection.className = 'mb-6 p-6 bg-purple-50 border-l-4 border-purple-600 rounded-lg';
        formatSection.classList.add('hidden'); // Will be controlled by initSceneSplitTab
        console.log('[Format] Reset formatSection innerHTML after raw mode completion');
      }
      
      // Reload project to show scenes
      await loadProject();
      
      isProcessing = false;
      setButtonLoading('formatBtn', false);
      return;
    }
    
    // SSOT: 監視するrun_id/run_noを保存（mismatch検出用）
    currentFormatRunId = response.data.run_id || null;
    currentFormatRunNo = response.data.run_no || null;
    console.log('[Format] Started monitoring run_id:', currentFormatRunId, 'run_no:', currentFormatRunNo);
    
    // Start polling for progress (AI mode)
    startFormatPolling();
    
  } catch (error) {
    console.error('Format error:', error);
    
    // Log detailed error information for debugging
    if (error.response) {
      console.error('Error response data:', error.response.data);
      console.error('Error response status:', error.response.status);
    }
    
    // Stop any running polling
    if (formatPollingInterval) {
      clearInterval(formatPollingInterval);
      formatPollingInterval = null;
    }
    
    // CRITICAL FIX: Reset formatSection innerHTML to original UI
    const formatSection = document.getElementById('formatSection');
    if (formatSection) {
      formatSection.innerHTML = renderFormatSectionUI();
      formatSection.className = 'mb-6 p-6 bg-purple-50 border-l-4 border-purple-600 rounded-lg';
      formatSection.classList.remove('hidden');
    }
    
    // INVALID_STATUS (failed) の場合、復帰導線を表示
    if (error.response?.status === 400 && 
        error.response?.data?.error?.code === 'INVALID_STATUS' &&
        error.response?.data?.error?.details?.current_status === 'failed') {
      showFailedProjectRecoveryUI();
    } else if (error.response?.data?.error?.code === 'PRESERVE_INTEGRITY_ERROR') {
      // SSOT: 原文保持の整合性エラー（重大事故）
      const details = error.response?.data?.error?.details || {};
      const originalChars = details.original_chars || '?';
      const afterChars = details.after_chars || '?';
      showToast(`原文保持エラー: 原文が改変されました（${originalChars}文字 → ${afterChars}文字）。再実行してください。`, 'error');
      console.error('[SSOT] PRESERVE_INTEGRITY_ERROR:', details);
    } else {
      // Show detailed error message
      const errorMsg = error.response?.data?.error?.message || error.message || 'シーン分割中にエラーが発生しました';
      const errorCode = error.response?.data?.error?.code;
      
      // Show both error code and message
      const displayMsg = errorCode ? `[${errorCode}] ${errorMsg}` : errorMsg;
      showToast(displayMsg, 'error');
    }
    
    isProcessing = false;
    setButtonLoading('formatBtn', false);
  }
}

// Show format progress UI
function showFormatProgressUI() {
  const formatSection = document.getElementById('formatSection');
  
  // Remove default purple border styling to prevent double border
  formatSection.className = 'mb-6';
  
  formatSection.innerHTML = `
    <div class="p-6 bg-blue-50 border-l-4 border-blue-600 rounded-lg">
      <div class="flex items-start">
        <i class="fas fa-spinner fa-spin text-blue-600 text-3xl mr-4 mt-1"></i>
        <div class="flex-1">
          <h3 class="font-bold text-gray-800 mb-2 text-lg">シーン化中...</h3>
          <p id="formatProgressText" class="text-sm text-gray-700 mb-4">
            解析中...
          </p>
          <div class="w-full bg-gray-200 rounded-full h-4 mb-2">
            <div id="formatProgressBar" class="bg-blue-600 h-4 rounded-full transition-all duration-500" style="width: 0%"></div>
          </div>
          <p id="formatProgressDetails" class="text-xs text-gray-600">
            進捗を確認中...
          </p>
          <div id="formatRunInfo" class="mt-2 text-xs text-gray-400">
            <!-- サポート用: Project / Run / 開始時刻 -->
          </div>
        </div>
      </div>
    </div>
  `;
  
  formatSection.classList.remove('hidden');
}

// Start polling for format progress with timeout
function startFormatPolling() {
  // Clear any existing interval
  if (formatPollingInterval) {
    clearInterval(formatPollingInterval);
  }
  
  // Record start time for timeout
  formatPollingStartTime = Date.now();
  
  // Poll every 5 seconds
  formatPollingInterval = setInterval(async () => {
    try {
      // ===== TIMEOUT CHECK =====
      const elapsed = Date.now() - formatPollingStartTime;
      if (elapsed > FORMAT_TIMEOUT_MS) {
        console.error('[Format] Timeout reached:', elapsed, 'ms');
        clearInterval(formatPollingInterval);
        formatPollingInterval = null;
        formatPollingStartTime = null;
        
        // Generate log ID for support
        const logId = `format_timeout_${PROJECT_ID}_${currentFormatRunNo || 'unknown'}_${Date.now()}`;
        console.error('[Format] LogID:', logId);
        
        // Show timeout UI with run_no
        showFormatTimeoutUI(logId, elapsed, currentFormatRunNo);
        isProcessing = false;
        return;
      }
      
      const response = await axios.get(`${API_BASE}/projects/${PROJECT_ID}/format/status`);
      const data = response.data;
      
      updateFormatProgress(data);
      
      console.log('Format polling status:', data.status, 'processed:', data.processed, 'pending:', data.pending, 'run_id:', data.run_id, 'elapsed:', Math.round(elapsed/1000), 's');
      
      // ===== RUN_ID MISMATCH CHECK (SSOT) =====
      // 別のrunが開始された場合は即座に停止
      if (currentFormatRunId && data.run_id && data.run_id !== currentFormatRunId) {
        console.warn('[Format] Run ID mismatch detected! Expected:', currentFormatRunId, 'Got:', data.run_id);
        clearInterval(formatPollingInterval);
        formatPollingInterval = null;
        formatPollingStartTime = null;
        currentFormatRunId = null;
        currentFormatRunNo = null;
        
        showToast('別のシーン化処理が開始されました。画面を更新してください。', 'warning');
        isProcessing = false;
        
        // CRITICAL FIX: Reset formatSection innerHTML to original UI
        const formatSection = document.getElementById('formatSection');
        if (formatSection) {
          formatSection.innerHTML = renderFormatSectionUI();
          formatSection.className = 'mb-6 p-6 bg-purple-50 border-l-4 border-purple-600 rounded-lg';
          formatSection.classList.remove('hidden');
        }
        return;
      }
      
      // ===== FAILED STATUS CHECK =====
      if (data.status === 'failed') {
        console.error('[Format] Project status is failed');
        clearInterval(formatPollingInterval);
        formatPollingInterval = null;
        formatPollingStartTime = null;
        
        showFormatFailedUI(data.error_message || 'シーン化に失敗しました', currentFormatRunNo);
        isProcessing = false;
        return;
      }
      
      // Check if completed
      if (data.status === 'formatted') {
        console.log('Format completed, stopping polling');
        clearInterval(formatPollingInterval);
        formatPollingInterval = null;
        formatPollingStartTime = null;
        
        // Get actual scene count from scenes API
        try {
          const scenesResponse = await axios.get(`${API_BASE}/projects/${PROJECT_ID}/scenes`);
          const sceneCount = scenesResponse.data.scenes?.length || 0;
          
          console.log('Scene count:', sceneCount);
          
          await onFormatComplete({
            total_scenes: sceneCount,
            chunk_stats: {
              total: data.total_chunks,
              processed: data.processed,
              failed: data.failed
            }
          });
        } catch (error) {
          console.error('Failed to get scenes count:', error);
          // Fallback: estimate from chunks
          await onFormatComplete({
            total_scenes: data.processed * 2, // Rough estimate: 2 scenes per chunk
            chunk_stats: {
              total: data.total_chunks,
              processed: data.processed,
              failed: data.failed
            }
          });
        }
      } else if (data.status === 'formatting' || data.status === 'uploaded') {
        // Continue polling and trigger next batch if pending > 0
        // BUG FIX: 'uploaded' 状態でもバッチトリガーを許可（バックエンドで formatting に遷移する）
        if (data.pending > 0 && data.processing === 0) {
          // Still have pending chunks, trigger next batch
          try {
            console.log('Triggering next batch: pending =', data.pending, 'status =', data.status);
            await axios.post(`${API_BASE}/projects/${PROJECT_ID}/format`);
          } catch (error) {
            console.error('Next batch format call error:', error);
          }
        } else if (data.pending === 0 && data.processing === 0) {
          // All chunks done, trigger one more format call to merge
          try {
            console.log('All chunks done, triggering final merge');
            await axios.post(`${API_BASE}/projects/${PROJECT_ID}/format`);
          } catch (error) {
            console.error('Final format call error:', error);
          }
        }
      }
      
    } catch (error) {
      console.error('Polling error:', error);
      // ===== NETWORK ERROR: Don't stop polling immediately =====
      // Only stop after 3 consecutive failures
      if (!window.formatPollingFailCount) window.formatPollingFailCount = 0;
      window.formatPollingFailCount++;
      
      if (window.formatPollingFailCount >= 3) {
        clearInterval(formatPollingInterval);
        formatPollingInterval = null;
        formatPollingStartTime = null;
        window.formatPollingFailCount = 0;
        
        const logId = `format_error_${PROJECT_ID}_${Date.now()}`;
        showFormatErrorUI(error.message || '進捗確認中にエラーが発生しました', logId);
        isProcessing = false;
      } else {
        console.warn(`[Format] Network error (attempt ${window.formatPollingFailCount}/3), retrying...`);
      }
    }
  }, 5000);
}

// Show timeout UI
function showFormatTimeoutUI(logId, elapsedMs, runNo = null) {
  const formatSection = document.getElementById('formatSection');
  const runInfoHtml = runNo ? `<span class="ml-4">Run: #${runNo}</span>` : '';
  formatSection.innerHTML = `
    <div class="p-6 bg-yellow-50 border-l-4 border-yellow-600 rounded-lg">
      <div class="flex items-start">
        <i class="fas fa-clock text-yellow-600 text-3xl mr-4 mt-1"></i>
        <div class="flex-1">
          <h3 class="font-bold text-gray-800 mb-2 text-lg">タイムアウトしました</h3>
          <p class="text-sm text-gray-700 mb-4">
            シーン化処理が ${Math.round(elapsedMs / 60000)} 分以上かかっています。<br>
            サーバー側で処理が継続している可能性があります。
          </p>
          <div class="bg-gray-100 p-2 rounded text-xs font-mono mb-4">
            Project: ${PROJECT_ID}${runInfoHtml}<br>
            LogID: ${logId}
          </div>
          <div class="flex gap-2">
            <button onclick="retryFormatPolling()" class="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700">
              <i class="fas fa-sync mr-1"></i>再確認
            </button>
            <button onclick="resetFormatAndRetry()" class="px-4 py-2 bg-gray-600 text-white rounded hover:bg-gray-700">
              <i class="fas fa-redo mr-1"></i>最初からやり直す
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
  formatSection.classList.remove('hidden');
}

// Show failed UI
function showFormatFailedUI(errorMessage, runNo = null) {
  const formatSection = document.getElementById('formatSection');
  const runInfoHtml = runNo ? `<div class="bg-gray-100 p-2 rounded text-xs font-mono mb-4">Project: ${PROJECT_ID} / Run: #${runNo}</div>` : '';
  formatSection.innerHTML = `
    <div class="p-6 bg-red-50 border-l-4 border-red-600 rounded-lg">
      <div class="flex items-start">
        <i class="fas fa-exclamation-circle text-red-600 text-3xl mr-4 mt-1"></i>
        <div class="flex-1">
          <h3 class="font-bold text-gray-800 mb-2 text-lg">シーン化に失敗しました</h3>
          <p class="text-sm text-gray-700 mb-4">${errorMessage}</p>
          ${runInfoHtml}
          <div class="flex gap-2">
            <button onclick="resetFormatAndRetry()" class="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700">
              <i class="fas fa-redo mr-1"></i>やり直す
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
  formatSection.classList.remove('hidden');
}

// Show error UI
function showFormatErrorUI(errorMessage, logId) {
  const formatSection = document.getElementById('formatSection');
  formatSection.innerHTML = `
    <div class="p-6 bg-red-50 border-l-4 border-red-600 rounded-lg">
      <div class="flex items-start">
        <i class="fas fa-wifi text-red-600 text-3xl mr-4 mt-1"></i>
        <div class="flex-1">
          <h3 class="font-bold text-gray-800 mb-2 text-lg">通信エラーが発生しました</h3>
          <p class="text-sm text-gray-700 mb-4">${errorMessage}</p>
          <div class="bg-gray-100 p-2 rounded text-xs font-mono mb-4">
            LogID: ${logId}
          </div>
          <div class="flex gap-2">
            <button onclick="retryFormatPolling()" class="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700">
              <i class="fas fa-sync mr-1"></i>再試行
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
  formatSection.classList.remove('hidden');
}

// Retry polling (check current status)
async function retryFormatPolling() {
  try {
    const response = await axios.get(`${API_BASE}/projects/${PROJECT_ID}/format/status`);
    const data = response.data;
    
    if (data.status === 'formatted') {
      showToast('シーン化が完了しています', 'success');
      await loadScenes();
      switchTab('builder');
    } else if (data.status === 'formatting') {
      showToast('処理を再開します', 'info');
      isProcessing = true;
      showFormatProgressUI();
      startFormatPolling();
    } else if (data.status === 'failed') {
      showFormatFailedUI(data.error_message || 'シーン化に失敗しました', data.run_no);
    } else {
      showToast(`現在のステータス: ${data.status}`, 'info');
    }
  } catch (error) {
    console.error('Retry check failed:', error);
    showToast('ステータス確認に失敗しました', 'error');
  }
}

// Reset and retry from beginning
async function resetFormatAndRetry() {
  if (!confirm('シーン化をやり直しますか？\n既存のシーンは削除されます。')) {
    return;
  }
  
  try {
    // Reset project status to 'uploaded' or 'parsed'
    // This will be handled by calling format again
    showToast('処理を再開します', 'info');
    
    // Hide and clear character-related sections (they will be refreshed after re-split)
    const traitsSection = document.getElementById('characterTraitsSummarySection');
    const traitsContent = document.getElementById('characterTraitsSummaryContent');
    const charStatusSection = document.getElementById('characterStatusSection');
    const scenesSection = document.getElementById('scenesSection');
    const characterTraitsList = document.getElementById('characterTraitsList');
    
    if (traitsSection) traitsSection.classList.add('hidden');
    if (traitsContent) traitsContent.innerHTML = '';
    if (characterTraitsList) characterTraitsList.innerHTML = '';
    if (charStatusSection) charStatusSection.classList.add('hidden');
    if (scenesSection) scenesSection.classList.add('hidden');
    
    // Clear scenes list
    const scenesList = document.getElementById('scenesList');
    if (scenesList) scenesList.innerHTML = '';
    
    // Reload project to get fresh status
    const projectResponse = await axios.get(`${API_BASE}/projects/${PROJECT_ID}`);
    updateCurrentProject(projectResponse.data);
    
    // Show format section and allow retry
    const formatSection = document.getElementById('formatSection');
    formatSection.innerHTML = `
      <div class="p-6 bg-purple-50 border-l-4 border-purple-600 rounded-lg">
        <h3 class="font-bold text-gray-800 mb-4">シーン分割</h3>
        <p class="text-sm text-gray-600 mb-4">テキストをシーンに分割します。</p>
        <button id="formatBtn" onclick="formatAndSplit()" class="w-full px-4 py-3 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors">
          <i class="fas fa-magic mr-2"></i>シーン化を実行
        </button>
      </div>
    `;
    formatSection.classList.remove('hidden');
    
  } catch (error) {
    console.error('Reset failed:', error);
    showToast('リセットに失敗しました', 'error');
  }
}

// Update format progress UI
async function updateFormatProgress(data) {
  const progressText = document.getElementById('formatProgressText');
  const progressBar = document.getElementById('formatProgressBar');
  const progressDetails = document.getElementById('formatProgressDetails');
  const runInfo = document.getElementById('formatRunInfo');
  
  if (!progressText || !progressBar || !progressDetails) return;
  
  const { status, total_chunks, processed, failed, processing, pending, run_no, run_id, started_at } = data;
  
  // サポート用: run_no を保持＆表示
  if (run_no) {
    currentFormatRunNo = run_no;
  }
  if (runInfo && run_no) {
    const startTime = started_at ? new Date(started_at).toLocaleTimeString('ja-JP') : '--:--';
    runInfo.innerHTML = `<span class="text-gray-500 text-xs">Project: ${PROJECT_ID} / Run: #${run_no} / 開始: ${startTime}</span>`;
  }
  
  // Calculate progress percentage
  const percentage = total_chunks > 0 ? Math.round((processed / total_chunks) * 100) : 0;
  progressBar.style.width = `${percentage}%`;
  
  // Update text
  if (status === 'parsed') {
    progressText.textContent = '解析中...';
    progressDetails.textContent = '準備中...';
  } else if (status === 'formatting') {
    progressText.textContent = `シーン化中…（${processed} / ${total_chunks}）`;
    
    if (failed > 0) {
      // 失敗チャンク詳細表示
      let failedChunksHTML = `<span class="text-yellow-600"><i class="fas fa-exclamation-triangle mr-1"></i>一部のチャンクで失敗しました（続行できます）</span>`;
      
      // Show failed chunk details button
      failedChunksHTML += ` <button onclick="showFailedChunks()" class="ml-2 text-sm text-blue-600 hover:underline">詳細を表示</button>`;
      
      progressDetails.innerHTML = failedChunksHTML;
    } else if (pending === 0 && processing === 0) {
      progressDetails.textContent = '最終処理中...';
    } else if (pending > 0 && processing === 0) {
      // ⚠️ 停止状態（再開が必要）
      progressDetails.innerHTML = `
        <span class="text-orange-600"><i class="fas fa-pause-circle mr-1"></i>処理が停止しています</span>
        <button 
          onclick="resumeFormatting()" 
          class="ml-3 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition"
        >
          <i class="fas fa-play mr-1"></i>処理を再開
        </button>
      `;
    } else {
      progressDetails.textContent = `処理済み: ${processed}, 処理中: ${processing}, 待機中: ${pending}, 失敗: ${failed}`;
    }
  }
}

// 失敗チャンク詳細表示
async function showFailedChunks() {
  try {
    const response = await axios.get(`${API_BASE}/projects/${PROJECT_ID}/chunks`);
    const { chunks, stats } = response.data;
    
    const failedChunks = chunks.filter(c => c.status === 'failed');
    
    if (failedChunks.length === 0) {
      showToast('失敗したチャンクはありません', 'info');
      return;
    }
    
    // モーダル表示
    const modal = document.createElement('div');
    modal.className = 'fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50';
    modal.innerHTML = `
      <div class="bg-white rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[80vh] overflow-y-auto">
        <div class="p-6 border-b border-gray-200">
          <h3 class="text-xl font-bold text-gray-800">
            <i class="fas fa-exclamation-triangle text-yellow-600 mr-2"></i>
            失敗したチャンク一覧（${failedChunks.length}件）
          </h3>
        </div>
        <div class="p-6">
          ${failedChunks.map(chunk => `
            <div class="mb-4 p-4 bg-red-50 border border-red-200 rounded">
              <div class="flex items-start justify-between mb-2">
                <div class="font-semibold text-red-800">チャンク #${chunk.idx}</div>
                <button 
                  onclick="retryChunk(${chunk.id})" 
                  class="px-3 py-1 bg-blue-600 text-white text-sm rounded hover:bg-blue-700"
                >
                  <i class="fas fa-redo mr-1"></i>再試行
                </button>
              </div>
              <div class="text-sm text-gray-700 mb-2">
                <strong>エラー:</strong> ${escapeHtml(chunk.error_message || '不明なエラー')}
              </div>
              <div class="text-xs text-gray-500 max-h-20 overflow-y-auto">
                ${escapeHtml(chunk.text.substring(0, 200))}${chunk.text.length > 200 ? '...' : ''}
              </div>
            </div>
          `).join('')}
        </div>
        <div class="p-6 border-t border-gray-200 flex justify-end">
          <button 
            onclick="this.closest('.fixed').remove()" 
            class="px-6 py-2 bg-gray-600 text-white rounded hover:bg-gray-700"
          >
            閉じる
          </button>
        </div>
      </div>
    `;
    
    document.body.appendChild(modal);
    
    // クリックで閉じる
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.remove();
      }
    });
    
  } catch (error) {
    console.error('Failed to load chunks:', error);
    showToast('チャンク情報の取得に失敗しました', 'error');
  }
}

// チャンク再試行
async function retryChunk(chunkId) {
  if (!confirm('このチャンクを再試行しますか？')) {
    return;
  }
  
  try {
    await axios.post(`${API_BASE}/text_chunks/${chunkId}/retry`);
    showToast('チャンクを再試行キューに追加しました', 'success');
    
    // モーダルを閉じる
    const modal = document.querySelector('.fixed.inset-0');
    if (modal) modal.remove();
    
    // 処理を再開
    await resumeFormatting();
    
  } catch (error) {
    console.error('Retry chunk error:', error);
    showToast('再試行に失敗しました', 'error');
  }
}

// フォーマット処理を再開
async function resumeFormatting() {
  try {
    showToast('処理を再開します...', 'info');
    
    // 次のバッチを呼び出し
    await axios.post(`${API_BASE}/projects/${PROJECT_ID}/format`);
    
    // ポーリングは継続中のはず（念のため確認）
    if (!formatPollingInterval) {
      startFormatPolling();
    }
    
  } catch (error) {
    console.error('Resume formatting error:', error);
    showToast('再開に失敗しました', 'error');
  }
}

// On format complete
async function onFormatComplete(data) {
  const { total_scenes, chunk_stats, failed } = data;
  
  console.log('[onFormatComplete] Starting with data:', data);
  
  // Calculate failed count from either chunk_stats or direct failed field
  const failedCount = chunk_stats?.failed ?? failed ?? 0;
  
  // Show completion message
  if (failedCount > 0) {
    showToast(`完了！${total_scenes || 0}シーンを生成しました（一部チャンク失敗: ${failedCount}件）`, 'warning');
  } else {
    showToast(`完了！${total_scenes || 0}シーンを生成しました`, 'success');
  }
  
  // CRITICAL FIX: Reset formatSection innerHTML before loadProject
  // showFormatProgressUI() replaces innerHTML with progress spinner
  const formatSection = document.getElementById('formatSection');
  if (formatSection) {
    formatSection.innerHTML = renderFormatSectionUI();
    formatSection.className = 'mb-6 p-6 bg-purple-50 border-l-4 border-purple-600 rounded-lg';
    console.log('[onFormatComplete] Reset formatSection innerHTML');
  }
  
  // キャッシュクリア（新しいシーンが生成された）
  window.sceneSplitInitialized = false;
  
  // Reload project and scenes
  console.log('[onFormatComplete] Calling loadProject...');
  await loadProject();
  console.log('[onFormatComplete] loadProject done, calling loadScenes...');
  await loadScenes();
  console.log('[onFormatComplete] loadScenes done');
  
  // Hide format section
  document.getElementById('formatSection').classList.add('hidden');
  document.getElementById('scenesSection').classList.remove('hidden');
  
  isProcessing = false;
  setButtonLoading('formatBtn', false);
  console.log('[onFormatComplete] Completed');
  
  // Auto-navigate to Builder tab (optional)
  // window.location.href = `/builder.html?id=${PROJECT_ID}`;
}

// Show recovery UI for failed projects
function showFailedProjectRecoveryUI() {
  const formatSection = document.getElementById('formatSection');
  
  formatSection.innerHTML = `
    <div class="p-6 bg-red-50 border-l-4 border-red-600 rounded-lg">
      <div class="flex items-start">
        <i class="fas fa-exclamation-triangle text-red-600 text-3xl mr-4 mt-1"></i>
        <div class="flex-1">
          <h3 class="font-bold text-gray-800 mb-2 text-lg">このプロジェクトは失敗状態です</h3>
          <p class="text-sm text-gray-700 mb-4">
            前回のシーン分割実行時にエラーが発生しました。<br>
            プロジェクトをリセットして再実行するか、新しいプロジェクトを作成してください。
          </p>
          <div class="flex flex-wrap gap-3">
            <button 
              onclick="resetProject()"
              class="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-semibold touch-manipulation"
            >
              <i class="fas fa-redo mr-2"></i>リセットして再実行
            </button>
            <button 
              onclick="window.location.href='/'"
              class="px-6 py-3 bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition-colors font-semibold touch-manipulation"
            >
              <i class="fas fa-plus mr-2"></i>新規プロジェクト作成
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
  
  formatSection.classList.remove('hidden');
}

// Reset project from failed state
async function resetProject() {
  if (isProcessing) {
    showToast('処理中です。しばらくお待ちください', 'warning');
    return;
  }
  
  isProcessing = true;
  
  try {
    const response = await axios.post(`${API_BASE}/projects/${PROJECT_ID}/reset`);
    
    if (response.data.success) {
      showToast(`プロジェクトをリセットしました（${response.data.reset_to}）`, 'success');
      await loadProject(); // Reload project
      
      // Format section を元に戻す（2モード対応）
      const formatSection = document.getElementById('formatSection');
      formatSection.innerHTML = renderFormatSectionUI();
      formatSection.classList.remove('hidden');
    } else {
      showToast(response.data.error?.message || 'リセットに失敗しました', 'error');
    }
  } catch (error) {
    console.error('Reset project error:', error);
    showToast('リセット中にエラーが発生しました', 'error');
  } finally {
    isProcessing = false;
  }
}

/**
 * Phase F-6: Bind Auto-Assign button in Builder tab
 * Separate from WorldCharacterUI.init() to ensure button works in Builder
 */
function bindBuilderAutoAssignButton() {
  const rerunBtn = document.getElementById('btnAutoAssignRerun');
  if (!rerunBtn) {
    console.log('[Builder] Auto-Assign button not found');
    return;
  }
  
  // Prevent double binding
  if (rerunBtn.dataset.bound === 'true') {
    console.log('[Builder] Auto-Assign button already bound');
    return;
  }
  
  rerunBtn.onclick = async function() {
    const projectId = window.PROJECT_ID;
    if (!projectId) {
      showToast('PROJECT_ID が取得できません', 'error');
      return;
    }
    
    // Confirm before running
    const confirmed = confirm(
      '全シーンのキャラクター割当を再計算します。\n' +
      '既存の手動割当は上書きされます。\n\n' +
      'この操作は取り消せません。実行しますか？'
    );
    if (!confirmed) return;
    
    // Disable button during processing
    rerunBtn.disabled = true;
    rerunBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>処理中...';
    
    try {
      console.log('[Builder] Starting auto-assign for project:', projectId);
      
      const response = await axios.post(`${API_BASE}/projects/${projectId}/characters/auto-assign`);
      const result = response.data;
      
      // Normalize response format
      const assigned = result.assigned || result.assignedCount || 0;
      const scenes = result.scenes || result.totalScenes || 0;
      const skipped = result.skipped || result.skippedCount || 0;
      
      showToast(`割当完了: ${assigned}件 / ${scenes}シーン (スキップ: ${skipped}件)`, 'success');
      console.log('[Builder] Auto-assign result:', result);
      
      // Refresh scenes to show updated character assignments
      await initBuilderTab();
      
    } catch (e) {
      console.error('[Builder] Auto-assign error:', e);
      showToast(`割当失敗: ${e.response?.data?.error?.message || e.message}`, 'error');
    } finally {
      // Re-enable button
      rerunBtn.disabled = false;
      rerunBtn.innerHTML = '<i class="fas fa-sync-alt mr-2"></i>Auto-Assign 実行';
    }
  };
  
  rerunBtn.dataset.bound = 'true';
  console.log('[Builder] Auto-Assign button bound successfully');
}

// Phase F-6: Toggle voice source (character voice vs scene setting)
window.toggleVoiceSource = function(sceneId, source) {
  const sceneSettings = document.getElementById(`sceneVoiceSettings-${sceneId}`);
  const charSettings = document.getElementById(`charVoiceSettings-${sceneId}`);
  const charLabel = document.getElementById(`voiceSourceChar-${sceneId}`);
  const sceneLabel = document.getElementById(`voiceSourceScene-${sceneId}`);
  
  if (source === 'character') {
    // Show character voice button, hide scene settings
    if (sceneSettings) sceneSettings.classList.add('hidden');
    if (charSettings) charSettings.classList.remove('hidden');
    if (charLabel) {
      charLabel.classList.add('border-green-400', 'bg-green-100');
      charLabel.classList.remove('border-green-300', 'bg-green-50');
    }
    if (sceneLabel) {
      sceneLabel.classList.remove('border-blue-400', 'bg-blue-100');
      sceneLabel.classList.add('border-blue-300', 'bg-blue-50');
    }
  } else {
    // Show scene settings, hide character voice button
    if (sceneSettings) sceneSettings.classList.remove('hidden');
    if (charSettings) charSettings.classList.add('hidden');
    if (charLabel) {
      charLabel.classList.remove('border-green-400', 'bg-green-100');
      charLabel.classList.add('border-green-300', 'bg-green-50');
    }
    if (sceneLabel) {
      sceneLabel.classList.add('border-blue-400', 'bg-blue-100');
      sceneLabel.classList.remove('border-blue-300', 'bg-blue-50');
    }
  }
};

// Phase F-6: Generate audio using character's voice preset
window.generateCharacterVoice = async function(sceneId) {
  // Block if bulk generation is running
  if (window.isBulkImageGenerating) {
    showToast('一括生成中です。完了後に音声を生成できます。', 'warning');
    return;
  }
  
  // Get the scene's voice character info from cached scenes
  const scene = window.lastLoadedScenes?.find(s => s.id === sceneId);
  const voiceChar = scene?.voice_character;
  
  if (!voiceChar || !voiceChar.voice_preset_id) {
    showToast('キャラクターに音声が設定されていません', 'error');
    return;
  }
  
  const voicePresetId = voiceChar.voice_preset_id;
  const provider = voicePresetId.startsWith('fish:') ? 'fish' : 'google';
  
  // F-6: Fish Audio warning removed - ユーザーの判断に委ねる
  
  const btn = document.getElementById(`charAudioBtn-${sceneId}`);
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>生成中...';
  }
  
  try {
    // Call audio generation API with character's voice preset
    const response = await axios.post(`${API_BASE}/scenes/${sceneId}/generate-audio`, {
      voice_preset_id: voicePresetId,
      provider: provider
    });
    
    showToast('音声生成を開始しました', 'success');
    
    // Start polling for completion
    if (window.AudioState) {
      window.AudioState.startWatch(sceneId);
      window.AudioState.startPolling(sceneId);
    }
    
    // Update button to show generating state
    if (btn) {
      btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>生成中...';
    }
  } catch (error) {
    console.error('[CharacterVoice] Generation error:', error);
    showToast('音声生成に失敗しました: ' + (error.response?.data?.message || error.message), 'error');
    
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-volume-up mr-2"></i>キャラ音声で生成';
    }
  }
};

// Phase F-7: Select character voice from dropdown
window.selectCharacterVoice = function(sceneId, characterKey) {
  console.log(`[Audio] Selected character ${characterKey} for scene ${sceneId}`);
  // キャラクター選択時の処理（音声プレビューなど今後拡張可能）
};

// Phase F-7: Generate audio using selected character's voice
window.generateSelectedCharVoice = async function(sceneId) {
  const select = document.getElementById(`charVoiceSelect-${sceneId}`);
  if (!select || !select.value) {
    showToast('キャラクターを選択してください', 'warning');
    return;
  }
  
  const charKey = select.value;
  const option = select.querySelector(`option[value="${charKey}"]`);
  const voicePresetId = option?.dataset.voice;
  
  if (!voicePresetId) {
    showToast('選択したキャラクターに音声が設定されていません。Styles > Characters で設定してください。', 'error');
    return;
  }
  
  const provider = voicePresetId.startsWith('fish:') ? 'fish' : 'google';
  
  // Fish Audio warning removed - ユーザーの判断に委ねる
  
  const btn = select.nextElementSibling;
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
  }
  
  try {
    await axios.post(`${API_BASE}/scenes/${sceneId}/generate-audio`, {
      voice_preset_id: voicePresetId,
      provider: provider
    });
    
    showToast('音声生成を開始しました', 'success');
    
    if (window.AudioState) {
      window.AudioState.startWatch(sceneId);
      window.AudioState.startPolling(sceneId);
    }
  } catch (error) {
    console.error('[CharacterVoice] Generation error:', error);
    showToast('音声生成に失敗しました: ' + (error.response?.data?.message || error.message), 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-volume-up"></i>';
    }
  }
};

// Phase F-7: Generate audio using narrator voice preset
window.generateNarratorVoice = async function(sceneId) {
  const select = document.getElementById(`voicePreset-${sceneId}`);
  if (!select || !select.value) {
    showToast('音声タイプを選択してください', 'warning');
    return;
  }
  
  const voicePresetId = select.value;
  const provider = 'google'; // インライン定義のプリセットはすべてGoogle
  
  const btn = select.nextElementSibling;
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
  }
  
  try {
    await axios.post(`${API_BASE}/scenes/${sceneId}/generate-audio`, {
      voice_preset_id: voicePresetId,
      provider: provider
    });
    
    showToast('音声生成を開始しました', 'success');
    
    if (window.AudioState) {
      window.AudioState.startWatch(sceneId);
      window.AudioState.startPolling(sceneId);
    }
  } catch (error) {
    console.error('[NarratorVoice] Generation error:', error);
    showToast('音声生成に失敗しました: ' + (error.response?.data?.message || error.message), 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-volume-up"></i>';
    }
  }
};

// Phase1.7: 漫画発話用の音声ポーリングタイマー
window.comicUtteranceAudioPolling = {};

// Phase1.7: 漫画発話用の音声生成
window.generateComicUtteranceVoice = async function(sceneId, utteranceIdx) {
  const btn = document.getElementById(`comicUtteranceVoiceBtn-${sceneId}-${utteranceIdx}`);
  const previewContainer = document.getElementById(`comicUtteranceAudioPreview-${sceneId}-${utteranceIdx}`);
  
  try {
    // シーンデータを取得
    const response = await axios.get(`${API_BASE}/scenes/${sceneId}?view=board`);
    const scene = response.data;
    const comicData = scene.comic_data;
    const utterances = comicData?.published?.utterances || comicData?.draft?.utterances || [];
    
    if (!utterances[utteranceIdx]) {
      showToast('発話が見つかりません', 'error');
      return;
    }
    
    const utterance = utterances[utteranceIdx];
    const text = utterance.text || '';
    
    if (!text.trim()) {
      showToast('発話テキストが空です', 'warning');
      return;
    }
    
    // 音声設定を取得
    const select = document.getElementById(`comicUtteranceVoice-${sceneId}-${utteranceIdx}`);
    let voicePresetId = select?.value || 'ja-JP-Neural2-B';
    let provider = 'google';
    
    // キャラクターが選択されている場合、そのキャラの音声を使用
    if (select?.value && !select.value.startsWith('ja-JP-')) {
      const charKey = select.value;
      const projectCharacters = window.lastLoadedCharacters || [];
      const char = projectCharacters.find(c => c.character_key === charKey);
      if (char?.voice_preset_id) {
        voicePresetId = char.voice_preset_id;
        provider = voicePresetId.startsWith('fish:') ? 'fish' : 'google';
      } else {
        showToast('選択したキャラクターに音声が設定されていません', 'warning');
        return;
      }
    }
    
    // ボタンを「生成中」状態に
    if (btn) {
      btn.disabled = true;
      btn.classList.remove('bg-purple-600', 'hover:bg-purple-700');
      btn.classList.add('bg-yellow-500');
      btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
    }
    
    showToast(`発話${utteranceIdx + 1}の音声生成を開始...`, 'info');
    
    // 音声生成API呼び出し（テキストを指定して生成）
    const genResponse = await axios.post(`${API_BASE}/scenes/${sceneId}/generate-audio`, {
      voice_preset_id: voicePresetId,
      provider: provider,
      text_override: text
    });
    
    const audioGeneration = genResponse.data.audio_generation;
    console.log('[ComicUtteranceVoice] Generation started:', audioGeneration);
    
    // ポーリング開始（この発話専用）
    const pollingKey = `${sceneId}-${utteranceIdx}`;
    if (window.comicUtteranceAudioPolling[pollingKey]) {
      clearInterval(window.comicUtteranceAudioPolling[pollingKey]);
    }
    
    window.comicUtteranceAudioPolling[pollingKey] = setInterval(async () => {
      try {
        const statusResponse = await axios.get(`${API_BASE}/scenes/${sceneId}/audio`);
        const latestAudio = statusResponse.data.audio_generations?.[0];
        
        if (!latestAudio) return;
        
        if (latestAudio.status === 'completed' && latestAudio.r2_url) {
          // ポーリング停止
          clearInterval(window.comicUtteranceAudioPolling[pollingKey]);
          delete window.comicUtteranceAudioPolling[pollingKey];
          
          // ボタンを「完了」状態に
          if (btn) {
            btn.disabled = false;
            btn.classList.remove('bg-yellow-500');
            btn.classList.add('bg-green-600', 'hover:bg-green-700');
            btn.innerHTML = '<i class="fas fa-redo"></i>';
            btn.title = '再生成';
          }
          
          // 音声プレビューを表示
          if (previewContainer) {
            previewContainer.innerHTML = `
              <audio controls class="w-full h-8" style="border-radius: 8px;">
                <source src="${latestAudio.r2_url}" type="audio/mpeg">
              </audio>
            `;
            previewContainer.classList.remove('hidden');
          }
          
          showToast(`発話${utteranceIdx + 1}の音声生成完了！`, 'success');
          
        } else if (latestAudio.status === 'failed') {
          // ポーリング停止
          clearInterval(window.comicUtteranceAudioPolling[pollingKey]);
          delete window.comicUtteranceAudioPolling[pollingKey];
          
          // ボタンを「エラー」状態に
          if (btn) {
            btn.disabled = false;
            btn.classList.remove('bg-yellow-500');
            btn.classList.add('bg-red-600', 'hover:bg-red-700');
            btn.innerHTML = '<i class="fas fa-exclamation-triangle"></i>';
            btn.title = '再試行';
          }
          
          showToast(`発話${utteranceIdx + 1}の音声生成に失敗しました`, 'error');
        }
      } catch (pollError) {
        console.error('[ComicUtteranceVoice] Polling error:', pollError);
      }
    }, 2000); // 2秒ごとにポーリング
    
  } catch (error) {
    console.error('[ComicUtteranceVoice] Generation error:', error);
    showToast('音声生成に失敗しました: ' + (error.response?.data?.error?.message || error.message), 'error');
    
    // ボタンをエラー状態に
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('bg-yellow-500');
      btn.classList.add('bg-red-600', 'hover:bg-red-700');
      btn.innerHTML = '<i class="fas fa-exclamation-triangle"></i>';
    }
  }
};

// Phase1.7: 漫画発話の音声を一括生成
window.generateAllComicUtteranceVoices = async function(sceneId) {
  try {
    const response = await axios.get(`${API_BASE}/scenes/${sceneId}?view=board`);
    const scene = response.data;
    const comicData = scene.comic_data;
    const utterances = comicData?.published?.utterances || comicData?.draft?.utterances || [];
    
    if (utterances.length === 0) {
      showToast('発話がありません', 'warning');
      return;
    }
    
    showToast(`${utterances.length}件の発話音声を順次生成します...`, 'info');
    
    for (let i = 0; i < utterances.length; i++) {
      await window.generateComicUtteranceVoice(sceneId, i);
      // 連続生成の間隔を空ける（次の生成開始前に1秒待機）
      if (i < utterances.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    showToast('全発話の音声生成を開始しました。順次完了します。', 'success');
  } catch (error) {
    console.error('[AllComicUtteranceVoices] Error:', error);
    showToast('一括生成に失敗しました', 'error');
  }
};

// Phase1.7: 漫画発話の音声タイプ選択
window.selectComicUtteranceVoice = function(sceneId, utteranceIdx, value) {
  console.log(`[ComicUtteranceVoice] Selected: scene=${sceneId}, idx=${utteranceIdx}, value=${value}`);
};

// Load scenes (Scene Split tab)
// Uses view=board to include character information
// Exposed to window for cross-module access (e.g., WorldCharacterModal)
window.loadScenes = async function loadScenes() {
  try {
    const response = await axios.get(`${API_BASE}/projects/${PROJECT_ID}/scenes?view=board`);
    const scenes = response.data.scenes || [];
    
    document.getElementById('scenesCount').textContent = scenes.length;
    
    if (scenes.length === 0) {
      document.getElementById('scenesSection').classList.add('hidden');
      document.getElementById('scenesEmptyState').classList.remove('hidden');
      return;
    }
    
    document.getElementById('scenesSection').classList.remove('hidden');
    document.getElementById('scenesEmptyState').classList.add('hidden');
    document.getElementById('formatSection').classList.add('hidden');
    
    // Only show Builder button when format is completed (formatted status or later)
    const builderAllowedStatuses = ['formatted', 'generating_images', 'completed'];
    const goToBuilderBtn = document.getElementById('goToBuilderBtn');
    if (goToBuilderBtn) {
      if (builderAllowedStatuses.includes(currentProject?.status)) {
        goToBuilderBtn.classList.remove('hidden');
      } else {
        goToBuilderBtn.classList.add('hidden');
      }
    }
    
    renderScenes(scenes);
  } catch (error) {
    console.error('Load scenes error:', error);
    showToast('シーンの読み込みに失敗しました', 'error');
  }
}

// Render scenes table
function renderScenes(scenes) {
  const container = document.getElementById('scenesList');
  
  container.innerHTML = scenes.map((scene, index) => {
    // Phase F-5: Render character assignment display
    const imageChars = Array.isArray(scene.characters) ? scene.characters : [];
    const voiceChar = scene.voice_character || null;
    const hasChars = imageChars.length > 0 || voiceChar;
    
    const charDisplay = hasChars ? `
      <div class="mt-4 p-3 bg-gray-50 rounded-lg border border-gray-200">
        <div class="flex items-center justify-between mb-3">
          <span class="text-sm font-semibold text-gray-700">
            <i class="fas fa-users mr-1 text-indigo-600"></i>キャラクター割り当て
          </span>
          <button 
            onclick="openSceneCharacterEdit(${scene.id})"
            class="text-xs px-2 py-1 bg-indigo-100 text-indigo-700 rounded hover:bg-indigo-200 transition-colors"
          >
            <i class="fas fa-edit mr-1"></i>編集
          </button>
        </div>
        ${imageChars.length > 0 ? `
          <div class="mb-2">
            <span class="text-xs text-gray-500 font-semibold block mb-1">
              <i class="fas fa-image mr-1 text-blue-500"></i>画像キャラ（画像生成用）
            </span>
            <div class="flex flex-wrap gap-2">
              ${imageChars.slice(0, 3).map(c => `
                <span class="inline-flex items-center px-2 py-1 rounded-full bg-blue-50 text-blue-700 text-xs border border-blue-200">
                  <i class="fas fa-image mr-1"></i>${escapeHtml(c.character_name || c.character_key)}
                </span>
              `).join('')}
            </div>
          </div>
        ` : ''}
        <div>
          <span class="text-xs text-gray-500 font-semibold block mb-1">
            <i class="fas fa-microphone mr-1 text-green-500"></i>音声キャラ（セリフ用）
          </span>
          <div class="flex flex-wrap gap-2">
            ${voiceChar ? `
              <span class="inline-flex items-center px-2 py-1 rounded-full bg-green-50 text-green-700 text-xs border border-green-200">
                <i class="fas fa-microphone mr-1"></i>${escapeHtml(voiceChar.character_name || voiceChar.character_key)}
              </span>
            ` : `
              <span class="inline-flex items-center px-2 py-1 rounded-full bg-gray-100 text-gray-500 text-xs border border-gray-200">
                <i class="fas fa-user-slash mr-1"></i>ナレーター（キャラなし）
              </span>
            `}
          </div>
        </div>
        ${imageChars.length > 0 ? `
          <!-- キャラクター特徴表示（A/B/C層） -->
          <div class="mt-3 pt-3 border-t border-gray-200">
            <div class="flex items-center justify-between mb-2">
              <span class="text-xs font-semibold text-gray-600">
                <i class="fas fa-user-tag mr-1 text-purple-500"></i>適用される特徴
              </span>
              <span class="text-xs text-gray-400">優先度: C > B > A</span>
            </div>
            <div class="space-y-2">
              ${imageChars.map(c => {
                const hasC = c.scene_trait && c.scene_trait.trim();
                const hasB = c.story_traits && c.story_traits.trim();
                const hasA = c.appearance_description && c.appearance_description.trim();
                const activeTrait = hasC ? c.scene_trait : (hasB ? c.story_traits : (hasA ? c.appearance_description : null));
                const activeLayer = hasC ? 'C' : (hasB ? 'B' : (hasA ? 'A' : null));
                const layerColors = { 'C': 'bg-yellow-100 text-yellow-800 border-yellow-300', 'B': 'bg-purple-100 text-purple-800 border-purple-300', 'A': 'bg-gray-100 text-gray-600 border-gray-300' };
                const layerBadge = activeLayer ? '<span class="px-1 py-0.5 text-xs rounded border ' + layerColors[activeLayer] + '">' + activeLayer + '</span>' : '';
                return '<div class="text-xs bg-gray-50 rounded p-2 border border-gray-100">' +
                  '<div class="flex items-center gap-1 mb-1">' +
                    layerBadge +
                    '<span class="font-medium text-gray-700">' + escapeHtml(c.character_name || c.character_key) + '</span>' +
                  '</div>' +
                  '<div class="text-gray-600 truncate" title="' + (activeTrait ? escapeHtml(activeTrait) : '特徴未設定') + '">' +
                    (activeTrait ? escapeHtml(activeTrait.substring(0, 50)) + (activeTrait.length > 50 ? '...' : '') : '<span class="text-gray-400 italic">特徴未設定</span>') +
                  '</div>' +
                '</div>';
              }).join('')}
            </div>
          </div>
          <div class="mt-2 pt-2 border-t border-gray-200">
            <button 
              onclick="openAddSceneTraitOverride(${scene.id}, ${scene.idx})"
              class="text-xs px-3 py-1.5 bg-yellow-100 text-yellow-700 rounded-lg hover:bg-yellow-200 transition-colors border border-yellow-200"
              title="変身・衣装変更・状態変化など、このシーンでのみ異なる描写が必要な場合に設定"
            >
              <i class="fas fa-magic mr-1"></i>シーン別の特徴変化を設定
            </button>
            <span class="ml-2 text-xs text-gray-400">変身・衣装変更・状態変化など</span>
          </div>
        ` : ''}
      </div>
    ` : `
      <div class="mt-4 p-3 bg-gray-50 rounded-lg border border-gray-200">
        <div class="flex items-center justify-between">
          <span class="text-sm text-gray-500">
            <i class="fas fa-user-slash mr-1"></i>キャラ未割当
          </span>
          <button 
            onclick="openSceneCharacterEdit(${scene.id})"
            class="text-xs px-2 py-1 bg-indigo-100 text-indigo-700 rounded hover:bg-indigo-200 transition-colors"
          >
            <i class="fas fa-plus mr-1"></i>割り当て
          </button>
        </div>
      </div>
    `;
    
    return `
    <div class="bg-white rounded-lg border-2 border-gray-200 p-6" id="scene-${scene.id}">
      <div class="flex items-center justify-between mb-4">
        <div class="flex items-center gap-4">
          <span class="text-2xl font-bold text-gray-400">#${scene.idx}</span>
          <select 
            id="role-${scene.id}"
            class="px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
          >
            <option value="hook" ${scene.role === 'hook' ? 'selected' : ''}>導入・つかみ</option>
            <option value="context" ${scene.role === 'context' ? 'selected' : ''}>背景・文脈</option>
            <option value="main_point" ${scene.role === 'main_point' ? 'selected' : ''}>主要ポイント</option>
            <option value="evidence" ${scene.role === 'evidence' ? 'selected' : ''}>根拠・証拠</option>
            <option value="timeline" ${scene.role === 'timeline' ? 'selected' : ''}>時系列</option>
            <option value="analysis" ${scene.role === 'analysis' ? 'selected' : ''}>分析・考察</option>
            <option value="summary" ${scene.role === 'summary' ? 'selected' : ''}>まとめ</option>
            <option value="cta" ${scene.role === 'cta' ? 'selected' : ''}>行動喚起</option>
          </select>
        </div>
        <div class="flex gap-2">
          ${index > 0 ? `<button onclick="moveSceneUp(${scene.id}, ${scene.idx})" class="px-3 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors touch-manipulation" title="上に移動"><i class="fas fa-arrow-up"></i></button>` : ''}
          ${index < scenes.length - 1 ? `<button onclick="moveSceneDown(${scene.id}, ${scene.idx})" class="px-3 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors touch-manipulation" title="下に移動"><i class="fas fa-arrow-down"></i></button>` : ''}
          <button 
            id="saveBtn-${scene.id}"
            onclick="saveScene(${scene.id})"
            class="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors touch-manipulation"
          >
            <i class="fas fa-save mr-1"></i>保存
          </button>
          <button 
            id="hideBtn-${scene.id}"
            onclick="hideScene(${scene.id})"
            class="px-4 py-2 bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition-colors touch-manipulation"
            title="シーンを非表示にします。関連データ（画像・音声等）は保持され、後から復元できます。"
          >
            <i class="fas fa-eye-slash mr-1"></i>非表示
          </button>
          <button 
            id="duplicateBtn-${scene.id}"
            onclick="duplicateScene(${scene.id})"
            class="px-4 py-2 bg-indigo-500 text-white rounded-lg hover:bg-indigo-600 transition-colors touch-manipulation"
            title="このシーンのテキスト情報をコピーして新しいシーンを作成します"
          >
            <i class="fas fa-copy mr-1"></i>コピー
          </button>
        </div>
      </div>
      
      <div class="grid grid-cols-1 gap-4">
        <div>
          <label class="block text-sm font-semibold text-gray-700 mb-2">タイトル</label>
          <input 
            type="text"
            id="title-${scene.id}"
            value="${escapeHtml(scene.title)}"
            class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
          />
        </div>
        
        <div>
          <label class="block text-sm font-semibold text-gray-700 mb-2">セリフ</label>
          <textarea 
            id="dialogue-${scene.id}"
            rows="4"
            class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
          >${escapeHtml(scene.dialogue)}</textarea>
        </div>
        
        <div>
          <label class="block text-sm font-semibold text-gray-700 mb-1">
            要点（1行1項目）
            <span class="text-xs font-normal text-gray-500">
              - 画像生成時の背景指示として使用
            </span>
          </label>
          <p class="text-xs text-blue-600 mb-2">
            <i class="fas fa-info-circle mr-1"></i>
            シーンの状況・場面設定。画像プロンプトに自動で追加されます。
          </p>
          <textarea 
            id="bullets-${scene.id}"
            rows="3"
            placeholder="森の中の出会い&#10;朝の光が差し込む&#10;静かな雰囲気"
            class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
          >${scene.bullets.join('\n')}</textarea>
        </div>
        
        <div>
          <label class="block text-sm font-semibold text-gray-700 mb-2">画像プロンプト</label>
          <p class="text-xs text-amber-600 mb-2">
            <i class="fas fa-exclamation-triangle mr-1"></i>
            ※画像内のテキストを日本語にしたい場合は、プロンプトに「文字は日本語で」と追記してください
          </p>
          <textarea 
            id="imagePrompt-${scene.id}"
            rows="3"
            placeholder="例: A beautiful forest scene. 文字は日本語で。"
            class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
          >${escapeHtml(scene.image_prompt)}</textarea>
        </div>
        
        ${charDisplay}
      </div>
    </div>
  `}).join('');
}

/**
 * Phase X-6: Open unified scene edit modal with character assignment + traits tabs
 * Replaces WorldCharacterModal.openAssign with SceneEditModal
 */
async function openSceneCharacterEdit(sceneId) {
  // Use unified SceneEditModal (Phase X-6)
  if (window.SceneEditModal && typeof window.SceneEditModal.open === 'function') {
    // P3-5: Pass source='builder' for SSOT control
    await window.SceneEditModal.open(sceneId, { source: 'builder' });
    // Default to characters tab
    if (window.SceneEditModal.switchTab) {
      window.SceneEditModal.switchTab('characters');
    }
  } else {
    // Fallback to old WorldCharacterModal if SceneEditModal not loaded
    console.warn('[openSceneCharacterEdit] SceneEditModal not loaded, trying fallback');
    if (window.WorldCharacterModal && typeof window.WorldCharacterModal.openAssign === 'function') {
      window.WorldCharacterModal.openAssign(sceneId);
    } else {
      showToast('モーダルの読み込みに失敗しました。ページを再読み込みしてください。', 'error');
    }
  }
}

// Save scene (行単位ロック)
async function saveScene(sceneId) {
  // 行単位チェック
  if (window.sceneProcessing[sceneId]) {
    showToast('このシーンは処理中です', 'warning');
    return;
  }
  
  window.sceneProcessing[sceneId] = true;
  setButtonLoading(`saveBtn-${sceneId}`, true);
  
  try {
    const title = document.getElementById(`title-${sceneId}`).value.trim();
    const role = document.getElementById(`role-${sceneId}`).value;
    const dialogue = document.getElementById(`dialogue-${sceneId}`).value.trim();
    const bulletsText = document.getElementById(`bullets-${sceneId}`).value.trim();
    const bullets = bulletsText.split('\n').filter(b => b.trim()).map(b => b.trim());
    const imagePrompt = document.getElementById(`imagePrompt-${sceneId}`).value.trim();
    
    const response = await axios.put(`${API_BASE}/scenes/${sceneId}`, {
      title,
      role,
      dialogue,
      bullets,
      image_prompt: imagePrompt
    });
    
    if (response.data.id) {
      showToast('シーンを保存しました', 'success');
      // キャッシュクリア（編集内容を反映）
      window.sceneSplitInitialized = false;
    } else {
      showToast('シーンの保存に失敗しました', 'error');
    }
  } catch (error) {
    console.error('Save scene error:', error);
    showToast('シーン保存中にエラーが発生しました', 'error');
  } finally {
    window.sceneProcessing[sceneId] = false;
    setButtonLoading(`saveBtn-${sceneId}`, false);
  }
}

// Hide scene (ソフトデリート - 行単位ロック)
// ⚠️ シーンは完全削除されず、非表示になるだけ
// 関連データ（画像、音声、動画等）はすべて保持される
async function hideScene(sceneId) {
  const confirmed = confirm(
    'このシーンを非表示にしますか？\n\n' +
    '・シーンは動画ビルドや一覧から除外されます\n' +
    '・画像・音声・動画などの関連データは保持されます\n' +
    '・後から復元することができます'
  );
  
  if (!confirmed) {
    return;
  }
  
  // 行単位チェック
  if (window.sceneProcessing[sceneId]) {
    showToast('このシーンは処理中です', 'warning');
    return;
  }
  
  window.sceneProcessing[sceneId] = true;
  setButtonLoading(`hideBtn-${sceneId}`, true);
  
  try {
    // DELETE エンドポイントがソフトデリート（非表示）に変更済み
    const response = await axios.delete(`${API_BASE}/scenes/${sceneId}`);
    
    if (response.data.success) {
      showToast('シーンを非表示にしました', 'success');
      // キャッシュクリア（非表示を反映）
      window.sceneSplitInitialized = false;
      await loadScenes(); // Reload scenes (idx will be re-numbered)
      // カウント更新（非表示タブのカウント同期）
      if (typeof window.updateSceneCountsAfterHide === 'function') {
        await window.updateSceneCountsAfterHide();
      }
    } else {
      showToast('シーンの非表示に失敗しました', 'error');
    }
  } catch (error) {
    console.error('Hide scene error:', error);
    const errorMsg = error.response?.data?.error?.message || 'シーン非表示中にエラーが発生しました';
    showToast(errorMsg, 'error');
  } finally {
    window.sceneProcessing[sceneId] = false;
    setButtonLoading(`hideBtn-${sceneId}`, false);
  }
}

// 後方互換性のため deleteScene も維持（hideScene を呼ぶ）
async function deleteScene(sceneId) {
  return hideScene(sceneId);
}

// ========================================
// シーン追加機能（Scene Split用）
// ========================================

// 現在のタブ状態
let addSceneCurrentTab = 'new';
// コピー元シーンのキャッシュ
let addSceneScenesCache = [];

// タブ切り替え
function switchAddSceneTab(tab) {
  addSceneCurrentTab = tab;
  
  // タブボタンのスタイル
  const newTab = document.getElementById('addSceneTab-new');
  const copyTab = document.getElementById('addSceneTab-copy');
  const newPanel = document.getElementById('addScenePanel-new');
  const copyPanel = document.getElementById('addScenePanel-copy');
  const confirmBtn = document.getElementById('addSceneConfirmBtn');
  
  if (tab === 'new') {
    newTab.className = 'flex-1 px-4 py-3 text-sm font-semibold text-center border-b-2 border-green-600 text-green-700 bg-green-50 transition-colors';
    copyTab.className = 'flex-1 px-4 py-3 text-sm font-semibold text-center border-b-2 border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50 transition-colors';
    newPanel.classList.remove('hidden');
    copyPanel.classList.add('hidden');
    if (confirmBtn) {
      confirmBtn.innerHTML = '<i class="fas fa-plus"></i>追加';
      confirmBtn.className = 'px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-semibold inline-flex items-center gap-2';
    }
  } else {
    newTab.className = 'flex-1 px-4 py-3 text-sm font-semibold text-center border-b-2 border-transparent text-gray-500 hover:text-gray-700 hover:bg-gray-50 transition-colors';
    copyTab.className = 'flex-1 px-4 py-3 text-sm font-semibold text-center border-b-2 border-indigo-600 text-indigo-700 bg-indigo-50 transition-colors';
    newPanel.classList.add('hidden');
    copyPanel.classList.remove('hidden');
    if (confirmBtn) {
      confirmBtn.innerHTML = '<i class="fas fa-copy"></i>コピーして追加';
      confirmBtn.className = 'px-6 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors font-semibold inline-flex items-center gap-2';
    }
    // コピー元リストを更新
    updateCopySceneSourceOptions();
  }
}

// コピー元シーンリストを更新
async function updateCopySceneSourceOptions() {
  const sourceSelect = document.getElementById('copySceneSource');
  const positionSelect = document.getElementById('copyScenePosition');
  if (!sourceSelect) return;
  
  try {
    const response = await axios.get(`${API_BASE}/projects/${PROJECT_ID}/scenes`);
    const scenes = response.data.scenes || [];
    addSceneScenesCache = scenes;
    
    // コピー元
    let sourceOptions = '<option value="">-- コピー元シーンを選択 --</option>';
    scenes.forEach((scene) => {
      const titlePreview = scene.title ? scene.title.substring(0, 25) : '(無題)';
      const dialoguePreview = scene.dialogue ? scene.dialogue.substring(0, 30).replace(/\n/g, ' ') : '';
      sourceOptions += `<option value="${scene.id}">#${scene.idx} ${escapeHtml(titlePreview)}${dialoguePreview ? ' - ' + escapeHtml(dialoguePreview) + '...' : ''}</option>`;
    });
    sourceSelect.innerHTML = sourceOptions;
    
    // 挿入位置
    if (positionSelect) {
      let posOptions = '<option value="end">最後に追加</option>';
      scenes.forEach((scene) => {
        posOptions += `<option value="${scene.idx}">シーン #${scene.idx}「${escapeHtml(scene.title.substring(0, 20))}」の後</option>`;
      });
      positionSelect.innerHTML = posOptions;
    }
  } catch (error) {
    console.error('Error loading scenes for copy:', error);
  }
}

// コピー元プレビュー表示
function onCopySceneSourceChange() {
  const sourceSelect = document.getElementById('copySceneSource');
  const previewBox = document.getElementById('copyScenePreview');
  const previewContent = document.getElementById('copyScenePreviewContent');
  if (!sourceSelect || !previewBox || !previewContent) return;
  
  const sceneId = parseInt(sourceSelect.value, 10);
  const scene = addSceneScenesCache.find(s => s.id === sceneId);
  
  if (!scene) {
    previewBox.classList.add('hidden');
    return;
  }
  
  previewBox.classList.remove('hidden');
  previewContent.innerHTML = `
    <div class="space-y-2">
      <div><span class="font-semibold text-gray-600">タイトル:</span> ${escapeHtml(scene.title || '(なし)')}</div>
      <div><span class="font-semibold text-gray-600">セリフ:</span> <span class="text-gray-500">${escapeHtml((scene.dialogue || '(なし)').substring(0, 100))}${(scene.dialogue || '').length > 100 ? '...' : ''}</span></div>
      ${scene.image_prompt ? `<div><span class="font-semibold text-gray-600">画像プロンプト:</span> <span class="text-xs text-gray-400">${escapeHtml(scene.image_prompt.substring(0, 80))}...</span></div>` : ''}
    </div>
  `;
}

// シーン追加モーダルを表示
function showAddSceneModal() {
  const modal = document.getElementById('addSceneModalSplit');
  if (!modal) return;
  
  // 挿入位置オプションを更新
  updateAddScenePositionOptions();
  
  // フォームリセット
  const titleInput = document.getElementById('addSceneTitle');
  const dialogueInput = document.getElementById('addSceneDialogue');
  if (titleInput) titleInput.value = '';
  if (dialogueInput) dialogueInput.value = '';
  
  // 「新規作成」タブに切り替え
  switchAddSceneTab('new');
  
  // コピー元プレビューを隠す
  const previewBox = document.getElementById('copyScenePreview');
  if (previewBox) previewBox.classList.add('hidden');
  
  // コピー元セレクトのchangeイベント
  const sourceSelect = document.getElementById('copySceneSource');
  if (sourceSelect) {
    sourceSelect.removeEventListener('change', onCopySceneSourceChange);
    sourceSelect.addEventListener('change', onCopySceneSourceChange);
  }
  
  modal.classList.remove('hidden');
}

// シーン追加モーダルを閉じる
function closeAddSceneModal() {
  const modal = document.getElementById('addSceneModalSplit');
  if (modal) modal.classList.add('hidden');
}

// 挿入位置オプションを更新
async function updateAddScenePositionOptions() {
  const select = document.getElementById('addScenePosition');
  if (!select) return;
  
  try {
    const response = await axios.get(`${API_BASE}/projects/${PROJECT_ID}/scenes`);
    const scenes = response.data.scenes || [];
    
    let options = '<option value="end">最後に追加</option>';
    scenes.forEach((scene) => {
      options += `<option value="${scene.idx}">シーン ${scene.idx}「${escapeHtml(scene.title.substring(0, 20))}」の後</option>`;
    });
    
    select.innerHTML = options;
  } catch (error) {
    console.error('Error loading scenes for position options:', error);
  }
}

// シーン追加を実行（新規 or コピー）
async function confirmAddScene() {
  // コピータブの場合
  if (addSceneCurrentTab === 'copy') {
    return confirmCopyScene();
  }
  
  // 新規作成
  const positionSelect = document.getElementById('addScenePosition');
  const titleInput = document.getElementById('addSceneTitle');
  const dialogueInput = document.getElementById('addSceneDialogue');
  
  const position = positionSelect?.value;
  const title = titleInput?.value?.trim() || '';
  const dialogue = dialogueInput?.value?.trim() || '';
  
  try {
    const payload = {
      project_id: PROJECT_ID,
      title: title || undefined,
      dialogue: dialogue || undefined
    };
    
    // 末尾追加でない場合は挿入位置を指定
    if (position && position !== 'end') {
      payload.insert_after_idx = parseInt(position, 10);
    }
    
    const response = await axios.post(`${API_BASE}/scenes`, payload);
    
    if (response.data.success) {
      showToast('シーンを追加しました', 'success');
      closeAddSceneModal();
      
      // シーンリストを再読込
      window.sceneSplitInitialized = false;
      await loadScenes();
    } else {
      showToast('シーンの追加に失敗しました', 'error');
    }
  } catch (error) {
    console.error('Error adding scene:', error);
    const errorMsg = error.response?.data?.error?.message || 'シーン追加中にエラーが発生しました';
    showToast(errorMsg, 'error');
  }
}

// グローバルにエクスポート
window.showAddSceneModal = showAddSceneModal;
window.closeAddSceneModal = closeAddSceneModal;
window.confirmAddScene = confirmAddScene;
window.switchAddSceneTab = switchAddSceneTab;
window.hideScene = hideScene;
window.deleteScene = deleteScene; // 後方互換性

// コピーして追加を実行
async function confirmCopyScene() {
  const sourceSelect = document.getElementById('copySceneSource');
  const positionSelect = document.getElementById('copyScenePosition');
  const confirmBtn = document.getElementById('addSceneConfirmBtn');
  
  const sourceSceneId = sourceSelect?.value;
  if (!sourceSceneId) {
    showToast('コピー元シーンを選択してください', 'warning');
    return;
  }
  
  const position = positionSelect?.value;
  
  // ボタンを無効化
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>コピー中...';
  }
  
  try {
    // duplicate APIを呼び出し（挿入位置をオプションで渡す）
    const payload = {};
    if (position && position !== 'end') {
      payload.insert_after_idx = parseInt(position, 10);
    }
    
    const response = await axios.post(`${API_BASE}/scenes/${sourceSceneId}/duplicate`, payload);
    if (response.data.success) {
      showToast('シーンをコピーしました', 'success');
      closeAddSceneModal();
      
      // シーンリストを再読込
      window.sceneSplitInitialized = false;
      await loadScenes();
    } else {
      showToast('シーンのコピーに失敗しました', 'error');
    }
  } catch (error) {
    console.error('Error copying scene:', error);
    const errorMsg = error.response?.data?.error?.message || 'シーンコピー中にエラーが発生しました';
    showToast(errorMsg, 'error');
  } finally {
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.innerHTML = '<i class="fas fa-copy"></i>コピーして追加';
    }
  }
}

// シーンコピー（Scene Splitタブ専用）
async function duplicateScene(sceneId) {
  if (!confirm('このシーンをコピーしますか？\n\nタイトル・セリフ・要点・プロンプト・キャラクター割り当てがコピーされます。\n画像・動画・漫画はコピーされません。')) {
    return;
  }

  const btn = document.getElementById(`duplicateBtn-${sceneId}`);
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>コピー中...';
  }

  try {
    const response = await axios.post(`${API_BASE}/scenes/${sceneId}/duplicate`);
    if (response.data.success) {
      showToast('シーンをコピーしました', 'success');
      // Scene Splitを再初期化してリストを更新
      window.sceneSplitInitialized = false;
      await loadScenes();
    } else {
      showToast('シーンのコピーに失敗しました', 'error');
    }
  } catch (error) {
    console.error('Error duplicating scene:', error);
    const errorMsg = error.response?.data?.error?.message || 'シーンコピー中にエラーが発生しました';
    showToast(errorMsg, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-copy mr-1"></i>コピー';
    }
  }
}
window.duplicateScene = duplicateScene;

// Move scene up
async function moveSceneUp(sceneId, currentIdx) {
  if (currentIdx <= 1) return; // Already at top
  
  const scenesResponse = await axios.get(`${API_BASE}/projects/${PROJECT_ID}/scenes`);
  const scenes = scenesResponse.data.scenes || [];
  
  const sceneIds = scenes.map(s => s.id);
  const currentIndex = sceneIds.indexOf(sceneId);
  
  if (currentIndex > 0) {
    // Swap with previous
    [sceneIds[currentIndex], sceneIds[currentIndex - 1]] = [sceneIds[currentIndex - 1], sceneIds[currentIndex]];
    await reorderScenes(sceneIds);
  }
}

// Move scene down
async function moveSceneDown(sceneId, currentIdx) {
  const scenesResponse = await axios.get(`${API_BASE}/projects/${PROJECT_ID}/scenes`);
  const scenes = scenesResponse.data.scenes || [];
  
  const sceneIds = scenes.map(s => s.id);
  const currentIndex = sceneIds.indexOf(sceneId);
  
  if (currentIndex < sceneIds.length - 1) {
    // Swap with next
    [sceneIds[currentIndex], sceneIds[currentIndex + 1]] = [sceneIds[currentIndex + 1], sceneIds[currentIndex]];
    await reorderScenes(sceneIds);
  }
}

// Reorder scenes
async function reorderScenes(sceneIds) {
  if (isProcessing) {
    showToast('処理中です。しばらくお待ちください', 'warning');
    return;
  }
  
  isProcessing = true;
  
  try {
    const response = await axios.post(`${API_BASE}/projects/${PROJECT_ID}/scenes/reorder`, {
      scene_ids: sceneIds
    });
    
    if (response.data.success) {
      showToast('並び順を変更しました', 'success');
      // キャッシュクリア（並び替えを反映）
      window.sceneSplitInitialized = false;
      await loadScenes(); // Reload to reflect new order
    } else {
      showToast('並び替えに失敗しました', 'error');
    }
  } catch (error) {
    console.error('Reorder scenes error:', error);
    showToast('並び替え中にエラーが発生しました', 'error');
  } finally {
    isProcessing = false;
  }
}

// Go to Builder tab
function goToBuilder() {
  switchTab('builder');
}

// ========== Builder Functions ==========

// Initialize Builder tab
// Exposed to window for cross-module access (e.g., WorldCharacterModal after saving assignments)
window.initBuilderTab = async function initBuilderTab() {
  const container = document.getElementById('builderScenesList');
  
  // ローディング表示
  container.innerHTML = `
    <div class="flex items-center justify-center py-12">
      <div class="text-center">
        <i class="fas fa-spinner fa-spin text-4xl text-blue-600 mb-4"></i>
        <p class="text-gray-600">シーンを読み込み中...</p>
      </div>
    </div>
  `;
  
  try {
    // Load style presets, scenes, and characters in parallel
    // Add cache buster to force fresh data
    const cacheBuster = Date.now();
    const [scenesResponse, stylesResponse, projectStyleResponse, charactersResponse] = await Promise.all([
      axios.get(`${API_BASE}/projects/${PROJECT_ID}/scenes?view=board&_t=${cacheBuster}`),
      axios.get(`${API_BASE}/style-presets?_t=${cacheBuster}`),
      axios.get(`${API_BASE}/projects/${PROJECT_ID}/style-settings?_t=${cacheBuster}`),
      axios.get(`${API_BASE}/projects/${PROJECT_ID}/characters?_t=${cacheBuster}`)
    ]);
    
    // Phase F-7: Store characters globally for audio UI
    window.lastLoadedCharacters = charactersResponse.data.characters || [];
    console.log('[Builder] Loaded characters:', window.lastLoadedCharacters.length);
    
    const scenes = scenesResponse.data.scenes || [];
    window.builderStylePresets = stylesResponse.data.style_presets || [];
    window.builderProjectDefaultStyle = projectStyleResponse.data.default_style_preset_id || null;
    
    // Update bulk style selector
    const bulkStyleSelector = document.getElementById('bulkStyleSelector');
    if (bulkStyleSelector) {
      bulkStyleSelector.innerHTML = '<option value="">未設定（プロジェクトデフォルト）</option>' +
        window.builderStylePresets.filter(s => s.is_active).map(s => 
          `<option value="${s.id}">${escapeHtml(s.name)}</option>`
        ).join('');
      
      // Set selected style: prefer applied bulk style, then project default
      if (window.appliedBulkStyleId !== undefined && window.appliedBulkStyleId !== null) {
        bulkStyleSelector.value = window.appliedBulkStyleId;
        console.log('[Builder] Set dropdown to applied bulk style:', window.appliedBulkStyleId);
      } else if (window.builderProjectDefaultStyle) {
        bulkStyleSelector.value = window.builderProjectDefaultStyle;
      }
    }
    
    if (scenes.length === 0) {
      document.getElementById('builderScenesList').classList.add('hidden');
      document.getElementById('builderEmptyState').classList.remove('hidden');
      return;
    }
    
    document.getElementById('builderScenesList').classList.remove('hidden');
    document.getElementById('builderEmptyState').classList.add('hidden');
    
    // ステータスバー更新
    updateBuilderStatusBar(scenes);
    
    // SceneCard描画
    renderBuilderScenes(scenes);
    
    // ✅ AUTO-RESUME: Detect generating scenes and restart polling
    autoResumeGeneratingScenes(scenes);
    
    // ✅ Step3-PR3: Check for running bulk audio job and resume polling
    checkAndResumeBulkAudioJob();
    
    // ✅ Bind Auto-Assign button in Builder tab (Phase F-6 fix)
    bindBuilderAutoAssignButton();
    
    // Update tab states based on current project status
    const projectResponse = await axios.get(`${API_BASE}/projects/${PROJECT_ID}`);
    updateTabStates(projectResponse.data.status);
    
    // 改善: Builderタブ表示時にpreflight取得して進捗バーを更新
    // これにより上部の制作進捗と下部の準備状況が整合する
    try {
      const preflightResponse = await axios.get(`${API_BASE}/projects/${PROJECT_ID}/video-builds/preflight`);
      window.videoBuildPreflightCache = preflightResponse.data;
      // 進捗バーを実際のシーン準備状況で更新
      updateProgressBar(projectResponse.data.status);
      console.log('[Builder] Updated progress bar with preflight data');
    } catch (preflightError) {
      console.warn('[Builder] Preflight fetch failed, using cached data:', preflightError.message);
    }
  } catch (error) {
    console.error('Load builder scenes error:', error);
    showToast('シーンの読み込みに失敗しました', 'error');
    container.innerHTML = `
      <div class="flex items-center justify-center py-12">
        <div class="text-center">
          <i class="fas fa-exclamation-circle text-4xl text-red-600 mb-4"></i>
          <p class="text-gray-600">シーンの読み込みに失敗しました</p>
        </div>
      </div>
    `;
  }
}

// Builderステータスバー更新
function updateBuilderStatusBar(scenes) {
  const stats = getSceneStats(scenes);
  const total = scenes.length;
  
  // Top Action Barの前に挿入（存在しない場合は作成）
  let statusBar = document.getElementById('builderStatusBar');
  if (!statusBar) {
    const container = document.getElementById('contentBuilder');
    const actionBar = container.querySelector('.mb-6.p-4.bg-gray-50');
    statusBar = document.createElement('div');
    statusBar.id = 'builderStatusBar';
    statusBar.className = 'mb-4 p-4 bg-white rounded-lg border-2 border-gray-200';
    container.insertBefore(statusBar, actionBar);
  }
  
  statusBar.innerHTML = `
    <div class="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
      <!-- 集計表示 -->
      <div class="flex items-center gap-4 text-sm font-semibold">
        <span class="text-gray-700">進捗:</span>
        <span class="text-green-600"><i class="fas fa-check mr-1"></i>完了 ${stats.completed}/${total}</span>
        ${stats.generating > 0 ? `<span class="text-yellow-600"><i class="fas fa-spinner fa-spin mr-1"></i>生成中 ${stats.generating}</span>` : ''}
        ${stats.failed > 0 ? `<span class="text-red-600"><i class="fas fa-times mr-1"></i>失敗 ${stats.failed}</span>` : ''}
        <span class="text-gray-600">未生成 ${stats.pending}</span>
      </div>
      
      <!-- フィルタボタン -->
      <div class="flex flex-wrap gap-2">
        <button onclick="setSceneFilter('all')" class="filter-btn ${(!window.currentFilter || window.currentFilter === 'all') ? 'active' : ''}" data-filter="all">
          全て (${total})
        </button>
        <button onclick="setSceneFilter('pending')" class="filter-btn ${window.currentFilter === 'pending' ? 'active' : ''}" data-filter="pending">
          未生成 (${stats.pending})
        </button>
        <button onclick="setSceneFilter('generating')" class="filter-btn ${window.currentFilter === 'generating' ? 'active' : ''}" data-filter="generating">
          生成中 (${stats.generating})
        </button>
        <button onclick="setSceneFilter('completed')" class="filter-btn ${window.currentFilter === 'completed' ? 'active' : ''}" data-filter="completed">
          完了 (${stats.completed})
        </button>
        ${stats.failed > 0 ? `
        <button onclick="setSceneFilter('failed')" class="filter-btn ${window.currentFilter === 'failed' ? 'active' : ''}" data-filter="failed">
          失敗 (${stats.failed})
        </button>
        ` : ''}
      </div>
    </div>
    
    ${stats.failed > 0 ? `
    <div class="mt-3 pt-3 border-t border-gray-200">
      <button 
        onclick="generateBulkImages('failed')"
        class="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors font-semibold"
      >
        <i class="fas fa-redo mr-2"></i>失敗シーンのみ再試行
      </button>
    </div>
    ` : ''}
  `;
  
  // Phase X-4: 画像生成ボタンの状態更新
  updateImageGenerationButtons(stats);
}

/**
 * Phase X-4: 画像生成ボタンの状態を更新
 * - 全画像完了時: ボタンを非活性化
 * - 未生成・失敗がない時: 該当ボタンを非活性化
 */
function updateImageGenerationButtons(stats) {
  const allBtn = document.getElementById('generateAllImagesBtn');
  const pendingBtn = document.getElementById('generatePendingImagesBtn');
  const failedBtn = document.getElementById('generateFailedImagesBtn');
  
  const total = stats.completed + stats.pending + stats.failed + stats.generating;
  const allCompleted = stats.completed === total && total > 0;
  const isGenerating = stats.generating > 0 || window.isBulkImageGenerating;
  
  // 全画像生成ボタン
  if (allBtn) {
    if (allCompleted) {
      allBtn.disabled = true;
      allBtn.classList.add('opacity-50', 'cursor-not-allowed');
      allBtn.classList.remove('hover:bg-green-700');
      allBtn.innerHTML = '<i class="fas fa-check-circle mr-2"></i>全画像生成済み';
    } else if (isGenerating) {
      // 生成中は別の処理で制御されるので触らない
    } else {
      allBtn.disabled = false;
      allBtn.classList.remove('opacity-50', 'cursor-not-allowed');
      allBtn.classList.add('hover:bg-green-700');
      allBtn.innerHTML = '<i class="fas fa-magic mr-2"></i>全画像生成';
    }
  }
  
  // 未生成のみボタン
  if (pendingBtn) {
    if (stats.pending === 0) {
      pendingBtn.disabled = true;
      pendingBtn.classList.add('opacity-50', 'cursor-not-allowed');
      pendingBtn.classList.remove('hover:bg-blue-700');
      pendingBtn.innerHTML = '<i class="fas fa-check-circle mr-2"></i>未生成なし';
    } else if (isGenerating) {
      // 生成中は別の処理で制御
    } else {
      pendingBtn.disabled = false;
      pendingBtn.classList.remove('opacity-50', 'cursor-not-allowed');
      pendingBtn.classList.add('hover:bg-blue-700');
      pendingBtn.innerHTML = '<i class="fas fa-plus-circle mr-2"></i>未生成のみ';
    }
  }
  
  // 失敗のみボタン
  if (failedBtn) {
    if (stats.failed === 0) {
      failedBtn.disabled = true;
      failedBtn.classList.add('opacity-50', 'cursor-not-allowed');
      failedBtn.classList.remove('hover:bg-red-700');
      failedBtn.innerHTML = '<i class="fas fa-check-circle mr-2"></i>失敗なし';
    } else if (isGenerating) {
      // 生成中は別の処理で制御
    } else {
      failedBtn.disabled = false;
      failedBtn.classList.remove('opacity-50', 'cursor-not-allowed');
      failedBtn.classList.add('hover:bg-red-700');
      failedBtn.innerHTML = '<i class="fas fa-redo mr-2"></i>失敗のみ';
    }
  }
}

// フィルタ設定
function setSceneFilter(filter) {
  window.currentFilter = filter;
  
  // ボタン状態更新
  document.querySelectorAll('.filter-btn').forEach(btn => {
    if (btn.dataset.filter === filter) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
  
  // Reset to page 1 when filter changes (Phase X-0)
  window.builderPagination.currentPage = 1;
  
  // Re-render with cached scenes (Phase X-0: Fix - avoid unnecessary fetch)
  if (window.lastLoadedScenes) {
    renderBuilderScenes(window.lastLoadedScenes, 1);
  } else {
    initBuilderTab();
  }
}

// ========== Phase X-0: Template Functions (DOM Error Prevention) ==========

/**
 * Render scene card header
 * @param {object} scene 
 * @param {string} imageStatus 
 * @returns {string} HTML
 */
function renderSceneCardHeader(scene, imageStatus) {
  // 安全なデフォルト値を最初に設定
  const safeScene = scene || {};
  const sceneId = safeScene.id || 0;
  const sceneIdx = safeScene.idx ?? '?';
  const sceneRole = safeScene.role || 'unknown';
  const safeStatus = imageStatus || 'pending';
  const displayAssetType = safeScene.display_asset_type || 'image';
  const isComicMode = displayAssetType === 'comic';
  
  // デバッグ: コンソールに出力
  console.log('[renderSceneCardHeader] sceneId=' + sceneId + ', isComicMode=' + isComicMode + ', displayAssetType=' + displayAssetType);
  const hasPublishedComic = !!(safeScene.active_comic && safeScene.active_comic.r2_url);
  const hasImage = safeStatus === 'completed';
  const latestImageCompleted = safeScene.latest_image && safeScene.latest_image.status === 'completed' && safeScene.latest_image.r2_url;
  const hasAnyCompletedImage = hasImage || hasPublishedComic || latestImageCompleted;
  const showComicButton = hasAnyCompletedImage;
  const sceneEditDisabled = isComicMode;
  
  // ヘッダーHTML生成（Phase1.7: Tailwind safelistで保護済み）
  let headerClass = isComicMode ? 'from-orange-600 to-purple-600' : 'from-blue-600 to-purple-600';
  let comicBadge = isComicMode ? '<span class="px-2 py-0.5 bg-orange-100 text-orange-800 rounded-full text-xs font-semibold"><i class="fas fa-comment-alt mr-1"></i>漫画</span>' : '';
  
  // シーン編集ボタン（漫画モード時は非活性化）
  let editBtnOnclick = sceneEditDisabled ? '' : 'openSceneEditModal(' + sceneId + ')';
  let editBtnClass = sceneEditDisabled ? 'bg-gray-400 cursor-not-allowed' : 'bg-blue-500 hover:bg-blue-400';
  let editBtnTitle = sceneEditDisabled ? '漫画採用中はシーン編集できません' : 'シーンを編集';
  let editBtnDisabled = sceneEditDisabled ? 'disabled' : '';
  let editBtnIcon = sceneEditDisabled ? 'lock' : 'pen';
  let editBtnText = sceneEditDisabled ? '編集不可' : 'シーン編集';
  
  // 漫画化ボタン
  let comicBtn = '';
  if (showComicButton) {
    let comicBtnTitle = isComicMode ? '漫画を編集' : '画像に吹き出しを追加して漫画化';
    let comicBtnText = isComicMode ? '漫画編集' : '漫画化';
    comicBtn = '<button onclick="openComicEditor(' + sceneId + ')" class="px-3 py-1.5 bg-orange-500 hover:bg-orange-400 rounded-lg text-white text-xs font-semibold transition-colors" title="' + comicBtnTitle + '"><i class="fas fa-comment-dots mr-1"></i>' + comicBtnText + '</button>';
  }
  
  let statusBadge = getSceneStatusBadge(safeStatus);
  let roleText = getRoleText(sceneRole);
  
  // R1.6: 音声状態バッジ（utterance_status）
  const utteranceStatus = safeScene.utterance_status || { total: 0, with_audio: 0, is_ready: false };
  let audioBadge = '';
  if (utteranceStatus.total === 0) {
    // 発話なし → 赤バッジ（クリックで音声タブを開く）
    audioBadge = '<button onclick="openSceneEditModal(' + sceneId + ', \'audio\')" class="px-2 py-0.5 bg-red-100 text-red-800 rounded-full text-xs font-semibold hover:bg-red-200 transition-colors" title="発話がありません。クリックして音声タブを開く"><i class="fas fa-microphone-slash mr-1"></i>音声なし</button>';
  } else if (!utteranceStatus.is_ready) {
    // 一部音声未生成 → 赤バッジ
    audioBadge = '<button onclick="openSceneEditModal(' + sceneId + ', \'audio\')" class="px-2 py-0.5 bg-red-100 text-red-800 rounded-full text-xs font-semibold hover:bg-red-200 transition-colors" title="' + utteranceStatus.with_audio + '/' + utteranceStatus.total + '件音声生成済み。クリックして音声タブを開く"><i class="fas fa-volume-mute mr-1"></i>' + utteranceStatus.with_audio + '/' + utteranceStatus.total + '</button>';
  } else {
    // 全て音声生成済み → 緑バッジ
    audioBadge = '<span class="px-2 py-0.5 bg-green-100 text-green-800 rounded-full text-xs font-semibold" title="全発話の音声生成完了"><i class="fas fa-volume-up mr-1"></i>' + utteranceStatus.total + '件</span>';
  }
  
  // R2-C: ステータスバー（素材/文字/音声/動き）
  const statusBar = renderSceneStatusBar(safeScene, utteranceStatus);
  
  return '<div class="bg-gradient-to-r ' + headerClass + ' px-4 py-3 flex items-center justify-between flex-wrap gap-2">' +
    '<div class="flex items-center gap-2">' +
      '<span class="text-white font-bold text-lg">#' + sceneIdx + '</span>' +
      '<span class="px-2 py-0.5 bg-white bg-opacity-20 rounded-full text-white text-xs font-semibold">' + roleText + '</span>' +
      comicBadge +
    '</div>' +
    '<div class="flex items-center gap-2 flex-wrap">' +
      '<button onclick="' + editBtnOnclick + '" class="px-3 py-1.5 ' + editBtnClass + ' rounded-lg text-white text-xs font-semibold transition-colors" title="' + editBtnTitle + '" ' + editBtnDisabled + '>' +
        '<i class="fas fa-' + editBtnIcon + ' mr-1"></i>' + editBtnText +
      '</button>' +
      comicBtn +
      '<div class="scene-status-badge-container">' + statusBadge + '</div>' +
    '</div>' +
  '</div>' +
  // R2-C: 「今何が出るか」一目でわかるステータスバー
  statusBar;
}

/**
 * R2-C: シーンの「素材/文字/音声/動き」ステータスバーを生成
 * これがあるだけで「今どのモード？」「二重になる？」が消える
 * @param {object} scene 
 * @param {object} utteranceStatus 
 * @returns {string} HTML
 */
function renderSceneStatusBar(scene, utteranceStatus) {
  // === 素材タイプ ===
  const displayAssetType = scene.display_asset_type || 'image';
  let assetIcon, assetLabel, assetClass;
  switch (displayAssetType) {
    case 'comic':
      assetIcon = '📙';
      assetLabel = '漫画';
      assetClass = 'bg-orange-100 text-orange-800';
      break;
    case 'video':
      assetIcon = '🎬';
      assetLabel = '動画';
      assetClass = 'bg-blue-100 text-blue-800';
      break;
    default:
      assetIcon = '🖼️';
      assetLabel = '静止画';
      assetClass = 'bg-green-100 text-green-800';
  }
  
  // === 文字レンダリングモード ===
  // comic → baked (焼き込み), image/video → remotion (Remotionで描画)
  const textRenderMode = scene.text_render_mode || (displayAssetType === 'comic' ? 'baked' : 'remotion');
  let textIcon, textLabel, textClass, textTooltip;
  switch (textRenderMode) {
    case 'baked':
      textIcon = '🔥';
      textLabel = '焼込';
      textClass = 'bg-orange-100 text-orange-800';
      textTooltip = '文字は画像に焼き込み済み（二重表示なし）';
      break;
    case 'none':
      textIcon = '⛔';
      textLabel = 'なし';
      textClass = 'bg-gray-100 text-gray-600';
      textTooltip = '文字は表示しません';
      break;
    default: // 'remotion'
      textIcon = '🧾';
      textLabel = 'まるっとムービー';
      textClass = 'bg-purple-100 text-purple-800';
      textTooltip = '文字はまるっとムービーで動的描画';
  }
  
  // === 音声状態 ===
  const total = utteranceStatus?.total || 0;
  const withAudio = utteranceStatus?.with_audio || 0;
  let audioIcon, audioLabel, audioClass, audioTooltip;
  if (total === 0) {
    audioIcon = '🔇';
    audioLabel = '発話なし';
    audioClass = 'bg-gray-100 text-gray-600';
    audioTooltip = '発話が設定されていません';
  } else if (withAudio === total) {
    audioIcon = '🎙️';
    audioLabel = `${total}件OK`;
    audioClass = 'bg-green-100 text-green-800';
    audioTooltip = `全${total}件の音声生成完了`;
  } else {
    audioIcon = '🎙️';
    audioLabel = `${withAudio}/${total}`;
    audioClass = 'bg-red-100 text-red-800';
    audioTooltip = `${total}件中${withAudio}件の音声生成完了`;
  }
  
  // === モーション ===
  const motionPresetId = scene.motion_preset_id || (displayAssetType === 'comic' ? 'none' : 'kenburns_soft');
  let motionIcon, motionLabel, motionClass, motionTooltip;
  // Phase A-2: 全20種類 + auto のラベル（video-build-helpers.ts MOTION_PRESETS_MAP と同期）
  const motionLabels = {
    'none': { icon: '⏸️', label: '静止', class: 'bg-gray-100 text-gray-600', tip: '動きなし' },
    // ズーム系
    'kenburns_soft': { icon: '🎥', label: 'ゆっくりズーム', class: 'bg-purple-100 text-purple-800', tip: 'ゆっくりズーム（1.0→1.05）' },
    'kenburns_strong': { icon: '🎥', label: '強ズーム', class: 'bg-purple-100 text-purple-800', tip: '強めズーム（1.0→1.15）' },
    'kenburns_zoom_out': { icon: '🔍', label: 'ズームアウト', class: 'bg-purple-100 text-purple-800', tip: 'ズームアウト（1.1→1.0）' },
    // パン系
    'pan_lr': { icon: '➡️', label: '左→右', class: 'bg-blue-100 text-blue-800', tip: '左から右へパン' },
    'pan_rl': { icon: '⬅️', label: '右→左', class: 'bg-blue-100 text-blue-800', tip: '右から左へパン' },
    'pan_tb': { icon: '⬇️', label: '上→下', class: 'bg-blue-100 text-blue-800', tip: '上から下へパン' },
    'pan_bt': { icon: '⬆️', label: '下→上', class: 'bg-blue-100 text-blue-800', tip: '下から上へパン' },
    // スライド系（大きめ移動）
    'slide_lr': { icon: '⏩', label: 'スライド左→右', class: 'bg-cyan-100 text-cyan-800', tip: 'スライド（左→右）大きめ移動' },
    'slide_rl': { icon: '⏪', label: 'スライド右→左', class: 'bg-cyan-100 text-cyan-800', tip: 'スライド（右→左）大きめ移動' },
    'slide_tb': { icon: '⏬', label: 'スライド上→下', class: 'bg-cyan-100 text-cyan-800', tip: 'スライド（上→下）大きめ移動' },
    'slide_bt': { icon: '⏫', label: 'スライド下→上', class: 'bg-cyan-100 text-cyan-800', tip: 'スライド（下→上）大きめ移動' },
    // 静止→スライド系
    'hold_then_slide_lr': { icon: '⏸➡', label: '静止→右へ', class: 'bg-teal-100 text-teal-800', tip: '前半静止、後半右スライド' },
    'hold_then_slide_rl': { icon: '⏸⬅', label: '静止→左へ', class: 'bg-teal-100 text-teal-800', tip: '前半静止、後半左スライド' },
    'hold_then_slide_tb': { icon: '⏸⬇', label: '静止→下へ', class: 'bg-teal-100 text-teal-800', tip: '前半静止、後半下スライド' },
    'hold_then_slide_bt': { icon: '⏸⬆', label: '静止→上へ', class: 'bg-teal-100 text-teal-800', tip: '前半静止、後半上スライド' },
    // 複合系（ズーム＋パン同時）
    'combined_zoom_pan_lr': { icon: '🎬', label: 'ズーム+右パン', class: 'bg-indigo-100 text-indigo-800', tip: 'ズームイン＋右パン同時' },
    'combined_zoom_pan_rl': { icon: '🎬', label: 'ズーム+左パン', class: 'bg-indigo-100 text-indigo-800', tip: 'ズームイン＋左パン同時' },
    // 自動
    'auto': { icon: '🎲', label: '自動', class: 'bg-yellow-100 text-yellow-800', tip: 'シードに基づき8種から自動選択' }
  };
  const motionInfo = motionLabels[motionPresetId] || { icon: '🎥', label: motionPresetId, class: 'bg-gray-100 text-gray-600', tip: motionPresetId };
  motionIcon = motionInfo.icon;
  motionLabel = motionInfo.label;
  motionClass = motionInfo.class;
  motionTooltip = motionInfo.tip;
  
  // === R3-A: シーン尺（duration）計算 ===
  // 優先順位: duration_override_ms > 音声合計 + 500ms > デフォルト3000ms
  let durationMs = 3000; // デフォルト
  let durationSource = 'デフォルト';
  let durationIcon = '⏱️';
  let durationClass = 'bg-gray-100 text-gray-600';
  
  if (scene.duration_override_ms && scene.duration_override_ms > 0) {
    // 手動設定の尺（無音シーン用）
    durationMs = scene.duration_override_ms;
    durationSource = '手動設定';
    durationIcon = '✏️';
    durationClass = 'bg-yellow-100 text-yellow-800';
  } else if (total > 0 && withAudio === total) {
    // 全音声生成済み → 音声の合計尺 + 500ms（推定値として表示）
    // ※実際のduration_msは各utteranceから取得する必要があるが、ここでは概算
    // utteranceStatus.total_duration_ms があれば使用
    const audioDurationMs = utteranceStatus.total_duration_ms;
    if (audioDurationMs && audioDurationMs > 0) {
      durationMs = audioDurationMs + 500;
      durationSource = '音声尺';
      durationIcon = '🎙️';
      durationClass = 'bg-green-100 text-green-800';
    }
  } else if (total === 0) {
    // 発話なし → デフォルトまたは手動設定を推奨
    durationSource = '無音/要設定';
    durationIcon = '⚠️';
    durationClass = 'bg-orange-100 text-orange-800';
  }
  
  // 尺を秒に変換（小数点1桁）
  const durationSec = (durationMs / 1000).toFixed(1);
  const durationTooltip = `シーン尺: ${durationSec}秒（${durationSource}）`;
  
  // === ステータスバーHTML ===
  return `
    <div class="bg-gray-50 border-b border-gray-200 px-4 py-2">
      <div class="flex flex-wrap items-center gap-3 text-xs">
        <!-- 素材 -->
        <span class="inline-flex items-center gap-1 px-2 py-1 rounded ${assetClass}" title="表示素材タイプ">
          <span>${assetIcon}</span>
          <span class="font-semibold">${assetLabel}</span>
        </span>
        
        <!-- PR-Comic-Rebake-DiffBadge: 漫画シーンのみ rebake バッジ表示用プレースホルダ -->
        ${displayAssetType === 'comic' ? `<span data-rebake-badge="${scene.id}" class="rebake-badge-container"></span>` : ''}
        
        <!-- 文字 -->
        <span class="inline-flex items-center gap-1 px-2 py-1 rounded ${textClass}" title="${textTooltip}">
          <span>${textIcon}</span>
          <span class="font-semibold">${textLabel}</span>
        </span>
        
        <!-- 音声 -->
        <span class="inline-flex items-center gap-1 px-2 py-1 rounded ${audioClass}" title="${audioTooltip}">
          <span>${audioIcon}</span>
          <span class="font-semibold">${audioLabel}</span>
        </span>
        
        <!-- R3-A: 尺（duration） -->
        <span class="inline-flex items-center gap-1 px-2 py-1 rounded ${durationClass}" title="${durationTooltip}">
          <span>${durationIcon}</span>
          <span class="font-semibold">${durationSec}秒</span>
        </span>
        
        <!-- P3: シーン別BGM -->
        ${(() => {
          const sceneBgm = scene.scene_bgm;
          const hasProjectBgm = window.currentBgm;
          
          if (sceneBgm) {
            // シーン別BGMがある場合（新SSOT優先）
            const sourceLabel = { system: 'システム', user: 'ユーザー', direct: 'URL' }[sceneBgm.source] || sceneBgm.source;
            const bgmName = sceneBgm.name || 'BGM';
            const truncatedName = bgmName.length > 12 ? bgmName.substring(0, 12) + '...' : bgmName;
            return `
              <button 
                onclick="openSceneEditModal(${scene.id}, 'bgm')"
                class="inline-flex items-center gap-1 px-2 py-1 rounded bg-yellow-100 text-yellow-800 hover:bg-yellow-200 transition-colors cursor-pointer" 
                title="シーンBGM: ${bgmName}（${sourceLabel}）クリックで編集"
              >
                <span>🎵</span>
                <span class="font-semibold">${truncatedName}</span>
                <span class="text-xs opacity-60">[${sourceLabel}]</span>
              </button>
            `;
          } else if (hasProjectBgm) {
            // プロジェクト共通BGMがある場合
            return `
              <button 
                onclick="openSceneEditModal(${scene.id}, 'bgm')"
                class="inline-flex items-center gap-1 px-2 py-1 rounded bg-yellow-50 text-yellow-700 hover:bg-yellow-100 transition-colors cursor-pointer" 
                title="プロジェクトBGM使用中。クリックでシーン別BGMを設定"
              >
                <span>🎵</span>
                <span class="font-semibold">全体BGM</span>
              </button>
            `;
          } else {
            // BGMなし
            return `
              <button 
                onclick="openSceneEditModal(${scene.id}, 'bgm')"
                class="inline-flex items-center gap-1 px-2 py-1 rounded bg-gray-100 text-gray-500 hover:bg-gray-200 transition-colors cursor-pointer" 
                title="BGM未設定。クリックでシーン別BGMを設定"
              >
                <span>🔇</span>
                <span class="font-semibold">BGMなし</span>
              </button>
            `;
          }
        })()}
        
        <!-- P3: SFX（効果音）改善 -->
        ${(() => {
          const sfxCount = scene.sfx_count || 0;
          const sfxPreview = scene.sfx_preview || [];
          
          if (sfxCount > 0) {
            // SFXがある場合：件数＋先頭2件のname
            const previewText = sfxPreview.length > 0 ? sfxPreview.join(', ') : 'SFX';
            const truncatedPreview = previewText.length > 15 ? previewText.substring(0, 15) + '...' : previewText;
            return `
              <button 
                onclick="openSceneEditModal(${scene.id}, 'sfx')"
                class="inline-flex items-center gap-1 px-2 py-1 rounded bg-pink-100 text-pink-800 hover:bg-pink-200 transition-colors cursor-pointer" 
                title="効果音: ${sfxCount}件（${sfxPreview.join(', ') || 'SFX'}）クリックで編集"
              >
                <span>💥</span>
                <span class="font-semibold">SFX ${sfxCount}</span>
                <span class="text-xs opacity-70">${truncatedPreview}</span>
              </button>
            `;
          } else {
            return `
              <button 
                onclick="openSceneEditModal(${scene.id}, 'sfx')"
                class="inline-flex items-center gap-1 px-2 py-1 rounded bg-gray-100 text-gray-400 hover:bg-gray-200 transition-colors cursor-pointer" 
                title="効果音なし。クリックでSFXを追加"
              >
                <span>💥</span>
                <span class="font-semibold">SFXなし</span>
              </button>
            `;
          }
        })()}
        
        <!-- 動き -->
        <span class="inline-flex items-center gap-1 px-2 py-1 rounded ${motionClass}" title="${motionTooltip}">
          <span>${motionIcon}</span>
          <span class="font-semibold">${motionLabel}</span>
        </span>
      </div>
    </div>
  `;
}

/**
 * Phase1.7: 漫画採用時の発話表示を生成
 * @param {object} scene 
 * @returns {string} HTML
 */
function renderComicUtterances(scene) {
  const comicData = scene.comic_data;
  const utterances = comicData?.published?.utterances || comicData?.draft?.utterances || [];
  
  if (utterances.length === 0) {
    return `<div class="text-gray-400 text-sm italic">発話なし</div>`;
  }
  
  // 話者タイプの表示ラベル
  const speakerTypeLabels = {
    'narration': 'ナレーション',
    'character': 'キャラクター'
  };
  
  return utterances.map((u, idx) => {
    const speakerLabel = u.speaker_type === 'character' && u.speaker_character_key 
      ? `キャラ: ${u.speaker_character_key}`
      : speakerTypeLabels[u.speaker_type] || 'ナレーション';
    
    return `
      <div class="p-2 bg-white border border-orange-200 rounded-lg mb-2">
        <div class="flex items-center gap-2 mb-1">
          <span class="px-2 py-0.5 bg-orange-100 text-orange-700 text-xs rounded-full font-semibold">発話${idx + 1}</span>
          <span class="text-xs text-gray-500">${escapeHtml(speakerLabel)}</span>
        </div>
        <div class="text-sm text-gray-800 whitespace-pre-wrap">${escapeHtml(u.text || '')}</div>
      </div>
    `;
  }).join('');
}

/**
 * Phase1.7: 漫画モード時の音声セクション（発話ごとに設定）
 * @param {object} scene 
 * @returns {string} HTML
 */
function renderComicAudioSection(scene) {
  const comicData = scene.comic_data;
  const utterances = comicData?.published?.utterances || comicData?.draft?.utterances || [];
  
  if (utterances.length === 0) {
    return `
      <div class="bg-gray-100 rounded-lg p-4 text-center text-gray-500">
        <i class="fas fa-info-circle mr-2"></i>発話がありません
      </div>
    `;
  }
  
  // 音声プリセットリスト
  const voicePresets = [
    { id: 'ja-JP-Neural2-B', name: '女性A（Neural2）' },
    { id: 'ja-JP-Neural2-C', name: '男性A（Neural2）' },
    { id: 'ja-JP-Neural2-D', name: '男性B（Neural2）' },
    { id: 'ja-JP-Wavenet-A', name: '女性A（WaveNet）' },
    { id: 'ja-JP-Wavenet-B', name: '女性B（WaveNet）' },
    { id: 'ja-JP-Wavenet-C', name: '男性A（WaveNet）' },
    { id: 'ja-JP-Wavenet-D', name: '男性B（WaveNet）' }
  ];
  
  const voiceOptions = voicePresets.map(preset => 
    `<option value="${preset.id}">${preset.name}</option>`
  ).join('');
  
  // プロジェクトのキャラクターリスト
  const projectCharacters = window.lastLoadedCharacters || [];
  
  const utteranceRows = utterances.map((u, idx) => {
    const speakerLabel = u.speaker_type === 'character' && u.speaker_character_key 
      ? u.speaker_character_key
      : 'ナレーション';
    const textPreview = (u.text || '').substring(0, 30) + ((u.text || '').length > 30 ? '...' : '');
    
    // キャラクター選択肢
    const charOptions = projectCharacters.length > 0 
      ? projectCharacters.map(char => {
          const voiceLabel = char.voice_preset_id ? '✓' : '×';
          const selected = u.speaker_character_key === char.character_key ? 'selected' : '';
          return `<option value="${char.character_key}" ${selected}>${escapeHtml(char.character_name)}（${voiceLabel}）</option>`;
        }).join('')
      : '';
    
    return `
      <div class="p-3 bg-white border border-orange-200 rounded-lg">
        <div class="flex items-center gap-2 mb-2">
          <span class="px-2 py-0.5 bg-orange-100 text-orange-700 text-xs rounded-full font-semibold">発話${idx + 1}</span>
          <span class="text-xs text-gray-500 truncate flex-1">${escapeHtml(textPreview)}</span>
        </div>
        <div class="flex items-center gap-2">
          ${projectCharacters.length > 0 ? `
            <select 
              id="comicUtteranceVoice-${scene.id}-${idx}"
              class="flex-1 px-2 py-1.5 border border-gray-300 rounded text-xs"
              onchange="window.selectComicUtteranceVoice(${scene.id}, ${idx}, this.value)"
            >
              <option value="">ナレーター音声</option>
              <optgroup label="キャラクター">
                ${charOptions}
              </optgroup>
            </select>
          ` : `
            <select 
              id="comicUtteranceVoice-${scene.id}-${idx}"
              class="flex-1 px-2 py-1.5 border border-gray-300 rounded text-xs"
            >
              ${voiceOptions}
            </select>
          `}
          <button 
            id="comicUtteranceVoiceBtn-${scene.id}-${idx}"
            onclick="window.generateComicUtteranceVoice(${scene.id}, ${idx})"
            class="px-3 py-1.5 bg-purple-600 text-white rounded text-xs hover:bg-purple-700"
            title="この発話の音声を生成"
          >
            <i class="fas fa-volume-up"></i>
          </button>
        </div>
        <!-- Phase1.7: 音声プレビュー領域 -->
        <div id="comicUtteranceAudioPreview-${scene.id}-${idx}" class="mt-2 hidden">
          <!-- 音声プレーヤーがここに挿入される -->
        </div>
      </div>
    `;
  }).join('');
  
  return `
    <div class="bg-gradient-to-br from-orange-50 to-purple-50 rounded-lg border-2 border-orange-200 overflow-hidden">
      <div class="bg-gradient-to-r from-orange-500 to-purple-500 px-4 py-2">
        <h4 class="text-white font-semibold text-sm flex items-center">
          <i class="fas fa-microphone mr-2"></i>
          発話ごとの音声（漫画用）
        </h4>
      </div>
      <div class="p-3 space-y-2">
        ${utteranceRows}
        <button
          onclick="window.generateAllComicUtteranceVoices(${scene.id})"
          class="w-full px-4 py-2 bg-gradient-to-r from-orange-500 to-purple-500 text-white rounded-lg hover:from-orange-600 hover:to-purple-600 transition-colors font-semibold text-sm"
        >
          <i class="fas fa-play-circle mr-2"></i>全発話の音声を一括生成
        </button>
        <p class="text-xs text-gray-500 text-center">
          <i class="fas fa-info-circle mr-1"></i>
          漫画の発話設定は「漫画化」ボタンから編集できます
        </p>
      </div>
    </div>
  `;
}

/**
 * Phase1: Render scene text content (結果確認専用)
 * トップカードは「結果確認」のみ。編集はモーダルに集約。
 * 
 * 表示順序（確定）:
 * ① セリフ概要（短縮・参照専用）
 * ② 発話サマリー（話者・件数・生成状態）
 * ③ 映像タイプ（画像/漫画）
 * ④ 登場キャラ（映像用）
 * ⑤ 詳細（折りたたみ：スタイル・プロンプト・要点）
 * 
 * @param {object} scene 
 * @returns {string} HTML
 */
function renderSceneTextContent(scene, imageStatus, disableVideoGen) {
  return `
    <div class="space-y-4">
      
      <!-- ① セリフ概要（短縮・参照専用） -->
      ${renderDialogueSummary(scene)}
      
      <!-- ② 発話サマリー（話者・件数・生成状態）+ 音声生成ボタン -->
      ${renderSpeakerSummarySection(scene, { showEditButton: true })}
      
      <!-- ③ 映像タイプ表示（画像/漫画） -->
      ${renderAssetTypeIndicator(scene)}
      
      <!-- ④ 登場キャラ（映像用） -->
      ${renderImageCharacterSection(scene)}
      
      <!-- ⑤ プロンプト編集（画像+動画統合、折りたたみ） -->
      ${renderSceneDetailsFold(scene, imageStatus, disableVideoGen)}
      
    </div>
  `;
}

/**
 * Render scene image section
 * @param {object} scene 
 * @param {string} imageUrl 
 * @param {string} imageStatus 
 * @returns {string} HTML
 */
function renderSceneImageSection(scene, imageUrl, imageStatus) {
  const isGenerating = imageStatus === 'generating';
  const activeVideo = scene.active_video || null;
  const hasCompletedVideo = activeVideo && activeVideo.status === 'completed' && activeVideo.r2_url;
  const isGeneratingVideo = window.videoGenerating && window.videoGenerating[scene.id];
  
  // Phase1.5: display_asset_type に基づく表示切替
  const displayAssetType = scene.display_asset_type || 'image';
  const activeComic = scene.active_comic || null;
  const comicUrl = activeComic?.r2_url || activeComic?.image_url || null;
  const hasPublishedComic = !!comicUrl;
  
  // Phase1.7: latest_image からもフォールバック
  const latestImage = scene.latest_image || null;
  const latestImageUrl = (latestImage?.status === 'completed') ? (latestImage?.r2_url || latestImage?.image_url) : null;
  const imageCompleted = imageStatus === 'completed';
  
  // 漫画モード判定
  const isComicMode = displayAssetType === 'comic';
  
  // 表示する画像URL（display_asset_typeに応じて切替、フォールバック付き）
  let displayUrl = null;
  if (displayAssetType === 'comic' && comicUrl) {
    displayUrl = comicUrl;
  } else if (imageUrl) {
    displayUrl = imageUrl;
  } else if (latestImageUrl) {
    displayUrl = latestImageUrl;
  }
  const isShowingComic = displayAssetType === 'comic' && comicUrl;
  
  // ✅ displayUrl の有効性チェック強化（null/undefined/'null'/'undefined' を除外）
  const validDisplayUrl = displayUrl && displayUrl !== 'null' && displayUrl !== 'undefined' ? displayUrl : null;
  
  // 採用タブ表示条件: 画像完了後は常に表示（動画化の導線を確保）
  const showAssetTabs = imageCompleted && (hasPublishedComic || hasCompletedVideo || !isComicMode);
  
  return `
    <!-- ========================================== -->
    <!-- メディアプレビューエリア: 画像は常に表示 -->
    <!-- ========================================== -->
    
    <!-- 画像/漫画プレビュー（常時表示） -->
    <div class="scene-image-container relative aspect-video bg-gray-100 rounded-lg border-2 ${isShowingComic ? 'border-orange-400' : 'border-gray-300'} overflow-hidden">
      ${validDisplayUrl 
        ? `<img 
             id="sceneImage-${scene.id}" 
             src="${validDisplayUrl}" 
             alt="Scene ${scene.idx}"
             class="w-full h-full object-cover"
           />`
        : `<div class="flex items-center justify-center h-full text-gray-400">
             <i class="fas fa-image text-4xl"></i>
             <span class="ml-2">画像未生成</span>
           </div>`
      }
      
      ${isGenerating 
        ? `<div class="absolute inset-0 bg-black bg-opacity-50 flex items-center justify-center">
             <div class="text-white text-center">
               <i class="fas fa-spinner fa-spin text-3xl mb-2"></i>
               <p>画像生成中...</p>
             </div>
           </div>`
        : ''
      }
      
      <!-- 左上バッジ: 現在の表示モード -->
      <div class="absolute top-2 left-2 px-2 py-1 ${isShowingComic ? 'bg-orange-600' : 'bg-blue-600'} text-white text-xs rounded-full font-semibold">
        <i class="fas ${isShowingComic ? 'fa-comment-alt' : 'fa-image'} mr-1"></i>${isShowingComic ? '漫画' : '画像'}
      </div>
    </div>
    
    <!-- ========================================== -->
    <!-- 動画プレビュー: 生成済み or 生成中 を画像の下に表示 -->
    <!-- ========================================== -->
    ${hasCompletedVideo ? `
    <div class="scene-video-container relative aspect-video bg-gray-900 rounded-lg border-2 border-purple-400 overflow-hidden mt-2" id="videoPreview-${scene.id}">
      <video 
        id="sceneVideo-${scene.id}" 
        src="${activeVideo.r2_url}" 
        class="w-full h-full object-contain"
        controls
        preload="metadata"
        poster="${imageUrl || ''}"
        onerror="this.onerror=null;refreshVideoUrl(${activeVideo.id}, ${scene.id})"
      >
        <source src="${activeVideo.r2_url}" type="video/mp4">
      </video>
      <div class="absolute top-2 left-2 px-2 py-1 bg-purple-600 text-white text-xs rounded-full font-semibold">
        <i class="fas fa-video mr-1"></i>動画 (${activeVideo.duration_sec || 5}秒)
      </div>
    </div>
    ` : isGeneratingVideo ? `
    <div class="relative aspect-video bg-gray-900 rounded-lg border-2 border-yellow-400 overflow-hidden mt-2 flex items-center justify-center" id="videoPreview-${scene.id}">
      <div class="text-center text-white">
        <i class="fas fa-spinner fa-spin text-3xl mb-2"></i>
        <p class="text-sm font-semibold" id="videoProgress-${scene.id}">動画生成中...</p>
        <p class="text-xs text-gray-400 mt-1">完了まで1〜3分</p>
      </div>
      <div class="absolute top-2 left-2 px-2 py-1 bg-yellow-500 text-white text-xs rounded-full font-semibold">
        <i class="fas fa-video mr-1"></i>生成中
      </div>
    </div>
    ` : ''}
    
    <!-- 採用切替タブ（画像完了後に常に表示） -->
    ${showAssetTabs ? `
    <div class="flex gap-2 mt-2">
      ${hasPublishedComic ? `
      <button 
        onclick="switchDisplayAssetType(${scene.id}, '${isShowingComic ? 'image' : 'comic'}')"
        class="flex-1 px-2 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
          isShowingComic 
            ? 'bg-blue-100 text-blue-700 hover:bg-blue-200 border border-blue-300'
            : 'bg-orange-100 text-orange-700 hover:bg-orange-200 border border-orange-300'
        }"
      >
        <i class="fas ${isShowingComic ? 'fa-image' : 'fa-comment-alt'} mr-1"></i>${isShowingComic ? '画像に切替' : '漫画に切替'}
      </button>
      ` : ''}
      ${hasCompletedVideo ? `
      <button 
        onclick="switchDisplayAssetType(${scene.id}, 'video')"
        class="flex-1 px-2 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
          displayAssetType === 'video' 
            ? 'bg-purple-600 text-white' 
            : 'bg-purple-100 text-purple-700 hover:bg-purple-200 border border-purple-300'
        }"
      >
        <i class="fas fa-check-circle mr-1"></i>動画を採用
      </button>
      ` : `
      <button 
        onclick="generateVideoFromTab(${scene.id})"
        id="videoTabBtn-${scene.id}"
        class="flex-1 px-2 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
          isComicMode 
            ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
            : isGeneratingVideo 
              ? 'bg-yellow-500 text-white cursor-not-allowed'
              : 'bg-purple-100 text-purple-700 hover:bg-purple-200 border border-purple-300'
        }"
        ${isComicMode || isGeneratingVideo ? 'disabled' : ''}
        title="${isComicMode ? '漫画採用中は動画化できません' : '画像から動画を生成'}"
      >
        ${isGeneratingVideo 
          ? '<i class="fas fa-spinner fa-spin mr-1"></i>動画生成中...'
          : '<i class="fas fa-magic mr-1"></i>動画化'
        }
      </button>
      `}
    </div>
    ` : ''}
  `;
}

/**
 * 動画プロンプト & 生成エリア（シーンカード内に常時表示）
 * - 画像完了時: プロンプト入力 + エンジン選択 + 生成/再生成ボタン
 * - 漫画採用中: 無効化表示
 * - 画像未完了: 「画像生成完了後に利用可能」メッセージ
 */
function renderVideoPromptSection(scene, imageStatus, disableVideoGen) {
  const activeVideo = scene.active_video || null;
  const hasCompletedVideo = activeVideo && activeVideo.status === 'completed' && activeVideo.r2_url;
  const isGeneratingVideo = window.videoGenerating && window.videoGenerating[scene.id];
  const existingPrompt = activeVideo?.prompt || '';
  const existingModel = activeVideo?.model || '';
  const isVeo3 = existingModel.includes('veo-3');
  
  // 漫画モード → 無効化メッセージ
  if (disableVideoGen) {
    return `
      <div class="bg-gray-50 rounded-lg border border-gray-200 p-3">
        <div class="flex items-center justify-between">
          <div class="text-xs font-semibold text-gray-400">
            <i class="fas fa-video mr-1"></i>動画プロンプト
          </div>
          <button 
            id="videoHistoryBtn-${scene.id}"
            onclick="viewVideoHistory(${scene.id})"
            class="text-xs px-2 py-1 bg-gray-500 text-white rounded hover:bg-gray-600 transition-colors"
            title="動画履歴"
          >
            <i class="fas fa-film mr-1"></i>履歴
          </button>
        </div>
        <p class="text-xs text-orange-600 mt-2">
          <i class="fas fa-lock mr-1"></i>漫画採用中は動画化できません。まるっとムービーで動画化されます。
        </p>
      </div>
    `;
  }
  
  // 画像未完了 → 「画像生成完了後に利用可能」
  if (imageStatus !== 'completed') {
    return `
      <div class="bg-gray-50 rounded-lg border border-gray-200 p-3">
        <div class="flex items-center justify-between">
          <div class="text-xs font-semibold text-gray-400">
            <i class="fas fa-video mr-1"></i>動画プロンプト
          </div>
          <button 
            id="videoHistoryBtn-${scene.id}"
            onclick="viewVideoHistory(${scene.id})"
            class="text-xs px-2 py-1 bg-gray-500 text-white rounded hover:bg-gray-600 transition-colors"
            title="動画履歴"
          >
            <i class="fas fa-film mr-1"></i>履歴
          </button>
        </div>
        <p class="text-xs text-gray-500 mt-2">
          <i class="fas fa-info-circle mr-1"></i>画像生成が完了すると、動画プロンプトを入力して動画化できます
        </p>
      </div>
    `;
  }
  
  // 画像完了 → プロンプト入力 + 生成ボタン
  return `
    <div class="bg-purple-50 rounded-lg border border-purple-200 p-3 space-y-3" id="videoPromptSection-${scene.id}">
      <!-- ヘッダー -->
      <div class="flex items-center justify-between">
        <div class="text-xs font-semibold text-purple-700">
          <i class="fas fa-video mr-1"></i>動画プロンプト
          ${hasCompletedVideo ? '<span class="ml-1 text-green-600"><i class="fas fa-check-circle"></i></span>' : ''}
        </div>
        <div class="flex items-center gap-2">
          ${hasCompletedVideo ? `
            <span class="text-xs text-green-600 font-medium">
              <i class="fas fa-check mr-1"></i>動画あり
            </span>
          ` : ''}
          <button 
            id="videoHistoryBtn-${scene.id}"
            onclick="viewVideoHistory(${scene.id})"
            class="text-xs px-2 py-1 bg-gray-500 text-white rounded hover:bg-gray-600 transition-colors"
            title="動画履歴"
          >
            <i class="fas fa-film mr-1"></i>履歴
          </button>
        </div>
      </div>
      
      <!-- プロンプト入力 -->
      <textarea 
        id="videoPromptInline-${scene.id}"
        rows="2"
        class="w-full px-3 py-2 text-sm border border-purple-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 resize-y bg-white"
        placeholder="動きや演出の指示を入力（例: カメラがゆっくりズームイン、表情変化、光の動き）"
        ${isGeneratingVideo ? 'disabled' : ''}
      >${escapeHtml(existingPrompt)}</textarea>
      <p class="text-xs text-gray-500">空欄の場合はシンプルなモーションが適用されます</p>
      
      <!-- エンジン選択 + 生成ボタン（横並び） -->
      <div class="flex items-center gap-2">
        <!-- エンジン選択（コンパクト） -->
        <select 
          id="videoEngineInline-${scene.id}" 
          class="text-xs px-2 py-2 border border-purple-300 rounded-lg bg-white focus:ring-2 focus:ring-purple-500"
          ${isGeneratingVideo ? 'disabled' : ''}
        >
          <option value="veo2" ${!isVeo3 ? 'selected' : ''}>🎬 Veo2 (5秒)</option>
          <option value="veo3" ${isVeo3 ? 'selected' : ''}>🚀 Veo3 (8秒)</option>
        </select>
        
        <!-- 生成/再生成ボタン -->
        <button 
          id="videoBtn-${scene.id}"
          onclick="generateVideoInline(${scene.id})"
          class="flex-1 px-3 py-2 rounded-lg font-semibold text-sm touch-manipulation ${
            isGeneratingVideo
              ? 'bg-yellow-500 text-white opacity-75 cursor-not-allowed'
              : 'bg-purple-600 text-white hover:bg-purple-700 transition-colors'
          }"
          ${isGeneratingVideo ? 'disabled' : ''}
        >
          ${isGeneratingVideo 
            ? '<i class="fas fa-spinner fa-spin mr-1"></i>生成中...'
            : hasCompletedVideo 
              ? '<i class="fas fa-redo mr-1"></i>プロンプトで再生成'
              : '<i class="fas fa-magic mr-1"></i>動画化'
          }
        </button>
      </div>
      
      ${hasCompletedVideo && existingPrompt ? `
        <div class="text-xs text-purple-600 bg-purple-100 rounded px-2 py-1">
          <i class="fas fa-info-circle mr-1"></i>現在の動画は上記プロンプトで生成されました。変更して再生成できます。
        </div>
      ` : ''}
    </div>
  `;
}

// Expose globally
window.renderVideoPromptSection = renderVideoPromptSection;

/**
 * 右カラムの「動画化」タブボタンから呼ばれる。
 * 詳細・プロンプト編集を展開し、動画プロンプトにフォーカスしてから生成を開始する。
 */
async function generateVideoFromTab(sceneId) {
  // 1. <details> 折りたたみを開く
  const detailsEl = document.getElementById(`details-fold-${sceneId}`);
  if (detailsEl && !detailsEl.open) {
    detailsEl.open = true;
  }
  
  // 2. 動画プロンプトセクションにスクロール
  const videoSection = document.getElementById(`videoPromptSection-${sceneId}`);
  if (videoSection) {
    videoSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // テキストエリアにフォーカス
    const promptEl = document.getElementById(`videoPromptInline-${sceneId}`);
    if (promptEl) {
      setTimeout(() => promptEl.focus(), 400);
    }
    return; // ユーザーにプロンプトを入力する機会を提供
  }
  
  // フォールバック
  showToast('動画プロンプトを開けませんでした。詳細を開いてお試しください。', 'warning');
}
window.generateVideoFromTab = generateVideoFromTab;

/**
 * Phase1.5: 採用切替（画像 ↔ 漫画）
 * Phase1.7: リアルタイムUI更新（スクロール位置を維持）
 */
async function switchDisplayAssetType(sceneId, newType) {
  try {
    const typeLabel = { image: '画像', comic: '漫画', video: '動画' }[newType] || newType;
    showToast(`${typeLabel}に切り替え中...`, 'info');
    
    const res = await axios.put(`/api/scenes/${sceneId}/display-asset-type`, {
      display_asset_type: newType
    });
    
    if (res.data.success) {
      showToast(`${typeLabel}を採用しました`, 'success');
      
      // Phase1.7: 対象シーンのみを再レンダリング（スクロール位置維持）
      try {
        // 最新のシーンデータを取得
        const sceneRes = await axios.get(`${API_BASE}/scenes/${sceneId}?view=board`);
        const updatedScene = sceneRes.data;
        
        // window.lastLoadedScenes を更新
        if (window.lastLoadedScenes) {
          const idx = window.lastLoadedScenes.findIndex(s => s.id === sceneId);
          if (idx !== -1) {
            window.lastLoadedScenes[idx] = updatedScene;
          }
        }
        
        // 対象のシーンカードを取得
        const sceneCard = document.getElementById(`builder-scene-${sceneId}`);
        if (sceneCard) {
          // スクロール位置を保存
          const scrollY = window.scrollY;
          
          // 新しいHTMLを生成して置換
          const newHtml = renderBuilderSceneCard(updatedScene);
          sceneCard.outerHTML = newHtml;
          
          // スクロール位置を復元
          window.scrollTo(0, scrollY);
          
          // 新しいカードのボタン状態を初期化
          const newCard = document.getElementById(`builder-scene-${sceneId}`);
          if (newCard) {
            initializeSceneCardButtons(updatedScene, newCard);
          }
          
          console.log(`[switchDisplayAssetType] Scene ${sceneId} UI updated to ${newType}`);
          
          // Phase 1-1: 漫画の文字セクションの表示/非表示を更新
          if (typeof updateComicTelopVisibility === 'function') {
            updateComicTelopVisibility();
          }
        }
      } catch (renderErr) {
        console.warn('[switchDisplayAssetType] Partial update failed, falling back to full reload:', renderErr);
        // フォールバック: 全体再読み込み
        if (typeof loadScenes === 'function') {
          await loadScenes();
        }
      }
    }
  } catch (err) {
    console.error('[switchDisplayAssetType] Error:', err);
    const errorMsg = err.response?.data?.error?.message || '切り替えに失敗しました';
    showToast(errorMsg, 'error');
  }
}

/**
 * Phase1.7: シーンカードのボタン状態を初期化
 */
function initializeSceneCardButtons(scene, cardElement) {
  const imageStatus = scene.latest_image?.status || 'pending';
  const displayAssetType = scene.display_asset_type || 'image';
  const isComicMode = displayAssetType === 'comic';
  const hasImage = scene.latest_image && imageStatus === 'completed';
  const isFailed = imageStatus === 'failed';
  
  // Primary button (再生成)
  const primaryBtn = cardElement.querySelector(`#primaryBtn-${scene.id}`);
  if (primaryBtn && !isComicMode) {
    if (window.isBulkImageGenerating) {
      primaryBtn.disabled = true;
      primaryBtn.innerHTML = '<i class="fas fa-lock mr-2"></i>一括処理中';
    } else if (isFailed) {
      setPrimaryButtonState(scene.id, 'failed');
    } else if (hasImage) {
      setPrimaryButtonState(scene.id, 'completed');
    } else {
      setPrimaryButtonState(scene.id, 'idle');
    }
  }
  
  // History button - Phase1.7: 漫画採用中も履歴は見れるようにする
  const historyBtn = cardElement.querySelector(`#historyBtn-${scene.id}`);
  if (historyBtn) {
    // active_image, active_comic, または latest_image があれば履歴ボタンを有効化
    // latest_image は is_active=0 でも履歴閲覧を許可
    const hasAnyImage = scene.active_image || scene.active_comic || scene.latest_image;
    historyBtn.disabled = !hasAnyImage;
  }
}

// グローバルに公開
window.switchDisplayAssetType = switchDisplayAssetType;

/**
 * 動画のURLをリフレッシュ（署名付きURLの期限切れ対応）
 * @param {number} videoId - 動画ID
 * @param {number} sceneId - シーンID
 */
window.refreshVideoUrl = async function(videoId, sceneId) {
  console.log(`[refreshVideoUrl] Refreshing video ${videoId} for scene ${sceneId} (CloudFront CDN)`);
  try {
    // ステータスAPIを呼び出して最新のCloudFront URLを取得
    const res = await axios.get(`${API_BASE}/videos/${videoId}/status`);
    // APIレスポンスは { video: { id, status, r2_url, ... } } 構造
    const videoData = res.data?.video || res.data;
    
    if (videoData.r2_url) {
      const videoEl = document.getElementById(`sceneVideo-${sceneId}`);
      if (videoEl) {
        // onerrorを一時的に無効化して無限ループを防ぐ
        videoEl.onerror = null;
        videoEl.src = videoData.r2_url;
        // sourceタグも更新
        const source = videoEl.querySelector('source');
        if (source) {
          source.src = videoData.r2_url;
        }
        videoEl.load();
        console.log(`[refreshVideoUrl] Updated video URL for scene ${sceneId} (CloudFront)`);
        
        // onerrorは再設定しない（CloudFront URLは永続なので再試行不要）
        // ネットワークエラーの場合のみ1回リトライ
        videoEl.onerror = () => {
          videoEl.onerror = null;
          console.warn(`[refreshVideoUrl] Video load failed permanently for scene ${sceneId}`);
        };
      }
    } else if (videoData.status === 'failed') {
      showToast('動画の生成に失敗しています', 'error');
    } else if (videoData.status === 'processing' || videoData.status === 'pending' || videoData.status === 'generating') {
      console.log(`[refreshVideoUrl] Video ${videoId} is still ${videoData.status}`);
    } else {
      console.warn(`[refreshVideoUrl] Video ${videoId} has no r2_url, status: ${videoData.status}`);
    }
  } catch (e) {
    console.error('[refreshVideoUrl] Error:', e);
  }
};

/**
 * Phase F-6: Render audio section with voice character selection
 * - Shows voice character info if assigned
 * - Radio buttons for "use character voice" vs "use scene setting"
 * @param {object} scene 
 * @returns {string} HTML
 */
function renderSceneAudioSection(scene) {
  const voiceChar = scene.voice_character || null;
  const hasVoiceChar = voiceChar && voiceChar.character_name;
  const hasCharVoice = hasVoiceChar && voiceChar.voice_preset_id;
  
  // 音声プリセットリスト（インライン定義で確実に表示）
  const voicePresets = [
    { id: 'ja-JP-Neural2-B', name: '女性A（Neural2）', gender: 'female' },
    { id: 'ja-JP-Neural2-C', name: '男性A（Neural2）', gender: 'male' },
    { id: 'ja-JP-Neural2-D', name: '男性B（Neural2）', gender: 'male' },
    { id: 'ja-JP-Wavenet-A', name: '女性A（WaveNet）', gender: 'female' },
    { id: 'ja-JP-Wavenet-B', name: '女性B（WaveNet）', gender: 'female' },
    { id: 'ja-JP-Wavenet-C', name: '男性A（WaveNet）', gender: 'male' },
    { id: 'ja-JP-Wavenet-D', name: '男性B（WaveNet）', gender: 'male' },
    { id: 'ja-JP-Standard-A', name: '女性A（Standard）', gender: 'female' },
    { id: 'ja-JP-Standard-B', name: '女性B（Standard）', gender: 'female' },
    { id: 'ja-JP-Standard-C', name: '男性A（Standard）', gender: 'male' },
    { id: 'ja-JP-Standard-D', name: '男性B（Standard）', gender: 'male' }
  ];
  
  const voiceOptions = voicePresets.map(preset => 
    `<option value="${preset.id}">${preset.name}</option>`
  ).join('');
  
  // プロジェクトのキャラクターリスト（マイキャラクター）
  const projectCharacters = window.lastLoadedCharacters || [];
  const charOptions = projectCharacters.length > 0 
    ? projectCharacters.map(char => {
        const voiceLabel = char.voice_preset_id 
          ? (char.voice_preset_id.startsWith('fish:') ? 'Fish Audio' : 'Google TTS')
          : '音声未設定';
        return `<option value="${char.character_key}" data-voice="${char.voice_preset_id || ''}">${escapeHtml(char.character_name)}（${voiceLabel}）</option>`;
      }).join('')
    : '';
  
  // Format voice preset for display
  const formatVoicePreset = (presetId) => {
    if (!presetId) return null;
    if (presetId.startsWith('fish:')) return 'Fish Audio';
    if (presetId.startsWith('google:')) return presetId.replace('google:', 'Google TTS: ');
    return presetId;
  };
  
  const charVoiceLabel = hasCharVoice 
    ? `${escapeHtml(voiceChar.character_name)} の音声（${formatVoicePreset(voiceChar.voice_preset_id)}）`
    : hasVoiceChar 
      ? `${escapeHtml(voiceChar.character_name)}（音声未設定）`
      : null;

  return `
    <div class="bg-gradient-to-br from-purple-50 to-blue-50 rounded-lg border-2 border-purple-200 overflow-hidden">
      <div class="bg-gradient-to-r from-purple-600 to-blue-600 px-4 py-2">
        <h4 class="text-white font-semibold text-sm flex items-center">
          <i class="fas fa-microphone mr-2"></i>
          このセリフの音声
        </h4>
      </div>
      <div class="p-4 space-y-3">
        <!-- Voice Source Selection -->
        <div class="space-y-2">
          ${hasVoiceChar ? `
            <!-- Option 1: Use character voice -->
            <label class="flex items-start gap-3 p-3 rounded-lg border-2 cursor-pointer transition-all
              ${hasCharVoice ? 'border-green-300 bg-green-50 hover:bg-green-100' : 'border-gray-200 bg-gray-50 opacity-60 cursor-not-allowed'}
            " id="voiceSourceChar-${scene.id}">
              <input 
                type="radio" 
                name="voiceSource-${scene.id}" 
                value="character"
                class="mt-1 w-4 h-4 text-green-600"
                ${hasCharVoice ? 'checked' : 'disabled'}
                onchange="window.toggleVoiceSource(${scene.id}, 'character')"
              />
              <div class="flex-1">
                <span class="font-semibold text-sm ${hasCharVoice ? 'text-green-800' : 'text-gray-500'}">
                  <i class="fas fa-user mr-1"></i>${charVoiceLabel}
                </span>
                ${!hasCharVoice ? `
                  <p class="text-xs text-orange-600 mt-1">
                    <i class="fas fa-exclamation-triangle mr-1"></i>
                    キャラに音声が設定されていません。Styles > Characters で設定してください。
                  </p>
                ` : ''}
              </div>
            </label>
          ` : ''}
          
          <!-- Option 2: Use scene setting (narrator) -->
          <label class="flex items-start gap-3 p-3 rounded-lg border-2 cursor-pointer transition-all border-blue-300 bg-blue-50 hover:bg-blue-100"
            id="voiceSourceScene-${scene.id}"
          >
            <input 
              type="radio" 
              name="voiceSource-${scene.id}" 
              value="scene"
              class="mt-1 w-4 h-4 text-blue-600"
              ${!hasCharVoice ? 'checked' : ''}
              onchange="window.toggleVoiceSource(${scene.id}, 'scene')"
            />
            <div class="flex-1">
              <span class="font-semibold text-sm text-blue-800">
                <i class="fas fa-sliders-h mr-1"></i>
                ${hasVoiceChar ? 'シーン設定を使用（キャラ音声を使わない）' : 'ナレーター音声を選択'}
              </span>
            </div>
          </label>
        </div>
        
        <!-- Scene Voice Settings (shown when "scene" is selected) -->
        <div id="sceneVoiceSettings-${scene.id}" class="${hasCharVoice ? 'hidden' : ''}">
          <div class="audio-section-content space-y-3">
            <!-- プロジェクトキャラクター選択 -->
            ${projectCharacters.length > 0 ? `
              <div>
                <label class="block text-sm font-semibold text-gray-700 mb-2">
                  <i class="fas fa-users mr-1 text-green-600"></i>マイキャラクターの音声
                </label>
                <div class="flex gap-2">
                  <select 
                    id="charVoiceSelect-${scene.id}"
                    class="flex-1 px-3 py-2 border-2 border-green-300 rounded-lg focus:border-green-500 text-sm bg-green-50"
                    onchange="window.selectCharacterVoice(${scene.id}, this.value)"
                  >
                    <option value="">-- キャラクターを選択 --</option>
                    ${charOptions}
                  </select>
                  <button 
                    onclick="window.generateSelectedCharVoice(${scene.id})"
                    class="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-semibold text-sm"
                  >
                    <i class="fas fa-volume-up"></i>
                  </button>
                </div>
              </div>
              <div class="border-t border-gray-200 pt-3">
                <p class="text-xs text-gray-500 mb-2 text-center">または</p>
              </div>
            ` : ''}
            
            <!-- ナレーター音声選択 -->
            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-2">
                <i class="fas fa-microphone mr-1 text-purple-600"></i>ナレーター音声
              </label>
              <div class="flex gap-2">
                <select 
                  id="voicePreset-${scene.id}"
                  class="flex-1 px-3 py-2 border-2 border-purple-300 rounded-lg focus:border-purple-500 text-sm bg-purple-50"
                >
                  ${voiceOptions}
                </select>
                <button 
                  onclick="window.generateNarratorVoice(${scene.id})"
                  class="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors font-semibold text-sm"
                >
                  <i class="fas fa-volume-up"></i>
                </button>
              </div>
            </div>
            
            <!-- 音声履歴 -->
            <button
              onclick="window.AudioUI && window.AudioUI.viewHistory(${scene.id})"
              class="w-full px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors text-sm"
            >
              <i class="fas fa-history mr-2"></i>音声履歴
            </button>
          </div>
        </div>
        
        <!-- Character Voice Generate Button (shown when "character" is selected) -->
        <div id="charVoiceSettings-${scene.id}" class="${!hasCharVoice ? 'hidden' : ''}">
          <!-- Audio Preview (will be populated when audio is generated) -->
          <div id="charAudioPreview-${scene.id}" class="mb-3 hidden">
            <!-- Audio player will be inserted here -->
          </div>
          
          <button
            id="charAudioBtn-${scene.id}"
            onclick="window.generateCharacterVoice(${scene.id})"
            class="w-full px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-semibold"
          >
            <i class="fas fa-volume-up mr-2"></i>キャラ音声で生成
          </button>
          <button
            onclick="window.AudioUI.viewHistory(${scene.id})"
            class="w-full mt-2 px-4 py-2 bg-gray-300 text-gray-700 rounded-lg hover:bg-gray-400 transition-colors font-semibold text-sm"
          >
            <i class="fas fa-history mr-2"></i>履歴
          </button>
        </div>
      </div>
    </div>
  `;
}

/**
 * Phase F-6: Render image character section (separate from audio)
 * @param {object} scene 
 * @returns {string} HTML
 */
function renderImageCharacterSection(scene) {
  const imageChars = Array.isArray(scene.characters) ? scene.characters : [];
  const topImage = imageChars.slice(0, 3).filter(c => c && c.character_name);

  const imageCharList = topImage.map((c) => {
    const name = escapeHtml(String(c.character_name));
    const starIcon = c.is_primary ? '<i class="fas fa-star text-yellow-500 mr-1" title="音声キャラ"></i>' : '';
    return `<span class="inline-flex items-center px-2 py-1 rounded-full bg-blue-100 text-blue-700 text-xs border border-blue-200">
      ${starIcon}<i class="fas fa-image mr-1"></i>${name}
    </span>`;
  }).join(' ');

  return `
    <div class="p-4 bg-blue-50 rounded-lg border border-blue-200">
      <div class="flex items-center justify-between mb-2">
        <span class="text-sm font-bold text-blue-800">
          <i class="fas fa-image mr-2"></i>画像キャラクター
        </span>
        <button
          type="button"
          class="text-xs px-3 py-1 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          data-action="open-character-assign"
          data-scene-id="${scene.id}"
        >
          <i class="fas fa-edit mr-1"></i>編集
        </button>
      </div>
      <div class="scene-character-tags flex flex-wrap gap-2" data-scene-id="${scene.id}">
        ${topImage.length > 0 
          ? imageCharList 
          : '<span class="text-sm text-gray-500">未設定（プロンプトのみで生成）</span>'}
      </div>
      <p class="text-xs text-gray-500 mt-2">
        <i class="fas fa-info-circle mr-1"></i>
        画像生成時にこのキャラクターが登場します（★は音声キャラ）
      </p>
    </div>
  `;
}

/**
 * PR-UX-2: 話者（音声）サマリーセクション
 * speaker_summary からキャラ名・ナレーションを表示
 * 推測ゼロ: speaker_summary がなければ "未設定" を表示
 * 
 * @param {object} scene 
 * @returns {string} HTML
 */
/**
 * PR-UX-2 + Phase1: 話者サマリーセクション
 * @param {object} scene 
 * @param {object} opts - { showEditButton: boolean } デフォルト true
 * @returns {string} HTML
 */
function renderSpeakerSummarySection(scene, opts = { showEditButton: true }) {
  const speakerSummary = scene.speaker_summary || null;
  const utteranceStatus = scene.utterance_status || { total: 0, with_audio: 0 };
  
  // P0-3: voice_preset_id NULL 警告
  // characters 配列から voice_preset_id が null のキャラクターを検出
  const characters = scene.characters || [];
  const voiceChar = scene.voice_character || null;
  const utteranceList = scene.utterance_list || [];
  const dialogueCharKeys = [...new Set(utteranceList.filter(u => u.role === 'dialogue' && u.character_key).map(u => u.character_key))];
  const charsWithoutVoice = dialogueCharKeys.filter(key => {
    const charInfo = characters.find(c => c.character_key === key);
    return !charInfo || !charInfo.voice_preset_id;
  });
  const voiceWarning = charsWithoutVoice.length > 0 
    ? `<div class="mt-1.5 px-2 py-1 bg-orange-100 border border-orange-300 rounded text-xs text-orange-800">
        <i class="fas fa-exclamation-triangle mr-1"></i>
        <strong>${charsWithoutVoice.map(k => {
          const c = characters.find(c => c.character_key === k);
          return c?.character_name || k;
        }).join('・')}</strong> に声が未設定です（デフォルト音声で生成されます）
       </div>` 
    : '';
  
  // 話者リスト
  let speakerDisplay = '';
  if (speakerSummary && speakerSummary.speakers && speakerSummary.speakers.length > 0) {
    speakerDisplay = speakerSummary.speakers.map(name => escapeHtml(name)).join(' / ');
  } else if (utteranceStatus.total === 0) {
    speakerDisplay = '<span class="text-gray-400">発話なし</span>';
  } else {
    speakerDisplay = '<span class="text-orange-500">未設定</span>';
  }
  
  // 発話状況バッジ
  const total = utteranceStatus.total || 0;
  const withAudio = utteranceStatus.with_audio || 0;
  const allGenerated = total > 0 && withAudio === total;
  const noneGenerated = withAudio === 0;
  const partialGenerated = total > 0 && withAudio > 0 && withAudio < total;
  
  let statusBadge = '';
  if (total === 0) {
    statusBadge = '<span class="px-2 py-0.5 bg-gray-100 text-gray-500 rounded-full text-xs">発話なし</span>';
  } else if (allGenerated) {
    statusBadge = `<span class="px-2 py-0.5 bg-green-100 text-green-700 rounded-full text-xs"><i class="fas fa-check mr-1"></i>${total}件生成済み</span>`;
  } else if (noneGenerated) {
    statusBadge = `<span class="px-2 py-0.5 bg-orange-100 text-orange-700 rounded-full text-xs"><i class="fas fa-exclamation-circle mr-1"></i>${total}件未生成</span>`;
  } else {
    statusBadge = `<span class="px-2 py-0.5 bg-blue-100 text-blue-700 rounded-full text-xs"><i class="fas fa-clock mr-1"></i>${withAudio}/${total}件生成済み</span>`;
  }
  
  // PR-Audio-Direct: 音声生成ボタン（シーンカードから直接生成可能に）
  // 未生成または一部未生成の場合に表示
  const needsAudioGeneration = total > 0 && !allGenerated;
  const audioGenButton = needsAudioGeneration ? `
    <button 
      id="audioGenBtn-${scene.id}"
      onclick="generateSceneAudio(${scene.id})"
      class="px-3 py-1.5 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors text-xs font-semibold flex items-center gap-1"
      title="このシーンの音声を一括生成"
    >
      <i class="fas fa-volume-up"></i>
      <span>音声生成</span>
      <span class="bg-purple-400 px-1.5 rounded">${total - withAudio}件</span>
    </button>
  ` : '';
  
  // Phase1: 編集ボタンはオプションで制御
  const editButton = opts.showEditButton ? `
    <button 
      onclick="openSceneEditModal(${scene.id}, 'audio')"
      class="text-xs px-2 py-1 bg-gray-200 text-gray-700 rounded hover:bg-gray-300 transition-colors"
      title="音声タブで詳細設定"
    >
      <i class="fas fa-cog mr-1"></i>詳細
    </button>
  ` : '';
  
  return `
    <div class="p-3 bg-purple-50 rounded-lg border border-purple-200">
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <span class="text-sm font-semibold text-purple-800">
            <i class="fas fa-microphone-alt mr-1"></i>話者（音声）
          </span>
          <span class="text-sm text-purple-700">${speakerDisplay}</span>
        </div>
        ${statusBadge}
      </div>
      <!-- PR-Audio-Direct: 音声生成ボタンを追加 -->
      <div class="mt-2 flex items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          ${audioGenButton}
          ${editButton}
        </div>
        ${total > 0 && utteranceStatus.total_duration_ms > 0 ? `
          <span class="text-xs text-gray-500">
            <i class="fas fa-clock mr-1"></i>${(utteranceStatus.total_duration_ms / 1000).toFixed(1)}秒
          </span>
        ` : ''}
      </div>
      ${voiceWarning}
    </div>
  `;
}

/**
 * @deprecated Kept for backward compatibility
 * @param {object} scene 
 * @returns {string} HTML
 */
function renderSceneAudioPlaceholder(scene) {
  return `
    <div class="mt-4 bg-gradient-to-br from-purple-50 to-blue-50 rounded-lg border-2 border-purple-200 overflow-hidden">
      <div class="bg-gradient-to-r from-purple-600 to-blue-600 px-4 py-2">
        <h4 class="text-white font-semibold text-sm flex items-center">
          <i class="fas fa-microphone mr-2"></i>
          音声生成
        </h4>
      </div>
      <div class="audio-section-content p-4">
        <div class="flex items-center justify-center py-8 text-gray-400">
          <i class="fas fa-spinner fa-spin text-purple-600 mr-2"></i>
          <span class="text-gray-600 text-sm">音声UIを読み込み中...</span>
        </div>
      </div>
    </div>
  `;
}

/**
 * PR-UX-1: 画像モード用の音声ガイドUI
 * 「このセリフの音声（1人）」を削除し、音声タブへの誘導に置換
 * 
 * 目的:
 * - 複数キャラの会話があっても、1人しか設定できない旧UIを削除
 * - 代わりにscene_utterances（音声タブ）への導線を提供
 * - 発話数と生成状況のサマリーを表示
 * 
 * @param {object} scene 
 * @returns {string} HTML
 */
function renderSceneAudioGuide(scene) {
  // utterance_status から情報を取得
  const utteranceStatus = scene.utterance_status || { total: 0, with_audio: 0, total_duration_ms: 0 };
  const total = utteranceStatus.total || 0;
  const withAudio = utteranceStatus.with_audio || 0;
  const allGenerated = total > 0 && withAudio === total;
  const noneGenerated = withAudio === 0;
  
  // 状態に応じたアイコンと色
  let statusIcon, statusColor, statusText, statusBg;
  if (total === 0) {
    statusIcon = 'fa-microphone-slash';
    statusColor = 'text-gray-500';
    statusText = '発話なし';
    statusBg = 'bg-gray-50 border-gray-200';
  } else if (allGenerated) {
    statusIcon = 'fa-check-circle';
    statusColor = 'text-green-600';
    statusText = `${total}件すべて生成済み`;
    statusBg = 'bg-green-50 border-green-200';
  } else if (noneGenerated) {
    statusIcon = 'fa-exclamation-circle';
    statusColor = 'text-orange-600';
    statusText = `${total}件 未生成`;
    statusBg = 'bg-orange-50 border-orange-200';
  } else {
    statusIcon = 'fa-clock';
    statusColor = 'text-blue-600';
    statusText = `${withAudio}/${total}件 生成済み`;
    statusBg = 'bg-blue-50 border-blue-200';
  }
  
  return `
    <div class="bg-gradient-to-br from-purple-50 to-blue-50 rounded-lg border-2 border-purple-200 overflow-hidden">
      <div class="bg-gradient-to-r from-purple-600 to-blue-600 px-4 py-2">
        <h4 class="text-white font-semibold text-sm flex items-center">
          <i class="fas fa-microphone-alt mr-2"></i>
          音声設定
        </h4>
      </div>
      <div class="p-4 space-y-3">
        <!-- 発話サマリー -->
        <div class="flex items-center justify-between p-3 ${statusBg} rounded-lg border">
          <div class="flex items-center gap-2">
            <i class="fas ${statusIcon} ${statusColor}"></i>
            <span class="text-sm font-semibold ${statusColor}">${statusText}</span>
          </div>
          ${total > 0 && utteranceStatus.total_duration_ms > 0 ? `
            <span class="text-xs text-gray-500">
              <i class="fas fa-clock mr-1"></i>${(utteranceStatus.total_duration_ms / 1000).toFixed(1)}秒
            </span>
          ` : ''}
        </div>
        
        <!-- ガイドテキスト -->
        <div class="text-sm text-gray-600">
          <p class="mb-2">
            <i class="fas fa-info-circle mr-1 text-purple-500"></i>
            複数キャラクターの会話は<strong>「音声タブ」</strong>で発話ごとに設定できます。
          </p>
          <ul class="text-xs text-gray-500 space-y-1 ml-5 list-disc">
            <li>各セリフに話者（キャラ/ナレーション）を設定</li>
            <li>発話ごとに音声を生成</li>
            <li>順番の入れ替えも可能</li>
          </ul>
        </div>
        
        <!-- P2-2: テロップタイムラインプレビュー -->
        ${renderTelopTimeline(scene)}
        
        <!-- 音声タブを開くボタン -->
        <button 
          onclick="openSceneEditModal(${scene.id}, 'audio')"
          class="w-full px-4 py-3 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors font-semibold text-sm flex items-center justify-center gap-2"
        >
          <i class="fas fa-microphone-alt"></i>
          音声タブで編集
          ${total > 0 && !allGenerated ? '<span class="ml-2 px-2 py-0.5 bg-orange-400 rounded-full text-xs">要設定</span>' : ''}
        </button>
      </div>
    </div>
  `;
}



/**
 * Render complete scene card (Phase F-6: Improved layout)
 * - セリフの直下に音声設定
 * - 画像キャラと音声キャラを分離
 * - Phase1.7: 漫画モード時のボタン制御追加
 * @param {object} scene 
 * @returns {string} HTML
 */
function renderBuilderSceneCard(scene) {
  // デバッグ: シーンデータの確認
  if (!scene || !scene.id) {
    console.error('[renderBuilderSceneCard] Invalid scene data:', scene);
    return '<div class="bg-red-100 border border-red-400 p-4 rounded">シーンデータが無効です</div>';
  }
  console.log(`[renderBuilderSceneCard] Rendering scene #${scene.idx} (id=${scene.id}), display_asset_type=${scene.display_asset_type}`);
  
  const activeImage = scene.active_image || null;
  const latestImage = scene.latest_image || null;
  // Phase1.7: imageUrl は active_image, または latest_image (fallback) から取得
  const imageUrl = activeImage?.image_url || activeImage?.r2_url 
    || (latestImage?.status === 'completed' ? (latestImage?.image_url || latestImage?.r2_url) : null);
  const imageStatus = latestImage ? latestImage.status : 'pending';
  const errorMessage = latestImage?.error_message || null;
  const isFailed = imageStatus === 'failed';
  
  // Phase1.7: 漫画モード判定
  const displayAssetType = scene.display_asset_type || 'image';
  const isComicMode = displayAssetType === 'comic';
  const activeVideo = scene.active_video || null;
  const hasCompletedVideo = activeVideo && activeVideo.status === 'completed' && activeVideo.r2_url;
  
  // Phase1.7: 漫画モード時は再生成・動画化を非活性化
  const disableRegenerate = isComicMode;
  const disableVideoGen = isComicMode;
  
  return `
    <div class="bg-white rounded-lg border-2 border-gray-200 shadow-md overflow-hidden" id="builder-scene-${scene.id}" data-scene-id="${scene.id}" data-status="${imageStatus}" data-display-asset-type="${displayAssetType}">
      ${renderSceneCardHeader(scene, imageStatus)}
      
      <!-- Content: Left-Right Split (PC) / Top-Bottom (Mobile) -->
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 p-6">
        <!-- Left: Text Content (includes Audio under dialogue) -->
        <div class="space-y-4">
          ${renderSceneTextContent(scene, imageStatus, disableVideoGen)}
        </div>
        
        <!-- Right: Image Preview & Actions -->
        <div class="space-y-4">
          ${renderSceneImageSection(scene, imageUrl, imageStatus)}
          
          <!-- 画像アクションボタン（画像の直下） -->
          <div class="flex gap-2">
            <button 
              id="primaryBtn-${scene.id}" 
              class="flex-1 px-4 py-2 rounded-lg font-semibold touch-manipulation ${disableRegenerate ? 'bg-gray-300 text-gray-500 cursor-not-allowed' : ''}"
              ${disableRegenerate ? 'disabled' : ''}
              title="${disableRegenerate ? '漫画採用中は画像を再生成できません。画像モードに切り替えてください。' : ''}"
            >
              ${disableRegenerate ? '<i class="fas fa-lock mr-2"></i>再生成不可' : '読み込み中...'}
            </button>
            <button 
              id="historyBtn-${scene.id}" 
              onclick="viewImageHistory(${scene.id})" 
              class="px-4 py-2 rounded-lg font-semibold touch-manipulation"
            >
              <i class="fas fa-history mr-2"></i>履歴
            </button>
          </div>
          
          ${disableRegenerate ? `
          <p class="text-xs text-orange-600 bg-orange-50 rounded px-3 py-2">
            <i class="fas fa-info-circle mr-1"></i>
            漫画採用中は画像の再生成ができません。画像を変更するには「画像を採用」に切り替えてください。
          </p>
          ` : ''}
          
          
          ${isFailed && errorMessage && !activeImage ? `
          <div class="bg-red-50 border-2 border-red-200 rounded-lg p-4">
            <p class="text-sm font-semibold text-red-800 mb-2">
              <i class="fas fa-exclamation-circle mr-1"></i>画像生成に失敗しました
            </p>
            <div class="text-xs text-red-700 bg-red-100 rounded p-2 font-mono whitespace-pre-wrap">
${escapeHtml(errorMessage)}
            </div>
          </div>
          ` : ''}
          
          <!-- Phase F-6: Image characters now in left column, under prompt -->
        </div>
      </div>
    </div>
  `;
}

// Render builder scene cards (Phase X-0: with pagination support)
function renderBuilderScenes(scenes, page = 1) {
  // ⚠️ PHASE X-5: Removed World tab skip guard (World & Characters moved to Styles tab)
  // Previous guard: if (window.WorldCharacterUI?.currentTab === 'world') return;
  // No longer needed - Builder always renders independently

  // Cache scenes for re-rendering during bulk generation
  window.lastLoadedScenes = scenes;
  
  // Phase 1-1: シーン読み込み後に漫画の文字セクションの表示/非表示を更新
  if (typeof updateComicTelopVisibility === 'function') {
    updateComicTelopVisibility();
  }
  
  const container = document.getElementById('builderScenesList');
  
  // フィルタリング適用（グローバル変数 currentFilter）
  const allFilteredScenes = filterScenes(scenes, window.currentFilter || 'all');
  
  // Update pagination state
  window.builderPagination.totalScenes = allFilteredScenes.length;
  window.builderPagination.currentPage = page;
  
  // Paginate filtered scenes
  const pageSize = window.builderPagination.pageSize;
  const startIdx = (page - 1) * pageSize;
  const endIdx = startIdx + pageSize;
  const filteredScenes = allFilteredScenes.slice(startIdx, endIdx);
  
  // Debug: Log pagination info
  console.log(`[Builder] Page ${page}: Rendering ${filteredScenes.length} of ${allFilteredScenes.length} scenes (${startIdx}-${endIdx})`);
  
  if (filteredScenes.length > 0) {
    console.log(`[Builder] First scene style_preset_id:`, filteredScenes[0].style_preset_id);
  }
  
  container.innerHTML = filteredScenes.map(scene => renderBuilderSceneCard(scene)).join('');
  
  // ✅ 初期状態を設定（レンダリング直後に実行）
  filteredScenes.forEach(scene => {
    const activeImage = scene.active_image || null;
    const latestImage = scene.latest_image || null;
    const imageStatus = latestImage ? latestImage.status : 'pending';
    const isFailed = imageStatus === 'failed';
    const hasImage = latestImage && imageStatus === 'completed';
    
    // Phase1.7: 漫画モード判定
    const displayAssetType = scene.display_asset_type || 'image';
    const isComicMode = displayAssetType === 'comic';
    
    // 状態に応じて初期ボタンを設定
    // Phase1.7: 漫画モード時はボタン状態を変更しない（HTMLで既に設定済み）
    if (isComicMode) {
      // 漫画モード時はスキップ（renderBuilderSceneCardで既に無効化済み）
      console.log(`[Builder] Scene ${scene.id}: Comic mode - keeping disabled state`);
    } else if (window.isBulkImageGenerating) {
      // 一括処理中は無効化
      const primaryBtn = document.getElementById(`primaryBtn-${scene.id}`);
      if (primaryBtn) {
        primaryBtn.disabled = true;
        primaryBtn.className = 'flex-1 px-4 py-2 bg-gray-400 text-white rounded-lg cursor-not-allowed font-semibold touch-manipulation';
        primaryBtn.innerHTML = '<i class="fas fa-lock mr-2"></i>一括処理中';
      }
    } else if (isFailed) {
      setPrimaryButtonState(scene.id, 'failed', 0);
    } else if (hasImage) {
      setPrimaryButtonState(scene.id, 'completed', 0);
    } else {
      setPrimaryButtonState(scene.id, 'idle', 0);
    }
    
    // 履歴ボタンを設定 - Phase1.7: 漫画採用中も履歴は見れるようにする
    const historyBtn = document.getElementById(`historyBtn-${scene.id}`);
    if (historyBtn) {
      // active_image, active_comic, または latest_image があれば履歴ボタンを有効化
      const hasAnyImage = activeImage || scene.active_comic || scene.latest_image;
      historyBtn.disabled = !hasAnyImage;
      historyBtn.className = `px-4 py-2 rounded-lg font-semibold touch-manipulation ${
        hasAnyImage ? 'bg-gray-600 text-white hover:bg-gray-700 transition-colors' : 'bg-gray-400 text-gray-200 cursor-not-allowed'
      }`;
      historyBtn.innerHTML = '<i class="fas fa-history mr-2"></i>履歴';
    }
  });
  
  // ========== Phase 3: Audio UI Initialization ==========
  // Initialize audio UI for visible scenes (Phase X-0: lazy loading with IntersectionObserver)
  if (window.AudioUI && typeof window.AudioUI.initForVisibleScenes === 'function') {
    console.log('[Builder] Initializing Audio UI for visible scenes (lazy loading)');
    
    // Phase X-0: Fix - Disconnect observer before re-initializing (prevent memory leak)
    if (window.AudioUI.observer) {
      window.AudioUI.observer.disconnect();
      console.log('[AudioUI] Disconnected previous observer to prevent memory leak');
    }
    
    window.AudioUI.initForVisibleScenes(filteredScenes);
  } else if (window.AudioUI && typeof window.AudioUI.initForScenes === 'function') {
    // Fallback to old method if new method not available
    console.log('[Builder] Initializing Audio UI for all scenes (fallback)');
    window.AudioUI.initForScenes(filteredScenes);
  }
  
  // Load existing audio for character voice sections (show preview if audio exists)
  if (window.AudioState && typeof window.AudioState.loadExistingAudioForScenes === 'function') {
    const sceneIds = filteredScenes.map(s => s.id);
    // Run async without blocking
    window.AudioState.loadExistingAudioForScenes(sceneIds).catch(err => {
      console.warn('[Builder] Failed to load existing audio:', err);
    });
  }
  
  // ⚠️ PHASE X-5: WorldCharacterUI.init() moved to initStylesTab()
  // World & Characters panel now lives in Styles tab (not Builder)
  // Previous: WorldCharacterUI.init() was called here
  
  // ========== Phase X-2 UI-3: Character Tag Click Handler ==========
  // Initialize character tag click events (idempotent, event delegation)
  initCharacterTagEvents();
  
  // ========== Phase X-5: Load Character Traits for Scenes ==========
  // Load character traits for each visible scene (async, non-blocking)
  // Throttled to avoid overwhelming the API with parallel requests
  setTimeout(async () => {
    const BATCH_SIZE = 3; // Load 3 scenes at a time
    for (let i = 0; i < filteredScenes.length; i += BATCH_SIZE) {
      const batch = filteredScenes.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(scene => loadBuilderSceneCharTraits(scene.id)));
    }
  }, 100);
  
  // ========== Phase X-0: Pagination Controls ==========
  renderPaginationControls(allFilteredScenes.length, page);
}

/**
 * Initialize character tag click events (Phase X-2 UI-3)
 * - Event delegation pattern (safe for re-rendering)
 * - Idempotent (only binds once)
 * - Opens assignment modal (UI-4) or shows placeholder toast
 */
function initCharacterTagEvents() {
  // Idempotent: bind only once
  if (window.__characterTagEventsBound) return;
  window.__characterTagEventsBound = true;

  document.addEventListener('click', (e) => {
    const btn = e.target?.closest?.('[data-action="open-character-assign"]');
    if (!btn) return;

    const sceneId = Number(btn.getAttribute('data-scene-id'));
    if (!Number.isFinite(sceneId)) return;

    // UI-4 will implement assignment modal. For now, safe placeholder.
    if (window.WorldCharacterModal && typeof window.WorldCharacterModal.openAssign === 'function') {
      window.WorldCharacterModal.openAssign(sceneId); // UI-4で実装予定
      return;
    }

    // Fallback: UI-4 not loaded
    if (window.showToast) {
      window.showToast(`シーン #${sceneId} のキャラクター割当編集（UI-4未ロード）`, 'warning');
    } else {
      alert(`シーン #${sceneId} のキャラクター割当編集（UI-4未ロード）`);
    }
  }, { passive: true });

  console.log('[CharacterTags] Click event handler initialized');
}

// Render pagination controls (Phase X-0)
function renderPaginationControls(totalScenes, currentPage) {
  const pageSize = window.builderPagination.pageSize;
  const totalPages = Math.ceil(totalScenes / pageSize);
  
  const container = document.getElementById('builderScenesList');
  
  // Remove existing pagination
  const existingPagination = container.querySelector('.builder-pagination');
  if (existingPagination) {
    existingPagination.remove();
  }
  
  // No pagination needed for <= 20 scenes
  if (totalPages <= 1) {
    return;
  }
  
  // Create pagination HTML
  const paginationHTML = `
    <div class="builder-pagination flex items-center justify-center gap-4 mt-6 pb-6 border-t pt-6">
      <button 
        id="prevPageBtn" 
        class="px-4 py-2 bg-blue-600 text-white hover:bg-blue-700 rounded-lg font-semibold disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-gray-400 transition-colors"
        ${currentPage === 1 ? 'disabled' : ''}
      >
        <i class="fas fa-arrow-left mr-2"></i>前へ
      </button>
      
      <span class="text-gray-700 font-semibold">
        ページ <span class="text-blue-600">${currentPage}</span> / ${totalPages}
        <span class="text-gray-500 text-sm ml-2">（全 ${totalScenes} シーン）</span>
      </span>
      
      <button 
        id="nextPageBtn" 
        class="px-4 py-2 bg-blue-600 text-white hover:bg-blue-700 rounded-lg font-semibold disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-gray-400 transition-colors"
        ${currentPage === totalPages ? 'disabled' : ''}
      >
        次へ<i class="fas fa-arrow-right ml-2"></i>
      </button>
    </div>
  `;
  
  container.insertAdjacentHTML('beforeend', paginationHTML);
  
  // Event listeners
  const prevBtn = document.getElementById('prevPageBtn');
  const nextBtn = document.getElementById('nextPageBtn');
  
  if (prevBtn) {
    prevBtn.addEventListener('click', () => {
      if (currentPage > 1) {
        renderBuilderScenes(window.lastLoadedScenes, currentPage - 1);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });
  }
  
  if (nextBtn) {
    nextBtn.addEventListener('click', () => {
      if (currentPage < totalPages) {
        renderBuilderScenes(window.lastLoadedScenes, currentPage + 1);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });
  }
}

// ========== Task C: State-driven button management ==========
/**
 * Set primary button state (IDLE/RUNNING/DONE/FAILED)
 * @param {number} sceneId 
 * @param {string} state - 'IDLE' | 'RUNNING' | 'DONE' | 'FAILED'
 * @param {number} percent - Progress percentage (for RUNNING state)
 */
function setPrimaryButtonState(sceneId, state, percent = 0) {
  const primaryBtn = document.getElementById(`primaryBtn-${sceneId}`);
  if (!primaryBtn) {
    console.warn(`[setPrimaryButtonState] primaryBtn not found for scene ${sceneId}`);
    return;
  }

  // Remove all state classes
  primaryBtn.classList.remove(
    'bg-blue-600', 'hover:bg-blue-700',     // IDLE
    'bg-yellow-500', 'opacity-75',           // RUNNING
    'bg-green-600', 'hover:bg-green-700',   // DONE
    'bg-red-600', 'hover:bg-red-700',       // FAILED
    'bg-orange-600', 'hover:bg-orange-700', // FAILED (alternative)
    'cursor-not-allowed'
  );

  switch (state.toLowerCase()) {
    case 'idle':
      // Blue button: "画像生成"
      primaryBtn.classList.add('bg-blue-600', 'hover:bg-blue-700');
      primaryBtn.disabled = false;
      primaryBtn.onclick = () => generateSceneImage(sceneId);
      primaryBtn.innerHTML = `<i class="fas fa-magic mr-2"></i>画像生成`;
      break;

    case 'generating':
    case 'running':
      // Yellow button: "生成中... XX%" (disabled)
      primaryBtn.classList.add('bg-yellow-500', 'opacity-75', 'cursor-not-allowed');
      primaryBtn.disabled = true;
      primaryBtn.onclick = null;
      primaryBtn.innerHTML = `<i class="fas fa-spinner fa-spin mr-2"></i>生成中... ${percent}%`;
      console.log(`[Progress] Scene ${sceneId}: ${percent}%`);
      
      // ✅ Also disable video button and prompt during image generation
      const videoBtn = document.getElementById(`videoBtn-${sceneId}`);
      if (videoBtn) {
        videoBtn.disabled = true;
        videoBtn.classList.remove('bg-purple-600', 'hover:bg-purple-700');
        videoBtn.classList.add('bg-gray-300', 'text-gray-500', 'cursor-not-allowed');
      }
      const vpEl = document.getElementById(`videoPromptInline-${sceneId}`);
      const veEl = document.getElementById(`videoEngineInline-${sceneId}`);
      if (vpEl) vpEl.disabled = true;
      if (veEl) veEl.disabled = true;
      break;

    case 'completed':
    case 'done':
      // Green button: "再生成"
      primaryBtn.classList.add('bg-green-600', 'hover:bg-green-700');
      primaryBtn.disabled = false;
      primaryBtn.onclick = () => regenerateSceneImage(sceneId);
      primaryBtn.innerHTML = `<i class="fas fa-redo mr-2"></i>再生成`;
      
      // ✅ Enable video button and prompt when image is completed
      const videoBtnDone = document.getElementById(`videoBtn-${sceneId}`);
      if (videoBtnDone) {
        videoBtnDone.disabled = false;
        videoBtnDone.classList.remove('bg-gray-300', 'text-gray-500', 'cursor-not-allowed');
        videoBtnDone.classList.add('bg-purple-600', 'text-white', 'hover:bg-purple-700');
      }
      const vpElDone = document.getElementById(`videoPromptInline-${sceneId}`);
      const veElDone = document.getElementById(`videoEngineInline-${sceneId}`);
      if (vpElDone) vpElDone.disabled = false;
      if (veElDone) veElDone.disabled = false;
      break;

    case 'failed':
      // Red button: "再生成" (after failure)
      primaryBtn.classList.add('bg-red-600', 'hover:bg-red-700');
      primaryBtn.disabled = false;
      primaryBtn.onclick = () => regenerateSceneImage(sceneId);
      primaryBtn.innerHTML = `<i class="fas fa-redo mr-2"></i>再生成`;
      break;

    default:
      console.error(`[setPrimaryButtonState] Invalid state: ${state}`);
  }
}

// ✅ Expose to window for debugging and external access
window.setPrimaryButtonState = setPrimaryButtonState;

// Get role text
function getRoleText(role) {
  const roleMap = {
    'hook': '導入・つかみ',
    'context': '背景・文脈',
    'main_point': '主要ポイント',
    'evidence': '根拠・証拠',
    'timeline': '時系列',
    'analysis': '分析・考察',
    'summary': 'まとめ',
    'cta': '行動喚起'
  };
  return roleMap[role] || role;
}

// Get image status badge
function getImageStatusBadge(status) {
  const statusMap = {
    'pending': '<span class="px-2 py-1 bg-gray-100 text-gray-800 text-xs rounded">未生成</span>',
    'generating': '<span class="px-2 py-1 bg-yellow-100 text-yellow-800 text-xs rounded">生成中</span>',
    'completed': '<span class="px-2 py-1 bg-green-100 text-green-800 text-xs rounded">生成済み</span>',
    'failed': '<span class="px-2 py-1 bg-red-100 text-red-800 text-xs rounded">失敗</span>'
  };
  return statusMap[status] || statusMap['pending'];
}

// SceneCard用ステータスバッジ（右上、スピナー付き）
function getSceneStatusBadge(status) {
  const statusMap = {
    'pending': '<span class="px-3 py-1 bg-gray-100 text-gray-800 text-sm rounded-full font-semibold">未生成</span>',
    'generating': '<span class="px-3 py-1 bg-yellow-100 text-yellow-800 text-sm rounded-full font-semibold"><i class="fas fa-spinner fa-spin mr-1"></i>生成中</span>',
    'completed': '<span class="px-3 py-1 bg-green-100 text-green-800 text-sm rounded-full font-semibold"><i class="fas fa-check mr-1"></i>生成済み</span>',
    'failed': '<span class="px-3 py-1 bg-red-100 text-red-800 text-sm rounded-full font-semibold"><i class="fas fa-times mr-1"></i>失敗</span>'
  };
  return statusMap[status] || statusMap['pending'];
}

// フィルタリング関数
function filterScenes(scenes, filter) {
  if (filter === 'all') return scenes;
  return scenes.filter(scene => {
    const status = scene.latest_image?.status || 'pending';
    return status === filter;
  });
}

// ステータス集計
function getSceneStats(scenes) {
  const stats = { completed: 0, generating: 0, failed: 0, pending: 0 };
  scenes.forEach(scene => {
    const status = scene.latest_image?.status || 'pending';
    stats[status] = (stats[status] || 0) + 1;
  });
  return stats;
}

// Generate single scene image
async function generateSceneImage(sceneId) {
  // ⚠️ Check project status FIRST - image generation requires 'formatted' or later
  const allowedStatuses = ['formatted', 'generating_images', 'completed'];
  if (currentProject && !allowedStatuses.includes(currentProject.status)) {
    const statusMsg = currentProject.status === 'uploaded' || currentProject.status === 'transcribed'
      ? '画像生成にはFormat（シーン分割）の完了が必要です。Scene Splitタブでフォーマットを実行してください。'
      : `現在のプロジェクトステータス（${currentProject.status}）では画像生成できません。`;
    showToast(statusMsg, 'error');
    return;
  }
  
  // Check if bulk generation is in progress
  if (window.isBulkImageGenerating) {
    showToast('一括画像生成中です。完了後に個別生成をお試しください', 'warning');
    return;
  }
  
  if (window.sceneProcessing[sceneId]) {
    showToast('このシーンは画像生成中です', 'warning');
    return;
  }
  
  // ⚠️ Check if video generation is in progress for this scene
  if (window.videoGenerating && window.videoGenerating[sceneId]) {
    showToast('このシーンは動画生成中です。完了後にお試しください', 'warning');
    return;
  }
  
  window.sceneProcessing[sceneId] = true;
  
  // Update prompt if edited
  const prompt = document.getElementById(`builderPrompt-${sceneId}`)?.value.trim();
  if (prompt) {
    try {
      await axios.put(`${API_BASE}/scenes/${sceneId}`, {
        image_prompt: prompt
      });
    } catch (error) {
      console.error('Update prompt error:', error);
    }
  }
  
  // ✅ Start fake progress timer BEFORE API call (for synchronous API)
  startGenerationWatch(sceneId);
  
  // Wait for next tick to ensure DOM is ready
  await new Promise(resolve => setTimeout(resolve, 0));
  
  updateGeneratingButtonUI(sceneId, 0); // Show 0% immediately
  
  let fakePercent = 0;
  const fakeStart = Date.now();
  const fakeTimer = setInterval(() => {
    const elapsed = (Date.now() - fakeStart) / 1000;
    if (elapsed < 45) {
      fakePercent = Math.round((elapsed / 45) * 80); // 0-45s → 0-80%
    } else if (elapsed < 90) {
      fakePercent = 80 + Math.round(((elapsed - 45) / 45) * 15); // 45-90s → 80-95%
    } else {
      fakePercent = 95; // 90s+ → stuck at 95%
    }
    updateGeneratingButtonUI(sceneId, fakePercent);
  }, 1000); // Update every 1 second
  
  try {
    const response = await axios.post(`${API_BASE}/scenes/${sceneId}/generate-image`);
    
    // Stop fake timer
    clearInterval(fakeTimer);
    
    // Show 100% briefly before updating
    updateGeneratingButtonUI(sceneId, 100);
    
    console.log('🔍 Generate image API response:', response.data);
    
    // Check for image_generation_id (new API) or id (old API)
    const imageGenId = response.data.image_generation_id || response.data.id;
    const responseStatus = response.data.status;
    
    if (imageGenId) {
      // ✅ CASE 1: API returns 'completed' (synchronous generation)
      if (responseStatus === 'completed') {
        console.log(`✅ Image generation completed immediately for scene ${sceneId}`);
        showToast('画像生成が完了しました', 'success');
        
        // Small delay to show 100% before updating card
        setTimeout(async () => {
          stopGenerationWatch(sceneId);
          window.sceneProcessing[sceneId] = false;
          
          // Update card immediately (no polling needed)
          await updateSingleSceneCard(sceneId);
          await checkAndUpdateProjectStatus();
        }, 500);
        return;
      }
      
      // ✅ CASE 2: API returns 'generating' or 'pending' (asynchronous generation)
      showToast('画像生成を開始しました', 'success');
      
      // Update only this scene's status badge to "generating" (no full reload)
      const sceneCard = document.getElementById(`builder-scene-${sceneId}`);
      if (sceneCard) {
        const statusBadge = sceneCard.querySelector('.bg-gradient-to-r > div:last-child');
        if (statusBadge) {
          statusBadge.innerHTML = getSceneStatusBadge('generating');
        }
      }
      
      // ✅ Start polling for completion (fake timer already running)
      console.log(`✅ Starting generation watch for scene ${sceneId}, image_gen_id: ${imageGenId}, status: ${responseStatus}`);
      pollSceneImageGeneration(sceneId);
    } else {
      console.error('❌ API response does not contain image_generation_id or id:', response.data);
      showToast('画像生成に失敗しました', 'error');
      stopGenerationWatch(sceneId);
      window.sceneProcessing[sceneId] = false;
      await updateSingleSceneCard(sceneId);
    }
  } catch (error) {
    console.error('Generate image error:', error);
    
    // Log detailed error information
    if (error.response) {
      console.error('Error response data:', error.response.data);
      console.error('Error response status:', error.response.status);
      
      // ✅ SPECIAL CASE: 524 timeout - DON'T stop timer, switch to polling
      if (error.response.status === 524) {
        console.warn(`⏰ 524 timeout detected for scene ${sceneId}. Switching to polling (fake timer continues at 95%)...`);
        showToast('生成に時間がかかっています（処理は継続中）', 'info');
        
        // DON'T clear fakeTimer - let it continue to 95%
        // DON'T stop generation watch - already started
        
        // Update status badge
        const sceneCard = document.getElementById(`builder-scene-${sceneId}`);
        if (sceneCard) {
          const statusBadge = sceneCard.querySelector('.bg-gradient-to-r > div:last-child');
          if (statusBadge) {
            statusBadge.innerHTML = getSceneStatusBadge('generating');
          }
        }
        
        // Start polling to check if generation completes server-side
        pollSceneImageGeneration(sceneId);
        return; // Don't show error toast or update card
      }
      
      // For other errors, stop timer and show error
      clearInterval(fakeTimer);
      stopGenerationWatch(sceneId);
      
      // Show detailed error message for other errors
      const errorCode = error.response.data?.error?.code;
      let errorMsg = error.response.data?.error?.message || error.message || '画像生成中にエラーが発生しました';
      
      // Add helpful guidance for common errors
      if (errorCode === 'INVALID_STATUS') {
        errorMsg = '画像生成にはFormat（シーン分割）の完了が必要です。Scene Splitタブでフォーマットを実行してください。';
      } else if (errorMsg.includes('RATE_LIMIT_429')) {
        // レート制限時は残り時間とともに通知
        const waitSeconds = 120; // 2分待機を推奨
        errorMsg = `APIレート制限に達しました。約${Math.floor(waitSeconds / 60)}分後に再試行してください。\n（Gemini無料枠: 1分間に15リクエストまで）`;
        
        // 自動再試行カウントダウンの開始（オプション）
        showRateLimitCountdown(sceneId, waitSeconds);
      }
      
      showToast(errorMsg, 'error');
    } else {
      clearInterval(fakeTimer);
      stopGenerationWatch(sceneId);
      showToast('画像生成中にエラーが発生しました', 'error');
    }
    
    window.sceneProcessing[sceneId] = false;
    await updateSingleSceneCard(sceneId);
  }
}

// Regenerate scene image
async function regenerateSceneImage(sceneId) {
  await generateSceneImage(sceneId);
}

// Bulk image generation
async function generateBulkImages(mode) {
  if (isProcessing) {
    showToast('処理中です。しばらくお待ちください', 'warning');
    return;
  }
  
  // Phase X-4: 事前チェック - 対象がない場合は早期リターン
  const currentScenes = window.lastLoadedScenes || [];
  const stats = getSceneStats(currentScenes);
  const total = stats.completed + stats.pending + stats.failed + stats.generating;
  
  // 🔍 DEBUG: Log stats for troubleshooting
  console.log(`[BULK] generateBulkImages called with mode=${mode}`);
  console.log(`[BULK] Stats:`, stats, `total=${total}`);
  console.log(`[BULK] currentScenes count:`, currentScenes.length);
  
  if (mode === 'all' && stats.completed === total && total > 0) {
    console.log('[BULK] Early return: all images completed');
    showToast('すべての画像は生成済みです', 'info');
    return;
  }
  if (mode === 'pending' && stats.pending === 0) {
    console.log('[BULK] Early return: no pending images');
    showToast('未生成の画像はありません', 'info');
    return;
  }
  if (mode === 'failed' && stats.failed === 0) {
    console.log('[BULK] Early return: no failed images (stats.failed=0)');
    // 🔍 DEBUG: Show actual scene statuses
    currentScenes.forEach((s, i) => {
      console.log(`[BULK] Scene ${i}: id=${s.id}, latest_image.status=${s.latest_image?.status}`);
    });
    showToast('失敗した画像はありません', 'info');
    return;
  }
  
  isProcessing = true;
  window.isBulkImageGenerating = true;  // Set global bulk generation flag
  
  // Re-render Builder UI to disable individual buttons
  if (currentScenes.length > 0) {
    renderBuilderScenes(currentScenes);
  }
  
  const buttonId = mode === 'all' ? 'generateAllImagesBtn' 
                 : mode === 'pending' ? 'generatePendingImagesBtn'
                 : 'generateFailedImagesBtn';
  setButtonLoading(buttonId, true);
  
  const modeText = mode === 'all' ? '全シーン' 
                 : mode === 'pending' ? '未生成シーン'
                 : '失敗シーン';
  
  try {
    showToast(`${modeText}の画像生成を開始します...`, 'info');
    
    // ★ mode === 'all' の場合のみ generate-all-images を使用（同期処理だがUI改善）
    // mode === 'failed' と 'pending' はポーリング方式を使用してリアルタイム進捗を表示
    if (mode === 'all') {
      console.log(`[BULK] Using generate-all-images endpoint with mode=${mode}`);
      
      // 進捗表示を開始（バックグラウンドでポーリング）
      const progressInterval = setInterval(async () => {
        try {
          const statusRes = await axios.get(`${API_BASE}/projects/${PROJECT_ID}/generate-images/status`);
          const { processed, pending, failed, generating } = statusRes.data;
          const total = processed + pending + failed + generating;
          const progressText = `画像生成中... (${processed}/${total})`;
          const btn = document.getElementById(buttonId);
          if (btn) {
            btn.innerHTML = `<i class="fas fa-spinner fa-spin mr-2"></i>${progressText}`;
          }
          
          // シーン一覧を更新して進捗を表示
          const scenesRes = await axios.get(`${API_BASE}/projects/${PROJECT_ID}/scenes?view=board`);
          const scenes = scenesRes.data.scenes || [];
          scenes.forEach(async (scene) => {
            const imageStatus = scene.latest_image?.status || 'pending';
            if (imageStatus === 'generating' && !window.generatingSceneWatch?.[scene.id]) {
              startGenerationWatch(scene.id);
            } else if (imageStatus === 'completed' && window.generatingSceneWatch?.[scene.id]) {
              stopGenerationWatch(scene.id);
              // updateSingleSceneCard でカード全体を更新
              await updateSingleSceneCard(scene.id);
            }
          });
        } catch (e) {
          console.warn('[BULK] Progress polling error:', e);
        }
      }, 3000);
      
      try {
        const response = await axios.post(`${API_BASE}/projects/${PROJECT_ID}/generate-all-images`, { mode }, {
          timeout: 600000 // 10分タイムアウト
        });
        const { total_scenes, success_count, failed_count } = response.data;
        
        if (failed_count > 0) {
          showToast(`画像生成完了！ (成功: ${success_count}件, 失敗: ${failed_count}件)`, 'warning');
        } else {
          showToast(`画像生成完了！ (${success_count}件)`, 'success');
        }
        
        await initBuilderTab();
      } catch (error) {
        console.error('[BULK] generate-all-images error:', error);
        const errorMsg = error.response?.data?.error?.message || '画像生成に失敗しました';
        showToast(errorMsg, 'error');
      } finally {
        clearInterval(progressInterval);
      }
      
      return; // early return for all mode
    }
    
    // mode === 'pending' または 'failed' の場合はポーリング方式
    // 5秒ごとにステータスポーリング & 自動再実行
    
    // 失敗シーンを取得（mode === 'failed' の場合）
    let failedSceneIds = [];
    if (mode === 'failed') {
      const scenesRes = await axios.get(`${API_BASE}/projects/${PROJECT_ID}/scenes?view=board`);
      const scenes = scenesRes.data.scenes || [];
      failedSceneIds = scenes
        .filter(s => s.latest_image?.status === 'failed')
        .map(s => s.id);
      console.log(`[BULK] Found ${failedSceneIds.length} failed scenes:`, failedSceneIds);
      
      if (failedSceneIds.length === 0) {
        showToast('失敗したシーンはありません', 'info');
        return;
      }
    }
    
    let pollCount = 0;
    const maxPolls = 300; // 最大25分（5秒 x 300回）
    let currentFailedIndex = 0; // 現在処理中の失敗シーンインデックス
    
    while (pollCount < maxPolls) {
      // 1) 現在のステータス取得
      const statusRes = await axios.get(`${API_BASE}/projects/${PROJECT_ID}/generate-images/status`);
      const { processed, pending, failed, generating, status } = statusRes.data;
      
      // UI更新（進捗表示）
      let progressText;
      if (mode === 'failed') {
        const completedFailed = failedSceneIds.length - failedSceneIds.filter(id => {
          const scene = (window.lastLoadedScenes || []).find(s => s.id === id);
          return scene?.latest_image?.status === 'failed';
        }).length;
        progressText = `失敗シーン再試行中... (${completedFailed}/${failedSceneIds.length})`;
      } else {
        progressText = `画像生成中... (${processed}/${processed + pending + failed})`;
      }
      const btn = document.getElementById(buttonId);
      if (btn) {
        btn.innerHTML = `<i class="fas fa-spinner fa-spin mr-2"></i>${progressText}`;
      }
      
      // 🎯 BULK PROGRESS: Update per-scene progress
      try {
        const scenesRes = await axios.get(`${API_BASE}/projects/${PROJECT_ID}/scenes?view=board`);
        const scenes = scenesRes.data.scenes || [];
        window.lastLoadedScenes = scenes; // キャッシュを更新
        
        scenes.forEach(scene => {
          const latestImage = scene.latest_image;
          const imageStatus = latestImage?.status || 'pending';
          
          if (imageStatus === 'generating') {
            // Start fake progress if not already running
            if (!window.generatingSceneWatch || !window.generatingSceneWatch[scene.id]) {
              console.log(`🚀 [BULK] Starting fake progress for scene ${scene.id}`);
              startGenerationWatch(scene.id);
            }
          } else if (imageStatus === 'completed') {
            // Stop fake progress and update to completed state
            if (window.generatingSceneWatch && window.generatingSceneWatch[scene.id]) {
              console.log(`✅ [BULK] Scene ${scene.id} completed, stopping fake progress`);
              stopGenerationWatch(scene.id);
              setPrimaryButtonState(scene.id, 'completed', 0);
            }
          }
        });
      } catch (sceneError) {
        console.warn('[BULK] Failed to fetch scenes for progress update:', sceneError);
      }
      
      // 2) 完了判定
      if (mode === 'failed') {
        // 失敗モード: 全ての失敗シーンが処理されたか確認
        const remainingFailed = failedSceneIds.filter(id => {
          const scene = (window.lastLoadedScenes || []).find(s => s.id === id);
          return scene?.latest_image?.status === 'failed' || scene?.latest_image?.status === 'generating';
        });
        
        if (remainingFailed.length === 0 && generating === 0) {
          // 最終的な成功/失敗数をカウント
          const finalSuccessCount = failedSceneIds.filter(id => {
            const scene = (window.lastLoadedScenes || []).find(s => s.id === id);
            return scene?.latest_image?.status === 'completed';
          }).length;
          const finalFailedCount = failedSceneIds.length - finalSuccessCount;
          
          if (finalFailedCount > 0) {
            showToast(`失敗シーン再試行完了！ (成功: ${finalSuccessCount}件, 再失敗: ${finalFailedCount}件)`, 'warning');
          } else {
            showToast(`失敗シーン再試行完了！ (${finalSuccessCount}件)`, 'success');
          }
          await initBuilderTab();
          break;
        }
        
        // 3) 次の失敗シーンを処理（generating === 0 の場合）
        if (generating === 0) {
          const nextFailedScene = failedSceneIds.find(id => {
            const scene = (window.lastLoadedScenes || []).find(s => s.id === id);
            return scene?.latest_image?.status === 'failed';
          });
          
          if (nextFailedScene) {
            try {
              console.log(`[BULK] Retrying failed scene ${nextFailedScene}`);
              await axios.post(`${API_BASE}/scenes/${nextFailedScene}/generate-image`);
            } catch (retryError) {
              console.warn(`[BULK] Retry error for scene ${nextFailedScene}:`, retryError);
            }
          }
        }
      } else {
        // pending モード: 既存のロジック
        if (pending === 0 && generating === 0) {
          // 最後のAPI呼び出しでプロジェクトステータスを 'completed' に更新
          try {
            await axios.post(`${API_BASE}/projects/${PROJECT_ID}/generate-images`);
          } catch (finalCallError) {
            console.warn('Final API call error:', finalCallError);
          }
          
          const finalMessage = failed > 0 
            ? `画像生成完了！ (成功: ${processed}件, 失敗: ${failed}件)` 
            : `画像生成完了！ (${processed}件)`;
          showToast(finalMessage, failed > 0 ? 'warning' : 'success');
          await initBuilderTab();
          break;
        }
        
        // 3) 次のバッチ実行（pending > 0 の場合）
        if (pending > 0 && generating === 0) {
          try {
            await axios.post(`${API_BASE}/projects/${PROJECT_ID}/generate-images`);
          } catch (batchError) {
            console.warn('Batch generation error:', batchError);
            // エラーでも次のポーリングで retry
          }
        }
      }
      
      // 4) 5秒待機
      await new Promise(resolve => setTimeout(resolve, 5000));
      pollCount++;
    }
    
    if (pollCount >= maxPolls) {
      showToast('画像生成がタイムアウトしました。再度お試しください。', 'error');
    }
    
  } catch (error) {
    console.error('Bulk generate error:', error);
    showToast('画像生成中にエラーが発生しました', 'error');
  } finally {
    isProcessing = false;
    window.isBulkImageGenerating = false;  // Reset global bulk generation flag
    setButtonLoading(buttonId, false);
    
    // Re-render Builder UI to enable individual buttons
    const currentScenes = window.lastLoadedScenes || [];
    if (currentScenes.length > 0) {
      renderBuilderScenes(currentScenes);
    }
  }
}

// View image history (SSOT Phase3: 漫画画像には「編集再開」ボタンを表示)
async function viewImageHistory(sceneId) {
  // sceneIdをモーダル用に保存
  window._currentHistorySceneId = sceneId;
  
  try {
    const response = await axios.get(`${API_BASE}/scenes/${sceneId}/images`);
    const images = response.data.images || [];
    
    const modal = document.getElementById('imageHistoryModal');
    const content = document.getElementById('imageHistoryContent');
    
    if (images.length === 0) {
      content.innerHTML = `
        <div class="text-center py-8 text-gray-500">
          <i class="fas fa-image text-6xl mb-4"></i>
          <p>画像生成履歴がありません</p>
        </div>
      `;
    } else {
      content.innerHTML = `
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          ${images.map(img => {
            const isComic = img.asset_type === 'comic';
            const typeLabel = isComic 
              ? '<span class="absolute top-2 left-2 px-2 py-1 bg-purple-600 text-white text-xs rounded"><i class="fas fa-comment-alt mr-1"></i>漫画</span>'
              : '';
            
            // アクションボタン
            let actionButtons = '';
            if (img.is_active) {
              actionButtons = '<span class="px-2 py-1 bg-blue-100 text-blue-800 rounded text-xs">現在使用中</span>';
            } else {
              actionButtons = `
                <button 
                  onclick="activateImage(${img.id}, ${sceneId})"
                  class="px-2 py-1 bg-green-600 text-white rounded hover:bg-green-700 transition-colors text-xs"
                >
                  採用
                </button>
              `;
            }
            
            // 漫画の場合は「編集再開」ボタンを追加
            if (isComic) {
              actionButtons += `
                <button 
                  onclick="reopenComicEditor(${sceneId})"
                  class="px-2 py-1 bg-purple-600 text-white rounded hover:bg-purple-700 transition-colors text-xs ml-1"
                >
                  <i class="fas fa-edit mr-1"></i>編集再開
                </button>
              `;
            }
            
            // ✅ image_url の有効性チェック
            const validImageUrl = img.image_url && img.image_url !== 'null' && img.image_url !== 'undefined' ? img.image_url : null;
            
            return `
              <div class="border-2 ${img.is_active ? 'border-blue-600' : 'border-gray-200'} rounded-lg overflow-hidden relative">
                ${typeLabel}
                <div class="aspect-video bg-gray-100">
                  ${validImageUrl 
                    ? `<img src="${validImageUrl}" alt="Generated image" class="w-full h-full object-cover" />`
                    : `<div class="flex items-center justify-center h-full text-gray-400">
                         <i class="fas fa-exclamation-triangle text-2xl"></i>
                         <span class="ml-2 text-sm">画像なし</span>
                       </div>`
                  }
                </div>
                <div class="p-3 space-y-2">
                  <p class="text-xs text-gray-600 line-clamp-2">${escapeHtml(img.prompt || (isComic ? '漫画画像' : ''))}</p>
                  <div class="flex flex-wrap items-center gap-1 text-xs text-gray-500">
                    <span class="mr-auto">${new Date(img.created_at.replace(' ', 'T') + 'Z').toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}</span>
                    ${actionButtons}
                  </div>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      `;
    }
    
    modal.classList.remove('hidden');
  } catch (error) {
    console.error('Load image history error:', error);
    showToast('画像履歴の読み込みに失敗しました', 'error');
  }
}

// 漫画編集を再開（履歴から）
function reopenComicEditor(sceneId) {
  // 履歴モーダルを閉じる
  closeImageHistory();
  // 漫画エディタを開く
  if (typeof window.openComicEditor === 'function') {
    window.openComicEditor(sceneId);
  } else {
    showToast('漫画エディタを読み込み中...', 'info');
    setTimeout(() => {
      if (typeof window.openComicEditor === 'function') {
        window.openComicEditor(sceneId);
      } else {
        showToast('漫画エディタの読み込みに失敗しました', 'error');
      }
    }, 500);
  }
}

// Close image history modal
function closeImageHistory() {
  document.getElementById('imageHistoryModal').classList.add('hidden');
}

// Activate image
async function activateImage(imageId, sceneId) {
  try {
    const response = await axios.post(`${API_BASE}/images/${imageId}/activate`);
    
    if (response.data.success) {
      showToast('画像を採用しました', 'success');
      closeImageHistory();
      await initBuilderTab(); // Refresh to show new active image
    } else {
      showToast('画像の採用に失敗しました', 'error');
    }
  } catch (error) {
    console.error('Activate image error:', error);
    showToast('画像採用中にエラーが発生しました', 'error');
  }
}

// ========== Export Functions ==========

// Initialize Export tab
async function initExportTab() {
  try {
    // Get project details
    const projectResponse = await axios.get(`${API_BASE}/projects/${PROJECT_ID}`);
    const project = projectResponse.data;
    
    // Get scenes count
    const scenesResponse = await axios.get(`${API_BASE}/projects/${PROJECT_ID}/scenes`);
    const scenes = scenesResponse.data.scenes || [];
    
    // Update UI
    document.getElementById('exportProjectTitle').textContent = project.title;
    document.getElementById('exportCreatedAt').textContent = new Date(project.created_at).toLocaleDateString('ja-JP');
    document.getElementById('exportSceneCount').textContent = `${scenes.length} シーン`;
  } catch (error) {
    console.error('Load export info error:', error);
    showToast('プロジェクト情報の読み込みに失敗しました', 'error');
  }
}

// Download functions
async function downloadImages() {
  window.open(`${API_BASE}/projects/${PROJECT_ID}/download/images`, '_blank');
  showToast('images.zip のダウンロードを開始しました', 'success');
}

async function downloadCSV() {
  window.open(`${API_BASE}/projects/${PROJECT_ID}/download/csv`, '_blank');
  showToast('dialogue.csv のダウンロードを開始しました', 'success');
}

async function downloadAll() {
  window.open(`${API_BASE}/projects/${PROJECT_ID}/download/all`, '_blank');
  showToast('all.zip のダウンロードを開始しました', 'success');
}

// Escape HTML
function escapeHtml(text) {
  if (text === null || text === undefined) return '';
  // 文字列以外（数値、配列など）は文字列に変換
  if (typeof text !== 'string') {
    text = String(text);
  }
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}

// ========== Delete Project ==========
function confirmDeleteProject() {
  console.log('Delete button clicked, isProcessing:', isProcessing);
  if (confirm('このプロジェクトを削除してもよろしいですか？\n\n関連するすべてのデータ（音声、シーン、画像）が削除されます。この操作は取り消せません。')) {
    deleteProject();
  }
}

async function deleteProject() {
  if (isProcessing) {
    showToast('処理中です。しばらくお待ちください', 'warning');
    return;
  }
  
  isProcessing = true;
  setButtonLoading('deleteBtn', true);
  
  try {
    const response = await axios.delete(`${API_BASE}/projects/${PROJECT_ID}`);
    
    if (response.data.success) {
      showToast('プロジェクトを削除しました', 'success');
      setTimeout(() => {
        window.location.href = '/';
      }, 1000);
    } else {
      showToast(response.data.error?.message || 'プロジェクト削除に失敗しました', 'error');
    }
  } catch (error) {
    console.error('Delete project error:', error);
    showToast('プロジェクト削除中にエラーが発生しました', 'error');
  } finally {
    isProcessing = false;
    setButtonLoading('deleteBtn', false);
  }
}

// ========== Style Presets Functions ==========

// Initialize Styles tab
async function initStylesTab() {
  try {
    // Load style presets
    await loadStylePresets();
    
    // Load project default style
    await loadProjectDefaultStyle();
    
    // ⚠️ PHASE X-5: Initialize World & Characters (moved from Builder)
    // World & Characters panel now lives in Styles tab
    if (window.WorldCharacterUI && typeof window.WorldCharacterUI.init === 'function') {
      window.WorldCharacterUI.init();
    }
  } catch (error) {
    console.error('Init styles tab error:', error);
    showToast('スタイル設定の読み込みに失敗しました', 'error');
  }
}

// Load all style presets
async function loadStylePresets() {
  try {
    const response = await axios.get(`${API_BASE}/style-presets`);
    const styles = response.data.style_presets || [];
    
    const container = document.getElementById('stylePresetsList');
    const emptyState = document.getElementById('stylesEmptyState');
    const select = document.getElementById('projectDefaultStyle');
    
    if (styles.length === 0) {
      container.innerHTML = '';
      emptyState.classList.remove('hidden');
      return;
    }
    
    emptyState.classList.add('hidden');
    
    // Render styles list
    container.innerHTML = styles.map(style => `
      <div class="bg-white rounded-lg border-2 ${style.is_active ? 'border-purple-200' : 'border-gray-200'} p-4">
        <div class="flex items-start justify-between gap-4">
          <div class="flex-1">
            <div class="flex items-center gap-2 mb-2">
              <h4 class="font-bold text-gray-800">${escapeHtml(style.name)}</h4>
              ${style.is_active 
                ? '<span class="text-xs bg-green-100 text-green-800 px-2 py-1 rounded">有効</span>' 
                : '<span class="text-xs bg-gray-100 text-gray-600 px-2 py-1 rounded">無効</span>'}
            </div>
            ${style.description ? `<p class="text-sm text-gray-600 mb-2">${escapeHtml(style.description)}</p>` : ''}
            <div class="text-xs text-gray-500 space-y-1 font-mono">
              ${style.prompt_prefix ? `<div>Prefix: ${escapeHtml(style.prompt_prefix.substring(0, 50))}${style.prompt_prefix.length > 50 ? '...' : ''}</div>` : ''}
              ${style.prompt_suffix ? `<div>Suffix: ${escapeHtml(style.prompt_suffix.substring(0, 50))}${style.prompt_suffix.length > 50 ? '...' : ''}</div>` : ''}
            </div>
          </div>
          <div class="flex gap-2">
            <button 
              onclick="editStylePreset(${style.id})"
              class="px-3 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors text-sm"
              title="編集"
            >
              <i class="fas fa-edit"></i>
            </button>
            <button 
              onclick="deleteStylePreset(${style.id}, '${escapeHtml(style.name)}')"
              class="px-3 py-2 bg-red-600 text-white rounded hover:bg-red-700 transition-colors text-sm"
              title="削除"
            >
              <i class="fas fa-trash"></i>
            </button>
          </div>
        </div>
      </div>
    `).join('');
    
    // Update dropdown options (check if element exists)
    if (select) {
      select.innerHTML = '<option value="">未設定（オリジナルプロンプト）</option>' +
        styles.filter(s => s.is_active).map(s => 
          `<option value="${s.id}">${escapeHtml(s.name)}</option>`
        ).join('');
    }
      
  } catch (error) {
    console.error('Load style presets error:', error);
    showToast('スタイルプリセットの読み込みに失敗しました', 'error');
  }
}

// Load project default style
async function loadProjectDefaultStyle() {
  try {
    const response = await axios.get(`${API_BASE}/projects/${PROJECT_ID}/style-settings`);
    const defaultStyleId = response.data.default_style_preset_id;
    
    const select = document.getElementById('projectDefaultStyle');
    if (defaultStyleId) {
      select.value = defaultStyleId;
    } else {
      select.value = '';
    }
  } catch (error) {
    console.error('Load project default style error:', error);
  }
}

// Save project default style
async function saveProjectDefaultStyle() {
  try {
    const select = document.getElementById('projectDefaultStyle');
    const styleId = select.value ? parseInt(select.value) : null;
    
    await axios.put(`${API_BASE}/projects/${PROJECT_ID}/style-settings`, {
      default_style_preset_id: styleId
    });
    
    showToast('デフォルトスタイルを保存しました', 'success');
  } catch (error) {
    console.error('Save project default style error:', error);
    showToast('デフォルトスタイルの保存に失敗しました', 'error');
  }
}

// Show style editor modal
function showStyleEditor(styleId = null) {
  const modal = document.getElementById('styleEditorModal');
  const title = document.getElementById('styleEditorTitle');
  const form = document.getElementById('styleEditorForm');
  
  // Reset form
  form.reset();
  document.getElementById('editingStyleId').value = '';
  document.getElementById('styleIsActive').checked = true;
  
  if (styleId) {
    // Edit mode
    title.textContent = 'スタイル編集';
    loadStyleForEdit(styleId);
  } else {
    // Create mode
    title.textContent = 'スタイル新規作成';
  }
  
  modal.classList.remove('hidden');
}

// Load style for editing
async function loadStyleForEdit(styleId) {
  try {
    const response = await axios.get(`${API_BASE}/style-presets/${styleId}`);
    const style = response.data;
    
    document.getElementById('editingStyleId').value = style.id;
    document.getElementById('styleName').value = style.name || '';
    document.getElementById('styleDescription').value = style.description || '';
    document.getElementById('stylePromptPrefix').value = style.prompt_prefix || '';
    document.getElementById('stylePromptSuffix').value = style.prompt_suffix || '';
    document.getElementById('styleNegativePrompt').value = style.negative_prompt || '';
    document.getElementById('styleIsActive').checked = style.is_active === 1;
  } catch (error) {
    console.error('Load style for edit error:', error);
    showToast('スタイルの読み込みに失敗しました', 'error');
  }
}

// Save style preset
async function saveStylePreset() {
  // Prevent double submission
  if (window.styleSaving) {
    showToast('保存中です。しばらくお待ちください', 'warning');
    return;
  }
  
  try {
    window.styleSaving = true;
    
    const styleId = document.getElementById('editingStyleId').value;
    const name = document.getElementById('styleName').value.trim();
    const description = document.getElementById('styleDescription').value.trim();
    const promptPrefix = document.getElementById('stylePromptPrefix').value.trim();
    const promptSuffix = document.getElementById('stylePromptSuffix').value.trim();
    const negativePrompt = document.getElementById('styleNegativePrompt').value.trim();
    const isActive = document.getElementById('styleIsActive').checked ? 1 : 0;
    
    if (!name) {
      showToast('スタイル名を入力してください', 'error');
      window.styleSaving = false;
      return;
    }
    
    const data = {
      name,
      description: description || null,
      prompt_prefix: promptPrefix || null,
      prompt_suffix: promptSuffix || null,
      negative_prompt: negativePrompt || null,
      is_active: isActive
    };
    
    if (styleId) {
      // Update
      await axios.put(`${API_BASE}/style-presets/${styleId}`, data);
      showToast('スタイルを更新しました', 'success');
    } else {
      // Create
      await axios.post(`${API_BASE}/style-presets`, data);
      showToast('スタイルを作成しました', 'success');
    }
    
    closeStyleEditor();
    await loadStylePresets();
    await loadProjectDefaultStyle();
    
  } catch (error) {
    console.error('Save style preset error:', error);
    showToast('スタイルの保存に失敗しました', 'error');
  } finally {
    window.styleSaving = false;
  }
}

// Edit style preset
function editStylePreset(styleId) {
  showStyleEditor(styleId);
}

// Delete style preset
async function deleteStylePreset(styleId, styleName) {
  if (!confirm(`スタイル「${styleName}」を削除しますか？`)) {
    return;
  }
  
  try {
    await axios.delete(`${API_BASE}/style-presets/${styleId}`);
    showToast('スタイルを削除しました', 'success');
    await loadStylePresets();
    await loadProjectDefaultStyle();
  } catch (error) {
    console.error('Delete style preset error:', error);
    showToast('スタイルの削除に失敗しました', 'error');
  }
}

// Close style editor modal
function closeStyleEditor() {
  document.getElementById('styleEditorModal').classList.add('hidden');
}

// ========== Builder Style Functions ==========

// Render style options for scene
function renderStyleOptions(currentStyleId) {
  const presets = window.builderStylePresets || [];
  const activePresets = presets.filter(p => p.is_active);
  
  let options = '<option value="">未設定（プロジェクトデフォルト）</option>';
  
  activePresets.forEach(preset => {
    const selected = currentStyleId === preset.id ? 'selected' : '';
    options += `<option value="${preset.id}" ${selected}>${escapeHtml(preset.name)}</option>`;
    
    // Debug log when a style is selected
    if (currentStyleId === preset.id) {
      console.log(`[Style] Selected preset for currentStyleId=${currentStyleId}: ${preset.name} (id=${preset.id})`);
    }
  });
  
  return options;
}

// Set scene style (called when dropdown changes)
async function setSceneStyle(sceneId) {
  const select = document.getElementById(`sceneStyle-${sceneId}`);
  const styleId = select.value ? parseInt(select.value) : null;
  
  try {
    await axios.put(`${API_BASE}/scenes/${sceneId}/style`, {
      style_preset_id: styleId
    });
    
    showToast('スタイルを設定しました', 'success');
    
    // Reload builder to reflect changes
    await initBuilderTab();
  } catch (error) {
    console.error('Set scene style error:', error);
    showToast('スタイル設定に失敗しました', 'error');
  }
}

// Clear scene style (revert to project default)
async function clearSceneStyle(sceneId) {
  try {
    await axios.put(`${API_BASE}/scenes/${sceneId}/style`, {
      style_preset_id: null
    });
    
    showToast('デフォルトに戻しました', 'success');
    
    // Reload builder to reflect changes
    await initBuilderTab();
  } catch (error) {
    console.error('Clear scene style error:', error);
    showToast('スタイルのクリアに失敗しました', 'error');
  }
}

// ✅ 新規: スタイルドロップダウン変更時の処理
async function onStyleSelectChange(sceneId, value) {
  const styleId = value ? parseInt(value) : null;
  
  try {
    await axios.put(`${API_BASE}/scenes/${sceneId}/style`, {
      style_preset_id: styleId
    });
    
    const styleName = styleId 
      ? (window.builderStylePresets?.find(s => s.id === styleId)?.name || `スタイルID: ${styleId}`)
      : 'デフォルト';
    
    showToast(`スタイルを「${styleName}」に変更しました`, 'success');
    
    // ✅ ページ全体をリロードせず、選択状態を維持
    console.log(`[StyleSelect] Scene ${sceneId} style changed to: ${styleName}`);
  } catch (error) {
    console.error('Style change error:', error);
    showToast('スタイル変更に失敗しました', 'error');
    
    // エラー時は元の値に戻す
    const select = document.getElementById(`style-select-${sceneId}`);
    if (select) {
      // 現在のシーンデータを取得して元に戻す
      try {
        const response = await axios.get(`${API_BASE}/scenes/${sceneId}`);
        select.value = response.data.style_preset_id || '';
      } catch (e) {
        console.error('Failed to restore style select:', e);
      }
    }
  }
}
window.onStyleSelectChange = onStyleSelectChange;

// ========== Image Generation Polling ==========

// Apply bulk style to all scenes
async function applyBulkStyle() {
  const select = document.getElementById('bulkStyleSelector');
  const styleId = select.value ? parseInt(select.value) : null;
  const styleName = select.options[select.selectedIndex].text;
  
  // Find the button element
  const applyBtn = select.parentElement.querySelector('button');
  const originalBtnHtml = applyBtn ? applyBtn.innerHTML : '';
  
  if (!confirm(`すべてのシーンに同じスタイルを適用しますか？\n\n選択したスタイル: ${styleName}`)) {
    return;
  }
  
  try {
    // Disable button and show initial state
    if (applyBtn) {
      applyBtn.disabled = true;
      applyBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>準備中...';
    }
    
    // Get all scenes
    const response = await axios.get(`${API_BASE}/projects/${PROJECT_ID}/scenes`);
    const scenes = response.data.scenes || [];
    
    if (scenes.length === 0) {
      showToast('シーンがありません', 'warning');
      if (applyBtn) {
        applyBtn.disabled = false;
        applyBtn.innerHTML = originalBtnHtml;
      }
      return;
    }
    
    // Apply style to each scene with progress
    let successCount = 0;
    const total = scenes.length;
    
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const progress = Math.round(((i + 1) / total) * 100);
      
      // Update button with progress
      if (applyBtn) {
        applyBtn.innerHTML = `<i class="fas fa-spinner fa-spin mr-2"></i>${progress}% (${i + 1}/${total})`;
      }
      
      try {
        await axios.put(`${API_BASE}/scenes/${scene.id}/style`, {
          style_preset_id: styleId
        });
        successCount++;
      } catch (error) {
        console.error(`Failed to apply style to scene ${scene.id}:`, error);
      }
    }
    
    console.log(`[BulkStyle] Applied style ${styleId} to ${successCount}/${total} scenes. Reloading builder...`);
    
    // Show completion state
    if (applyBtn) {
      applyBtn.innerHTML = `<i class="fas fa-check mr-2"></i>適用完了 (${successCount}/${total})`;
      applyBtn.classList.remove('bg-purple-600', 'hover:bg-purple-700');
      applyBtn.classList.add('bg-green-600', 'hover:bg-green-700');
    }
    
    showToast(`${successCount}/${total}シーンにスタイルを適用しました`, 'success');
    
    // Save the applied style to window for restoration after reload
    window.appliedBulkStyleId = styleId;
    console.log('[BulkStyle] Saved applied style ID:', styleId);
    
    // Reload builder (will use window.appliedBulkStyleId for dropdown)
    await initBuilderTab();
    
    // Reset button after reload (with slight delay for visual feedback)
    setTimeout(() => {
      if (applyBtn) {
        applyBtn.disabled = false;
        applyBtn.innerHTML = originalBtnHtml;
        applyBtn.classList.remove('bg-green-600', 'hover:bg-green-700');
        applyBtn.classList.add('bg-purple-600', 'hover:bg-purple-700');
      }
    }, 2000);
    
  } catch (error) {
    console.error('Apply bulk style error:', error);
    showToast('一括スタイル適用に失敗しました', 'error');
    
    // Reset button on error
    if (applyBtn) {
      applyBtn.disabled = false;
      applyBtn.innerHTML = originalBtnHtml;
    }
  }
}

// Update single scene card without full page reload
async function updateSingleSceneCard(sceneId) {
  try {
    console.log(`[UpdateScene] Updating scene ${sceneId} only (no full reload)`);
    
    // ✅ 単一シーンのみ取得（新規API使用）
    const response = await axios.get(`${API_BASE}/scenes/${sceneId}?view=board&_t=${Date.now()}`);
    const scene = response.data;
    
    if (scene.error) {
      console.error('Scene fetch error:', scene.error);
      return;
    }
    
    // Find the scene card element
    const sceneCard = document.getElementById(`builder-scene-${sceneId}`);
    if (!sceneCard) {
      console.error('Scene card element not found:', sceneId);
      return;
    }
    
    // ✅ スクロール位置を保存
    const scrollY = window.scrollY;
    
    // Extract scene data
    const activeImage = scene.active_image || null;
    const latestImage = scene.latest_image || null;
    
    // ✅ r2_url が null の場合は画像なしとして扱う
    const imageUrl = activeImage?.image_url || activeImage?.r2_url || null;
    const imageStatus = latestImage ? latestImage.status : 'pending';
    const errorMessage = latestImage?.error_message || null;
    
    // 一括生成中かどうか
    const isBulkActive = window.isBulkImageGenerating || false;
    const isProcessing = window.sceneProcessing?.[sceneId] || false;
    
    console.log(`[UpdateScene] Scene ${sceneId} status: ${imageStatus}, bulkActive: ${isBulkActive}, processing: ${isProcessing}`);
    
    // ===== 1. 画像表示を更新 =====
    const imgContainer = sceneCard.querySelector('.scene-image-container');
    if (imgContainer) {
      // ✅ imageUrl が有効な場合のみ画像を表示（null/undefined チェック強化）
      if (imageUrl && imageUrl !== 'null' && imageUrl !== 'undefined') {
        imgContainer.innerHTML = `
          <img src="${imageUrl}?t=${Date.now()}" 
               class="w-full h-full object-cover"
               loading="lazy"
               alt="Scene ${scene.idx}">
        `;
      } else {
        imgContainer.innerHTML = `
          <div class="w-full h-full flex items-center justify-center bg-gray-200">
            <i class="fas fa-image text-gray-400 text-4xl"></i>
          </div>
        `;
      }
    }
    
    // ===== 2. ステータスバッジを更新 =====
    const badgeContainer = sceneCard.querySelector('.scene-status-badge-container');
    if (badgeContainer) {
      badgeContainer.innerHTML = getImageStatusBadge(imageStatus);
    }
    
    // ===== 3. アクションボタンを更新 =====
    const actionBtnContainer = sceneCard.querySelector('.scene-action-buttons');
    if (actionBtnContainer) {
      const hasImage = latestImage && imageStatus === 'completed';
      const isGenerating = imageStatus === 'generating';
      const isFailed = imageStatus === 'failed';
      
      // ✅ 修正: imageStatus が 'completed' の場合は生成中状態を無視して完了表示にする
      const shouldShowGenerating = (isGenerating || isProcessing) && imageStatus !== 'completed';
      
      if (shouldShowGenerating) {
        // 生成中 - ✅ setPrimaryButtonState()を使用
        const timerRunning = window.generatingSceneWatch?.[sceneId];
        const existingBtn = document.getElementById(`primaryBtn-${sceneId}`);
        
        // タイマーが実行中で、ボタンが既に存在する場合は上書きしない
        if (!existingBtn || !timerRunning) {
          // ボタンが存在しない、またはタイマーが動いていない場合のみ作成
          if (!existingBtn) {
            actionBtnContainer.innerHTML = `
              <button id="primaryBtn-${sceneId}" class="flex-1 px-4 py-2 bg-gray-300 text-white rounded-lg font-semibold touch-manipulation">
                <i class="fas fa-spinner fa-spin mr-2"></i>読み込み中...
              </button>
              <button id="historyBtn-${sceneId}" onclick="viewImageHistory(${sceneId})" class="px-4 py-2 bg-gray-300 text-white rounded-lg font-semibold touch-manipulation">
                <i class="fas fa-history mr-2"></i>履歴
              </button>
            `;
          }
          setPrimaryButtonState(sceneId, 'generating', 0);
        } else {
          console.log(`[UpdateScene] Keeping existing button for scene ${sceneId} (timer running)`);
        }
      } else if (isBulkActive) {
        // 一括処理中（ロック）
        actionBtnContainer.innerHTML = `
          <button disabled class="px-4 py-2 bg-gray-400 text-white rounded opacity-50 cursor-not-allowed"
                  title="一括画像生成中">
            <i class="fas fa-lock mr-2"></i>
            一括処理中
          </button>
        `;
      } else {
        // 完了 or 失敗 or 未生成
        console.log(`[UpdateScene] Complete/Failed/Idle state - hasImage: ${hasImage}, isFailed: ${isFailed}, imageStatus: ${imageStatus}`);
        
        // ✅ 修正: ボタンを常に再作成してから状態を設定（生成中→完了の遷移を確実に反映）
        console.log(`[UpdateScene] Recreating buttons for scene ${sceneId} to ensure state update`);
        actionBtnContainer.innerHTML = `
          <button id="primaryBtn-${sceneId}" class="flex-1 px-4 py-2 bg-gray-300 text-white rounded-lg font-semibold touch-manipulation">
            <i class="fas fa-spinner fa-spin mr-2"></i>読み込み中...
          </button>
          <button id="historyBtn-${sceneId}" onclick="viewImageHistory(${sceneId})" class="px-4 py-2 bg-gray-300 text-white rounded-lg font-semibold touch-manipulation">
            <i class="fas fa-history mr-2"></i>履歴
          </button>
        `;
        
        if (isFailed) {
          console.log(`[UpdateScene] Setting FAILED state for scene ${sceneId}`);
          setPrimaryButtonState(sceneId, 'failed', 0);
        } else if (hasImage) {
          console.log(`[UpdateScene] Setting COMPLETED state for scene ${sceneId}`);
          setPrimaryButtonState(sceneId, 'completed', 0);
        } else {
          console.log(`[UpdateScene] Setting IDLE state for scene ${sceneId}`);
          setPrimaryButtonState(sceneId, 'idle', 0);
        }
        
        // 履歴ボタンを更新 - Phase1.7: 漫画採用中も履歴は見れるようにする
        const historyBtn = document.getElementById(`historyBtn-${sceneId}`);
        if (historyBtn) {
          const activeComic = scene.active_comic || null;
          // active_image, active_comic, または latest_image があれば履歴ボタンを有効化
          const hasAnyImage = activeImage || activeComic || scene.latest_image;
          historyBtn.disabled = !hasAnyImage;
          historyBtn.className = `px-4 py-2 rounded-lg font-semibold touch-manipulation ${
            hasAnyImage ? 'bg-gray-600 text-white hover:bg-gray-700 transition-colors' : 'bg-gray-400 text-gray-200 cursor-not-allowed'
          }`;
          historyBtn.innerHTML = '<i class="fas fa-history mr-2"></i>履歴';
        }
      }
    }
    
    // ===== 4. エラーメッセージ表示/非表示 =====
    // ✅ 修正: active_imageがある場合は古いエラーを表示しない（再生成成功後のエラー残り対策）
    let errorContainer = sceneCard.querySelector('.scene-error-message');
    const shouldShowError = imageStatus === 'failed' && errorMessage && !activeImage;
    
    if (shouldShowError) {
      if (!errorContainer) {
        errorContainer = document.createElement('div');
        errorContainer.className = 'scene-error-message mt-2 p-3 bg-red-50 border border-red-200 rounded text-sm';
        const contentDiv = sceneCard.querySelector('.p-4');
        if (contentDiv) {
          contentDiv.appendChild(errorContainer);
        }
      }
      
      // エラーメッセージをパース
      let errorText = errorMessage;
      try {
        const errorObj = JSON.parse(errorText);
        errorText = `[${errorObj.status || 'ERROR'}] ${errorObj.message || errorText}`;
      } catch (e) {
        // JSONでない場合はそのまま表示
      }
      
      errorContainer.innerHTML = `
        <div class="flex items-start gap-2">
          <i class="fas fa-exclamation-triangle text-red-600 mt-0.5"></i>
          <div class="flex-1">
            <div class="font-semibold text-red-800 mb-1">失敗理由</div>
            <div class="text-red-700">${escapeHtml(errorText)}</div>
          </div>
        </div>
      `;
    } else if (errorContainer) {
      errorContainer.remove();
    }
    
    // ===== 5. data-status 属性を更新 =====
    sceneCard.setAttribute('data-status', imageStatus);
    
    // ✅ スクロール位置を復元
    window.scrollTo(0, scrollY);
    
    console.log(`✅ Scene ${sceneId} card updated successfully`);
    
  } catch (error) {
    console.error(`Failed to update scene ${sceneId}:`, error);
    showToast(`シーン${sceneId}の更新に失敗しました`, 'error');
  }
}

// Check if all images are completed and update project status
async function checkAndUpdateProjectStatus() {
  try {
    const statusRes = await axios.get(`${API_BASE}/projects/${PROJECT_ID}/generate-images/status`);
    const { pending, generating, status } = statusRes.data;
    
    console.log(`[ProjectStatus] Current status: ${status}, pending: ${pending}, generating: ${generating}`);
    
    // If all images are completed but project status is not yet "completed"
    // Fix: Also trigger for "formatted" status when all images exist
    if (pending === 0 && generating === 0 && (status === 'generating_images' || status === 'formatted')) {
      console.log('[ProjectStatus] All images completed, calling final API to update project status');
      
      // Call the batch API one more time to trigger status update to "completed"
      try {
        await axios.post(`${API_BASE}/projects/${PROJECT_ID}/generate-images`);
        console.log('[ProjectStatus] Project status updated to completed');
        
        // Update tab states
        updateTabStates('completed');
      } catch (error) {
        console.warn('[ProjectStatus] Failed to update project status:', error);
      }
    }
  } catch (error) {
    console.error('[ProjectStatus] Failed to check project status:', error);
  }
}

// Update tab states based on project status
function updateTabStates(projectStatus) {
  console.log(`[TabStates] Updating tab states for status: ${projectStatus}`);
  
  const tabs = [
    { id: 'sceneTab', minStatus: 'transcribed' },
    { id: 'builderTab', minStatus: 'formatted' },
    { id: 'exportTab', minStatus: 'completed' }
  ];
  
  const statusOrder = [
    'created', 'uploaded', 'transcribing', 'transcribed',
    'parsing', 'parsed', 'formatting', 'formatted',
    'generating_images', 'completed', 'failed'
  ];
  
  const currentIndex = statusOrder.indexOf(projectStatus);
  
  tabs.forEach(tab => {
    const button = document.querySelector(`button[onclick="switchTab('${tab.id.replace('Tab', '')}')"]`);
    if (button) {
      const minIndex = statusOrder.indexOf(tab.minStatus);
      
      if (currentIndex >= minIndex) {
        // Enable tab
        button.disabled = false;
        button.classList.remove('opacity-50', 'cursor-not-allowed');
        button.classList.add('hover:bg-blue-700');
      } else {
        // Disable tab
        button.disabled = true;
        button.classList.add('opacity-50', 'cursor-not-allowed');
        button.classList.remove('hover:bg-blue-700');
      }
    }
  });
}

// ========== Progress Bar ==========
/**
 * Update the progress bar based on project status AND actual scene readiness
 * Shows clear progress percentage and next action guidance
 * 
 * 改善: プロジェクトstatusだけでなく、実際のシーン準備状況も考慮
 * - formatted + 全シーン素材準備完了 → Video Buildへ案内
 * - formatted + 素材未準備あり → Builderで画像/動画生成を案内
 * 
 * @param {string} status - Current project status
 */
function updateProgressBar(status) {
  const progressBarFill = document.getElementById('progressBarFill');
  const progressPercent = document.getElementById('progressPercent');
  const progressMessage = document.getElementById('progressMessage');
  
  if (!progressBarFill || !progressPercent || !progressMessage) return;
  
  // 実際のシーン準備状況を取得（preflight結果があれば使用）
  const preflight = window.videoBuildPreflightCache || {};
  const scenes = window.lastLoadedScenes || [];
  
  // シーンの素材準備状況を計算
  let allScenesReady = false;
  let readyCount = 0;
  let totalCount = 0;
  
  if (preflight.total_count !== undefined) {
    // Preflight結果がある場合はそれを使用（最も正確）
    allScenesReady = preflight.is_ready === true;
    readyCount = preflight.ready_count || 0;
    totalCount = preflight.total_count || 0;
  } else if (scenes.length > 0) {
    // Preflightがない場合はローカルのシーンデータで判定
    totalCount = scenes.filter(s => !s.is_hidden).length;
    readyCount = scenes.filter(s => {
      if (s.is_hidden) return false;
      const displayType = s.display_asset_type || 'image';
      if (displayType === 'comic') return s.active_comic?.r2_url;
      if (displayType === 'video') return s.active_video?.status === 'completed' && s.active_video?.r2_url;
      return s.active_image?.r2_url;
    }).length;
    allScenesReady = totalCount > 0 && readyCount === totalCount;
  }
  
  // Define progress stages - NO buttons, just clear status messages
  // step: 1=入力, 2=分割, 3=画像, 4=動画, 5=完了
  const stages = {
    'created': { 
      percent: 5, 
      step: 0, 
      message: '📝 ステップ1/4: テキストまたは音声を入力してください'
    },
    'uploaded': { 
      percent: 20, 
      step: 1, 
      message: '✅ 入力完了 → 📋 ステップ2/4: 下の「フォーマット実行」ボタンをクリック'
    },
    'transcribing': { 
      percent: 25, 
      step: 1, 
      message: '⏳ 音声を文字起こし中... しばらくお待ちください'
    },
    'transcribed': { 
      percent: 30, 
      step: 1, 
      message: '✅ 文字起こし完了 → 📋 ステップ2/4: 下の「フォーマット実行」ボタンをクリック'
    },
    'parsing': { 
      percent: 35, 
      step: 2, 
      message: '⏳ テキストを解析中... しばらくお待ちください'
    },
    'parsed': { 
      percent: 40, 
      step: 2, 
      message: '✅ 解析完了 → 下の「フォーマット実行」ボタンをクリック'
    },
    'formatting': { 
      percent: 45, 
      step: 2, 
      message: '⏳ シーン分割中... 完了まで約1分お待ちください'
    },
    'formatted': { 
      percent: 50, 
      step: 2, 
      message: '✅ シーン分割完了 → 🖼️ ステップ3/4: Builderタブで画像を生成',
      nextTab: 'builder'
    },
    'generating_images': { 
      percent: 70, 
      step: 3, 
      message: '⏳ 画像生成中... 完了までお待ちください'
    },
    'completed': { 
      percent: 100, 
      step: 5, 
      message: '🎉 全ステップ完了！ステップ4/4: Video Buildで動画を生成',
      nextTab: 'videoBuild'
    }
  };
  
  let stage = stages[status] || { percent: 0, step: 0, message: '状態を確認中...', nextAction: null };
  
  // 改善: formatted状態でも実際のシーン準備状況に応じて表示を変更
  if (status === 'formatted' && totalCount > 0) {
    if (allScenesReady) {
      // 全シーン準備完了 → Video Buildへ案内
      stage = {
        percent: 90,
        step: 4,
        message: `✅ 素材準備完了（${readyCount}/${totalCount}シーン） → 🎬 ステップ4/4: Video Buildで動画を生成`,
        nextTab: 'videoBuild'
      };
    } else if (readyCount > 0) {
      // 一部準備完了 → 進捗を表示
      const progressPct = Math.round(50 + (readyCount / totalCount) * 40); // 50-90%
      stage = {
        percent: progressPct,
        step: 3,
        message: `🖼️ 素材準備中（${readyCount}/${totalCount}シーン完了） → Builderで残りの素材を設定`,
        nextTab: 'builder'
      };
    }
    // readyCount === 0 の場合はデフォルトの formatted 表示を維持
  }
  
  // Update progress bar
  progressBarFill.style.width = stage.percent + '%';
  progressPercent.textContent = stage.percent + '%';
  
  // Update message - only show next tab button when step is complete and ready to move on
  // (formatted -> Builder, completed -> Video Build)
  if (stage.nextTab) {
    const tabLabels = {
      'builder': 'Builderへ進む',
      'videoBuild': 'Video Buildへ進む'
    };
    progressMessage.innerHTML = `
      <span>${stage.message}</span>
      <button 
        onclick="switchTab('${stage.nextTab}')"
        class="ml-3 px-4 py-1 bg-green-600 text-white text-sm rounded-lg hover:bg-green-700 transition-colors font-semibold"
      >
        ${tabLabels[stage.nextTab] || '次へ'} <i class="fas fa-arrow-right ml-1"></i>
      </button>
    `;
  } else {
    progressMessage.innerHTML = `<span>${stage.message}</span>`;
  }
  
  // Update step circles
  for (let i = 1; i <= 5; i++) {
    const stepEl = document.getElementById(`step${i}`);
    if (!stepEl) continue;
    
    const circle = stepEl.querySelector('.step-circle');
    const label = stepEl.querySelector('.step-label');
    
    if (i <= stage.step) {
      // Completed step
      circle.classList.remove('bg-gray-300', 'bg-blue-500');
      circle.classList.add('bg-green-500');
      label.classList.remove('text-gray-500', 'text-blue-600');
      label.classList.add('text-green-600', 'font-semibold');
    } else if (i === stage.step + 1) {
      // Current step (next to do)
      circle.classList.remove('bg-gray-300', 'bg-green-500');
      circle.classList.add('bg-blue-500', 'animate-pulse');
      label.classList.remove('text-gray-500', 'text-green-600');
      label.classList.add('text-blue-600', 'font-semibold');
    } else {
      // Future step
      circle.classList.remove('bg-green-500', 'bg-blue-500', 'animate-pulse');
      circle.classList.add('bg-gray-300');
      label.classList.remove('text-green-600', 'text-blue-600', 'font-semibold');
      label.classList.add('text-gray-500');
    }
  }
}

// Export for global access
window.updateProgressBar = updateProgressBar;

// Poll for single scene image generation completion
// ========== Robust Polling with Progress Indicator ==========

// Start watching a scene for image generation
function startGenerationWatch(sceneId) {
  if (!window.generatingSceneWatch[sceneId]) {
    window.generatingSceneWatch[sceneId] = { 
      startedAt: Date.now(), 
      attempts: 0,
      timerId: null
    };
    console.log(`✅ Started watching scene ${sceneId}`);
  }
}

// Stop watching a scene
function stopGenerationWatch(sceneId) {
  const watch = window.generatingSceneWatch[sceneId];
  if (watch) {
    if (watch.timerId) {
      clearInterval(watch.timerId);
    }
    delete window.generatingSceneWatch[sceneId];
    console.log(`✅ Stopped watching scene ${sceneId}`);
  }
}

// Rate limit countdown state
window.rateLimitCountdowns = window.rateLimitCountdowns || {};

/**
 * レート制限時のカウントダウン表示
 * 待機時間経過後に自動再試行をサポート
 */
function showRateLimitCountdown(sceneId, waitSeconds) {
  // 既存のカウントダウンがあれば停止
  if (window.rateLimitCountdowns[sceneId]) {
    clearInterval(window.rateLimitCountdowns[sceneId].timerId);
    delete window.rateLimitCountdowns[sceneId];
  }
  
  const startTime = Date.now();
  const endTime = startTime + (waitSeconds * 1000);
  
  // カウントダウントーストを表示
  const toastId = `rate-limit-toast-${sceneId}`;
  const toastHtml = `
    <div id="${toastId}" class="fixed bottom-20 right-4 bg-yellow-500 text-white px-4 py-3 rounded-lg shadow-lg z-50 flex items-center gap-3">
      <i class="fas fa-clock animate-pulse"></i>
      <div>
        <div class="font-medium">レート制限中</div>
        <div class="text-sm">
          再試行可能まで: <span id="${toastId}-countdown">${waitSeconds}</span>秒
        </div>
      </div>
      <button onclick="cancelRateLimitCountdown(${sceneId})" class="ml-2 text-white/70 hover:text-white">
        <i class="fas fa-times"></i>
      </button>
    </div>
  `;
  
  // 既存の同じトーストを削除
  const existingToast = document.getElementById(toastId);
  if (existingToast) existingToast.remove();
  
  document.body.insertAdjacentHTML('beforeend', toastHtml);
  
  // カウントダウン更新
  const timerId = setInterval(() => {
    const remaining = Math.max(0, Math.ceil((endTime - Date.now()) / 1000));
    const countdownEl = document.getElementById(`${toastId}-countdown`);
    
    if (countdownEl) {
      countdownEl.textContent = remaining;
    }
    
    if (remaining <= 0) {
      clearInterval(timerId);
      delete window.rateLimitCountdowns[sceneId];
      
      // トーストを更新して再試行ボタンを表示
      const toast = document.getElementById(toastId);
      if (toast) {
        toast.className = 'fixed bottom-20 right-4 bg-green-500 text-white px-4 py-3 rounded-lg shadow-lg z-50 flex items-center gap-3';
        toast.innerHTML = `
          <i class="fas fa-check-circle"></i>
          <div>
            <div class="font-medium">待機完了</div>
            <div class="text-sm">再試行できます</div>
          </div>
          <button onclick="retryAfterRateLimit(${sceneId})" class="ml-2 bg-white/20 hover:bg-white/30 px-3 py-1 rounded text-sm">
            再生成
          </button>
          <button onclick="document.getElementById('${toastId}').remove()" class="ml-1 text-white/70 hover:text-white">
            <i class="fas fa-times"></i>
          </button>
        `;
        
        // 10秒後に自動で非表示
        setTimeout(() => {
          const t = document.getElementById(toastId);
          if (t) t.remove();
        }, 10000);
      }
    }
  }, 1000);
  
  window.rateLimitCountdowns[sceneId] = { timerId, endTime };
}

// カウントダウンをキャンセル
function cancelRateLimitCountdown(sceneId) {
  if (window.rateLimitCountdowns[sceneId]) {
    clearInterval(window.rateLimitCountdowns[sceneId].timerId);
    delete window.rateLimitCountdowns[sceneId];
  }
  const toast = document.getElementById(`rate-limit-toast-${sceneId}`);
  if (toast) toast.remove();
}

// レート制限後の再試行
async function retryAfterRateLimit(sceneId) {
  const toast = document.getElementById(`rate-limit-toast-${sceneId}`);
  if (toast) toast.remove();
  
  // 少し待ってから再生成を試行
  showToast('画像を再生成しています...', 'info');
  await generateSceneImage(sceneId);
}

// Update button UI with progress percentage
function updateGeneratingButtonUI(sceneId, percent) {
  // Use new state-driven function
  setPrimaryButtonState(sceneId, 'RUNNING', percent);
}

// Robust polling function with network error resilience
function pollSceneImageGeneration(sceneId) {
  const maxAttempts = 120; // 10 minutes (5s × 120)
  const intervalMs = 5000;
  
  // Start watching if not already
  startGenerationWatch(sceneId);
  
  const timerId = setInterval(async () => {
    try {
      const watch = window.generatingSceneWatch[sceneId];
      if (!watch) {
        clearInterval(timerId);
        return;
      }
      
      watch.attempts++;
      
      // ✅ Calculate pseudo-progress based on elapsed time
      const elapsedSec = (Date.now() - watch.startedAt) / 1000;
      let percent;
      if (elapsedSec < 45) {
        percent = Math.round((elapsedSec / 45) * 80); // 0-45s → 0-80%
      } else if (elapsedSec < 90) {
        percent = 80 + Math.round(((elapsedSec - 45) / 45) * 15); // 45-90s → 80-95%
      } else {
        percent = 95; // 90s+ → stuck at 95%
      }
      
      updateGeneratingButtonUI(sceneId, percent);
      
      // ✅ Fetch single scene status (lightweight)
      const response = await axios.get(`${API_BASE}/scenes/${sceneId}?view=board&_t=${Date.now()}`);
      const scene = response.data;
      const imageStatus = scene?.latest_image?.status || 'pending';
      
      console.log(`[Poll] Scene ${sceneId} status: ${imageStatus}, elapsed: ${Math.round(elapsedSec)}s, attempt: ${watch.attempts}/${maxAttempts}`);
      
      // ===== STATUS: COMPLETED =====
      if (imageStatus === 'completed') {
        clearInterval(timerId);
        stopGenerationWatch(sceneId);
        if (window.sceneProcessing) window.sceneProcessing[sceneId] = false;
        
        showToast('画像生成が完了しました', 'success');
        
        // ✅ Update only this scene card (no full reload)
        await updateSingleSceneCard(sceneId);
        
        // ✅ Check if all images are done → update project status to 'completed'
        await checkAndUpdateProjectStatus();
        return;
      }
      
      // ===== STATUS: FAILED =====
      if (imageStatus === 'failed') {
        clearInterval(timerId);
        stopGenerationWatch(sceneId);
        if (window.sceneProcessing) window.sceneProcessing[sceneId] = false;
        
        const errorMsg = scene.latest_image?.error_message || '画像生成に失敗しました';
        showToast(`画像生成失敗: ${errorMsg}`, 'error');
        
        // ✅ Update card to show error + regenerate button
        await updateSingleSceneCard(sceneId);
        return;
      }
      
      // ===== TIMEOUT =====
      if (watch.attempts >= maxAttempts) {
        clearInterval(timerId);
        
        console.warn(`[Poll] Scene ${sceneId} timeout after ${maxAttempts} attempts. Attempting auto-recovery...`);
        
        // ✅ IMPROVEMENT: Try to recover by calling cleanup API and checking true status
        try {
          // 1. Call status API which will auto-cleanup stuck records on backend
          const recoveryResponse = await axios.get(`${API_BASE}/scenes/${sceneId}?view=board&_t=${Date.now()}&force_cleanup=1`);
          const recoveredScene = recoveryResponse.data;
          const recoveredStatus = recoveredScene?.latest_image?.status || 'unknown';
          
          console.log(`[Poll] Recovery check for scene ${sceneId}: status = ${recoveredStatus}`);
          
          if (recoveredStatus === 'completed') {
            // Image was actually completed
            stopGenerationWatch(sceneId);
            if (window.sceneProcessing) window.sceneProcessing[sceneId] = false;
            showToast('画像生成が完了しました', 'success');
            await updateSingleSceneCard(sceneId);
            await checkAndUpdateProjectStatus();
            return;
          } else if (recoveredStatus === 'failed') {
            // Image generation failed
            stopGenerationWatch(sceneId);
            if (window.sceneProcessing) window.sceneProcessing[sceneId] = false;
            showToast('画像生成がタイムアウトしました。再生成してください', 'warning');
            await updateSingleSceneCard(sceneId);
            return;
          } else {
            // Still generating - restart polling with fresh timer
            watch.attempts = 0;
            watch.startedAt = Date.now();
            showToast(`画像生成を継続監視中（シーン${sceneId}）`, 'info');
            pollSceneImageGeneration(sceneId); // Restart polling
            return;
          }
        } catch (recoveryError) {
          console.error(`[Poll] Recovery failed for scene ${sceneId}:`, recoveryError);
          // Show warning but don't stop completely
          stopGenerationWatch(sceneId);
          if (window.sceneProcessing) window.sceneProcessing[sceneId] = false;
          showToast(`通信エラー。ページをリロードしてください`, 'error');
          await updateSingleSceneCard(sceneId);
          return;
        }
      }
      
    } catch (error) {
      // ✅ CRITICAL: Network errors should NOT stop polling
      console.warn(`[Poll] Transient error for scene ${sceneId}:`, error?.message || error);
      // Continue to next tick (do NOT clear interval, do NOT stop watch)
    }
  }, intervalMs);
  
  // Store timer ID for cleanup
  const watch = window.generatingSceneWatch[sceneId];
  if (watch) {
    watch.timerId = timerId;
  }
}

// Auto-resume generating scenes (called from initBuilderTab)
function autoResumeGeneratingScenes(scenes) {
  scenes.forEach(scene => {
    const imageStatus = scene.latest_image?.status;
    if (imageStatus === 'generating') {
      // Check if already watching
      if (!window.generatingSceneWatch[scene.id]) {
        console.log(`[AutoResume] Resuming polling for scene ${scene.id}`);
        startGenerationWatch(scene.id);
        pollSceneImageGeneration(scene.id);
      }
    }
  });
}

/**
 * Phase 2-3: Open scene edit modal
 * @param {number} sceneId 
 */
function openSceneEditModal(sceneId, initialTab) {
  if (window.SceneEditModal) {
    // P3-5: Pass source='builder' for SSOT control (hides chat edit button)
    window.SceneEditModal.open(sceneId, { source: 'builder' });
    
    // R1.6: If initialTab specified, switch to that tab after modal opens
    if (initialTab && window.SceneEditModal.switchTab) {
      setTimeout(() => {
        // Map 'audio' to 'utterances' for backward compatibility
        const tabName = initialTab === 'audio' ? 'utterances' : initialTab;
        window.SceneEditModal.switchTab(tabName);
      }, 300);
    }
  } else {
    console.error('[SceneEdit] SceneEditModal not loaded');
    alert('シーン編集機能が読み込まれていません');
  }
}

/**
 * R1.6: Open scene edit modal and switch to utterances tab
 * Used from video build preflight errors to address voice/audio issues
 * @param {number} sceneId - Scene DB ID (not index)
 */
function openSceneEditModalToVoiceTab(sceneId) {
  if (!sceneId || sceneId < 1) {
    console.error('[SceneEdit] Invalid sceneId:', sceneId);
    alert('シーンIDが無効です');
    return;
  }
  
  if (window.SceneEditModal) {
    // P3-5: Pass source='video_build' for SSOT control (shows chat edit button)
    window.SceneEditModal.open(sceneId, { source: 'video_build' });
    
    // 少し待ってから発話（utterances）タブに切り替え
    // 注: 'voice' タブは存在しない。音声編集は 'utterances' タブで行う
    setTimeout(() => {
      if (window.SceneEditModal.switchTab) {
        window.SceneEditModal.switchTab('utterances');
      }
    }, 300);
  } else {
    console.error('[SceneEdit] SceneEditModal not loaded');
    alert('シーン編集機能が読み込まれていません');
  }
}

// ========== Phase D-1: Video Generation ==========

// Global state for video generation
window.videoGenerating = window.videoGenerating || {};

/**
 * Check if user has configured video API key
 * @returns {Promise<boolean>}
 */
async function checkVideoApiKey() {
  try {
    const response = await axios.get(`${API_BASE}/user/api-keys`);
    // 仕様: { keys: [ { provider: "google", is_configured: true, updated_at: "..." } ] }
    const keys = response.data.keys || [];
    const googleKey = keys.find(k => k.provider === 'google');
    return googleKey && googleKey.is_configured;
  } catch (error) {
    console.error('[Video] Failed to check API key:', error);
    return false;
  }
}

/**
 * Open video generation modal
 * @param {number} sceneId 
 */
async function openVideoModal(sceneId) {
  // Check for active image
  const sceneCard = document.getElementById(`builder-scene-${sceneId}`);
  if (!sceneCard || sceneCard.getAttribute('data-status') !== 'completed') {
    showToast('画像生成が完了してから動画化してください', 'warning');
    return;
  }
  
  // Check API key
  const hasApiKey = await checkVideoApiKey();
  if (!hasApiKey) {
    showToast('動画生成には Google AI Studio のAPIキー設定が必要です', 'warning');
    // Offer to redirect to settings (non-intrusive)
    if (confirm('設定画面でAPIキーを登録しますか？\n\n※ Google AI Studio で無料取得できます')) {
      window.location.href = '/settings';
    }
    return;
  }
  
  // Check for existing generating video
  if (window.videoGenerating[sceneId]) {
    showToast('このシーンは動画生成中です', 'warning');
    return;
  }
  
  // ⚠️ Check if image generation is in progress for this scene
  if (window.sceneProcessing && window.sceneProcessing[sceneId]) {
    showToast('このシーンは画像生成中です。完了後にお試しください', 'warning');
    return;
  }
  
  // Create modal HTML
  const modalId = 'videoGenerationModal';
  let modal = document.getElementById(modalId);
  if (!modal) {
    modal = document.createElement('div');
    modal.id = modalId;
    document.body.appendChild(modal);
  }
  
  modal.className = 'fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50';
  modal.innerHTML = `
    <div class="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 overflow-hidden">
      <div class="bg-gradient-to-r from-purple-600 to-blue-600 px-6 py-4">
        <h3 class="text-xl font-bold text-white">
          <i class="fas fa-video mr-2"></i>動画生成 - シーン #${getSceneIndex(sceneId)}
        </h3>
      </div>
      <div class="p-6 space-y-6">
        <!-- Engine Selection (Veo2 / Veo3) -->
        <div>
          <label class="block text-sm font-semibold text-gray-700 mb-2">
            <i class="fas fa-cog mr-1"></i>動画エンジン
          </label>
          <div class="grid grid-cols-2 gap-3">
            <label class="relative cursor-pointer">
              <input type="radio" name="videoEngine-${sceneId}" value="veo2" class="peer sr-only" checked>
              <div class="p-3 border-2 rounded-lg peer-checked:border-purple-500 peer-checked:bg-purple-50 hover:bg-gray-50 transition-colors">
                <div class="font-semibold text-gray-800">🎬 Veo2</div>
                <div class="text-xs text-gray-500 mt-1">Google AI Studio</div>
                <div class="text-xs text-blue-600 mt-1">5秒 / 手軽</div>
              </div>
            </label>
            <label class="relative cursor-pointer">
              <input type="radio" name="videoEngine-${sceneId}" value="veo3" class="peer sr-only">
              <div class="p-3 border-2 rounded-lg peer-checked:border-purple-500 peer-checked:bg-purple-50 hover:bg-gray-50 transition-colors">
                <div class="font-semibold text-gray-800">🚀 Veo3</div>
                <div class="text-xs text-gray-500 mt-1">Vertex AI</div>
                <div class="text-xs text-green-600 mt-1">8秒 / 高品質</div>
              </div>
            </label>
          </div>
        </div>

        <!-- Duration Display (changes based on engine) -->
        <div>
          <label class="block text-sm font-semibold text-gray-700 mb-2">
            <i class="fas fa-clock mr-1"></i>動画の長さ
          </label>
          <div class="flex gap-4 items-center" id="durationDisplay-${sceneId}">
            <span class="px-3 py-1 bg-purple-100 text-purple-700 rounded-full text-sm font-medium">5秒（固定）</span>
            <span class="text-xs text-gray-500">※ Veo2 の仕様です</span>
          </div>
        </div>
        
        <!-- Prompt Input -->
        <div>
          <label class="block text-sm font-semibold text-gray-700 mb-2">
            <i class="fas fa-edit mr-1"></i>動画プロンプト（任意）
          </label>
          <textarea 
            id="videoPrompt-${sceneId}"
            rows="3"
            class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 text-sm"
            placeholder="動きや演出の指示を入力（例: カメラがゆっくりズームイン、光の動き、キャラクターの微妙な表情変化）"
          ></textarea>
          <p class="text-xs text-gray-500 mt-1">空欄の場合はシンプルなモーションが適用されます</p>
        </div>
        
        <!-- Cost & Retention Notice -->
        <div class="bg-yellow-50 border-l-4 border-yellow-400 p-4 rounded">
          <div class="flex items-start">
            <i class="fas fa-exclamation-triangle text-yellow-500 mr-2 mt-0.5"></i>
            <div class="text-sm">
              <p class="font-semibold text-yellow-800 mb-1">ご注意</p>
              <ul class="text-yellow-700 space-y-1">
                <li>• <strong>APIコスト</strong>: お客様のAPIキーで課金されます</li>
                <li>• <strong>保存期間</strong>: 動画は<strong>30日後</strong>に自動削除されます</li>
                <li>• 生成には<strong>1-3分</strong>かかる場合があります</li>
              </ul>
            </div>
          </div>
        </div>
        
        <!-- Consent Checkbox -->
        <div class="flex items-start gap-2">
          <input 
            type="checkbox" 
            id="videoConsent-${sceneId}" 
            class="w-4 h-4 mt-1 text-purple-600"
          >
          <label for="videoConsent-${sceneId}" class="text-sm text-gray-700">
            上記の注意事項を理解し、APIコストが発生することに同意します
          </label>
        </div>
      </div>
      
      <!-- Actions -->
      <div class="px-6 py-4 bg-gray-50 border-t border-gray-200 flex justify-end gap-3">
        <button 
          onclick="closeVideoModal()"
          class="px-4 py-2 bg-gray-500 text-white rounded-lg hover:bg-gray-600 transition-colors font-semibold"
        >
          キャンセル
        </button>
        <button 
          id="generateVideoBtn-${sceneId}"
          onclick="generateVideo(${sceneId})"
          class="px-6 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors font-semibold"
        >
          <i class="fas fa-magic mr-2"></i>動画を生成
        </button>
      </div>
    </div>
  `;
  
  modal.classList.remove('hidden');
  
  // Close on backdrop click
  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      closeVideoModal();
    }
  });
  
  // Engine selection change handler
  const engineRadios = modal.querySelectorAll(`input[name="videoEngine-${sceneId}"]`);
  engineRadios.forEach(radio => {
    radio.addEventListener('change', () => {
      const display = document.getElementById(`durationDisplay-${sceneId}`);
      if (radio.value === 'veo3') {
        display.innerHTML = `
          <span class="px-3 py-1 bg-green-100 text-green-700 rounded-full text-sm font-medium">8秒（固定）</span>
          <span class="text-xs text-gray-500">※ Veo3 の仕様です</span>
        `;
      } else {
        display.innerHTML = `
          <span class="px-3 py-1 bg-purple-100 text-purple-700 rounded-full text-sm font-medium">5秒（固定）</span>
          <span class="text-xs text-gray-500">※ Veo2 の仕様です</span>
        `;
      }
    });
  });
}

/**
 * Get scene index from cached scenes
 * @param {number} sceneId 
 * @returns {number}
 */
function getSceneIndex(sceneId) {
  const scenes = window.lastLoadedScenes || [];
  const scene = scenes.find(s => s.id === sceneId);
  return scene?.idx || '?';
}

/**
 * Close video generation modal
 */
function closeVideoModal() {
  const modal = document.getElementById('videoGenerationModal');
  if (modal) {
    modal.classList.add('hidden');
    modal.innerHTML = '';
  }
}

/**
 * Generate video for a scene
 * @param {number} sceneId 
 */
async function generateVideo(sceneId) {
  // Get modal button first (for disabling during processing)
  const btn = document.getElementById(`generateVideoBtn-${sceneId}`);
  
  // Validate consent
  const consent = document.getElementById(`videoConsent-${sceneId}`);
  if (!consent || !consent.checked) {
    showToast('注意事項への同意が必要です', 'warning');
    return;
  }
  
  // Get selected engine (veo2 or veo3)
  const engineRadio = document.querySelector(`input[name="videoEngine-${sceneId}"]:checked`);
  const videoEngine = engineRadio?.value || 'veo2';
  
  // Duration depends on engine
  const duration = videoEngine === 'veo3' ? 8 : 5;
  
  // Get prompt
  const promptEl = document.getElementById(`videoPrompt-${sceneId}`);
  const prompt = promptEl?.value?.trim() || '';
  
  // Prevent double click - check both flag AND button state
  if (window.videoGenerating[sceneId] || (btn && btn.disabled)) {
    showToast('動画生成中です', 'warning');
    return;
  }
  
  // Immediately disable button to prevent rapid clicks
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>生成開始中...';
  }
  
  window.videoGenerating[sceneId] = true;
  
  try {
    const response = await axios.post(`${API_BASE}/scenes/${sceneId}/generate-video`, {
      duration_sec: duration,
      prompt: prompt,
      provider: 'google',
      video_engine: videoEngine
    });
    
    if (response.data.success) {
      showToast('動画生成を開始しました。完了まで1-3分お待ちください', 'success');
      closeVideoModal();
      
      // Start polling for video completion
      pollVideoGeneration(sceneId, response.data.video_id);
    } else {
      throw new Error(response.data.error?.message || '動画生成の開始に失敗しました');
    }
    
  } catch (error) {
    console.error('[Video] Generation error:', error);
    
    // Handle 409 Conflict - already generating
    if (error.response?.status === 409) {
      showToast('このシーンは既に動画生成中です', 'warning');
      closeVideoModal();
      // Keep videoGenerating flag true since it's actually generating
      return;
    }
    
    const errorMsg = error.response?.data?.error?.message || error.message || '動画生成中にエラーが発生しました';
    showToast(errorMsg, 'error');
    
    window.videoGenerating[sceneId] = false;
    
    // Reset button
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-magic mr-2"></i>動画を生成';
    }
  }
}

/**
 * Generate video from inline prompt section (no modal)
 * Uses video-regenerate API if video already exists, generate-video otherwise
 * @param {number} sceneId 
 */
async function generateVideoInline(sceneId) {
  const btn = document.getElementById(`videoBtn-${sceneId}`);
  const promptEl = document.getElementById(`videoPromptInline-${sceneId}`);
  const engineEl = document.getElementById(`videoEngineInline-${sceneId}`);
  
  const prompt = promptEl?.value?.trim() || '';
  const videoEngine = engineEl?.value || 'veo2';
  const duration = videoEngine === 'veo3' ? 8 : 5;
  
  // Prevent double click
  if (window.videoGenerating[sceneId] || (btn && btn.disabled)) {
    showToast('動画生成中です', 'warning');
    return;
  }
  
  // Check API key
  const hasApiKey = await checkVideoApiKey();
  if (!hasApiKey) {
    showToast('動画生成には Google AI Studio のAPIキー設定が必要です', 'warning');
    if (confirm('設定画面でAPIキーを登録しますか？\n\n※ Google AI Studio で無料取得できます')) {
      window.location.href = '/settings';
    }
    return;
  }
  
  // Check if image generation is in progress
  if (window.sceneProcessing && window.sceneProcessing[sceneId]) {
    showToast('このシーンは画像生成中です。完了後にお試しください', 'warning');
    return;
  }
  
  // Disable UI elements
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>生成開始中...';
  }
  if (promptEl) promptEl.disabled = true;
  if (engineEl) engineEl.disabled = true;
  
  window.videoGenerating[sceneId] = true;
  
  // ✅ 右カラムに動画生成中プレビューを動的に追加
  const existingVideoPreview = document.getElementById(`videoPreview-${sceneId}`);
  if (!existingVideoPreview) {
    // 画像コンテナの直後に挿入
    const imageContainer = document.querySelector(`#builder-scene-${sceneId} .scene-image-container`);
    if (imageContainer) {
      const progressDiv = document.createElement('div');
      progressDiv.id = `videoPreview-${sceneId}`;
      progressDiv.className = 'relative aspect-video bg-gray-900 rounded-lg border-2 border-yellow-400 overflow-hidden mt-2 flex items-center justify-center';
      progressDiv.innerHTML = `
        <div class="text-center text-white">
          <i class="fas fa-spinner fa-spin text-3xl mb-2"></i>
          <p class="text-sm font-semibold" id="videoProgress-${sceneId}">動画生成開始中...</p>
          <p class="text-xs text-gray-400 mt-1">完了まで1〜3分</p>
        </div>
        <div class="absolute top-2 left-2 px-2 py-1 bg-yellow-500 text-white text-xs rounded-full font-semibold">
          <i class="fas fa-video mr-1"></i>生成中
        </div>
      `;
      imageContainer.insertAdjacentElement('afterend', progressDiv);
    }
  } else {
    // 既存のプレビューを生成中に更新
    existingVideoPreview.className = 'relative aspect-video bg-gray-900 rounded-lg border-2 border-yellow-400 overflow-hidden mt-2 flex items-center justify-center';
    existingVideoPreview.innerHTML = `
      <div class="text-center text-white">
        <i class="fas fa-spinner fa-spin text-3xl mb-2"></i>
        <p class="text-sm font-semibold" id="videoProgress-${sceneId}">動画を再生成中...</p>
        <p class="text-xs text-gray-400 mt-1">完了まで1〜3分</p>
      </div>
      <div class="absolute top-2 left-2 px-2 py-1 bg-yellow-500 text-white text-xs rounded-full font-semibold">
        <i class="fas fa-video mr-1"></i>生成中
      </div>
    `;
  }
  
  // 動画化タブボタンも更新
  const tabBtn = document.getElementById(`videoTabBtn-${sceneId}`);
  if (tabBtn) {
    tabBtn.disabled = true;
    tabBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>動画生成中...';
    tabBtn.className = 'flex-1 px-2 py-1.5 rounded-lg text-xs font-semibold transition-colors bg-yellow-500 text-white cursor-not-allowed';
  }
  
  // Determine: regenerate (has active video) or first-time generate
  const scenes = window.lastLoadedScenes || [];
  const scene = scenes.find(s => s.id === sceneId);
  const hasActiveVideo = scene?.active_video && scene.active_video.status === 'completed';
  
  try {
    let response;
    if (hasActiveVideo) {
      // Regenerate with updated prompt
      response = await axios.post(`${API_BASE}/scenes/${sceneId}/video-regenerate`, {
        prompt: prompt || undefined,
        duration_sec: duration,
        model: videoEngine === 'veo3' ? 'veo-3.0-generate-preview' : 'veo-2.0-generate-001',
      });
    } else {
      // First-time generation
      response = await axios.post(`${API_BASE}/scenes/${sceneId}/generate-video`, {
        duration_sec: duration,
        prompt: prompt,
        provider: 'google',
        video_engine: videoEngine,
      });
    }
    
    if (response.data.success || response.data.video_id || response.data.video_generation) {
      const videoId = response.data.video_id || response.data.video_generation?.id;
      showToast('動画生成を開始しました。完了まで1-3分お待ちください', 'success');
      
      // Start polling
      if (videoId) {
        pollVideoGeneration(sceneId, videoId);
      }
    } else {
      throw new Error(response.data.error?.message || '動画生成の開始に失敗しました');
    }
    
  } catch (error) {
    console.error('[VideoInline] Generation error:', error);
    
    if (error.response?.status === 409) {
      showToast('このシーンは既に動画生成中です', 'warning');
      return;
    }
    
    const errorMsg = error.response?.data?.error?.message || error.message || '動画生成中にエラーが発生しました';
    showToast(errorMsg, 'error');
    
    window.videoGenerating[sceneId] = false;
    
    // Reset UI
    if (btn) {
      btn.disabled = false;
      const hasVideo = scene?.active_video?.status === 'completed';
      btn.innerHTML = hasVideo 
        ? '<i class="fas fa-redo mr-1"></i>プロンプトで再生成'
        : '<i class="fas fa-magic mr-1"></i>動画化';
    }
    if (promptEl) promptEl.disabled = false;
    if (engineEl) engineEl.disabled = false;
  }
}

// Expose globally
window.generateVideoInline = generateVideoInline;

/**
 * Poll for video generation completion (To-Be: AWS status API使用)
 * @param {number} sceneId 
 * @param {number} videoId 
 */
function pollVideoGeneration(sceneId, videoId) {
  const maxAttempts = 120; // 10 minutes (5s × 120)
  let attempts = 0;
  const startTime = Date.now();
  
  // Progress stage mapping for display
  const progressStageMap = {
    'queued': { text: 'キュー待ち', percent: 10 },
    'generating': { text: '生成中', percent: 50 },
    'uploading': { text: 'アップロード中', percent: 90 },
    'completed': { text: '完了', percent: 100 },
    'failed': { text: '失敗', percent: 0 },
  };
  
  // Update video button to show generating state
  const videoBtn = document.getElementById(`videoBtn-${sceneId}`);
  
  // Also disable primary button (image regenerate) during video generation
  const primaryBtn = document.getElementById(`primaryBtn-${sceneId}`);
  if (primaryBtn && !primaryBtn.disabled) {
    primaryBtn.dataset.wasEnabled = 'true';
    primaryBtn.disabled = true;
    primaryBtn.classList.add('opacity-50', 'cursor-not-allowed');
  }
  
  if (videoBtn) {
    videoBtn.disabled = true;
    videoBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>キュー待ち...';
    videoBtn.className = 'flex-1 px-3 py-2 rounded-lg font-semibold text-sm touch-manipulation bg-yellow-500 text-white opacity-75 cursor-not-allowed';
  }
  
  const pollInterval = setInterval(async () => {
    try {
      attempts++;
      
      // Calculate elapsed time for display
      const elapsedMs = Date.now() - startTime;
      const elapsedSec = Math.floor(elapsedMs / 1000);
      const elapsedMin = Math.floor(elapsedSec / 60);
      const elapsedSecRemainder = elapsedSec % 60;
      const elapsedStr = elapsedMin > 0 ? `${elapsedMin}分${elapsedSecRemainder}秒` : `${elapsedSecRemainder}秒`;
      
      // Fetch AWS job status via new status API
      const response = await axios.get(`${API_BASE}/scenes/${sceneId}/videos/${videoId}/status`);
      const statusData = response.data;
      
      // Get progress stage info
      const progressStage = statusData.progress_stage || statusData.status || 'generating';
      const stageInfo = progressStageMap[progressStage] || progressStageMap['generating'];
      
      // Update button with status (not fake percentage)
      if (videoBtn) {
        videoBtn.innerHTML = `<i class="fas fa-spinner fa-spin mr-1"></i>${stageInfo.text} (${elapsedStr})`;
      }
      
      // Update right-column video progress indicator
      const videoProgressEl = document.getElementById(`videoProgress-${sceneId}`);
      if (videoProgressEl) {
        videoProgressEl.textContent = `${stageInfo.text}... (${elapsedStr})`;
      }
      
      console.log(`[VideoPoll] Video ${videoId} status: ${statusData.status}, stage: ${progressStage}, elapsed: ${elapsedStr}, attempt: ${attempts}/${maxAttempts}`);
      
      // Helper to restore primary button
      const restorePrimaryBtn = () => {
        const pBtn = document.getElementById(`primaryBtn-${sceneId}`);
        if (pBtn && pBtn.dataset.wasEnabled === 'true') {
          pBtn.disabled = false;
          pBtn.classList.remove('opacity-50', 'cursor-not-allowed');
          delete pBtn.dataset.wasEnabled;
        }
      };
      
      // Check status from AWS response
      if (statusData.status === 'completed') {
        clearInterval(pollInterval);
        window.videoGenerating[sceneId] = false;
        
        showToast('動画生成が完了しました！', 'success');
        
        // Update button to show "再生成" state
        if (videoBtn) {
          videoBtn.disabled = false;
          videoBtn.innerHTML = '<i class="fas fa-redo mr-1"></i>プロンプトで再生成';
          videoBtn.className = 'flex-1 px-3 py-2 rounded-lg font-semibold text-sm touch-manipulation bg-purple-600 text-white hover:bg-purple-700 transition-colors';
        }
        
        // Re-enable inline prompt controls
        const promptEl = document.getElementById(`videoPromptInline-${sceneId}`);
        const engineEl = document.getElementById(`videoEngineInline-${sceneId}`);
        if (promptEl) promptEl.disabled = false;
        if (engineEl) engineEl.disabled = false;
        
        restorePrimaryBtn();
        
        // Refresh the scene card to show the new video preview
        try {
          const sceneRes = await axios.get(`${API_BASE}/scenes/${sceneId}?view=board`);
          const updatedScene = sceneRes.data;
          if (window.lastLoadedScenes) {
            const idx = window.lastLoadedScenes.findIndex(s => s.id === sceneId);
            if (idx !== -1) window.lastLoadedScenes[idx] = updatedScene;
          }
          const sceneCard = document.getElementById(`builder-scene-${sceneId}`);
          if (sceneCard) {
            const scrollY = window.scrollY;
            sceneCard.outerHTML = renderBuilderSceneCard(updatedScene);
            window.scrollTo(0, scrollY);
            const newCard = document.getElementById(`builder-scene-${sceneId}`);
            if (newCard) initializeSceneCardButtons(updatedScene, newCard);
          }
        } catch (refreshErr) {
          console.warn('[VideoPoll] Scene refresh failed:', refreshErr);
        }
        
        return;
      }
      
      if (statusData.status === 'failed') {
        clearInterval(pollInterval);
        window.videoGenerating[sceneId] = false;
        
        const errorMsg = statusData.error?.message || '動画生成に失敗しました';
        showToast(`動画生成失敗: ${errorMsg}`, 'error');
        
        // Update button
        if (videoBtn) {
          videoBtn.disabled = false;
          const scenes = window.lastLoadedScenes || [];
          const sc = scenes.find(s => s.id === sceneId);
          const hasVideo = sc?.active_video?.status === 'completed';
          videoBtn.innerHTML = hasVideo 
            ? '<i class="fas fa-redo mr-1"></i>プロンプトで再生成'
            : '<i class="fas fa-magic mr-1"></i>動画化';
          videoBtn.className = 'flex-1 px-3 py-2 rounded-lg font-semibold text-sm touch-manipulation bg-purple-600 text-white hover:bg-purple-700 transition-colors';
        }
        
        // Re-enable inline prompt controls
        const promptElFail = document.getElementById(`videoPromptInline-${sceneId}`);
        const engineElFail = document.getElementById(`videoEngineInline-${sceneId}`);
        if (promptElFail) promptElFail.disabled = false;
        if (engineElFail) engineElFail.disabled = false;
        
        restorePrimaryBtn();
        return;
      }
      
      // Timeout
      if (attempts >= maxAttempts) {
        clearInterval(pollInterval);
        window.videoGenerating[sceneId] = false;
        
        showToast('動画生成がタイムアウトしました。履歴をご確認ください', 'warning');
        
        // Reset button
        if (videoBtn) {
          videoBtn.disabled = false;
          const scenes = window.lastLoadedScenes || [];
          const sc = scenes.find(s => s.id === sceneId);
          const hasVideo = sc?.active_video?.status === 'completed';
          videoBtn.innerHTML = hasVideo 
            ? '<i class="fas fa-redo mr-1"></i>プロンプトで再生成'
            : '<i class="fas fa-magic mr-1"></i>動画化';
          videoBtn.className = 'flex-1 px-3 py-2 rounded-lg font-semibold text-sm touch-manipulation bg-purple-600 text-white hover:bg-purple-700 transition-colors';
        }
        
        // Re-enable inline prompt controls
        const promptElTimeout = document.getElementById(`videoPromptInline-${sceneId}`);
        const engineElTimeout = document.getElementById(`videoEngineInline-${sceneId}`);
        if (promptElTimeout) promptElTimeout.disabled = false;
        if (engineElTimeout) engineElTimeout.disabled = false;
        
        restorePrimaryBtn();
      }
      
    } catch (error) {
      console.warn('[VideoPoll] Transient error:', error?.message);
      // Continue polling (transient errors are normal during AWS processing)
    }
  }, 5000);
}

/**
 * View video history for a scene
 * @param {number} sceneId 
 */
async function viewVideoHistory(sceneId) {
  try {
    const response = await axios.get(`${API_BASE}/scenes/${sceneId}/videos`);
    // Backend returns video_generations (not videos)
    const videos = response.data.video_generations || response.data.videos || [];
    
    // Create modal
    const modalId = 'videoHistoryModal';
    let modal = document.getElementById(modalId);
    if (!modal) {
      modal = document.createElement('div');
      modal.id = modalId;
      document.body.appendChild(modal);
    }
    
    modal.className = 'fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50';
    
    if (videos.length === 0) {
      modal.innerHTML = `
        <div class="bg-white rounded-lg shadow-xl max-w-md w-full mx-4">
          <div class="bg-gradient-to-r from-purple-600 to-blue-600 px-6 py-4">
            <h3 class="text-xl font-bold text-white">
              <i class="fas fa-film mr-2"></i>動画履歴 - シーン #${getSceneIndex(sceneId)}
            </h3>
          </div>
          <div class="p-8 text-center">
            <i class="fas fa-video text-6xl text-gray-300 mb-4"></i>
            <p class="text-gray-500">動画生成履歴がありません</p>
          </div>
          <div class="px-6 py-4 bg-gray-50 border-t border-gray-200 flex justify-end">
            <button onclick="closeVideoHistoryModal()" class="px-4 py-2 bg-gray-500 text-white rounded-lg hover:bg-gray-600 transition-colors font-semibold">
              閉じる
            </button>
          </div>
        </div>
      `;
    } else {
      modal.innerHTML = `
        <div class="bg-white rounded-lg shadow-xl max-w-4xl w-full mx-4 max-h-[90vh] overflow-hidden flex flex-col">
          <div class="bg-gradient-to-r from-purple-600 to-blue-600 px-6 py-4">
            <h3 class="text-xl font-bold text-white">
              <i class="fas fa-film mr-2"></i>動画履歴 - シーン #${getSceneIndex(sceneId)}
            </h3>
          </div>
          <div class="p-6 overflow-y-auto flex-1">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
              ${videos.map(video => renderVideoCard(video, sceneId)).join('')}
            </div>
          </div>
          <div class="px-6 py-4 bg-gray-50 border-t border-gray-200 flex justify-end">
            <button onclick="closeVideoHistoryModal()" class="px-4 py-2 bg-gray-500 text-white rounded-lg hover:bg-gray-600 transition-colors font-semibold">
              閉じる
            </button>
          </div>
        </div>
      `;
    }
    
    modal.classList.remove('hidden');
    
    // Close on backdrop click
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        closeVideoHistoryModal();
      }
    });
    
  } catch (error) {
    console.error('[VideoHistory] Error:', error);
    showToast('動画履歴の読み込みに失敗しました', 'error');
  }
}

/**
 * Render video card for history modal
 * @param {object} video 
 * @param {number} sceneId 
 * @returns {string}
 */
function renderVideoCard(video, sceneId) {
  const statusConfig = {
    'generating': { text: '生成中', color: 'bg-yellow-100 text-yellow-800', icon: 'fa-spinner fa-spin' },
    'completed': { text: '完了', color: 'bg-green-100 text-green-800', icon: 'fa-check' },
    'failed': { text: '失敗', color: 'bg-red-100 text-red-800', icon: 'fa-times' }
  };
  const status = statusConfig[video.status] || statusConfig.failed;
  
  // Parse UTC datetime from DB (format: "2026-01-16 12:44:44") and convert to local timezone
  const createdAtUtc = video.created_at.replace(' ', 'T') + 'Z'; // Add 'T' and 'Z' for ISO format
  const createdAt = new Date(createdAtUtc).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  const retentionDays = 30;
  const expiresAt = new Date(new Date(createdAtUtc).getTime() + retentionDays * 24 * 60 * 60 * 1000);
  const daysLeft = Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
  
  return `
    <div class="border-2 ${video.is_active ? 'border-purple-600' : 'border-gray-200'} rounded-lg overflow-hidden">
      <div class="aspect-video bg-gray-100">
        ${video.status === 'completed' && video.r2_url 
          ? `<video 
               src="${video.r2_url.startsWith('http') ? video.r2_url : '/video/' + video.r2_url}" 
               class="w-full h-full object-cover"
               controls
               preload="metadata"
               onerror="this.onerror=null;this.parentElement.innerHTML='<div class=\\'flex items-center justify-center h-full text-gray-500 text-sm\\'><i class=\\'fas fa-exclamation-triangle mr-2 text-yellow-500\\'></i>動画を読み込めません</div>';"
             ></video>`
          : video.status === 'generating'
            ? `<div class="w-full h-full flex items-center justify-center text-gray-400">
                 <div class="text-center">
                   <i class="fas fa-spinner fa-spin text-4xl text-purple-600 mb-2"></i>
                   <p class="text-sm">生成中...</p>
                 </div>
               </div>`
            : `<div class="w-full h-full flex items-center justify-center text-gray-400">
                 <div class="text-center">
                   <i class="fas fa-video-slash text-4xl mb-2"></i>
                   <p class="text-sm">動画なし</p>
                 </div>
               </div>`
        }
      </div>
      <div class="p-3 space-y-2">
        <div class="flex items-center justify-between">
          <span class="px-2 py-1 ${status.color} text-xs rounded font-semibold">
            <i class="fas ${status.icon} mr-1"></i>${status.text}
          </span>
          <span class="text-xs text-gray-500">${video.duration_sec}秒</span>
        </div>
        
        <!-- プロンプト表示 & コピーボタン -->
        ${video.prompt ? `
          <div class="bg-gray-50 rounded p-2 border border-gray-200">
            <div class="flex items-center justify-between mb-1">
              <span class="text-xs font-semibold text-gray-600">
                <i class="fas fa-edit mr-1"></i>プロンプト
              </span>
              <button 
                onclick="useVideoPromptForRegeneration(${sceneId}, '${escapeHtml(video.prompt).replace(/'/g, "\\'").replace(/\n/g, "\\n")}')"
                class="text-xs px-2 py-0.5 bg-purple-100 text-purple-700 rounded hover:bg-purple-200 transition-colors"
                title="このプロンプトをシーンカードにコピー"
              >
                <i class="fas fa-copy mr-1"></i>使う
              </button>
            </div>
            <p class="text-xs text-gray-600">${escapeHtml(video.prompt)}</p>
          </div>
        ` : `
          <div class="text-xs text-gray-400 italic">プロンプト未設定（デフォルトモーション）</div>
        `}
        
        <div class="text-xs text-gray-500 space-y-1">
          <p><i class="fas fa-clock mr-1"></i>${createdAt}</p>
          ${video.status === 'completed' ? `
            <p class="text-green-600">
              <i class="fas fa-cloud mr-1"></i>CDN保存済み
            </p>
          ` : ''}
        </div>
        ${video.status === 'completed' ? `
          <div class="flex gap-2 pt-2">
            ${video.is_active 
              ? '<span class="flex-1 px-2 py-1 bg-purple-100 text-purple-800 text-xs rounded text-center font-semibold">使用中</span>'
              : `<button 
                   onclick="activateVideo(${video.id}, ${sceneId})"
                   class="flex-1 px-2 py-1 bg-green-600 text-white text-xs rounded hover:bg-green-700 transition-colors font-semibold"
                 >
                   採用
                 </button>`
            }
            ${!video.is_active ? `
              <button 
                onclick="deleteVideo(${video.id}, ${sceneId})"
                class="px-2 py-1 bg-red-600 text-white text-xs rounded hover:bg-red-700 transition-colors"
                title="削除"
              >
                <i class="fas fa-trash"></i>
              </button>
            ` : ''}
            <a 
              href="${video.r2_url.startsWith('http') ? video.r2_url : '/video/' + video.r2_url}"
              download="scene_${getSceneIndex(sceneId)}_video_${video.id}.mp4"
              class="px-2 py-1 bg-blue-600 text-white text-xs rounded hover:bg-blue-700 transition-colors"
              title="ダウンロード"
            >
              <i class="fas fa-download"></i>
            </a>
          </div>
        ` : ''}
        ${video.status === 'failed' && video.error_message ? `
          <div class="text-xs text-red-600 bg-red-50 rounded p-2 mt-2">
            <i class="fas fa-exclamation-circle mr-1"></i>${escapeHtml(video.error_message)}
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

/**
 * Close video history modal
 */
function closeVideoHistoryModal() {
  const modal = document.getElementById('videoHistoryModal');
  if (modal) {
    modal.classList.add('hidden');
    modal.innerHTML = '';
  }
}

/**
 * Use a video's prompt for regeneration - copies to inline prompt field
 * @param {number} sceneId 
 * @param {string} prompt 
 */
function useVideoPromptForRegeneration(sceneId, prompt) {
  // Close the history modal
  closeVideoHistoryModal();
  
  // Set the prompt in the inline field
  const promptEl = document.getElementById(`videoPromptInline-${sceneId}`);
  if (promptEl) {
    promptEl.value = prompt;
    promptEl.focus();
    // Scroll to the prompt section
    const section = document.getElementById(`videoPromptSection-${sceneId}`);
    if (section) {
      section.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Flash effect to draw attention
      section.classList.add('ring-2', 'ring-purple-500');
      setTimeout(() => section.classList.remove('ring-2', 'ring-purple-500'), 2000);
    }
    showToast('プロンプトをコピーしました。必要に応じて編集して「再生成」を押してください', 'success');
  } else {
    showToast('プロンプトフィールドが見つかりません', 'warning');
  }
}

// Expose globally
window.useVideoPromptForRegeneration = useVideoPromptForRegeneration;

/**
 * Activate a video
 * @param {number} videoId 
 * @param {number} sceneId 
 */
async function activateVideo(videoId, sceneId) {
  try {
    const response = await axios.post(`${API_BASE}/videos/${videoId}/activate`);
    
    if (response.data.success) {
      showToast('動画を採用しました', 'success');
      // Refresh video history
      viewVideoHistory(sceneId);
    } else {
      throw new Error(response.data.error?.message || '動画の採用に失敗しました');
    }
  } catch (error) {
    console.error('[Video] Activate error:', error);
    const errorMsg = error.response?.data?.error?.message || error.message || '動画採用中にエラーが発生しました';
    showToast(errorMsg, 'error');
  }
}

/**
 * Delete a video
 * @param {number} videoId 
 * @param {number} sceneId 
 */
async function deleteVideo(videoId, sceneId) {
  if (!confirm('この動画を削除しますか？')) {
    return;
  }
  
  try {
    const response = await axios.delete(`${API_BASE}/videos/${videoId}`);
    
    if (response.data.success) {
      showToast('動画を削除しました', 'success');
      // Refresh video history
      viewVideoHistory(sceneId);
    } else {
      throw new Error(response.data.error?.message || '動画の削除に失敗しました');
    }
  } catch (error) {
    console.error('[Video] Delete error:', error);
    const errorMsg = error.response?.data?.error?.message || error.message || '動画削除中にエラーが発生しました';
    showToast(errorMsg, 'error');
  }
}

// ========================================
// Phase B-3: Video Build (Remotion Lambda)
// ========================================

// Video Build state
window.videoBuildPollingInterval = null;
window.videoBuildListCache = [];
window.videoBuildUsageCache = null;

/**
 * Initialize Video Build tab
 */
async function initVideoBuildTab() {
  console.log('[VideoBuild] Initializing tab');
  
  // Load scenes if not already loaded (required for requirements check)
  if (!window.lastLoadedScenes || window.lastLoadedScenes.length === 0) {
    console.log('[VideoBuild] Loading scenes for requirements check...');
    try {
      const response = await axios.get(`${API_BASE}/projects/${PROJECT_ID}/scenes`);
      window.lastLoadedScenes = response.data.scenes || [];
      console.log('[VideoBuild] Loaded', window.lastLoadedScenes.length, 'scenes');
    } catch (error) {
      console.error('[VideoBuild] Failed to load scenes:', error);
      window.lastLoadedScenes = [];
    }
  }
  
  // Load usage stats
  await refreshVideoBuildUsage();
  
  // Load video builds
  await loadVideoBuilds();
  
  // Check requirements
  updateVideoBuildRequirements();
  
  // Start polling if there's an active build
  startVideoBuildPollingIfNeeded();
  
  // R4: Load patch history
  await loadPatchHistory();
}

/**
 * Refresh video build usage stats
 */
async function refreshVideoBuildUsage() {
  try {
    const response = await axios.get(`${API_BASE}/video-builds/usage`);
    const data = response.data;
    
    window.videoBuildUsageCache = data;
    
    // Update UI
    document.getElementById('videoBuildUsageCount').textContent = data.monthly_builds || 0;
    document.getElementById('videoBuildConcurrent').textContent = data.concurrent_builds || 0;
    
    // Update button state
    updateVideoBuildButtonState();
    
  } catch (error) {
    console.error('[VideoBuild] Failed to load usage:', error);
    document.getElementById('videoBuildUsageCount').textContent = '-';
    document.getElementById('videoBuildConcurrent').textContent = '-';
  }
}

/**
 * Check and update video build requirements
 * PR-3: 事前チェック（preflight）を新UIに対応
 * - 必須（赤）: 素材不足のみがブロック条件
 * - 推奨（黄）: 音声なし等はブロックしない
 */
async function updateVideoBuildRequirements() {
  // 新UIの要素を取得
  const requiredEl = document.getElementById('preflightRequiredItems');
  const recommendedEl = document.getElementById('preflightRecommendedItems');
  const summaryEl = document.getElementById('preflightSummary');
  const blockReasonEl = document.getElementById('preflightBlockReason');
  
  // 新UIがなければスキップ
  if (!requiredEl || !recommendedEl || !summaryEl) {
    console.log('[Preflight] New UI not found, skipping');
    return;
  }
  
  // Usage info
  const usage = window.videoBuildUsageCache || {};
  const isAtLimit = (usage.monthly_builds || 0) >= 60;
  const hasConcurrent = (usage.concurrent_builds || 0) >= 1;
  
  // 初期表示（ローディング）
  requiredEl.innerHTML = '<div class="text-gray-400"><i class="fas fa-spinner fa-spin mr-2"></i>チェック中...</div>';
  recommendedEl.innerHTML = '';
  summaryEl.innerHTML = '';
  if (blockReasonEl) blockReasonEl.classList.add('hidden');
  
  const SCENE_LIMIT_THRESHOLD = 100;
  let blockReasons = [];
  let requiredHtml = '';
  let recommendedHtml = '';
  let summaryStatus = 'ok'; // 'ok', 'warning', 'error'
  
  // Call preflight API for accurate check
  try {
    const response = await axios.get(`${API_BASE}/projects/${PROJECT_ID}/video-builds/preflight`);
    const preflight = response.data;
    
    // Store preflight result for button state
    window.videoBuildPreflightCache = preflight;
    
    // === 必須チェック（素材） ===
    if (preflight.total_count === 0) {
      requiredHtml += '<div class="flex items-center text-red-600"><i class="fas fa-times-circle mr-2"></i>シーンがありません</div>';
      blockReasons.push('シーンが作成されていません');
      summaryStatus = 'error';
    } else if (!preflight.is_ready) {
      // 素材が不足
      requiredHtml += '<div class="flex items-center text-red-600">';
      requiredHtml += '<i class="fas fa-times-circle mr-2"></i>';
      requiredHtml += '素材が不足（' + preflight.ready_count + '/' + preflight.total_count + ' シーン準備済み）';
      requiredHtml += '</div>';
      
      // 不足の詳細
      if (preflight.missing && preflight.missing.length > 0) {
        requiredHtml += '<div class="ml-6 mt-1 text-xs text-gray-500 space-y-0.5">';
        preflight.missing.slice(0, 3).forEach(m => {
          requiredHtml += '<div>• シーン' + m.scene_idx + ': ' + m.reason + '</div>';
        });
        if (preflight.missing.length > 3) {
          requiredHtml += '<div>• 他 ' + (preflight.missing.length - 3) + ' 件...</div>';
        }
        requiredHtml += '</div>';
      }
      blockReasons.push('素材が不足しています（画像/漫画/動画を設定してください）');
      summaryStatus = 'error';
    } else if (preflight.total_count > SCENE_LIMIT_THRESHOLD) {
      // シーン数上限超過
      requiredHtml += '<div class="flex items-center text-red-600">';
      requiredHtml += '<i class="fas fa-times-circle mr-2"></i>';
      requiredHtml += preflight.total_count + 'シーンは上限（' + SCENE_LIMIT_THRESHOLD + '）を超えています';
      requiredHtml += '</div>';
      blockReasons.push(preflight.total_count + 'シーンは上限（' + SCENE_LIMIT_THRESHOLD + '）を超えています');
      summaryStatus = 'error';
    } else {
      // 素材OK
      requiredHtml += '<div class="flex items-center text-green-600">';
      requiredHtml += '<i class="fas fa-check-circle mr-2"></i>';
      requiredHtml += '素材OK（' + preflight.total_count + 'シーン準備完了）';
      requiredHtml += '</div>';
    }
    
    // === 推奨チェック（音声・その他） ===
    const validation = preflight.validation || {};
    const hasBgm = validation.has_bgm || false;
    const hasSfx = validation.has_sfx || false;
    const hasVoice = validation.summary?.has_voice || false;
    const hasAnyAudio = hasBgm || hasSfx || hasVoice;
    
    // 音声状態
    if (hasAnyAudio) {
      const audioLayers = [];
      if (hasVoice) audioLayers.push('Voice');
      if (hasBgm) audioLayers.push('BGM');
      if (hasSfx) audioLayers.push('SFX');
      recommendedHtml += '<div class="flex items-center text-green-600">';
      recommendedHtml += '<i class="fas fa-check-circle mr-2"></i>';
      recommendedHtml += '音声あり（' + audioLayers.join(' + ') + '）';
      recommendedHtml += '</div>';
    } else {
      recommendedHtml += '<div class="flex items-center text-amber-600">';
      recommendedHtml += '<i class="fas fa-info-circle mr-2"></i>';
      recommendedHtml += '音声なし（無音動画になります）';
      recommendedHtml += '</div>';
      if (summaryStatus === 'ok') summaryStatus = 'warning';
    }
    
    // 警告があれば表示
    const warningCount = (preflight.warnings?.length || 0) + (preflight.utterance_errors?.length || 0);
    
    // PR-Audio-Bulk: 未生成音声のシーンをカウント
    const audioMissingErrors = (preflight.utterance_errors || []).filter(e => e.type === 'AUDIO_MISSING' || e.type === 'NO_UTTERANCES');
    const missingAudioSceneIds = [...new Set(audioMissingErrors.map(e => e.scene_id))];
    const missingAudioCount = missingAudioSceneIds.length;
    
    // PR-Audio-Bulk: キャッシュに保存（一括生成で使用）
    window.missingAudioSceneIds = missingAudioSceneIds;
    
    if (warningCount > 0) {
      recommendedHtml += '<div class="flex items-center justify-between text-amber-600">';
      recommendedHtml += '<span><i class="fas fa-info-circle mr-2"></i>注意事項 ' + warningCount + '件（生成には影響しません）</span>';
      // PR-Audio-Bulk: 未生成音声がある場合は一括生成ボタンを追加
      if (missingAudioCount > 0) {
        recommendedHtml += `
          <button id="btnBulkAudioGenerate" 
            onclick="generateAllMissingAudio()" 
            class="ml-3 px-3 py-1 text-xs bg-purple-500 hover:bg-purple-600 text-white rounded-lg transition-colors whitespace-nowrap">
            <i class="fas fa-volume-up mr-1"></i>音声を一括生成（${missingAudioCount}シーン）
          </button>`;
      }
      recommendedHtml += '</div>';
      if (summaryStatus === 'ok') summaryStatus = 'warning';
    }
    
  } catch (error) {
    console.error('[VideoBuild] Preflight error:', error);
    // Fallback to local check
    const scenes = window.lastLoadedScenes || [];
    const hasScenes = scenes.length > 0;
    
    const scenesReady = scenes.filter(s => {
      const displayType = s.display_asset_type || 'image';
      if (displayType === 'comic') return s.active_comic?.r2_url;
      if (displayType === 'video') return s.active_video?.status === 'completed' && s.active_video?.r2_url;
      return s.active_image?.r2_url;
    }).length;
    
    window.videoBuildPreflightCache = {
      is_ready: hasScenes && scenesReady === scenes.length,
      can_generate: false,
      ready_count: scenesReady,
      total_count: scenes.length,
      missing: [],
      warnings: [],
      utterance_errors: []
    };
    
    if (!hasScenes) {
      requiredHtml += '<div class="flex items-center text-red-600"><i class="fas fa-times-circle mr-2"></i>シーンがありません</div>';
      blockReasons.push('シーンが作成されていません');
    } else if (scenesReady < scenes.length) {
      requiredHtml += '<div class="flex items-center text-red-600"><i class="fas fa-times-circle mr-2"></i>素材が不足（' + scenesReady + '/' + scenes.length + '）</div>';
      blockReasons.push('素材が不足しています');
    } else {
      requiredHtml += '<div class="flex items-center text-amber-600"><i class="fas fa-exclamation-triangle mr-2"></i>チェックに失敗しました（再試行してください）</div>';
    }
    summaryStatus = 'error';
    recommendedHtml += '<div class="text-gray-400">-</div>';
  }
  
  // Usage制限チェック
  if (isAtLimit) {
    blockReasons.push('今月の生成上限（60本）に達しています');
    summaryStatus = 'error';
  }
  // 削除: 別の動画生成中でもVideo Buildは並列実行可能なので、ブロックしない
  // if (hasConcurrent) {
  //   blockReasons.push('別の動画が生成中です（完了後に再試行してください）');
  //   summaryStatus = 'error';
  // }
  
  // UIを更新
  requiredEl.innerHTML = requiredHtml;
  recommendedEl.innerHTML = recommendedHtml;
  
  // サマリー表示（わかりやすく）
  if (blockReasons.length > 0) {
    summaryEl.className = 'p-4 rounded-lg border mt-3 bg-red-50 border-red-200';
    summaryEl.innerHTML = `
      <div class="flex items-center text-red-700 mb-2">
        <i class="fas fa-times-circle mr-2 text-xl"></i>
        <span class="font-bold text-lg">生成できません</span>
      </div>
      <p class="text-sm text-red-600 ml-7">
        👆 上記の「必須」項目を解決してください
      </p>
    `;
    
    // ブロック理由を表示
    if (blockReasonEl) {
      blockReasonEl.innerHTML = '<i class="fas fa-exclamation-circle mr-2"></i>' + blockReasons.join('、');
      blockReasonEl.classList.remove('hidden');
    }
  } else if (summaryStatus === 'warning') {
    summaryEl.className = 'p-4 rounded-lg border mt-3 bg-amber-50 border-amber-200';
    summaryEl.innerHTML = `
      <div class="flex items-center text-amber-700 mb-2">
        <i class="fas fa-check-circle mr-2 text-xl"></i>
        <span class="font-bold text-lg">生成可能</span>
      </div>
      <p class="text-sm text-amber-600 ml-7">
        ⚠️ 注意事項がありますが、動画生成は可能です
      </p>
    `;
    if (blockReasonEl) blockReasonEl.classList.add('hidden');
  } else {
    summaryEl.className = 'p-4 rounded-lg border mt-3 bg-green-50 border-green-200';
    summaryEl.innerHTML = `
      <div class="flex items-center text-green-700 mb-2">
        <i class="fas fa-check-circle mr-2 text-xl"></i>
        <span class="font-bold text-lg">✅ 準備完了！</span>
      </div>
      <p class="text-sm text-green-600 ml-7">
        🎬 下の「動画を生成」ボタンをクリックしてください
      </p>
    `;
    if (blockReasonEl) blockReasonEl.classList.add('hidden');
  }
  
  // ボタン状態を更新
  updateVideoBuildButtonState();
}



/**
 * Update video build button state
 * Phase R1.6: Use can_generate from preflight (utterances + 素材)
 */
function updateVideoBuildButtonState() {
  const btn = document.getElementById('btnStartVideoBuild');
  if (!btn) return;
  
  // PR-Audio-UI: 音声生成中は非活性化
  const isGeneratingAudio = window.isGeneratingAudio === true;
  
  // Use preflight cache (SSOT-based validation)
  const preflight = window.videoBuildPreflightCache || {};
  const hasScenes = (preflight.total_count || 0) > 0;
  
  // R1.6: can_generate は素材 + utterances の両方がOKの場合のみ true
  const canGenerate = preflight.can_generate === true;
  
  const usage = window.videoBuildUsageCache || {};
  const isAtLimit = (usage.monthly_builds || 0) >= 60;
  // 修正: hasConcurrentはボタン表示のみに使用、ブロックには使わない
  const hasConcurrent = (usage.concurrent_builds || 0) >= 1;
  
  // Phase 1: Limit to 100 scenes until segment rendering is implemented
  const SCENE_LIMIT_THRESHOLD = 100;
  const exceedsSceneLimit = (preflight.total_count || 0) > SCENE_LIMIT_THRESHOLD;
  
  // R1.6: canStart は can_generate を使用（+ 上限チェック）
  // 修正: hasConcurrentはブロック条件から削除（Video Buildは並列実行可能）
  const canStart = canGenerate && !isAtLimit && !exceedsSceneLimit && !isGeneratingAudio;
  btn.disabled = !canStart;
  
  // ボタン表示を状態に応じて変更
  if (hasConcurrent) {
    // 動画生成中でも開始可能だが、状態を表示（情報として）
    btn.innerHTML = '<i class="fas fa-film mr-2"></i>🎬 動画を生成 <span class="text-xs opacity-75">(他に生成中あり)</span>';
  } else if (isGeneratingAudio) {
    // 音声生成中
    btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>音声生成中...';
  } else {
    // 通常状態
    btn.innerHTML = '<i class="fas fa-film mr-2"></i>🎬 動画を生成';
  }
  
  console.log('[VideoBuild] Button state:', { 
    canStart, 
    canGenerate,
    isAtLimit, 
    hasConcurrent, 
    exceedsSceneLimit,
    preflight_is_ready: preflight.is_ready,
    preflight_can_generate: preflight.can_generate,
    preflight_count: preflight.ready_count + '/' + preflight.total_count,
    utterance_errors: preflight.utterance_errors?.length || 0
  });
  
  // Also enable/disable Video Build tab
  const tabBtn = document.getElementById('tabVideoBuild');
  if (tabBtn) {
    tabBtn.disabled = !hasScenes;
  }
}

/**
 * Load video builds for current project
 */
async function loadVideoBuilds() {
  const listEl = document.getElementById('videoBuildList');
  const emptyEl = document.getElementById('videoBuildListEmpty');
  const loadingEl = document.getElementById('videoBuildListLoading');
  
  if (!listEl || !emptyEl || !loadingEl) return;
  
  // Show loading
  listEl.innerHTML = '';
  emptyEl.classList.add('hidden');
  loadingEl.classList.remove('hidden');
  
  try {
    const response = await axios.get(`${API_BASE}/projects/${PROJECT_ID}/video-builds`);
    const builds = response.data.builds || response.data.video_builds || [];
    
    window.videoBuildListCache = builds;
    
    loadingEl.classList.add('hidden');
    
    if (builds.length === 0) {
      emptyEl.classList.remove('hidden');
      return;
    }
    
    listEl.innerHTML = builds.map(renderVideoBuildItem).join('');
    
    // PR-4-2: 待ち受けスクロール（startVideoBuild成功時に設定される）
    if (window.pendingScrollToBuildId) {
      const ok = scrollToAndHighlightBuild(window.pendingScrollToBuildId);
      if (ok) {
        window.pendingScrollToBuildId = null;
      }
    }
    
    // Check for active build
    const activeBuild = builds.find(b => 
      ['queued', 'validating', 'submitted', 'rendering', 'uploading', 'retry_wait'].includes(b.status)
    );
    
    if (activeBuild) {
      showVideoBuildProgress(activeBuild);
    } else {
      hideVideoBuildProgress();
    }
    
  } catch (error) {
    console.error('[VideoBuild] Failed to load builds:', error);
    loadingEl.classList.add('hidden');
    listEl.innerHTML = '<div class="p-4 text-red-600 text-center"><i class="fas fa-exclamation-circle mr-2"></i>読み込みに失敗しました</div>';
  }
}

/**
 * Calculate download expiry time
 * @param {Object} build 
 * @returns {string|null}
 */
function formatDownloadExpiry(build) {
  if (!build.render_completed_at) return null;
  
  // Default to 24 hours (86400 seconds) if not specified
  const expiresSeconds = build.expires_seconds || 86400;
  
  const completedAt = new Date(build.render_completed_at);
  const expiresAt = new Date(completedAt.getTime() + expiresSeconds * 1000);
  
  // Check if already expired
  if (expiresAt < new Date()) {
    return 'expired';
  }
  
  return expiresAt.toLocaleString('ja-JP');
}

/**
 * Toggle video build error details
 * @param {number} buildId 
 */
function toggleVideoBuildError(buildId) {
  const el = document.getElementById(`videoBuildError-${buildId}`);
  if (el) {
    el.classList.toggle('hidden');
  }
}

// ===== PR-4: Video Build レーン化ヘルパー =====

/**
 * Extract error message safely (PR-4: [object Object] 根絶)
 * 優先順位: data.error (string) > data.errors (array) > data.error.message > data.message > err.message
 */
function extractErrorMessage(err, fallback = '失敗しました') {
  if (!err) return fallback;
  const data = err.response?.data;
  if (typeof data === 'string') return data;
  // API直接のerrorフィールド（string）
  if (typeof data?.error === 'string') return data.error;
  // errorsが配列の場合
  if (Array.isArray(data?.errors) && data.errors.length > 0) {
    return data.errors.map(e => typeof e === 'string' ? e : e.message || JSON.stringify(e)).join('\n');
  }
  if (data?.error?.message) return data.error.message;
  if (data?.message) return data.message;
  if (typeof err.message === 'string') return err.message;
  try { return JSON.stringify(data); } catch { return fallback; }
}

/**
 * Safely parse JSON string
 */
function safeJsonParse(str, fallback = null) {
  if (!str || typeof str !== 'string') return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

/**
 * Get build status metadata for UI
 */
function buildStatusMeta(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'completed') return { label: '完了', cls: 'bg-green-100 text-green-800', icon: 'fa-check-circle', isActive: false };
  if (s === 'failed') return { label: '失敗', cls: 'bg-red-100 text-red-800', icon: 'fa-times-circle', isActive: false };
  if (s === 'cancelled') return { label: '中止', cls: 'bg-gray-100 text-gray-700', icon: 'fa-ban', isActive: false };
  if (['rendering','uploading','submitted','queued','validating','retry_wait'].includes(s)) {
    return { label: '生成中', cls: 'bg-amber-100 text-amber-800', icon: 'fa-spinner', isActive: true };
  }
  return { label: '準備', cls: 'bg-gray-100 text-gray-700', icon: 'fa-circle', isActive: false };
}

/**
 * Summarize build settings for display
 * PR-5-1: expression_summary を追加（表現サマリー）
 */
function summarizeBuildSettings(build) {
  const settings = safeJsonParse(build.settings_json) || build.settings || build.build_settings || {};
  const preset = settings.output_preset || settings.outputPreset || 'yt_long';
  const captionsEnabled = settings.captions?.enabled ?? settings.include_captions ?? true;
  const captionsPos = settings.captions?.position || 'bottom';
  const bgmEnabled = settings.bgm?.enabled ?? settings.background_music?.enabled ?? settings.include_bgm ?? false;
  const bgmVol = (settings.bgm?.volume ?? 0.25);
  const bgmVolPct = Math.round(Math.min(1, Math.max(0, bgmVol)) * 100);
  const motionPreset = settings.motion?.preset ?? (settings.motion?.ken_burns ? 'kenburns_soft' : 'none') ?? 'none';
  
  // PR-5-1: 表現サマリー（expression_summary）
  const expr = settings.expression_summary || null;
  
  // PR-5-3a + Phase 1: テロップ設定
  const telopsEnabled = settings.telops?.enabled ?? true;  // デフォルトON
  const telopStylePreset = settings.telops?.style_preset || 'outline';  // Phase 1
  const telopSizePreset = settings.telops?.size_preset || 'md';
  const telopPositionPreset = settings.telops?.position_preset || 'bottom';
  
  return { 
    preset, 
    captionsEnabled, 
    captionsPos, 
    bgmEnabled, 
    bgmVolPct, 
    motionPreset,
    // PR-5-3a + Phase 1: テロップ表示設定
    telopsEnabled,
    telopStylePreset,  // Phase 1: スタイルプリセット
    telopSizePreset,
    telopPositionPreset,
    // PR-5-1: 表現サマリー（なければnull = 過去ビルド）
    expression: expr ? {
      hasVoice: expr.has_voice ?? false,
      hasBgm: expr.has_bgm ?? false,
      hasSfx: expr.has_sfx ?? false,
      isSilent: expr.is_silent ?? false,
      balloonCount: expr.balloon_count ?? 0,
      balloonPolicy: expr.balloon_policy_summary || null,
      // PR-5-3a: テロップ有無
      hasTelops: expr.has_telops ?? expr.telops_enabled ?? true,
    } : null
  };
}

/**
 * Get preset display label
 */
function presetLabel(preset) {
  const p = String(preset || '');
  if (p === 'yt_long') return 'YouTube長尺';
  if (p === 'short_vertical') return '縦型ショート';
  if (p === 'yt_shorts') return 'YT Shorts';
  if (p === 'reels') return 'Reels';
  if (p === 'tiktok') return 'TikTok';
  return p;
}

/**
 * Motion preset label
 */
function motionLabel(preset) {
  if (preset === 'none') return 'なし';
  if (preset === 'kenburns_soft') return 'ゆっくり';
  if (preset === 'kenburns_medium') return '標準';
  return preset;
}

/**
 * Scroll to and highlight a build lane (PR-4-2)
 */
function scrollToAndHighlightBuild(buildId) {
  const el = document.getElementById(`video-build-lane-${buildId}`);
  if (!el) return false;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('ring-2', 'ring-indigo-400', 'bg-indigo-50');
  setTimeout(() => {
    el.classList.remove('ring-2', 'ring-indigo-400', 'bg-indigo-50');
  }, 3000);
  return true;
}
window.scrollToAndHighlightBuild = scrollToAndHighlightBuild;

/**
 * Render a single video build item (PR-4 レーン化)
 */
function renderVideoBuildItem(build) {
  const status = buildStatusMeta(build.status);
  const statusInfo = getVideoBuildStatusInfo(build.status);
  
  // Parse UTC datetime and convert to Japan timezone
  const createdAtUtc = build.created_at.replace(' ', 'T') + 'Z';
  const createdAt = new Date(createdAtUtc).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  
  // Build settings summary (PR-4 + PR-5-3a)
  const s = summarizeBuildSettings(build);
  const settingsLine = `
    <div class="flex flex-wrap gap-1 mt-2">
      <span class="px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 text-xs">📺 ${presetLabel(s.preset)}</span>
      <span class="px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 text-xs">CC ${s.captionsEnabled ? 'ON' : 'OFF'}</span>
      <span class="px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 text-xs">📝 ${s.telopsEnabled ? 'ON' : 'OFF'}</span>
      <span class="px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 text-xs">🎵 ${s.bgmEnabled ? 'ON' : 'OFF'}</span>
      <span class="px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 text-xs">🏃 ${motionLabel(s.motionPreset)}</span>
    </div>
  `;
  
  // PR-5-1: 表現サマリータグ行（expression_summary があれば表示）
  let expressionLine = '';
  if (s.expression) {
    const expr = s.expression;
    const tags = [];
    
    // 無音判定（最優先で警告表示）
    if (expr.isSilent) {
      tags.push('<span class="px-1.5 py-0.5 rounded bg-gray-200 text-gray-500 text-xs">🔇 無音</span>');
    } else {
      // 音声あり
      if (expr.hasVoice) {
        tags.push('<span class="px-1.5 py-0.5 rounded bg-green-100 text-green-700 text-xs">🔊 音声</span>');
      }
      // BGMあり
      if (expr.hasBgm) {
        tags.push('<span class="px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 text-xs">🎵 BGM</span>');
      }
      // SFXあり
      if (expr.hasSfx) {
        tags.push('<span class="px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 text-xs">🔔 効果音</span>');
      }
    }
    
    // バルーンあり
    if (expr.balloonCount > 0) {
      let balloonLabel = `💬 バブル ${expr.balloonCount}`;
      // ポリシー内訳（括弧で小さく表示）
      if (expr.balloonPolicy && (expr.balloonPolicy.always > 0 || expr.balloonPolicy.voice_window > 0 || expr.balloonPolicy.manual_window > 0)) {
        const parts = [];
        if (expr.balloonPolicy.always > 0) parts.push(`常時${expr.balloonPolicy.always}`);
        if (expr.balloonPolicy.voice_window > 0) parts.push(`喋${expr.balloonPolicy.voice_window}`);
        if (expr.balloonPolicy.manual_window > 0) parts.push(`手${expr.balloonPolicy.manual_window}`);
        if (parts.length > 0) {
          balloonLabel += ` <span class="text-gray-400">(${parts.join('/')})</span>`;
        }
      }
      tags.push(`<span class="px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 text-xs">${balloonLabel}</span>`);
    }
    
    // PR-5-3a: テロップ表示（ON/OFFを明示）
    if (expr.hasTelops !== undefined) {
      if (expr.hasTelops) {
        tags.push('<span class="px-1.5 py-0.5 rounded bg-orange-100 text-orange-700 text-xs">📝 テロップON</span>');
      } else {
        tags.push('<span class="px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 text-xs">📝 テロップOFF</span>');
      }
    }
    
    if (tags.length > 0) {
      expressionLine = `<div class="flex flex-wrap gap-1 mt-1">${tags.join('')}</div>`;
    }
  }
  
  // Lane class (active builds get highlighted border)
  const isActive = status.isActive;
  const laneClass = isActive 
    ? 'p-4 hover:bg-gray-50 transition-colors border-l-4 border-indigo-500 bg-indigo-50/40'
    : 'p-4 hover:bg-gray-50 transition-colors';
  
  let actionHtml = '';
  let expiryHtml = '';
  
  if (build.status === 'completed' && build.download_url) {
    // 動画ビルド完了: プレビュー/修正/DLボタン表示
    // download_url は presigned URL の場合あり → openXxxWithRefresh で最新URL取得
    actionHtml = `
      <div class="flex items-center gap-2">
        <button onclick="openPreviewWithRefresh(${build.id}, '')"
          class="px-3 py-2 bg-gray-800 text-white rounded-lg hover:bg-gray-900 text-sm font-semibold flex items-center gap-2"
          title="プレビュー再生">
          <i class="fas fa-play"></i>
        </button>
        <button onclick="openChatEditWithRefresh(${build.id}, '')"
          class="px-3 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-semibold flex items-center gap-2"
          title="チャットで修正">
          <i class="fas fa-comments"></i>修正
        </button>
        <button onclick="downloadBuildVideo(${build.id})"
          class="px-3 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 text-sm font-semibold flex items-center gap-2">
          <i class="fas fa-download"></i>DL
        </button>
      </div>
    `;
    // 有効期限表示も削除（ユーザーを混乱させるため）
  } else if (build.status === 'completed' && !build.download_url) {
    actionHtml = `
      <button onclick="refreshVideoBuildDownload(${build.id})"
        class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-semibold flex items-center gap-2">
        <i class="fas fa-sync-alt"></i>URL取得
      </button>
    `;
  } else if (build.status === 'failed') {
    actionHtml = `
      <div class="flex items-center gap-2">
        <button onclick="toggleVideoBuildError(${build.id})"
          class="px-3 py-2 text-red-600 hover:bg-red-50 rounded-lg text-sm flex items-center gap-1">
          <i class="fas fa-info-circle"></i>詳細
        </button>
        <button onclick="retryVideoBuild(${build.id})"
          class="px-3 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 text-sm font-semibold flex items-center gap-2">
          <i class="fas fa-redo"></i>再試行
        </button>
      </div>
    `;
  } else if (isActive) {
    // 生成中の場合は更新ボタン
    actionHtml = `
      <button onclick="loadVideoBuilds()"
        class="px-3 py-2 bg-gray-200 text-gray-800 rounded-lg hover:bg-gray-300 text-sm font-semibold flex items-center gap-2">
        <i class="fas fa-sync-alt"></i>更新
      </button>
    `;
  }
  
  // Progress bar for active builds
  let progressHtml = '';
  if (isActive && build.progress_percent !== null && build.progress_percent !== undefined) {
    progressHtml = `
      <div class="mt-3">
        <div class="flex items-center justify-between text-xs text-gray-500 mb-1">
          <span>${build.progress_stage || '処理中...'}</span>
          <span>${build.progress_percent}%</span>
        </div>
        <div class="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
          <div class="h-full bg-indigo-600 transition-all" style="width:${build.progress_percent}%"></div>
        </div>
      </div>
    `;
  }
  
  // Error details (collapsed by default)
  let errorHtml = '';
  if (build.status === 'failed') {
    const errorCode = build.error_code || 'UNKNOWN_ERROR';
    const errorMessage = build.error_message || '不明なエラーが発生しました';
    errorHtml = `
      <div id="videoBuildError-${build.id}" class="hidden mt-3 p-3 bg-red-50 rounded-lg border border-red-200">
        <div class="flex items-start gap-2">
          <i class="fas fa-exclamation-circle text-red-500 mt-0.5"></i>
          <div class="flex-1 min-w-0">
            <p class="text-xs font-semibold text-red-700">エラーコード: ${errorCode}</p>
            <p class="text-xs text-red-600 mt-1 whitespace-pre-wrap break-words">${errorMessage}</p>
            <button onclick="navigator.clipboard.writeText('${errorCode}: ${errorMessage.replace(/'/g, "\\'")}'); showToast('エラー情報をコピーしました', 'success');"
              class="mt-2 text-xs text-red-500 hover:text-red-700 underline">
              <i class="fas fa-copy mr-1"></i>コピー
            </button>
          </div>
        </div>
      </div>
    `;
  }
  
  // Retry waiting state display
  let retryHtml = '';
  if (build.status === 'retry_wait' || (build.retry_count && build.retry_count > 0 && build.status !== 'completed' && build.status !== 'failed')) {
    const remaining = 5 - (build.retry_count || 0);
    retryHtml = `<p class="text-xs text-amber-600 mt-1"><i class="fas fa-hourglass-half mr-1"></i>自動再試行中（あと最大${remaining}回）</p>`;
  }
  
  return `
    <div id="video-build-lane-${build.id}" class="${laneClass}" data-build-id="${build.id}">
      <div class="flex items-start justify-between gap-4">
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded ${status.cls} text-xs font-semibold">
              <i class="fas ${status.icon} ${status.icon === 'fa-spinner' ? 'fa-spin' : ''}"></i>
              ${status.label}
            </span>
            <span class="text-sm font-semibold text-gray-900">Build #${build.id}</span>
            <span class="text-xs text-gray-500">${createdAt}</span>
            ${build.is_delegation ? '<span class="text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">🔁 代行</span>' : ''}
          </div>
          ${settingsLine}
          ${expressionLine}
          ${expiryHtml}
          ${retryHtml}
          ${progressHtml}
        </div>
        <div class="shrink-0">
          ${actionHtml}
        </div>
      </div>
      ${errorHtml}
    </div>
  `;
}

/**
 * Refresh video build download URL (fetch CloudFront URL from server)
 * Used when download_url is missing (e.g., completed build without URL stored)
 * PR-4-4: 二重送信ガード + スクロール導線 + エラー表示統一
 * @param {number} buildId 
 */
async function refreshVideoBuildDownload(buildId) {
  // PR-4-4-3: 二重送信ガード（buildId単位）
  if (!window.videoBuildRefreshUrlInFlight) window.videoBuildRefreshUrlInFlight = {};
  if (window.videoBuildRefreshUrlInFlight[buildId]) {
    console.log('[VideoBuild] Refresh already in flight for buildId:', buildId);
    return;
  }
  window.videoBuildRefreshUrlInFlight[buildId] = true;
  
  try {
    showToast('ダウンロードURLを取得中...', 'info');
    
    const response = await axios.post(`${API_BASE}/video-builds/${buildId}/refresh`);
    
    // FIX: APIレスポンス構造に合わせる（build.download_url を参照）
    const build = response.data.build;
    const downloadUrl = build?.download_url;
    
    if (response.data.success && build?.status === 'completed' && downloadUrl) {
      // Update cache
      const idx = (window.videoBuildListCache || []).findIndex(b => b.id === buildId);
      if (idx >= 0) {
        window.videoBuildListCache[idx].download_url = downloadUrl;
        window.videoBuildListCache[idx].render_completed_at = window.videoBuildListCache[idx].render_completed_at || new Date().toISOString();
      }
      
      // PR-4-4-2: スクロール導線（A確定 = 強調表示のみ、プレビュー自動オープンなし）
      window.pendingScrollToBuildId = buildId;
      
      // Reload list → 自動でスクロール＆ハイライト
      await loadVideoBuilds();
      
      showToast('新しいダウンロードURLを取得しました', 'success');
    } else if (response.data.warning) {
      // AWS側の問題（設定なし、ジョブIDなし等）
      showToast(response.data.warning, 'warning');
    } else {
      throw new Error('URLの取得に失敗しました。動画が存在しない可能性があります。');
    }
  } catch (error) {
    console.error('[VideoBuild] Refresh download error:', error);
    // PR-4-4-4: エラー表示統一
    const errMsg = extractErrorMessage(error, 'ダウンロードURLの取得に失敗しました');
    showToast(errMsg, 'error');
  } finally {
    // PR-4-4-3: 必ずフラグを戻す
    window.videoBuildRefreshUrlInFlight[buildId] = false;
  }
}

/**
 * Open chat edit modal (CloudFront URLs are permanent - no refresh needed)
 * @param {number} buildId 
 * @param {string} videoUrl - CloudFront URL (permanent, no expiry)
 */
async function openChatEditWithRefresh(buildId, videoUrl) {
  try {
    // 最新のdownload_urlをAPIから取得（presigned URL refresh対応）
    const res = await axios.get(`${API_BASE}/video-builds/${buildId}`);
    const freshUrl = res.data?.build?.download_url || videoUrl;
    openChatEditModal(buildId, freshUrl);
  } catch (error) {
    console.error('[ChatEdit] Error:', error);
    // フォールバック: 元のURLで開く
    openChatEditModal(buildId, videoUrl);
  }
}

/**
 * Open preview modal with fresh download URL
 * @param {number} buildId 
 * @param {string} videoUrl
 */
async function openPreviewWithRefresh(buildId, videoUrl) {
  try {
    // 最新のdownload_urlをAPIから取得（presigned URL refresh対応）
    const res = await axios.get(`${API_BASE}/video-builds/${buildId}`);
    const freshUrl = res.data?.build?.download_url || videoUrl;
    openVideoBuildPreviewModal(buildId, freshUrl);
  } catch (error) {
    console.error('[Preview] Error:', error);
    openVideoBuildPreviewModal(buildId, videoUrl);
  }
}

// Export for global access
window.openChatEditWithRefresh = openChatEditWithRefresh;
window.openPreviewWithRefresh = openPreviewWithRefresh;

/**
 * Download build video with fresh URL
 */
async function downloadBuildVideo(buildId) {
  try {
    const res = await axios.get(`${API_BASE}/video-builds/${buildId}`);
    const url = res.data?.build?.download_url;
    if (url) {
      window.open(url, '_blank');
    } else {
      showToast('ダウンロードURLが取得できませんでした', 'error');
    }
  } catch (error) {
    console.error('[Download] Error:', error);
    showToast('ダウンロードURLの取得に失敗しました', 'error');
  }
}
window.downloadBuildVideo = downloadBuildVideo;

/**
 * Get status info (icon, label, color)
 */
function getVideoBuildStatusInfo(status) {
  const statusMap = {
    queued: { icon: '⏳', label: 'キュー待ち', textColor: 'text-gray-600' },
    validating: { icon: '🔍', label: '素材確認中', textColor: 'text-blue-600' },
    submitted: { icon: '☁️', label: 'AWS送信済み', textColor: 'text-blue-600' },
    rendering: { icon: '🎞️', label: 'レンダリング中', textColor: 'text-purple-600' },
    uploading: { icon: '📤', label: 'アップロード中', textColor: 'text-purple-600' },
    retry_wait: { icon: '🕒', label: '再試行待ち', textColor: 'text-amber-600' },
    completed: { icon: '✅', label: '完了', textColor: 'text-green-600' },
    failed: { icon: '❌', label: '失敗', textColor: 'text-red-600' },
    cancelled: { icon: '🚫', label: 'キャンセル', textColor: 'text-gray-500' }
  };
  
  return statusMap[status] || { icon: '❓', label: status, textColor: 'text-gray-600' };
}

/**
 * Format time duration as human-readable string
 */
function formatDuration(ms) {
  if (!ms || ms < 0) return '計算中...';
  
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  
  if (hours > 0) {
    return `約${hours}時間${minutes}分`;
  } else if (minutes > 0) {
    return `約${minutes}分${seconds}秒`;
  } else {
    return `約${seconds}秒`;
  }
}

/**
 * Calculate estimated remaining time based on progress
 */
function calculateEta(build) {
  const percent = build.progress_percent || 0;
  const createdAt = build.created_at ? new Date(build.created_at) : null;
  const startedAt = build.render_started_at ? new Date(build.render_started_at) : null;
  
  // Use render_started_at if available, otherwise created_at
  const startTime = startedAt || createdAt;
  if (!startTime || percent <= 0) {
    return { elapsed: null, remaining: null, total: null };
  }
  
  const now = new Date();
  const elapsedMs = now - startTime;
  
  // Calculate remaining time based on current progress rate
  // If 30% done in 2 minutes, remaining 70% should take ~4.7 minutes
  if (percent > 0 && percent < 100) {
    const remainingPercent = 100 - percent;
    const estimatedTotalMs = (elapsedMs / percent) * 100;
    const estimatedRemainingMs = (elapsedMs / percent) * remainingPercent;
    
    return {
      elapsed: elapsedMs,
      remaining: estimatedRemainingMs,
      total: estimatedTotalMs
    };
  }
  
  return { elapsed: elapsedMs, remaining: 0, total: elapsedMs };
}

/**
 * Show progress section with ETA
 */
function showVideoBuildProgress(build) {
  const progressEl = document.getElementById('videoBuildProgress');
  if (!progressEl) return;
  
  const statusInfo = getVideoBuildStatusInfo(build.status);
  const percent = build.progress_percent || 0;
  
  // Basic info
  document.getElementById('videoBuildProgressIcon').textContent = statusInfo.icon;
  document.getElementById('videoBuildProgressTitle').textContent = statusInfo.label;
  document.getElementById('videoBuildProgressPercent').textContent = `${percent}%`;
  document.getElementById('videoBuildProgressBar').style.width = `${percent}%`;
  document.getElementById('videoBuildProgressStage').textContent = build.progress_stage || build.progress_message || '準備中...';
  document.getElementById('videoBuildProgressId').textContent = `#${build.id}`;
  
  // Calculate and display ETA
  const eta = calculateEta(build);
  const etaEl = document.getElementById('videoBuildProgressEta');
  const elapsedEl = document.getElementById('videoBuildProgressElapsed');
  const durationEl = document.getElementById('videoBuildProgressDuration');
  
  if (etaEl) {
    if (percent === 0) {
      etaEl.textContent = '初期化中...';
    } else if (percent >= 100) {
      etaEl.textContent = '完了処理中...';
    } else if (eta.remaining !== null) {
      etaEl.textContent = `残り ${formatDuration(eta.remaining)}`;
    } else {
      etaEl.textContent = '残り時間を計算中...';
    }
  }
  
  if (elapsedEl && eta.elapsed !== null) {
    elapsedEl.textContent = `経過時間: ${formatDuration(eta.elapsed)}`;
  }
  
  if (durationEl && eta.total !== null && percent > 5) {
    durationEl.textContent = `推定総時間: ${formatDuration(eta.total)}`;
  } else if (durationEl) {
    durationEl.textContent = '推定総時間: 計算中...';
  }
  
  progressEl.classList.remove('hidden');
}

/**
 * Hide progress section
 */
function hideVideoBuildProgress() {
  const progressEl = document.getElementById('videoBuildProgress');
  if (progressEl) {
    progressEl.classList.add('hidden');
  }
}

/**
 * Update BGM volume label (PR-2)
 */
function updateBgmVolumeLabel() {
  const slider = document.getElementById('vbBgmVolume');
  const label = document.getElementById('vbBgmVolumeLabel');
  if (slider && label) {
    label.textContent = slider.value + '%';
  }
}

/**
 * Start video build
 * PR-2: 新UI (videoBuildConfigCard) 対応
 * PR-4-4: 二重送信ガード追加
 */
async function startVideoBuild() {
  const btn = document.getElementById('btnStartVideoBuild');
  if (!btn || btn.disabled) return;
  
  // PR-4-4-3: 二重送信ガード
  if (window.videoBuildStartInFlight) {
    console.log('[VideoBuild] Start already in flight');
    return;
  }
  window.videoBuildStartInFlight = true;
  
  // Helper functions for reading UI values
  function getBool(id, fallback = false) {
    const el = document.getElementById(id);
    if (!el) return fallback;
    return !!el.checked;
  }
  function getVal(id, fallback = null) {
    const el = document.getElementById(id);
    if (!el) return fallback;
    return el.value;
  }
  function getRange01(id, fallback = 0.25) {
    const el = document.getElementById(id);
    if (!el) return fallback;
    const n = Number(el.value);
    if (Number.isNaN(n)) return fallback;
    return Math.min(1, Math.max(0, n / 100));
  }
  
  // Check if new UI exists (PR-2)
  const hasNewConfigUI = !!document.getElementById('videoBuildConfigCard');
  
  // Output preset (Video Build側で決定)
  const preset = hasNewConfigUI
    ? (getVal('vbPresetSelector', 'yt_long') || 'yt_long')
    : 'yt_long';
  
  // Captions
  const captionsEnabled = hasNewConfigUI
    ? getBool('vbCaptionsToggle', true)
    : getBool('videoBuildCaptions', true);
  const captionsPos = hasNewConfigUI
    ? (getVal('vbCaptionsPosition', 'bottom') || 'bottom')
    : 'bottom';
  
  // BGM
  const bgmEnabled = hasNewConfigUI
    ? getBool('vbBgmToggle', false)
    : getBool('videoBuildBgm', false);
  const bgmVolume = hasNewConfigUI
    ? getRange01('vbBgmVolume', 0.25)
    : 0.25;
  
  // Motion (Remotion語は内部のみ)
  const motionPreset = hasNewConfigUI
    ? (getVal('vbMotionPreset', 'kenburns_soft') || 'kenburns_soft')
    : (getBool('videoBuildMotion', true) ? 'kenburns_soft' : 'none');
  
  // PR-5-3a + Phase 1: Telops（テロップ - 字幕とは別）
  const telopsEnabled = hasNewConfigUI
    ? getBool('vbTelopsToggle', true)  // デフォルトON
    : true;
  
  // Phase 1: テロップスタイル設定（UIから取得）
  const telopStylePreset = hasNewConfigUI
    ? (getVal('vbTelopStyle', 'outline') || 'outline')
    : 'outline';
  const telopSizePreset = hasNewConfigUI
    ? (getVal('vbTelopSize', 'md') || 'md')
    : 'md';
  const telopPositionPreset = hasNewConfigUI
    ? (getVal('vbTelopPosition', 'bottom') || 'bottom')
    : 'bottom';
  
  // Vrew風カスタムスタイル設定（UIから取得）
  const customStyle = hasNewConfigUI ? getTelopCustomStyle() : null;
  
  // PR-Remotion-Typography: Typography設定（UIから取得）
  const typography = hasNewConfigUI ? getTelopTypography() : null;
  
  // Build settings for API (SSOT aligned)
  const buildSettings = {
    output_preset: preset,
    captions: {
      enabled: captionsEnabled,
      position: captionsPos,
    },
    bgm: {
      enabled: bgmEnabled,
      volume: bgmVolume,
    },
    motion: {
      preset: motionPreset,
    },
    // PR-5-3a/b + Phase 1: テロップ表示設定
    telops: {
      enabled: telopsEnabled,
      // Phase 1: スタイルプリセット（UIから取得）
      style_preset: telopStylePreset,  // minimal | outline | band | pop | cinematic
      position_preset: telopPositionPreset,  // bottom | center | top
      size_preset: telopSizePreset,  // sm | md | lg
      // Vrew風カスタムスタイル（設定されていれば上書き）
      custom_style: customStyle,
      // PR-Remotion-Typography: 文字組み設定（設定されていれば追加）
      typography: typography,
    },
  };
  
  // PR-Audio-Bulk: 未生成音声チェック
  const preflight = window.videoBuildPreflightCache;
  const audioMissingErrors = (preflight?.utterance_errors || []).filter(
    e => e.type === 'AUDIO_MISSING' || e.type === 'NO_UTTERANCES'
  );
  const missingAudioSceneIds = [...new Set(audioMissingErrors.map(e => e.scene_id))];
  const hasMissingAudio = missingAudioSceneIds.length > 0;

  // 未生成音声がある場合、先に生成するか確認
  if (hasMissingAudio) {
    const result = await showAudioConfirmDialog(missingAudioSceneIds.length);
    if (result === 'cancel') {
      window.videoBuildStartInFlight = false;
      return;
    }
    if (result === 'generate') {
      window.videoBuildStartInFlight = false;
      // 音声生成を実行（確認ダイアログはスキップ - 既にダイアログで確認済み）
      await generateAllMissingAudio(true);
      return; // 音声生成完了後にユーザーが再度ビルドを開始
    }
    // result === 'skip' の場合はそのまま続行（無音動画）
  }

  // Confirm
  if (!confirm('動画を生成しますか？\n\n生成後は「修正（チャット）」で調整できます。')) {
    window.videoBuildStartInFlight = false;
    return;
  }
  
  // Disable button
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>送信中...';
  
  try {
    // API payload (PR-2: 新形式 - output_preset/captions/bgm/motion を直接送信)
    const response = await axios.post(`${API_BASE}/projects/${PROJECT_ID}/video-builds`, buildSettings);
    
    if (response.data.success) {
      showToast('動画生成を開始しました', 'success');
      
      // PR-Remotion-Telop-DefaultSave: Save telop settings if checkbox is ON
      const saveDefaultCheckbox = document.getElementById('vbTelopSaveDefault');
      if (saveDefaultCheckbox?.checked) {
        try {
          const saved = await saveRemotionTelopSettings();
          if (saved) {
            console.log('[VideoBuild] Telop settings saved as project default');
          }
        } catch (saveError) {
          console.warn('[VideoBuild] Failed to save telop defaults (non-blocking):', saveError);
          // Don't show error toast - build already started successfully
        }
      }
      
      // PR-4-2: 新ビルドIDを待ち受けスクロール用に設定
      const newId = response.data.video_build_id || response.data.build_id || response.data.id || response.data.new_video_build_id;
      if (newId) {
        window.pendingScrollToBuildId = Number(newId);
      }
      
      // Reload builds (will trigger scroll if newId is set)
      await loadVideoBuilds();
      
      // PR-4-2: IDが取れなかった場合のフォールバック - 生成中ビルドを探す
      if (!newId) {
        const builds = window.videoBuildListCache || [];
        const activeBuild = builds.find(b => 
          ['queued', 'validating', 'submitted', 'rendering', 'uploading'].includes(String(b.status || '').toLowerCase())
        );
        if (activeBuild?.id) {
          scrollToAndHighlightBuild(activeBuild.id);
        }
      }
      
      // Refresh usage
      await refreshVideoBuildUsage();
      
      // Start polling
      startVideoBuildPolling();
    } else {
      throw new Error(response.data.error?.message || '動画生成の開始に失敗しました');
    }
    
  } catch (error) {
    console.error('[VideoBuild] Start error:', error);
    
    // User-friendly error messages
    const errorCode = error.response?.data?.error?.code;
    let errorMsg = error.response?.data?.error?.message || error.message || '動画生成の開始に失敗しました';
    
    if (errorCode === 'CONCURRENT_LIMIT') {
      errorMsg = '現在、別の動画生成を処理中です。\n完了後に、もう一度お試しください。';
    } else if (errorCode === 'MONTHLY_LIMIT') {
      errorMsg = '今月の動画生成上限（30本）に達しました。\n翌月になると自動的にリセットされます。';
    } else if (errorCode === 'NO_SCENES' || errorCode === 'NO_IMAGES') {
      errorMsg = '動画生成に必要な素材が不足しています。\nすべてのシーンに画像を設定してください。';
    } else if (errorCode === 'PROJECT_JSON_INVALID') {
      // PR-A2: project.json 検証エラーの詳細表示
      const details = error.response?.data?.error?.details;
      const criticalErrors = details?.critical_errors || [];
      if (criticalErrors.length > 0) {
        // 各エラーの理由を1行にまとめて表示
        const errorDetails = criticalErrors.map(e => `• ${e.reason}`).join('\n');
        errorMsg = `動画生成に必要な素材が不足しています：\n\n${errorDetails}`;
      } else {
        errorMsg = '動画データに問題があります。\n素材を確認してください。';
      }
    } else if (errorCode === 'AWS_ORCHESTRATOR_ERROR') {
      const awsError = error.response?.data?.error?.details?.aws_error || '';
      if (awsError.includes('Rate') || awsError.includes('Concurrency')) {
        errorMsg = '現在、動画生成が混み合っています。\n数分後に自動で再試行されます。';
      }
    }
    
    showToast(errorMsg, 'error');
  } finally {
    // PR-4-4-3: 必ずフラグを戻す
    window.videoBuildStartInFlight = false;
    // ボタン状態は updateVideoBuildButtonState() に任せる
    // concurrent_builds がある場合は無効化されるべき
    updateVideoBuildButtonState();
  }
}

/**
 * Retry failed video build (create new one)
 */
async function retryVideoBuild(failedBuildId) {
  if (!confirm('同じ内容で、もう一度動画生成を行いますか？\n\n（新しい動画としてカウントされます）')) {
    return;
  }
  
  // Simply start a new build
  await startVideoBuild();
}

/**
 * Start polling for active builds
 */
function startVideoBuildPolling() {
  // Clear existing interval
  stopVideoBuildPolling();
  
  console.log('[VideoBuild] Starting polling');
  
  window.videoBuildPollingInterval = setInterval(async () => {
    await pollActiveVideoBuilds();
  }, 5000); // Poll every 5 seconds
  
  // Also poll immediately
  pollActiveVideoBuilds();
}

/**
 * Stop polling
 */
function stopVideoBuildPolling() {
  if (window.videoBuildPollingInterval) {
    clearInterval(window.videoBuildPollingInterval);
    window.videoBuildPollingInterval = null;
    console.log('[VideoBuild] Stopped polling');
  }
}

/**
 * Start polling if there's an active build
 */
function startVideoBuildPollingIfNeeded() {
  const builds = window.videoBuildListCache || [];
  const activeBuild = builds.find(b => 
    ['queued', 'validating', 'submitted', 'rendering', 'uploading', 'retry_wait'].includes(b.status)
  );
  
  if (activeBuild) {
    startVideoBuildPolling();
  } else {
    stopVideoBuildPolling();
  }
}

// Active statuses that need polling
const VIDEO_BUILD_ACTIVE_STATUSES = ['queued', 'validating', 'submitted', 'rendering', 'uploading', 'retry_wait'];

/**
 * Poll for active video builds
 */
async function pollActiveVideoBuilds() {
  const builds = window.videoBuildListCache || [];
  const activeBuilds = builds.filter(b => 
    VIDEO_BUILD_ACTIVE_STATUSES.includes(b.status)
  );
  
  if (window.DEBUG_VIDEO_BUILD) console.log(`[VB Poll] tick: ${activeBuilds.length} active builds (cache has ${builds.length} total)`);
  
  if (activeBuilds.length === 0) {
    stopVideoBuildPolling();
    hideVideoBuildProgress();
    return;
  }
  
  for (const build of activeBuilds) {
    try {
      // For retry_wait, don't call refresh (cron handles it)
      // Just reload the list periodically
      if (build.status === 'retry_wait') {
        continue;
      }
      
      if (window.DEBUG_VIDEO_BUILD) console.log(`[VB Poll] refreshing buildId=${build.id}, current status=${build.status}`);
      const response = await axios.post(`${API_BASE}/video-builds/${build.id}/refresh`);
      // BUG FIX: Backend returns "build", not "video_build"
      const updatedBuild = response.data.build || response.data.video_build;
      if (window.DEBUG_VIDEO_BUILD) console.log(`[VB Poll] refreshed buildId=${build.id}, new status=${updatedBuild?.status}, progress=${updatedBuild?.progress_percent}%`);
      
      if (updatedBuild) {
        // Update cache
        const idx = window.videoBuildListCache.findIndex(b => b.id === build.id);
        if (idx >= 0) {
          // Merge to preserve fields not in response
          window.videoBuildListCache[idx] = { ...window.videoBuildListCache[idx], ...updatedBuild };
        }
        
        // Update UI
        updateVideoBuildItemUI(updatedBuild);
        
        // Update progress section
        if (VIDEO_BUILD_ACTIVE_STATUSES.includes(updatedBuild.status)) {
          showVideoBuildProgress(updatedBuild);
        } else {
          hideVideoBuildProgress();
          
          // Build completed or failed
          if (updatedBuild.status === 'completed') {
            showToast('動画が完成しました！', 'success');
          } else if (updatedBuild.status === 'failed') {
            showToast('動画生成に失敗しました', 'error');
          }
          
          // Refresh usage
          refreshVideoBuildUsage();
          
          // Reload list
          loadVideoBuilds();
        }
      }
    } catch (error) {
      console.error(`[VideoBuild] Refresh error for build ${build.id}:`, error);
      
      // On error, reload the build list to get fresh status from DB
      // This handles cases where build status changed but cache is stale
      console.log('[VideoBuild] Reloading build list due to refresh error...');
      await loadVideoBuilds();
      
      // Check if the build is no longer active (may have failed/completed)
      const freshBuild = window.videoBuildListCache.find(b => b.id === build.id);
      if (freshBuild && !VIDEO_BUILD_ACTIVE_STATUSES.includes(freshBuild.status)) {
        console.log(`[VideoBuild] Build ${build.id} is no longer active (${freshBuild.status})`);
        // Update UI and stop polling for this build
        updateVideoBuildItemUI(freshBuild);
        hideVideoBuildProgress();
        refreshVideoBuildUsage();
      }
    }
  }
}

/**
 * Update a single build item in the list
 */
function updateVideoBuildItemUI(build) {
  const listEl = document.getElementById('videoBuildList');
  if (!listEl) return;
  
  const itemEl = listEl.querySelector(`[data-build-id="${build.id}"]`);
  if (itemEl) {
    const newHtml = renderVideoBuildItem(build);
    const temp = document.createElement('div');
    temp.innerHTML = newHtml;
    itemEl.replaceWith(temp.firstElementChild);
  }
}

// Clean up on page unload
window.addEventListener('beforeunload', () => {
  stopVideoBuildPolling();
});

// ========== Phase F-3: Reset to Input ==========

/**
 * Show reset to input confirmation modal
 */
async function showResetToInputModal() {
  try {
    // Get preview data
    const response = await axios.get(`${API_BASE}/projects/${PROJECT_ID}/reset-to-input/preview`);
    const data = response.data;
    
    if (!data.can_reset) {
      // Show detailed block reason
      const reason = data.block_reason || `現在のステータス（${data.project.status}）ではリセットできません`;
      
      // Create info modal for blocked reset
      const blockedHtml = `
        <div id="resetBlockedModal" class="fixed inset-0 flex items-center justify-center z-50">
          <div class="absolute inset-0 bg-black/50" onclick="document.getElementById('resetBlockedModal')?.remove()"></div>
          <div class="relative bg-white rounded-xl shadow-xl w-[min(450px,94vw)] p-6">
            <div class="text-center mb-4">
              <i class="fas fa-lock text-5xl text-gray-400 mb-3"></i>
              <h3 class="text-xl font-bold text-gray-800">リセットできません</h3>
            </div>
            <div class="bg-yellow-50 border border-yellow-300 rounded-lg p-4 mb-4">
              <p class="text-yellow-800">${reason}</p>
            </div>
            ${data.has_video_build ? '<p class="text-sm text-gray-600 mb-2"><i class="fas fa-video mr-2 text-blue-500"></i>最終動画が作成済みです</p>' : ''}
            ${data.has_comic ? '<p class="text-sm text-gray-600 mb-2"><i class="fas fa-book mr-2 text-purple-500"></i>漫画化データが存在します</p>' : ''}
            ${data.has_scene_videos ? '<p class="text-sm text-gray-600 mb-2"><i class="fas fa-film mr-2 text-green-500"></i>シーン動画が生成済みです</p>' : ''}
            <div class="text-center mt-4">
              <button 
                onclick="document.getElementById('resetBlockedModal')?.remove()"
                class="px-6 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition-colors font-semibold"
              >
                閉じる
              </button>
            </div>
          </div>
        </div>
      `;
      const container = document.createElement('div');
      container.innerHTML = blockedHtml;
      document.body.appendChild(container.firstElementChild);
      return;
    }
    
    const willDelete = data.will_delete;
    const willPreserve = data.will_preserve;
    
    // Calculate total items to delete
    const totalItems = (willDelete.scenes || 0) + (willDelete.images || 0) + 
                       (willDelete.audios || 0) + (willDelete.videos || 0);
    
    // Create modal HTML with strong warning
    const modalHtml = `
      <div id="resetToInputModal" class="fixed inset-0 flex items-center justify-center z-50">
        <div class="absolute inset-0 bg-black/70"></div>
        <div class="relative bg-white rounded-xl shadow-2xl w-[min(550px,94vw)] max-h-[90vh] overflow-y-auto border-4 border-red-500">
          <div class="p-6">
            <!-- Critical Warning Banner -->
            <div class="bg-red-600 text-white p-4 rounded-lg mb-4 -mx-2 -mt-2">
              <div class="flex items-center gap-3">
                <i class="fas fa-radiation text-4xl animate-pulse"></i>
                <div>
                  <h3 class="text-xl font-bold">⚠️ 重大な警告 - データ完全削除</h3>
                  <p class="text-red-100 text-sm mt-1">この操作は取り消せません</p>
                </div>
              </div>
            </div>
            
            <!-- Main Warning Message -->
            <div class="bg-yellow-50 border-2 border-yellow-400 rounded-lg p-4 mb-4">
              <p class="text-yellow-800 font-bold text-center">
                <i class="fas fa-exclamation-triangle mr-2"></i>
                以下のデータが完全に削除され、二度と復元できません
              </p>
            </div>
            
            <!-- Deletion Details -->
            <div class="mb-4 p-4 bg-red-50 rounded-lg border-2 border-red-300">
              <h4 class="font-bold text-red-800 mb-3 text-lg">
                <i class="fas fa-skull-crossbones mr-2"></i>完全削除されるデータ
              </h4>
              <ul class="text-red-700 space-y-2">
                <li class="flex justify-between border-b border-red-200 pb-1">
                  <span><i class="fas fa-film mr-2"></i>シーンデータ</span>
                  <strong class="text-red-800">${willDelete.scenes}件</strong>
                </li>
                <li class="flex justify-between border-b border-red-200 pb-1">
                  <span><i class="fas fa-image mr-2"></i>生成済み画像（全履歴含む）</span>
                  <strong class="text-red-800">${willDelete.images}件</strong>
                </li>
                <li class="flex justify-between border-b border-red-200 pb-1">
                  <span><i class="fas fa-volume-up mr-2"></i>生成済み音声（全履歴含む）</span>
                  <strong class="text-red-800">${willDelete.audios}件</strong>
                </li>
                <li class="flex justify-between border-b border-red-200 pb-1">
                  <span><i class="fas fa-video mr-2"></i>生成済み動画</span>
                  <strong class="text-red-800">${willDelete.videos}件</strong>
                </li>
                <li class="flex justify-between">
                  <span><i class="fas fa-puzzle-piece mr-2"></i>テキストチャンク</span>
                  <strong class="text-red-800">${willDelete.chunks}件</strong>
                </li>
              </ul>
              <div class="mt-3 pt-3 border-t-2 border-red-300">
                <p class="text-red-800 font-bold text-center">
                  合計 <span class="text-2xl">${totalItems}</span> 件のコンテンツが削除されます
                </p>
              </div>
            </div>
            
            <!-- Impact Warning -->
            <div class="mb-4 p-3 bg-orange-50 rounded-lg border border-orange-300">
              <h4 class="font-semibold text-orange-800 mb-2">
                <i class="fas fa-ban mr-1"></i>削除後にできなくなること
              </h4>
              <ul class="text-sm text-orange-700 space-y-1">
                <li>• <strong>ダウンロード不可</strong>: 生成した画像・音声・動画はダウンロードできなくなります</li>
                <li>• <strong>履歴消失</strong>: シーンごとの生成履歴は全て失われます</li>
                <li>• <strong>復元不可</strong>: 一度削除したデータは復元できません</li>
              </ul>
            </div>
            
            <!-- Preserved Data -->
            <div class="mb-4 p-3 bg-green-50 rounded-lg border border-green-200">
              <h4 class="font-semibold text-green-700 mb-2">
                <i class="fas fa-shield-alt mr-1"></i>保持されるデータ
              </h4>
              <ul class="text-sm text-green-600 space-y-1">
                <li>• キャラクター設定: <strong>${willPreserve.characters}人</strong></li>
                <li>• ワールド設定・スタイル設定</li>
                <li>• 入力テキスト${willPreserve.source_text ? '（保持）' : '（なし）'}</li>
              </ul>
            </div>
            
            <!-- Confirmation Checkbox -->
            <div class="mb-4 p-3 bg-gray-100 rounded-lg">
              <label class="flex items-start gap-3 cursor-pointer">
                <input type="checkbox" id="resetConfirmCheckbox" class="mt-1 w-5 h-5 accent-red-600">
                <span class="text-gray-700 text-sm">
                  上記の内容を理解し、<strong class="text-red-600">${totalItems}件のデータが完全に削除される</strong>ことに同意します
                </span>
              </label>
            </div>
            
            <!-- Action Buttons -->
            <div class="flex gap-3 justify-end">
              <button 
                onclick="closeResetToInputModal()"
                class="px-6 py-3 bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition-colors font-bold"
              >
                <i class="fas fa-times mr-2"></i>キャンセル（安全）
              </button>
              <button 
                id="resetExecuteBtn"
                onclick="executeResetToInput()"
                disabled
                class="px-6 py-3 bg-red-600 text-white rounded-lg transition-colors font-bold disabled:opacity-50 disabled:cursor-not-allowed hover:bg-red-700"
              >
                <i class="fas fa-trash-alt mr-2"></i>完全削除を実行
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
    
    // Enable button only when checkbox is checked
    setTimeout(() => {
      const checkbox = document.getElementById('resetConfirmCheckbox');
      const btn = document.getElementById('resetExecuteBtn');
      if (checkbox && btn) {
        checkbox.addEventListener('change', () => {
          btn.disabled = !checkbox.checked;
        });
      }
    }, 100);
    
    // Add modal to DOM
    const modalContainer = document.createElement('div');
    modalContainer.innerHTML = modalHtml;
    document.body.appendChild(modalContainer.firstElementChild);
    
  } catch (error) {
    console.error('Error showing reset modal:', error);
    showToast('リセットプレビューの取得に失敗しました', 'error');
  }
}

/**
 * Close reset to input modal
 */
function closeResetToInputModal() {
  const modal = document.getElementById('resetToInputModal');
  if (modal) {
    modal.remove();
  }
}

/**
 * Execute reset to input
 */
async function executeResetToInput() {
  try {
    closeResetToInputModal();
    
    showToast('リセット中...', 'info');
    
    const response = await axios.post(`${API_BASE}/projects/${PROJECT_ID}/reset-to-input`);
    
    if (response.data.success) {
      // API returns: { success, message, project_id, reset_to, deleted }
      const deleted = response.data.deleted || {};
      const msg = deleted.scenes !== undefined 
        ? `リセット完了: シーン${deleted.scenes}件、画像${deleted.images}件、音声${deleted.audios}件、動画${deleted.videos}件を削除しました`
        : 'リセット完了: シーン・画像・音声を削除しました';
      showToast(msg, 'success');
      
      // Update project status in cache (SSOT: updateCurrentProjectで統一更新)
      const updatedProject = { ...currentProject, status: response.data.reset_to };
      updateCurrentProject(updatedProject);
      
      // Clear scene caches to force refresh
      window.sceneSplitLoaded = false;
      window.sceneSplitInitialized = false;
      window.builderInitialized = false;
      
      // Hide scenes section and show format section
      document.getElementById('scenesSection')?.classList.add('hidden');
      // Note: resetToInputSection removed - using only resetToInputBtnSmall in scenes header
      document.getElementById('goToBuilderBtn')?.classList.add('hidden');
      document.getElementById('characterWarningSection')?.classList.add('hidden');
      document.getElementById('formatSection')?.classList.remove('hidden');
      document.getElementById('scenesEmptyState')?.classList.add('hidden');
      
      // Clear scenes list
      const scenesList = document.getElementById('scenesList');
      if (scenesList) {
        scenesList.innerHTML = '';
      }
      
      // Update tab states
      updateTabStates(response.data.reset_to);
      
      // Switch to SceneSplit tab and reinitialize
      switchTab('sceneSplit');
      
    } else {
      showToast(response.data.error?.message || 'リセットに失敗しました', 'error');
    }
  } catch (error) {
    console.error('Error resetting to input:', error);
    const errorMsg = error.response?.data?.error?.details || error.response?.data?.error?.message || 'リセット中にエラーが発生しました';
    showToast(errorMsg, 'error');
  }
}

/**
 * Update reset to input button visibility and state based on project status
 * Also checks if videos/comics exist to disable the button
 */
async function updateResetToInputVisibility(status) {
  const resetBtnSmall = document.getElementById('resetToInputBtnSmall');
  
  // Show reset button only when scenes exist (formatted, generating_images, completed, failed)
  const showReset = ['formatted', 'generating_images', 'completed', 'failed'].includes(status);
  
  if (resetBtnSmall) {
    if (showReset) {
      resetBtnSmall.classList.remove('hidden');
      
      // Check if reset is actually allowed (no videos/comics)
      try {
        const response = await axios.get(`${API_BASE}/projects/${PROJECT_ID}/reset-to-input/preview`);
        const data = response.data;
        
        if (!data.can_reset) {
          // Disable button and show reason on hover
          resetBtnSmall.disabled = true;
          resetBtnSmall.classList.add('opacity-50', 'cursor-not-allowed');
          resetBtnSmall.classList.remove('hover:bg-orange-200');
          resetBtnSmall.title = data.block_reason || 'リセットできません';
          resetBtnSmall.innerHTML = '<i class="fas fa-lock mr-1"></i>やり直し不可';
        } else {
          // Enable button
          resetBtnSmall.disabled = false;
          resetBtnSmall.classList.remove('opacity-50', 'cursor-not-allowed');
          resetBtnSmall.classList.add('hover:bg-orange-200');
          resetBtnSmall.title = '入力からやり直す';
          resetBtnSmall.innerHTML = '<i class="fas fa-undo mr-1"></i>やり直す';
        }
      } catch (e) {
        console.error('Failed to check reset availability:', e);
      }
    } else {
      resetBtnSmall.classList.add('hidden');
    }
  }
}

// ============================================================
// R3-A: BGM Management Functions
// ============================================================

// Global BGM state
window.currentBgm = null;

/**
 * Load BGM status for the current project
 */
async function loadBgmStatus() {
  try {
    const response = await axios.get(`${API_BASE}/projects/${PROJECT_ID}/audio-tracks`);
    const data = response.data;
    
    if (data.active_bgm) {
      window.currentBgm = data.active_bgm;
      showBgmActiveState(data.active_bgm);
    } else {
      window.currentBgm = null;
      showBgmEmptyState();
    }
  } catch (error) {
    console.error('[BGM] Load status error:', error);
    showBgmEmptyState();
  }
}

/**
 * Handle BGM file upload
 */
async function handleBgmUpload(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  
  // Validate file type
  if (!file.type.startsWith('audio/')) {
    showToast('音声ファイルを選択してください', 'error');
    return;
  }
  
  // Validate file size (max 50MB)
  const maxSize = 50 * 1024 * 1024;
  if (file.size > maxSize) {
    showToast('ファイルサイズは50MB以下にしてください', 'error');
    return;
  }
  
  try {
    showBgmUploadingState();
    
    // Web Audio APIを使って音声の長さを取得
    let durationMs = null;
    try {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const arrayBuffer = await file.arrayBuffer();
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
      durationMs = Math.round(audioBuffer.duration * 1000);
      await audioContext.close();
      console.log(`[BGM] Detected duration: ${durationMs}ms`);
    } catch (audioErr) {
      console.warn('[BGM] Could not detect audio duration:', audioErr);
      // duration取得に失敗してもアップロードは続行
    }
    
    const formData = new FormData();
    formData.append('file', file);
    formData.append('volume', '0.25');
    formData.append('loop', '1');
    if (durationMs) {
      formData.append('duration_ms', String(durationMs));
    }
    
    const response = await axios.post(
      `${API_BASE}/projects/${PROJECT_ID}/audio-tracks/bgm/upload`,
      formData,
      {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: (progressEvent) => {
          const progress = Math.round((progressEvent.loaded / progressEvent.total) * 100);
          const progressBar = document.getElementById('bgmUploadProgress');
          if (progressBar) {
            progressBar.style.width = `${progress}%`;
          }
        }
      }
    );
    
    window.currentBgm = response.data;
    showBgmActiveState(response.data);
    showToast('BGMをアップロードしました', 'success');
    
  } catch (error) {
    console.error('[BGM] Upload error:', error);
    showToast('BGMのアップロードに失敗しました', 'error');
    showBgmEmptyState();
  }
  
  // Reset file input
  event.target.value = '';
}

/**
 * Remove current BGM
 */
async function removeBgm() {
  if (!window.currentBgm?.id) return;
  
  if (!confirm('BGMを削除しますか？')) return;
  
  try {
    await axios.delete(`${API_BASE}/projects/${PROJECT_ID}/audio-tracks/${window.currentBgm.id}`);
    window.currentBgm = null;
    showBgmEmptyState();
    showToast('BGMを削除しました', 'success');
  } catch (error) {
    console.error('[BGM] Remove error:', error);
    showToast('BGMの削除に失敗しました', 'error');
  }
}

/**
 * Update BGM volume
 */
async function updateBgmVolume(value) {
  const volumeLabel = document.getElementById('bgmVolumeLabel');
  if (volumeLabel) {
    volumeLabel.textContent = `${value}%`;
  }
  
  if (!window.currentBgm?.id) return;
  
  try {
    await axios.put(`${API_BASE}/projects/${PROJECT_ID}/audio-tracks/${window.currentBgm.id}`, {
      volume: parseFloat(value) / 100
    });
  } catch (error) {
    console.error('[BGM] Update volume error:', error);
  }
}

/**
 * Update BGM loop setting
 */
async function updateBgmLoop(checked) {
  if (!window.currentBgm?.id) return;
  
  try {
    await axios.put(`${API_BASE}/projects/${PROJECT_ID}/audio-tracks/${window.currentBgm.id}`, {
      loop: checked ? 1 : 0
    });
  } catch (error) {
    console.error('[BGM] Update loop error:', error);
  }
}

/**
 * Show empty BGM state
 */
function showBgmEmptyState() {
  const emptyState = document.getElementById('bgmEmptyState');
  const activeState = document.getElementById('bgmActiveState');
  const uploadingState = document.getElementById('bgmUploadingState');
  const statusCard = document.getElementById('bgmStatusCard');
  
  if (emptyState) emptyState.classList.remove('hidden');
  if (activeState) activeState.classList.add('hidden');
  if (uploadingState) uploadingState.classList.add('hidden');
  if (statusCard) {
    statusCard.classList.remove('border-yellow-400', 'bg-yellow-50');
    statusCard.classList.add('border-gray-200', 'bg-gray-50');
  }
}

/**
 * Show uploading BGM state
 */
function showBgmUploadingState() {
  const emptyState = document.getElementById('bgmEmptyState');
  const activeState = document.getElementById('bgmActiveState');
  const uploadingState = document.getElementById('bgmUploadingState');
  const progressBar = document.getElementById('bgmUploadProgress');
  
  if (emptyState) emptyState.classList.add('hidden');
  if (activeState) activeState.classList.add('hidden');
  if (uploadingState) uploadingState.classList.remove('hidden');
  if (progressBar) progressBar.style.width = '0%';
}

/**
 * Show active BGM state
 */
function showBgmActiveState(bgm) {
  const emptyState = document.getElementById('bgmEmptyState');
  const activeState = document.getElementById('bgmActiveState');
  const uploadingState = document.getElementById('bgmUploadingState');
  const statusCard = document.getElementById('bgmStatusCard');
  const fileName = document.getElementById('bgmFileName');
  const previewPlayer = document.getElementById('bgmPreviewPlayer');
  const volumeSlider = document.getElementById('bgmVolumeSlider');
  const volumeLabel = document.getElementById('bgmVolumeLabel');
  const loopToggle = document.getElementById('bgmLoopToggle');
  
  if (emptyState) emptyState.classList.add('hidden');
  if (activeState) activeState.classList.remove('hidden');
  if (uploadingState) uploadingState.classList.add('hidden');
  
  if (statusCard) {
    statusCard.classList.remove('border-gray-200', 'bg-gray-50');
    statusCard.classList.add('border-yellow-400', 'bg-yellow-50');
  }
  
  // Set file info
  if (fileName) {
    const duration = bgm.duration_ms ? `${Math.round(bgm.duration_ms / 1000)}秒` : '';
    fileName.textContent = duration ? `再生時間: ${duration}` : 'BGM';
  }
  
  // Set audio preview
  if (previewPlayer && bgm.r2_url) {
    previewPlayer.src = bgm.r2_url;
  }
  
  // Set volume
  const volume = Math.round((bgm.volume ?? 0.25) * 100);
  if (volumeSlider) volumeSlider.value = volume;
  if (volumeLabel) volumeLabel.textContent = `${volume}%`;
  
  // Set loop
  if (loopToggle) loopToggle.checked = bgm.loop === 1 || bgm.loop === true;
}

// Make functions globally available
window.handleBgmUpload = handleBgmUpload;
window.removeBgm = removeBgm;
window.updateBgmVolume = updateBgmVolume;
window.updateBgmLoop = updateBgmLoop;
window.loadBgmStatus = loadBgmStatus;

// ============================================
// R3-A-2: Project BGM Library Selection
// ============================================

/**
 * Open project-level BGM library modal
 * @param {string} libraryType - 'system' or 'user'
 */
async function openProjectBgmLibrary(libraryType) {
  // Check if modal exists, create if not
  let modal = document.getElementById('projectBgmLibraryModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'projectBgmLibraryModal';
    modal.className = 'hidden fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center';
    modal.innerHTML = `
      <div class="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[80vh] overflow-hidden mx-4">
        <div class="p-4 border-b border-gray-200 flex items-center justify-between">
          <h3 class="font-bold text-lg" id="projectBgmLibraryTitle">BGMライブラリ</h3>
          <button onclick="closeProjectBgmLibrary()" class="text-gray-500 hover:text-gray-700">
            <i class="fas fa-times text-xl"></i>
          </button>
        </div>
        <div id="projectBgmLibraryContent" class="p-4 overflow-y-auto max-h-[60vh]">
          <!-- Library content will be loaded dynamically -->
        </div>
      </div>
    `;
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeProjectBgmLibrary();
    });
    document.body.appendChild(modal);
  }
  
  // Set title based on library type
  const titleEl = document.getElementById('projectBgmLibraryTitle');
  if (titleEl) {
    titleEl.textContent = libraryType === 'system' ? 'システムBGMライブラリ' : 'マイBGMライブラリ';
  }
  
  // Show modal with loading spinner
  modal.classList.remove('hidden');
  const contentEl = document.getElementById('projectBgmLibraryContent');
  if (contentEl) {
    contentEl.innerHTML = `
      <div class="p-4 text-center text-gray-500">
        <i class="fas fa-spinner fa-spin mr-2"></i>読み込み中...
      </div>
    `;
  }
  
  // Fetch library items
  try {
    const endpoint = libraryType === 'system' 
      ? `${API_BASE}/audio-library/system?category=bgm`
      : `${API_BASE}/audio-library?type=bgm`;
    
    const response = await axios.get(endpoint);
    const items = response.data.items || [];
    
    if (items.length === 0) {
      contentEl.innerHTML = `
        <div class="p-4 text-center text-gray-500">
          <i class="fas fa-music text-4xl mb-3"></i>
          <p>BGMが登録されていません</p>
        </div>
      `;
      return;
    }
    
    contentEl.innerHTML = `
      <div class="space-y-3">
        ${items.map(item => `
          <div class="p-3 border border-gray-200 rounded-lg hover:border-blue-300 hover:bg-blue-50 transition-colors">
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-3">
                <span class="text-2xl">🎵</span>
                <div>
                  <div class="font-semibold text-gray-800">${escapeHtml(item.name || 'BGM')}</div>
                  <div class="text-xs text-gray-500">
                    ${item.duration_ms ? Math.round(item.duration_ms / 1000) + '秒' : ''}
                    ${item.category ? ' | ' + item.category : ''}
                    ${item.mood ? ' | ' + item.mood : ''}
                  </div>
                </div>
              </div>
              <button 
                onclick="selectProjectBgm('${libraryType}', ${item.id}, '${escapeHtml(item.name || 'BGM')}')"
                class="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors text-sm font-semibold"
              >
                <i class="fas fa-check mr-1"></i>選択
              </button>
            </div>
            ${item.r2_url ? `
              <audio src="${item.r2_url}" controls class="w-full mt-2 h-8"></audio>
            ` : ''}
          </div>
        `).join('')}
      </div>
    `;
  } catch (error) {
    console.error('[ProjectBGM] Library load error:', error);
    contentEl.innerHTML = `
      <div class="p-4 text-center text-red-500">
        <i class="fas fa-exclamation-circle mr-2"></i>
        読み込みに失敗しました
      </div>
    `;
  }
}

/**
 * Close project BGM library modal
 */
function closeProjectBgmLibrary() {
  const modal = document.getElementById('projectBgmLibraryModal');
  if (modal) modal.classList.add('hidden');
}

/**
 * Select BGM from library for project-wide use
 * @param {string} libraryType - 'system' or 'user'
 * @param {number} itemId - Audio library item ID
 * @param {string} itemName - Item name for display
 */
async function selectProjectBgm(libraryType, itemId, itemName) {
  try {
    const payload = {
      audio_library_type: libraryType,
      volume: 0.25,
      loop: false  // ループはデフォルトOFF
    };
    
    if (libraryType === 'system') {
      payload.system_audio_id = itemId;
    } else {
      payload.user_audio_id = itemId;
    }
    
    const response = await axios.post(
      `${API_BASE}/projects/${PROJECT_ID}/audio-tracks/bgm/from-library`,
      payload
    );
    
    closeProjectBgmLibrary();
    showToast(`BGM「${itemName}」を設定しました`, 'success');
    
    // Update UI with the new BGM
    if (response.data) {
      window.currentBgm = response.data;
      showBgmActiveState(response.data);
    } else {
      loadBgmStatus();
    }
  } catch (error) {
    console.error('[ProjectBGM] Select error:', error);
    showToast('BGMの設定に失敗しました', 'error');
  }
}

// Expose functions globally
window.openProjectBgmLibrary = openProjectBgmLibrary;
window.closeProjectBgmLibrary = closeProjectBgmLibrary;
window.selectProjectBgm = selectProjectBgm;

// ============================================
// R4: Patch History (SSOT Patch)
// ============================================

/**
 * Load patch history for current project
 */
async function loadPatchHistory() {
  const listEl = document.getElementById('patchHistoryList');
  const emptyEl = document.getElementById('patchHistoryEmpty');
  const loadingEl = document.getElementById('patchHistoryLoading');
  
  if (!listEl || !emptyEl || !loadingEl) return;
  
  // Show loading
  listEl.innerHTML = '';
  emptyEl.classList.add('hidden');
  loadingEl.classList.remove('hidden');
  
  try {
    const response = await axios.get(`${API_BASE}/projects/${PROJECT_ID}/patches`);
    const patches = response.data.patches || [];
    
    window.patchHistoryCache = patches;
    
    loadingEl.classList.add('hidden');
    
    if (patches.length === 0) {
      emptyEl.classList.remove('hidden');
      return;
    }
    
    listEl.innerHTML = patches.map(renderPatchHistoryItem).join('');
    
  } catch (error) {
    console.error('[PatchHistory] Failed to load patches:', error);
    loadingEl.classList.add('hidden');
    listEl.innerHTML = '<div class="p-4 text-red-600 text-center"><i class="fas fa-exclamation-circle mr-2"></i>読み込みに失敗しました</div>';
  }
}

/**
 * Render a single patch history item
 */
function renderPatchHistoryItem(patch) {
  const statusInfo = getPatchStatusInfo(patch.status);
  // Parse UTC datetime and convert to Japan timezone
  const createdAtUtc = patch.created_at.replace(' ', 'T') + 'Z';
  const createdAt = new Date(createdAtUtc).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  
  // Extract change type from ops_json
  let changeType = '-';
  try {
    const ops = typeof patch.ops_json === 'string' ? JSON.parse(patch.ops_json) : patch.ops_json;
    if (Array.isArray(ops) && ops.length > 0) {
      const entities = [...new Set(ops.map(op => op.entity))];
      const opTypes = [...new Set(ops.map(op => op.op))];
      changeType = `${opTypes.join('/')} ${entities.join(', ')}`;
    }
  } catch (e) {
    console.warn('[PatchHistory] Failed to parse ops_json:', e);
  }
  
  // Find generated video build (if any)
  let buildLink = '';
  if (patch.generated_video_build_id) {
    buildLink = `
      <a href="#" onclick="scrollToVideoBuild(${patch.generated_video_build_id})" 
         class="text-blue-600 hover:underline text-sm">
        <i class="fas fa-film mr-1"></i>ビルド #${patch.generated_video_build_id}
      </a>
    `;
  }
  
  return `
    <div class="p-4 hover:bg-gray-50 transition-colors">
      <div class="flex items-start justify-between">
        <div class="flex-1">
          <div class="flex items-center gap-2 mb-1">
            <span class="text-lg" title="${statusInfo.label}">${statusInfo.icon}</span>
            <span class="text-sm font-medium text-gray-700">#${patch.id}</span>
            <span class="text-xs text-gray-400">${createdAt}</span>
          </div>
          
          <p class="text-sm text-gray-800 mb-1">
            ${escapeHtml(patch.user_message || '(メッセージなし)')}
          </p>
          
          <div class="flex items-center gap-3 text-xs text-gray-500">
            <span><i class="fas fa-exchange-alt mr-1"></i>${changeType}</span>
            ${buildLink}
          </div>
        </div>
        
        <button 
          onclick="togglePatchDetails(${patch.id})"
          class="text-gray-400 hover:text-gray-600 p-2"
          title="詳細を表示"
        >
          <i class="fas fa-chevron-down"></i>
        </button>
      </div>
      
      <div id="patchDetails-${patch.id}" class="hidden mt-3 pt-3 border-t border-gray-200">
        <div class="text-xs text-gray-600 space-y-2">
          <div>
            <span class="font-semibold">ソース:</span> ${patch.source || '-'}
          </div>
          <div>
            <span class="font-semibold">ステータス:</span> 
            <span class="${statusInfo.textColor}">${statusInfo.label}</span>
          </div>
          <div>
            <span class="font-semibold">操作:</span>
            <pre class="mt-1 p-2 bg-gray-100 rounded text-xs overflow-x-auto max-h-32">${escapeHtml(JSON.stringify(patch.ops_json, null, 2) || '[]')}</pre>
          </div>
        </div>
      </div>
    </div>
  `;
}

/**
 * Get patch status info
 */
function getPatchStatusInfo(status) {
  const statusMap = {
    draft: { icon: '📝', label: '下書き', textColor: 'text-gray-600' },
    dry_run_ok: { icon: '✔️', label: 'プレビュー済み', textColor: 'text-blue-600' },
    dry_run_failed: { icon: '⚠️', label: 'プレビュー失敗', textColor: 'text-amber-600' },
    apply_ok: { icon: '✅', label: '適用済み', textColor: 'text-green-600' },
    apply_failed: { icon: '❌', label: '適用失敗', textColor: 'text-red-600' }
  };
  
  return statusMap[status] || { icon: '❓', label: status, textColor: 'text-gray-600' };
}

/**
 * Toggle patch details visibility
 */
function togglePatchDetails(patchId) {
  const detailsEl = document.getElementById(`patchDetails-${patchId}`);
  if (detailsEl) {
    detailsEl.classList.toggle('hidden');
    
    // Toggle chevron icon
    const btn = detailsEl.previousElementSibling?.querySelector('button');
    if (btn) {
      const icon = btn.querySelector('i');
      if (icon) {
        icon.classList.toggle('fa-chevron-down');
        icon.classList.toggle('fa-chevron-up');
      }
    }
  }
}

/**
 * Scroll to a specific video build in the list
 */
function scrollToVideoBuild(buildId) {
  // Find build element
  const buildEl = document.querySelector(`[data-build-id="${buildId}"]`);
  if (buildEl) {
    buildEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    buildEl.classList.add('ring-2', 'ring-blue-400');
    setTimeout(() => {
      buildEl.classList.remove('ring-2', 'ring-blue-400');
    }, 2000);
  }
}

// Make patch functions globally available
window.loadPatchHistory = loadPatchHistory;
window.togglePatchDetails = togglePatchDetails;
window.scrollToVideoBuild = scrollToVideoBuild;

// ============================================
// Safe Chat v0: Chat Edit Panel
// ============================================

// State for chat edit panel
window.chatEditState = {
  buildId: null,
  videoUrl: null,
  patchRequestId: null,
  dryRunResult: null,
  messages: [],
};

// ===== PR-4-3: Video Build Preview Modal =====

/**
 * Open the video build preview modal
 * @param {number} buildId 
 * @param {string} videoUrl 
 */
function openVideoBuildPreviewModal(buildId, videoUrl) {
  const modal = document.getElementById('videoBuildPreviewModal');
  if (!modal) return;

  const title = document.getElementById('vbPreviewTitle');
  const idEl = document.getElementById('vbPreviewBuildId');
  const src = document.getElementById('vbPreviewVideoSrc');
  const video = document.getElementById('vbPreviewVideo');
  const errorEl = document.getElementById('vbPreviewError');

  if (title) title.textContent = 'プレビュー（完成動画）';
  if (idEl) idEl.textContent = `Build #${buildId}`;
  
  // エラー表示をリセット
  if (errorEl) errorEl.classList.add('hidden');

  if (src && videoUrl) {
    src.src = videoUrl;
    
    // CloudFront URLs are permanent - simple error handling
    video.onerror = () => {
      console.warn('[VideoBuild] Video load error for build:', buildId);
      if (errorEl) {
        errorEl.innerHTML = `
          <div class="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">
            <i class="fas fa-times-circle mr-1"></i>
            動画の読み込みに失敗しました。<br/>
            <span class="text-xs text-red-600">動画ファイルが存在しない可能性があります。</span>
          </div>
        `;
        errorEl.classList.remove('hidden');
      }
    };
    
    video.load();
  }

  // DLリンク
  const dl = document.getElementById('vbPreviewDownloadLink');
  if (dl && videoUrl) dl.href = videoUrl;

  // 修正（チャット）ボタン → chatEditModal を開く
  const chatBtn = document.getElementById('vbPreviewChatEditBtn');
  if (chatBtn) {
    chatBtn.onclick = () => {
      closeVideoBuildPreviewModal();
      openChatEditModal(buildId, videoUrl);
    };
  }

  modal.classList.remove('hidden');
  document.body.classList.add('overflow-hidden');
}

/**
 * Close the video build preview modal
 */
function closeVideoBuildPreviewModal() {
  const modal = document.getElementById('videoBuildPreviewModal');
  if (!modal) return;

  // stop video
  const video = document.getElementById('vbPreviewVideo');
  try { video.pause(); } catch {}
  
  // stop all audio elements (BGM preview, etc.)
  stopAllAudioPreviews();
  
  modal.classList.add('hidden');
  document.body.classList.remove('overflow-hidden');
}

/**
 * Stop all audio preview elements
 * Called when closing modals or switching tabs
 */
function stopAllAudioPreviews() {
  // Stop BGM preview
  const bgmPlayer = document.getElementById('bgmPreviewPlayer');
  if (bgmPlayer) {
    try {
      bgmPlayer.pause();
      bgmPlayer.currentTime = 0;
    } catch (e) {
      console.warn('[Audio] Failed to stop BGM preview:', e);
    }
  }
  
  // Stop all audio elements in the page (scene audio, SFX, etc.)
  document.querySelectorAll('audio').forEach(audio => {
    try {
      audio.pause();
      audio.currentTime = 0;
    } catch (e) {
      console.warn('[Audio] Failed to stop audio:', e);
    }
  });
  
  console.log('[Audio] All audio previews stopped');
}

// Export for global access
window.openVideoBuildPreviewModal = openVideoBuildPreviewModal;
window.closeVideoBuildPreviewModal = closeVideoBuildPreviewModal;
window.stopAllAudioPreviews = stopAllAudioPreviews;

// ============================================
// Phase C: Chat Context Helpers
// ============================================

function clampInt(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, Math.trunc(x)));
}

function getSceneCountFromCache() {
  // Try various caches for scene count
  const scenes = window.videoBuildListCacheScenes || window.lastLoadedScenes || window.builderScenesCache || [];
  if (Array.isArray(scenes) && scenes.length > 0) return scenes.length;
  // Fallback: try preflight summary
  const pre = window.lastPreflightSummary?.preflight_count;
  if (typeof pre === 'string' && pre.includes('/')) {
    const rhs = pre.split('/')[1];
    const v = parseInt(rhs, 10);
    if (!Number.isNaN(v) && v > 0) return v;
  }
  return 10; // Default max
}

function setChatContext(sceneIdx, balloonNo) {
  window.chatEditState = window.chatEditState || {};
  window.chatEditState.contextSceneIdx = clampInt(sceneIdx, 1, 999);
  window.chatEditState.contextBalloonNo = clampInt(balloonNo, 1, 999);

  // Reflect to UI
  const sceneSel = document.getElementById('chatEditContextScene');
  const balloonInput = document.getElementById('chatEditContextBalloon');
  if (sceneSel) sceneSel.value = String(window.chatEditState.contextSceneIdx);
  if (balloonInput) balloonInput.value = String(window.chatEditState.contextBalloonNo);
}

function populateChatContextSelectors() {
  const sceneSel = document.getElementById('chatEditContextScene');
  if (!sceneSel) return;
  
  const count = getSceneCountFromCache();
  const current = clampInt(window.chatEditState?.contextSceneIdx || 1, 1, Math.max(1, count));

  sceneSel.innerHTML = Array.from({ length: count }, (_, i) => {
    const v = i + 1;
    return `<option value="${v}" ${v === current ? 'selected' : ''}>${v}</option>`;
  }).join('');

  // Bind change events once
  if (!sceneSel.dataset.bound) {
    sceneSel.dataset.bound = 'true';
    sceneSel.addEventListener('change', () => {
      setChatContext(parseInt(sceneSel.value, 10), window.chatEditState?.contextBalloonNo || 1);
    });
  }

  const balloonInput = document.getElementById('chatEditContextBalloon');
  if (balloonInput && !balloonInput.dataset.bound) {
    balloonInput.dataset.bound = 'true';
    balloonInput.addEventListener('change', () => {
      setChatContext(window.chatEditState?.contextSceneIdx || 1, parseInt(balloonInput.value, 10));
    });
  }
}

function bindAiToggle() {
  const aiToggle = document.getElementById('chatEditUseAiToggle');
  if (!aiToggle) return;
  
  if (!aiToggle.dataset.bound) {
    aiToggle.dataset.bound = 'true';
    aiToggle.addEventListener('change', () => {
      window.chatEditState = window.chatEditState || {};
      window.chatEditState.useAiParse = !!aiToggle.checked;
      // Update parse mode indicator
      const modeLabel = document.getElementById('chatEditParseMode');
      if (modeLabel) {
        modeLabel.classList.toggle('hidden', !aiToggle.checked);
      }
    });
  }
  
  // Sync state -> UI
  if (typeof window.chatEditState?.useAiParse !== 'boolean') {
    window.chatEditState = window.chatEditState || {};
    window.chatEditState.useAiParse = true; // Default ON
  }
  aiToggle.checked = !!window.chatEditState.useAiParse;
}

/**
 * Open the chat edit modal for a specific build (v1 Center Popup)
 * Phase C: 文脈SSOT + AIトグル対応
 * Phase C1: シーンセレクタ連携 - SceneEditModal.currentSceneIdx を自動参照
 * @param {number} buildId 
 * @param {string} videoUrl 
 * @param {Object} options - オプション { sceneIdx: number, balloonNo: number }
 */
function openChatEditModal(buildId, videoUrl, options = {}) {
  const modal = document.getElementById('chatEditModal');
  if (!modal) return;

  // Phase C1: シーンセレクタ連携
  // 優先順位: 1. options.sceneIdx 2. SceneEditModal.currentSceneIdx 3. state保持値 4. デフォルト1
  const sceneFromModal = window.SceneEditModal?.currentSceneIdx;
  const contextSceneIdx = options.sceneIdx ?? sceneFromModal ?? window.chatEditState?.contextSceneIdx ?? 1;
  const contextBalloonNo = options.balloonNo ?? window.chatEditState?.contextBalloonNo ?? 1;
  
  // C1: ログ出力（デバッグ用）
  if (sceneFromModal) {
    console.log(`[ChatEdit] Using scene ${sceneFromModal} from SceneEditModal`);
  }

  // Reset state with context SSOT + AI toggle
  window.chatEditState = {
    buildId,
    projectId: PROJECT_ID,
    videoUrl: videoUrl || null,
    patchRequestId: null,
    dryRunResult: null,
    // Phase C: 文脈SSOT
    contextSceneIdx,
    contextBalloonNo,
    // Phase C: AI parse toggle (default ON)
    useAiParse: window.chatEditState?.useAiParse ?? true,
    // C3: Explain初期化
    explain: null,
  };

  // Update header labels
  const buildLabel = document.getElementById('chatEditBuildLabel');
  const projectLabel = document.getElementById('chatEditProjectLabel');
  if (buildLabel) buildLabel.textContent = buildId ? `Build #${buildId}` : 'Pre-build';
  if (projectLabel) projectLabel.textContent = `Project #${PROJECT_ID}`;

  // Phase C: Populate context selectors
  populateChatContextSelectors();
  setChatContext(contextSceneIdx, contextBalloonNo);
  
  // Phase C: Bind AI toggle
  bindAiToggle();

  // Set video source
  const videoSrc = document.getElementById('chatEditVideoSrc');
  const video = document.getElementById('chatEditVideo');
  if (videoSrc && videoUrl) {
    videoSrc.src = videoUrl;
    video.load();
  }
  
  // SSOT: Playback Context 同期をバインド（動画再生位置 → 現在シーン）
  setTimeout(() => {
    bindPlaybackContextSync();
  }, 200);

  // Reset history
  const history = document.getElementById('chatEditHistory');
  if (history) history.innerHTML = '';

  // Hide dry-run box
  const dryBox = document.getElementById('chatEditDryRunBox');
  if (dryBox) dryBox.classList.add('hidden');
  
  // C3: Hide and reset Explain box
  const explainBox = document.getElementById('chatEditExplainBox');
  if (explainBox) explainBox.classList.add('hidden');
  const explainContent = document.getElementById('chatEditExplainContent');
  if (explainContent) explainContent.innerHTML = '';

  // Clear input
  const input = document.getElementById('chatEditInput');
  if (input) input.value = '';
  
  // Hide parse mode indicator initially
  const modeLabel = document.getElementById('chatEditParseMode');
  if (modeLabel) modeLabel.classList.add('hidden');

  // Show modal
  modal.classList.remove('hidden');
  document.body.classList.add('overflow-hidden');

  // Focus input after animation
  setTimeout(() => input?.focus(), 100);
}

// Backward compatibility alias
function openChatEditPanel(buildId, videoUrl) {
  openChatEditModal(buildId, videoUrl);
}

/**
 * Close the chat edit modal
 */
function closeChatEditModal() {
  const modal = document.getElementById('chatEditModal');
  if (!modal) return;
  
  // 動画を停止
  const video = document.getElementById('chatEditVideo');
  if (video) {
    video.pause();
    video.currentTime = 0;
  }
  
  // 音声・BGMを停止
  if (typeof stopAllAudioPreviews === 'function') {
    stopAllAudioPreviews();
  }
  
  // 状態をリセット
  if (window.chatEditState) {
    window.chatEditState.pendingSuggestion = null;
    window.chatEditState.dryRunResult = null;
    window.chatEditState.patchRequestId = null;
  }
  
  modal.classList.add('hidden');
  document.body.classList.remove('overflow-hidden');
  
  console.log('[ChatEdit] Modal closed, all audio/video stopped');
}

// Backward compatibility alias
function closeChatEditPanel() {
  closeChatEditModal();
}

/**
 * Parse user message to intent (simple pattern matching for v0)
 * @param {string} message 
 * @returns {Object|null} Intent object or null if parsing failed
 */
function parseMessageToIntent(message) {
  const actions = [];
  const errors = [];
  
  // Normalize message
  const normalizedMsg = message.toLowerCase()
    .replace(/シーン/g, 'scene')
    .replace(/バブル/g, 'balloon')
    .replace(/ふきだし/g, 'balloon')
    .replace(/吹き出し/g, 'balloon')
    .replace(/音量/g, 'volume')
    .replace(/％/g, '%');
  
  // Pattern: BGM volume (e.g., "BGM音量を20%に", "BGMを30%に")
  const bgmVolumeMatch = message.match(/bgm.*?(\d+)\s*%/i) || message.match(/(\d+)\s*%.*?bgm/i);
  if (bgmVolumeMatch) {
    const volume = parseInt(bgmVolumeMatch[1]) / 100;
    if (volume >= 0 && volume <= 1) {
      actions.push({
        action: 'bgm.set_volume',
        volume: volume,
      });
    } else {
      errors.push(`BGM音量は0-100%の範囲で指定してください（入力: ${bgmVolumeMatch[1]}%）`);
    }
  }
  
  // Pattern: BGM loop (e.g., "BGMをループにして", "BGMループオフ")
  if (/bgm.*?ループ(?:オン|on|する|にして)/i.test(message)) {
    actions.push({ action: 'bgm.set_loop', loop: true });
  } else if (/bgm.*?ループ(?:オフ|off|しない|解除)/i.test(message)) {
    actions.push({ action: 'bgm.set_loop', loop: false });
  }
  
  // Pattern: SFX volume (e.g., "シーン2のSFX1の音量を50%に")
  const sfxVolumeMatches = message.matchAll(/(?:scene|シーン)\s*(\d+).*?(?:sfx|効果音)\s*(\d+).*?(?:volume|音量).*?(\d+)\s*%/gi);
  for (const match of sfxVolumeMatches) {
    const sceneIdx = parseInt(match[1]);
    const cueNo = parseInt(match[2]);
    const volume = parseInt(match[3]) / 100;
    if (volume >= 0 && volume <= 1) {
      actions.push({
        action: 'sfx.set_volume',
        scene_idx: sceneIdx,
        cue_no: cueNo,
        volume: volume,
      });
    }
  }
  
  // Pattern: Balloon timing adjustment (e.g., "シーン2のバブル1を+300ms")
  const balloonTimingMatches = message.matchAll(/(?:scene|シーン)\s*(\d+).*?(?:balloon|バブル)\s*(\d+).*?([+-]?\d+)\s*ms/gi);
  for (const match of balloonTimingMatches) {
    const sceneIdx = parseInt(match[1]);
    const balloonNo = parseInt(match[2]);
    const deltaMs = parseInt(match[3]);
    
    // Determine if it's start or end timing
    if (/開始|start|早|遅/.test(message)) {
      actions.push({
        action: 'balloon.adjust_window',
        scene_idx: sceneIdx,
        balloon_no: balloonNo,
        delta_start_ms: deltaMs,
      });
    } else {
      // Default to adjusting both start and end (move entire window)
      actions.push({
        action: 'balloon.adjust_window',
        scene_idx: sceneIdx,
        balloon_no: balloonNo,
        delta_start_ms: deltaMs,
        delta_end_ms: deltaMs,
      });
    }
  }
  
  // Pattern: Simple balloon timing with "遅らせる" or "早める"
  const balloonDelayMatch = message.match(/(?:scene|シーン)\s*(\d+).*?(?:balloon|バブル)\s*(\d+).*?(\d+)\s*(?:ms|ミリ秒)?.*?(?:遅|おそ|delay)/i);
  if (balloonDelayMatch && !message.includes('+') && !message.includes('-')) {
    actions.push({
      action: 'balloon.adjust_window',
      scene_idx: parseInt(balloonDelayMatch[1]),
      balloon_no: parseInt(balloonDelayMatch[2]),
      delta_start_ms: parseInt(balloonDelayMatch[3]),
      delta_end_ms: parseInt(balloonDelayMatch[3]),
    });
  }
  
  const balloonEarlyMatch = message.match(/(?:scene|シーン)\s*(\d+).*?(?:balloon|バブル)\s*(\d+).*?(\d+)\s*(?:ms|ミリ秒)?.*?(?:早|はや|early)/i);
  if (balloonEarlyMatch && !message.includes('+') && !message.includes('-')) {
    actions.push({
      action: 'balloon.adjust_window',
      scene_idx: parseInt(balloonEarlyMatch[1]),
      balloon_no: parseInt(balloonEarlyMatch[2]),
      delta_start_ms: -parseInt(balloonEarlyMatch[3]),
      delta_end_ms: -parseInt(balloonEarlyMatch[3]),
    });
  }
  
  // ★ Pattern: Balloon display policy (e.g., "シーン2のバブル1を出しっぱなしにして")
  const balloonPolicyMatch = message.match(/(?:scene|シーン)\s*(\d+).*?(?:balloon|バブル)\s*(\d+).*?(出しっぱなし|常時表示|always.?on|喋って(?:る|い)?時(?:だけ)?|voice.?window|手動|manual)/i);
  if (balloonPolicyMatch) {
    const sceneIdx = parseInt(balloonPolicyMatch[1], 10);
    const balloonNo = parseInt(balloonPolicyMatch[2], 10);
    const modeWord = balloonPolicyMatch[3].toLowerCase();
    
    let policy = 'voice_window';
    if (modeWord.includes('出しっぱなし') || modeWord.includes('常時') || modeWord.includes('always')) {
      policy = 'always_on';
    } else if (modeWord.includes('手動') || modeWord.includes('manual')) {
      policy = 'manual_window';
    }
    
    const policyAction = {
      action: 'balloon.set_policy',
      scene_idx: sceneIdx,
      balloon_no: balloonNo,
      policy: policy,
    };
    
    // manual_window の場合、開始/終了を拾う（存在すれば）
    if (policy === 'manual_window') {
      // パターン1: 「開始Xms 終了Yms」形式
      const msStartMatch = message.match(/開始\s*(\d+)\s*ms/i);
      const msEndMatch = message.match(/終了\s*(\d+)\s*ms/i);
      
      // パターン2: 「X秒目からY秒目」「X秒からY秒まで」「X秒〜Y秒」形式 (C2: 秒数指定)
      const secRangeMatch = message.match(/(\d+(?:\.\d+)?)\s*秒[目]?\s*(?:から|〜|～|-|−|ー)\s*(\d+(?:\.\d+)?)\s*秒/i);
      
      // パターン3: 「X.X秒からY.Y秒まで」形式（小数対応）
      const secRangeMatch2 = message.match(/(\d+(?:\.\d+)?)\s*(?:秒目?(?:から)?|s)\s*(?:〜|～|-|−|ー|から)\s*(\d+(?:\.\d+)?)\s*(?:秒目?(?:まで)?|s)/i);
      
      if (msStartMatch && msEndMatch) {
        policyAction.start_ms = parseInt(msStartMatch[1], 10);
        policyAction.end_ms = parseInt(msEndMatch[1], 10);
      } else if (secRangeMatch) {
        // 秒をミリ秒に変換
        policyAction.start_ms = Math.round(parseFloat(secRangeMatch[1]) * 1000);
        policyAction.end_ms = Math.round(parseFloat(secRangeMatch[2]) * 1000);
      } else if (secRangeMatch2) {
        // 秒をミリ秒に変換
        policyAction.start_ms = Math.round(parseFloat(secRangeMatch2[1]) * 1000);
        policyAction.end_ms = Math.round(parseFloat(secRangeMatch2[2]) * 1000);
      }
    }
    
    actions.push(policyAction);
  }
  
  // Pattern: Change all balloons to a policy (e.g., "全部出しっぱなし", "すべて喋ってる時だけ")
  // Note: This will require frontend to fetch all balloon_nos and create multiple actions
  // For now, we just warn that this is not supported in single-action mode
  
  // ========================================
  // C2: 秒数指定バルーン表示パターン
  // 「シーン1のバブル1を3秒から5秒まで表示」「シーン1のバブル1を3秒目〜5秒目に表示」
  // ========================================
  const secBalloonMatch = message.match(
    /(?:scene|シーン)\s*(\d+).*?(?:balloon|バブル)\s*(\d+).*?(\d+(?:\.\d+)?)\s*秒[目]?\s*(?:から|〜|～|-|−|ー)\s*(\d+(?:\.\d+)?)\s*秒[目]?\s*(?:まで|に|で)?.*?(?:表示|出)/i
  );
  if (secBalloonMatch && !balloonPolicyMatch) {
    const sceneIdx = parseInt(secBalloonMatch[1], 10);
    const balloonNo = parseInt(secBalloonMatch[2], 10);
    const startSec = parseFloat(secBalloonMatch[3]);
    const endSec = parseFloat(secBalloonMatch[4]);
    
    actions.push({
      action: 'balloon.set_policy',
      scene_idx: sceneIdx,
      balloon_no: balloonNo,
      policy: 'manual_window',
      start_ms: Math.round(startSec * 1000),
      end_ms: Math.round(endSec * 1000),
    });
  }
  
  // ========================================
  // PR-5-3b: テロップコマンドのパース
  // ========================================
  
  // Pattern: シーン単位テロップON/OFF (e.g., "シーン1のテロップをOFF", "シーン2のテロップを消して")
  const sceneTelopMatch = message.match(/シーン\s*(\d+)\s*の?\s*テロップ.*?(?:off|オフ|非表示|消す|消して)/i);
  const sceneTelopOnMatch = message.match(/シーン\s*(\d+)\s*の?\s*テロップ.*?(?:on|オン|表示|出す|出して)/i);
  
  // Pattern: 「このシーン/ここの」テロップON/OFF (PlaybackContextのscene_idxを使用)
  const thisSceneTelopOffMatch = /(?:この|今の|現在の|ここの)\s*(?:シーン)?\s*の?\s*テロップ.*?(?:off|オフ|非表示|消す|消して|けして)/i.test(message);
  const thisSceneTelopOnMatch = /(?:この|今の|現在の|ここの)\s*(?:シーン)?\s*の?\s*テロップ.*?(?:on|オン|表示|出す|出して)/i.test(message);
  
  if (sceneTelopMatch) {
    const sceneIdx = parseInt(sceneTelopMatch[1], 10);
    actions.push({ action: 'telop.set_enabled_scene', scene_idx: sceneIdx, enabled: false });
  } else if (sceneTelopOnMatch) {
    const sceneIdx = parseInt(sceneTelopOnMatch[1], 10);
    actions.push({ action: 'telop.set_enabled_scene', scene_idx: sceneIdx, enabled: true });
  }
  // Pattern: 「このシーン」のテロップON/OFF - scene_idxはnullで、normalizeIntentで補完
  else if (thisSceneTelopOffMatch) {
    // scene_idx: null → normalizeIntent で PlaybackContext から補完
    actions.push({ action: 'telop.set_enabled_scene', scene_idx: null, enabled: false, _contextual: true });
  } else if (thisSceneTelopOnMatch) {
    actions.push({ action: 'telop.set_enabled_scene', scene_idx: null, enabled: true, _contextual: true });
  }
  // Pattern: テロップON/OFF 全体 (e.g., "テロップを全部ON", "テロップを全部OFF", "テロップをOFFに")
  // 「全部」「全て」「すべて」が明示的にある場合のみ全体扱い
  else if (/テロップ.*?(?:全部|全て|すべて|ぜんぶ).*?(?:off|オフ|非表示|消す|消して)/i.test(message)) {
    actions.push({ action: 'telop.set_enabled', enabled: false });
  } else if (/テロップ.*?(?:全部|全て|すべて|ぜんぶ).*?(?:on|オン|表示|出す|出して)/i.test(message)) {
    actions.push({ action: 'telop.set_enabled', enabled: true });
  }
  // Pattern: 単純な「テロップ消して」はコンテキストがあればシーン単位、なければ全体
  else if (/テロップ.*?(?:off|オフ|非表示|消す|消して|けして)/i.test(message)) {
    // コンテキスト依存: normalizeIntent で判定
    actions.push({ action: 'telop.set_enabled_scene', scene_idx: null, enabled: false, _contextual: true });
  } else if (/テロップ.*?(?:on|オン|表示|出す|出して)/i.test(message)) {
    actions.push({ action: 'telop.set_enabled_scene', scene_idx: null, enabled: true, _contextual: true });
  }
  
  // Pattern: テロップ位置 (e.g., "テロップ位置を上に", "テロップを下に", "テロップ中央")
  if (/テロップ.*?(?:位置)?.*?(?:上|top|トップ)/i.test(message)) {
    actions.push({ action: 'telop.set_position', position_preset: 'top' });
  } else if (/テロップ.*?(?:位置)?.*?(?:中央|center|センター|真ん中)/i.test(message)) {
    actions.push({ action: 'telop.set_position', position_preset: 'center' });
  } else if (/テロップ.*?(?:位置)?.*?(?:下|bottom|ボトム)/i.test(message)) {
    actions.push({ action: 'telop.set_position', position_preset: 'bottom' });
  }
  
  // Pattern: テロップサイズ (e.g., "テロップサイズを大に", "テロップを小さく")
  if (/テロップ.*?(?:サイズ)?.*?(?:大|large|lg|大きく)/i.test(message)) {
    actions.push({ action: 'telop.set_size', size_preset: 'lg' });
  } else if (/テロップ.*?(?:サイズ)?.*?(?:中|medium|md)/i.test(message)) {
    actions.push({ action: 'telop.set_size', size_preset: 'md' });
  } else if (/テロップ.*?(?:サイズ)?.*?(?:小|small|sm|小さく)/i.test(message)) {
    actions.push({ action: 'telop.set_size', size_preset: 'sm' });
  }
  
  // Phase 2-1 + A-3: モーション変更パターン（全プリセット対応）
  {
    const motionPresetMap = {
      'なし|止め|停止|静止|none': 'none',
      // ズーム系
      'ゆっくりズーム|kenburns.*?soft|ケンバーンズ.*?ソフト': 'kenburns_soft',
      '強め.*?ズーム|kenburns.*?strong|ケンバーンズ.*?ストロング|大きくズーム': 'kenburns_strong',
      'ズームアウト|zoom.*?out|引き|引く': 'kenburns_zoom_out',
      // パン系
      '左.*?右.*?パン|pan.*?lr|左から右': 'pan_lr',
      '右.*?左.*?パン|pan.*?rl|右から左': 'pan_rl',
      '上.*?下.*?パン|pan.*?tb|上から下': 'pan_tb',
      '下.*?上.*?パン|pan.*?bt|下から上': 'pan_bt',
      // スライド系
      '左.*?右.*?スライド|slide.*?lr|スライド.*?左.*?右': 'slide_lr',
      '右.*?左.*?スライド|slide.*?rl|スライド.*?右.*?左': 'slide_rl',
      '上.*?下.*?スライド|slide.*?tb|スライド.*?上.*?下': 'slide_tb',
      '下.*?上.*?スライド|slide.*?bt|スライド.*?下.*?上': 'slide_bt',
      // 静止→スライド系
      '静止.*?右|hold.*?slide.*?lr|止まって.*?右|静止→右': 'hold_then_slide_lr',
      '静止.*?左|hold.*?slide.*?rl|止まって.*?左|静止→左': 'hold_then_slide_rl',
      '静止.*?下.*?スライド|hold.*?slide.*?tb|静止→下': 'hold_then_slide_tb',
      '静止.*?上.*?スライド|hold.*?slide.*?bt|静止→上': 'hold_then_slide_bt',
      // 複合系
      'ズーム.*?右.*?パン|combined.*?lr|ズーム＋右|zoom.*?pan.*?lr': 'combined_zoom_pan_lr',
      'ズーム.*?左.*?パン|combined.*?rl|ズーム＋左|zoom.*?pan.*?rl': 'combined_zoom_pan_rl',
      // 自動
      '自動|ランダム|auto|おまかせ|シード': 'auto',
    };
    
    // シーン番号の取得
    const motionSceneMatch = message.match(/(?:シーン|scene)\s*(\d+)/i);
    const motionSceneIdx = motionSceneMatch ? parseInt(motionSceneMatch[1]) : null;
    
    for (const [patterns, presetId] of Object.entries(motionPresetMap)) {
      const regex = new RegExp(`(?:モーション|動き|カメラ|motion).*?(?:${patterns})`, 'i');
      const regex2 = new RegExp(`(?:${patterns}).*?(?:モーション|動き|カメラ|パン|ズーム|スライド|にして|にする)`, 'i');
      if (regex.test(message) || regex2.test(message)) {
        // Phase B-3: 「全シーン」「全部」等が含まれていれば bulk アクション
        const isBulk = /全シーン|全部|全て|すべて|一括|全.{0,3}シーン/i.test(message);
        if (isBulk) {
          actions.push({
            action: 'motion.set_preset_bulk',
            preset_id: presetId,
          });
        } else {
          actions.push({
            action: 'motion.set_preset',
            scene_idx: motionSceneIdx,
            preset_id: presetId,
            _contextual: !motionSceneIdx,
          });
        }
        break;
      }
    }
  }
  
  // Phase A3: エラーUX改善 - より具体的なエラーメッセージ
  if (actions.length === 0 && errors.length === 0) {
    // 入力内容に基づいて具体的なヒントを提供
    let hint = '';
    
    // バブル関連の入力があるがシーン/バブル番号がない場合
    if (/バブル|ふきだし|吹き出し|balloon/i.test(message) && !/シーン\s*\d|scene\s*\d/i.test(message)) {
      hint = '💡 シーン番号を追加してください。例: 「シーン1のバブル1を〜」';
    }
    // SFX関連の入力があるがシーン番号がない場合
    else if (/sfx|効果音/i.test(message) && !/シーン\s*\d|scene\s*\d/i.test(message)) {
      hint = '💡 シーン番号を追加してください。例: 「シーン1のSFX1の音量を50%に」';
    }
    // 数値はあるがコマンドが不明な場合
    else if (/\d+/.test(message)) {
      hint = '💡 対象を明示してください: BGM/バブル/SFX/テロップ';
    }
    // 一般的なヒント
    else {
      hint = '💡 テンプレボタンをクリックすると正しい形式が入力されます';
    }
    
    return {
      ok: false,
      error: `修正指示を解析できませんでした。\n\n${hint}\n\n📝 認識できる形式:\n• BGM: 「BGM音量を20%に」「BGMをOFFにして」\n• バブル: 「シーン1のバブル1を喋る時だけ表示にして」\n• バブル秒数指定: 「シーン1のバブル1を3秒から5秒まで表示」\n• SFX: 「シーン1のSFX1の音量を50%に」\n• テロップ: 「テロップを全部OFF」「シーン1のテロップをOFF」「テロップ位置を上に」`,
    };
  }
  
  if (errors.length > 0) {
    return {
      ok: false,
      error: errors.join('\n'),
    };
  }
  
  return {
    ok: true,
    intent: {
      schema: 'rilarc_intent_v1',
      actions,
    },
  };
}

/**
 * Phase C: AI Intent Parse API call
 * C3: rejected_actions も返す
 */
async function parseIntentWithAI(userMessage) {
  const payload = {
    user_message: userMessage,
    context: {
      scene_idx: window.chatEditState?.contextSceneIdx || 1,
      balloon_no: window.chatEditState?.contextBalloonNo || 1,
    },
  };
  const res = await axios.post(`${API_BASE}/projects/${PROJECT_ID}/chat-edits/parse-ai`, payload);
  if (!res.data?.ok) {
    throw new Error(res.data?.error || 'AI parse failed');
  }
  // C3: intent + rejected_actions を返す
  return {
    intent: res.data.intent,
    rejected_actions: res.data.rejected_actions || [],
  };
}

// ====================================================================
// STEP④: Chat Mode 判定システム（SSOT設計書準拠）
// ====================================================================

/**
 * シーン単位のアクション一覧（scene_idx 自動補完対象）
 */
const SCENE_LEVEL_ACTIONS = [
  'telop.set_enabled_scene',
  'balloon.adjust_window',
  'balloon.adjust_position',
  'balloon.set_policy',
  'sfx.set_volume',
  'sfx.set_timing',
  'sfx.remove',
  'sfx.add_from_library',
  'motion.set_preset',
  'image.set_active',
];

/**
 * アクションが「明確」かを判定
 * - 明確 = 即編集可能（Mode C）
 * - 不明確 = 提案が必要（Mode B）
 */
function isActionExplicit(action, playbackContext) {
  // scene_idx が明示 or playbackContext から取得可能
  const hasSceneIdx = action.scene_idx != null || playbackContext?.scene_idx != null;
  
  switch (action.action) {
    // BGM関連（グローバルなのでscene不要）
    case 'bgm.set_volume':
      return typeof action.volume === 'number' && action.volume >= 0 && action.volume <= 1;
    case 'bgm.set_loop':
      return typeof action.loop === 'boolean';
    
    // テロップ関連（グローバル）
    case 'telop.set_enabled':
      return typeof action.enabled === 'boolean';
    case 'telop.set_position':
      return ['top', 'center', 'bottom'].includes(action.position_preset);
    case 'telop.set_size':
      return ['sm', 'md', 'lg'].includes(action.size_preset);
    
    // テロップ関連（シーン単位）
    case 'telop.set_enabled_scene':
      return hasSceneIdx && typeof action.enabled === 'boolean';
    
    // バルーン関連
    case 'balloon.set_policy':
      return hasSceneIdx && 
             action.balloon_no != null && 
             ['always_on', 'voice_window', 'manual_window'].includes(action.policy);
    case 'balloon.adjust_window':
      return hasSceneIdx && 
             action.balloon_no != null && 
             (action.delta_start_ms != null || action.delta_end_ms != null || 
              action.absolute_start_ms != null || action.absolute_end_ms != null);
    case 'balloon.adjust_position':
      return hasSceneIdx && 
             action.balloon_no != null && 
             (action.delta_x != null || action.delta_y != null || 
              action.absolute_x != null || action.absolute_y != null);
    
    // SFX関連
    case 'sfx.set_volume':
      return hasSceneIdx && 
             action.cue_no != null && 
             typeof action.volume === 'number';
    case 'sfx.set_timing':
      return hasSceneIdx && action.cue_no != null;
    case 'sfx.remove':
      return hasSceneIdx && action.cue_no != null;
    
    // 未実装アクション（将来用）
    case 'motion.set_preset':
      return hasSceneIdx && action.preset != null;
    case 'image.set_active':
      return hasSceneIdx && action.image_generation_id != null;
    
    default:
      return false;
  }
}

/**
 * Intent を正規化（scene_idx 自動補完）
 * 
 * SSOT: 
 * - _contextual フラグがあるアクションは PlaybackContext から scene_idx を補完
 * - scene_idx が null でシーン単位アクションの場合も補完
 * - 補完後は _contextual フラグを削除
 */
function normalizeIntent(intent, playbackContext) {
  if (!intent || !intent.actions) return intent;
  
  const normalizedActions = intent.actions.map(action => {
    const needsSceneIdx = action.scene_idx == null && SCENE_LEVEL_ACTIONS.includes(action.action);
    const isContextual = action._contextual === true;
    
    // scene_idx 補完が必要な場合
    if ((needsSceneIdx || isContextual) && playbackContext?.scene_idx != null) {
      const normalized = { ...action, scene_idx: playbackContext.scene_idx };
      delete normalized._contextual; // 内部フラグを削除
      console.log('[ChatEdit] normalizeIntent: scene_idx補完', { 
        action: action.action, 
        from: action.scene_idx, 
        to: playbackContext.scene_idx 
      });
      return normalized;
    }
    
    // _contextual だが PlaybackContext がない場合は警告
    if (isContextual && playbackContext?.scene_idx == null) {
      console.warn('[ChatEdit] normalizeIntent: PlaybackContextなしでコンテキスト依存アクション', action);
      // フォールバック: scene_idx = 1（最初のシーン）
      const normalized = { ...action, scene_idx: 1 };
      delete normalized._contextual;
      return normalized;
    }
    
    return action;
  });
  
  return {
    ...intent,
    actions: normalizedActions
  };
}

/**
 * SSOT: バックエンドエラーをユーザーフレンドリーなメッセージに変換
 */
function convertToUserFriendlyError(errorMsg) {
  if (!errorMsg) return '不明なエラーが発生しました';
  
  // Scene not found
  const sceneMatch = errorMsg.match(/Scene not found: scene_idx=(\d+)/);
  if (sceneMatch) {
    return `シーン${sceneMatch[1]}が見つかりません。シーン番号を確認してください。`;
  }
  
  // Balloon not found
  const balloonMatch = errorMsg.match(/Balloon not found: scene_idx=(\d+), balloon_no=(\d+)/);
  if (balloonMatch) {
    return `シーン${balloonMatch[1]}にバブル${balloonMatch[2]}が見つかりません。バブル番号を確認してください。`;
  }
  
  // SFX not found
  const sfxMatch = errorMsg.match(/SFX cue not found: scene_idx=(\d+), cue_no=(\d+)/);
  if (sfxMatch) {
    return `シーン${sfxMatch[1]}に効果音${sfxMatch[2]}が見つかりません。`;
  }
  
  // ops array is empty
  if (errorMsg.includes('ops array is empty') || errorMsg.includes('No actions in intent')) {
    return '指示を理解できませんでした。より具体的に教えてください。\n例: 「BGMを50%に」「テロップをOFF」';
  }
  
  // Invalid scene_idx
  if (errorMsg.includes('Invalid scene_idx')) {
    return 'シーン番号が正しくありません。1以上の数値を指定してください。';
  }
  
  // Invalid intent schema
  if (errorMsg.includes('Invalid intent schema')) {
    return '指示の形式が正しくありません。もう一度お試しください。';
  }
  
  // Default
  return errorMsg;
}

/**
 * Chat Mode 判定（SSOTの中核）
 * 
 * Mode A: Conversation - 会話のみ（actions空）
 * Mode B: Suggestion - 提案カード表示（曖昧な指示）
 * Mode C: Direct Edit - dry-run直行（明確な指示）
 * 
 * @param {Object} input
 * @param {string} input.userMessage - ユーザー入力
 * @param {Object|null} input.intent - 解析されたIntent
 * @param {Object|null} input.playbackContext - 再生中シーン情報
 * @returns {Object} { mode: 'A'|'B'|'C', reason: string, normalizedIntent: Object|null }
 */
function decideChatMode({ userMessage, intent, playbackContext }) {
  // Rule 1: actions が空 → 必ず Mode A
  if (!intent || !intent.actions || intent.actions.length === 0) {
    return {
      mode: 'A',
      reason: 'No actions in intent',
      normalizedIntent: null
    };
  }
  
  // Intent を正規化（scene_idx 補完）
  const normalized = normalizeIntent(intent, playbackContext);
  
  // Rule 2: 全アクションが「明確」かチェック
  const allActionsExplicit = normalized.actions.every(action => 
    isActionExplicit(action, playbackContext)
  );
  
  if (allActionsExplicit) {
    // Mode C: Direct Edit
    return {
      mode: 'C',
      reason: 'All actions are explicit',
      normalizedIntent: normalized
    };
  } else {
    // Mode B: Suggestion
    return {
      mode: 'B',
      reason: 'Actions contain ambiguous elements',
      normalizedIntent: normalized
    };
  }
}

/**
 * Playback Context を同期（動画再生位置からシーンを特定）
 */
function syncPlaybackContext() {
  const video = document.getElementById('chatEditVideo');
  if (!video) return;
  
  const currentTimeMs = video.currentTime * 1000;
  const scenes = window.lastLoadedScenes || 
                 window.videoBuildListCacheScenes || 
                 window.builderScenesCache || [];
  
  if (scenes.length === 0) return;
  
  let accTime = 0;
  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    const duration = scene.duration_ms || 5000;
    
    if (currentTimeMs < accTime + duration) {
      // 現在のシーンを特定
      window.chatEditState = window.chatEditState || {};
      window.chatEditState.playbackContext = {
        scene_idx: i + 1,
        scene_id: scene.id,
        playback_time_ms: currentTimeMs,
        scene_snapshot: {
          has_image: !!(scene.image_url || scene.images?.length),
          has_audio: !!(scene.utterances?.length || scene.audio_url),
          telop_enabled: scene.telop_enabled !== false,
          balloon_count: scene.balloons?.length || 0,
          sfx_count: scene.audio_cues?.length || 0,
        }
      };
      
      // UI更新（コンテキスト表示）
      updatePlaybackContextDisplay();
      return;
    }
    accTime += duration;
  }
  
  // 最後のシーンを超えた場合、最後のシーンを設定
  const lastScene = scenes[scenes.length - 1];
  window.chatEditState = window.chatEditState || {};
  window.chatEditState.playbackContext = {
    scene_idx: scenes.length,
    scene_id: lastScene.id,
    playback_time_ms: currentTimeMs,
    scene_snapshot: {
      has_image: !!(lastScene.image_url || lastScene.images?.length),
      has_audio: !!(lastScene.utterances?.length || lastScene.audio_url),
      telop_enabled: lastScene.telop_enabled !== false,
      balloon_count: lastScene.balloons?.length || 0,
      sfx_count: lastScene.audio_cues?.length || 0,
    }
  };
  updatePlaybackContextDisplay();
}

/**
 * Playback Context のUI表示更新
 */
function updatePlaybackContextDisplay() {
  const ctx = window.chatEditState?.playbackContext;
  if (!ctx) return;
  
  // コンテキストセレクタを更新（存在する場合）
  const sceneSelect = document.getElementById('chatEditContextScene');
  if (sceneSelect && sceneSelect.value != ctx.scene_idx) {
    sceneSelect.value = ctx.scene_idx;
  }
  
  // シーン情報バッジを更新
  const badge = document.getElementById('chatEditSceneBadge');
  if (badge) {
    const snapshot = ctx.scene_snapshot;
    const icons = [];
    if (snapshot.has_image) icons.push('🖼️');
    if (snapshot.has_audio) icons.push('🔊');
    if (snapshot.telop_enabled) icons.push('📝');
    if (snapshot.balloon_count > 0) icons.push(`💬×${snapshot.balloon_count}`);
    if (snapshot.sfx_count > 0) icons.push(`🎵×${snapshot.sfx_count}`);
    
    badge.innerHTML = `
      <span class="text-xs font-medium text-purple-700">シーン${ctx.scene_idx}</span>
      <span class="text-xs text-gray-500 ml-1">${icons.join(' ')}</span>
    `;
  }
}

/**
 * 動画プレイヤーに Playback Context 同期をバインド
 */
function bindPlaybackContextSync() {
  const video = document.getElementById('chatEditVideo');
  if (!video) return;
  
  // 既存のリスナーを削除（二重バインド防止）
  video.removeEventListener('timeupdate', syncPlaybackContext);
  video.removeEventListener('seeked', syncPlaybackContext);
  video.removeEventListener('play', syncPlaybackContext);
  
  // 新規バインド
  video.addEventListener('timeupdate', syncPlaybackContext);
  video.addEventListener('seeked', syncPlaybackContext);
  video.addEventListener('play', syncPlaybackContext);
  
  // 初回同期
  syncPlaybackContext();
}

// グローバル公開
window.decideChatMode = decideChatMode;
window.syncPlaybackContext = syncPlaybackContext;
window.bindPlaybackContextSync = bindPlaybackContextSync;

// ====================================================================
// End of Chat Mode 判定システム
// ====================================================================

/**
 * 会話SSOT: ChatGPT体験 - 3層構造
 * 1. Conversation: 常に自然文で返答
 * 2. Suggestion: 必要時のみ編集提案を追加
 * 3. Execution: ユーザー確認後にdry-run/apply
 */
async function sendChatEditMessage() {
  const input = document.getElementById('chatEditInput');
  const sendBtn = document.getElementById('btnChatEditSend');
  const history = document.getElementById('chatEditHistory');
  const modeLabel = document.getElementById('chatEditParseMode');
  
  if (!input || !sendBtn || !history) return;
  
  const message = input.value.trim();
  if (!message) return;
  
  // 二重送信ガード
  if (window.chatEditSendInFlight) {
    console.log('[ChatEdit] Send already in flight');
    return;
  }
  window.chatEditSendInFlight = true;
  
  // Disable input
  input.disabled = true;
  sendBtn.disabled = true;
  
  // Add user message to history
  history.innerHTML += `
    <div class="flex justify-end mb-2">
      <div class="bg-purple-600 text-white rounded-lg px-3 py-2 max-w-[80%]">
        <p class="text-sm">${escapeHtml(message)}</p>
      </div>
    </div>
  `;
  history.scrollTop = history.scrollHeight;
  
  // 会話履歴の管理（最大10往復 = 20メッセージ）
  window.chatEditConversation = window.chatEditConversation || [];
  window.chatEditConversation.push({ role: 'user', content: message });
  if (window.chatEditConversation.length > 20) {
    window.chatEditConversation = window.chatEditConversation.slice(-20);
  }
  
  // ====================================================================
  // SSOT: Playback Context を取得（現在再生中のシーン）
  // ====================================================================
  const playbackContext = window.chatEditState?.playbackContext || null;
  
  // デバッグログ
  console.log('[ChatEdit] PlaybackContext:', playbackContext);
  
  // ====================================================================
  // Step 1: ルールベース解析を試行
  // ====================================================================
  const parsed = parseMessageToIntent(message);
  let intent = null;
  let parseMode = null;
  let assistantMessage = null;
  let suggestionSummary = null;
  let rejectedActions = [];
  
  if (parsed.ok && parsed.intent?.actions?.length > 0) {
    intent = parsed.intent;
    parseMode = 'regex';
  }
  
  // ====================================================================
  // Step 2: ルール解析失敗 → AI会話APIを使用
  // ====================================================================
  if (!intent && window.chatEditState?.useAiParse) {
    const thinkingId = `thinking-${Date.now()}`;
    history.innerHTML += `
      <div id="${thinkingId}" class="flex justify-start mb-2">
        <div class="bg-purple-50 rounded-lg px-3 py-2 border border-purple-200">
          <p class="text-sm text-purple-600">
            <i class="fas fa-magic fa-spin mr-1"></i>考え中...
          </p>
        </div>
      </div>
    `;
    history.scrollTop = history.scrollHeight;
    
    try {
      // Playback Context を含む強化版 context を構築
      const chatPayload = {
        user_message: message,
        context: {
          scene_idx: playbackContext?.scene_idx || window.chatEditState?.contextSceneIdx || 1,
          balloon_no: window.chatEditState?.contextBalloonNo || 1,
          video_build_id: window.chatEditState?.buildId || null,
          // SSOT: 現在シーンの詳細情報を追加
          current_scene: playbackContext?.scene_snapshot || null,
          total_scenes: (window.lastLoadedScenes || []).length || null,
          playback_time_ms: playbackContext?.playback_time_ms || null,
        },
        history: window.chatEditConversation.slice(0, -1),
      };
      
      const chatResponse = await axios.post(`${API_BASE}/projects/${PROJECT_ID}/chat-edits/chat`, chatPayload);
      
      // Remove thinking message
      const thinkingEl = document.getElementById(thinkingId);
      if (thinkingEl) thinkingEl.remove();
      
      if (chatResponse.data.ok) {
        assistantMessage = chatResponse.data.assistant_message;
        const suggestion = chatResponse.data.suggestion;
        
        if (suggestion?.intent?.actions?.length > 0) {
          intent = suggestion.intent;
          suggestionSummary = suggestion.summary;
          rejectedActions = suggestion.rejected_actions || [];
        }
        parseMode = 'ai';
        
        // 会話履歴に追加
        window.chatEditConversation.push({ role: 'assistant', content: assistantMessage });
        if (window.chatEditConversation.length > 20) {
          window.chatEditConversation = window.chatEditConversation.slice(-20);
        }
      } else {
        // API failed
        history.innerHTML += `
          <div class="bg-red-50 rounded-lg p-3 border border-red-200 mb-2">
            <p class="text-sm text-red-700">
              <i class="fas fa-exclamation-circle mr-1"></i>
              ${escapeHtml(chatResponse.data.error || '応答に失敗しました')}
            </p>
          </div>
        `;
        input.value = '';
        input.disabled = false;
        sendBtn.disabled = false;
        window.chatEditSendInFlight = false;
        input.focus();
        return;
      }
      
    } catch (error) {
      const thinkingEl = document.getElementById(thinkingId);
      if (thinkingEl) thinkingEl.remove();
      
      console.error('[ChatEdit] Chat API error:', error);
      const errorMsg = extractErrorMessage(error, '会話に失敗しました');
      
      history.innerHTML += `
        <div class="bg-red-50 rounded-lg p-3 border border-red-200 mb-2">
          <p class="text-sm text-red-700">
            <i class="fas fa-exclamation-triangle mr-1"></i>
            ${escapeHtml(errorMsg)}
          </p>
        </div>
      `;
      input.value = '';
      input.disabled = false;
      sendBtn.disabled = false;
      window.chatEditSendInFlight = false;
      input.focus();
      return;
    }
  }
  
  // ====================================================================
  // Step 3: SSOT Mode 判定（A / B / C）
  // ====================================================================
  const modeDecision = decideChatMode({ userMessage: message, intent, playbackContext });
  
  console.log('[ChatEdit] Mode Decision:', modeDecision);
  
  // Explain 保存（デバッグ用）
  window.chatEditState.explain = {
    mode: parseMode || 'none',
    userMessage: message,
    intent: modeDecision.normalizedIntent,
    rejectedActions,
    context: {
      sceneIdx: playbackContext?.scene_idx || 1,
      balloonNo: window.chatEditState?.contextBalloonNo || 1,
    },
    modeDecision: modeDecision.mode,
    modeReason: modeDecision.reason,
  };
  
  // Mode ラベル更新
  if (modeLabel) {
    const modeLabels = {
      'A': { text: '会話', class: 'bg-gray-100 text-gray-600' },
      'B': { text: '提案', class: 'bg-amber-100 text-amber-700' },
      'C': { text: '即編集', class: 'bg-green-100 text-green-700' },
    };
    const labelConfig = modeLabels[modeDecision.mode] || modeLabels['A'];
    modeLabel.textContent = `${parseMode === 'ai' ? 'AI' : 'ルール'}→${labelConfig.text}`;
    modeLabel.className = `text-[10px] px-1.5 py-0.5 rounded ${labelConfig.class}`;
    modeLabel.classList.remove('hidden');
  }
  
  // ====================================================================
  // Step 4: Mode に応じた処理
  // ====================================================================
  
  // --- Mode A: 会話のみ ---
  if (modeDecision.mode === 'A') {
    // AI会話メッセージがあれば表示
    if (assistantMessage) {
      history.innerHTML += `
        <div class="flex justify-start mb-2">
          <div class="bg-gray-100 rounded-lg px-3 py-2 max-w-[80%]">
            <p class="text-sm text-gray-800">${escapeHtml(assistantMessage)}</p>
          </div>
        </div>
      `;
    } else {
      // ルールベースもAIも使わなかった場合
      history.innerHTML += `
        <div class="flex justify-start mb-2">
          <div class="bg-blue-50 rounded-lg px-3 py-2 border border-blue-200 max-w-[80%]">
            <p class="text-sm text-blue-800">
              <i class="fas fa-info-circle mr-1"></i>
              修正指示として認識できませんでした。
            </p>
            <p class="text-xs text-blue-600 mt-1">
              「BGMを20%に」「テロップをOFF」などの具体的な指示をお試しください。
            </p>
          </div>
        </div>
      `;
    }
    
    input.value = '';
    input.disabled = false;
    sendBtn.disabled = false;
    window.chatEditSendInFlight = false;
    input.focus();
    history.scrollTop = history.scrollHeight;
    return;
  }
  
  // --- Mode B: 提案カード表示 ---
  if (modeDecision.mode === 'B') {
    // AI会話メッセージを先に表示
    if (assistantMessage) {
      history.innerHTML += `
        <div class="flex justify-start mb-2">
          <div class="bg-gray-100 rounded-lg px-3 py-2 max-w-[80%]">
            <p class="text-sm text-gray-800">${escapeHtml(assistantMessage)}</p>
          </div>
        </div>
      `;
    }
    
    // 提案カードを表示
    const suggestionId = `suggestion-${Date.now()}`;
    const actionCount = modeDecision.normalizedIntent?.actions?.length || 0;
    const summary = suggestionSummary || `${actionCount}件の編集`;
    
    // Phase 3-A: telop アクションから scope を検出
    const telopActions = (modeDecision.normalizedIntent?.actions || []).filter(a => 
      a.action?.startsWith('telop.')
    );
    let scopeHtml = '';
    if (telopActions.length > 0) {
      const hasComic = telopActions.some(a => a.scope === 'comic');
      const hasBoth = telopActions.some(a => a.scope === 'both');
      
      if (hasBoth) {
        scopeHtml = `
          <div class="bg-amber-100 text-amber-800 border border-amber-300 rounded-lg p-2 mb-3 text-xs font-medium flex items-center gap-2">
            <i class="fas fa-crosshairs"></i>
            適用先：両方（まるっとムービー字幕＋漫画焼き込み）
            <span class="text-amber-600">※漫画は再生成が必要</span>
          </div>
        `;
      } else if (hasComic) {
        scopeHtml = `
          <div class="bg-orange-100 text-orange-800 border border-orange-300 rounded-lg p-2 mb-3 text-xs font-medium flex items-center gap-2">
            <i class="fas fa-crosshairs"></i>
            適用先：漫画焼き込み
            <span class="text-orange-600">※再生成が必要</span>
          </div>
        `;
      } else {
        // デフォルト: remotion
        scopeHtml = `
          <div class="bg-blue-100 text-blue-800 border border-blue-300 rounded-lg p-2 mb-3 text-xs font-medium flex items-center gap-2">
            <i class="fas fa-crosshairs"></i>
            適用先：まるっとムービー字幕（即時反映）
          </div>
        `;
      }
    }
    
    history.innerHTML += `
      <div id="${suggestionId}" class="bg-gradient-to-r from-amber-50 to-yellow-50 rounded-lg p-4 border border-amber-200 mb-2 shadow-sm">
        <div class="flex items-center gap-2 mb-3">
          <span class="flex items-center justify-center w-8 h-8 bg-amber-100 rounded-full">
            <i class="fas fa-lightbulb text-amber-500"></i>
          </span>
          <div>
            <p class="text-sm font-medium text-amber-800">編集提案</p>
            <p class="text-xs text-amber-600">${actionCount}件の変更</p>
          </div>
        </div>
        <div class="bg-white rounded-md p-3 mb-3 border border-amber-100">
          <p class="text-sm text-gray-700 font-medium">${escapeHtml(summary)}</p>
        </div>
        ${scopeHtml}
        <p class="text-xs text-gray-500 mb-3">
          <i class="fas fa-shield-alt mr-1 text-green-500"></i>
          「確認する」を押すと変更内容を確認できます（まだ適用されません）
        </p>
        <div class="flex gap-2">
          <button onclick="confirmSuggestion('${suggestionId}')" class="flex-1 px-4 py-2 bg-green-500 text-white text-sm font-medium rounded-lg hover:bg-green-600 transition-colors">
            <i class="fas fa-search mr-1"></i>確認する
          </button>
          <button onclick="dismissSuggestion('${suggestionId}')" class="px-4 py-2 bg-gray-100 text-gray-600 text-sm rounded-lg hover:bg-gray-200 transition-colors">
            やめる
          </button>
        </div>
      </div>
    `;
    
    // 提案を state に保存
    window.chatEditState.pendingSuggestion = {
      id: suggestionId,
      intent: modeDecision.normalizedIntent,
      summary: summary,
    };
    
    // 自動スクロール
    setTimeout(() => {
      const suggestionEl = document.getElementById(suggestionId);
      if (suggestionEl) {
        suggestionEl.scrollIntoView({ behavior: 'smooth', block: 'end' });
      }
    }, 100);
    
    input.value = '';
    input.disabled = false;
    sendBtn.disabled = false;
    window.chatEditSendInFlight = false;
    input.focus();
    history.scrollTop = history.scrollHeight;
    return;
  }
  
  // --- Mode C: 直接 dry-run へ ---
  if (modeDecision.mode === 'C') {
    // 短い確認メッセージを表示（ルールベース時）
    if (parseMode === 'regex') {
      history.innerHTML += `
        <div class="flex justify-start mb-2">
          <div class="bg-green-50 rounded-lg px-3 py-2 border border-green-200 max-w-[80%]">
            <p class="text-sm text-green-700">
              <i class="fas fa-bolt mr-1"></i>
              変更を確認しています...
            </p>
          </div>
        </div>
      `;
    } else if (assistantMessage) {
      // AI会話メッセージがあれば表示
      history.innerHTML += `
        <div class="flex justify-start mb-2">
          <div class="bg-gray-100 rounded-lg px-3 py-2 max-w-[80%]">
            <p class="text-sm text-gray-800">${escapeHtml(assistantMessage)}</p>
          </div>
        </div>
      `;
    }
    
    // dry-run へ直行（提案カードなし）
    await processDryRunWithIntent(modeDecision.normalizedIntent, message, history, input, sendBtn);
    return;
  }
}

/**
 * 提案を確認してdry-runへ進む
 */
async function confirmSuggestion(suggestionId) {
  const suggestion = window.chatEditState?.pendingSuggestion;
  if (!suggestion || suggestion.id !== suggestionId) {
    showToast('提案が見つかりません', 'error');
    return;
  }
  
  const suggestionEl = document.getElementById(suggestionId);
  if (suggestionEl) {
    suggestionEl.innerHTML = `
      <div class="text-center py-2">
        <i class="fas fa-spinner fa-spin text-amber-600"></i>
        <span class="text-sm text-amber-700 ml-2">変更を確認中...</span>
      </div>
    `;
  }
  
  const history = document.getElementById('chatEditHistory');
  const input = document.getElementById('chatEditInput');
  const sendBtn = document.getElementById('btnChatEditSend');
  
  await processDryRunWithIntent(suggestion.intent, suggestion.summary, history, input, sendBtn);
  
  // 提案カードを削除
  if (suggestionEl) suggestionEl.remove();
  window.chatEditState.pendingSuggestion = null;
}

/**
 * 提案をキャンセル
 */
function dismissSuggestion(suggestionId) {
  const suggestionEl = document.getElementById(suggestionId);
  if (suggestionEl) suggestionEl.remove();
  window.chatEditState.pendingSuggestion = null;
  
  const history = document.getElementById('chatEditHistory');
  history.innerHTML += `
    <div class="flex justify-start mb-2">
      <div class="bg-gray-100 rounded-lg px-3 py-2">
        <p class="text-sm text-gray-600">
          <i class="fas fa-undo mr-1"></i>提案をキャンセルしました
        </p>
      </div>
    </div>
  `;
  history.scrollTop = history.scrollHeight;
}

/**
 * intentを使ってdry-run APIを呼び出す
 */
async function processDryRunWithIntent(intent, userMessage, history, input, sendBtn) {
  const thinkingId = `thinking-${Date.now()}`;
  history.innerHTML += `
    <div id="${thinkingId}" class="flex justify-start mb-2">
      <div class="bg-gray-100 rounded-lg px-3 py-2">
        <p class="text-sm text-gray-600">
          <i class="fas fa-spinner fa-spin mr-1"></i>
          変更内容を確認中...
        </p>
      </div>
    </div>
  `;
  history.scrollTop = history.scrollHeight;
  
  try {
    const payload = {
      user_message: userMessage,
      intent: intent,
    };
    if (window.chatEditState.buildId) {
      payload.video_build_id = window.chatEditState.buildId;
    }
    
    const response = await axios.post(`${API_BASE}/projects/${PROJECT_ID}/chat-edits/dry-run`, payload);
    
    // Remove thinking message
    const thinkingEl = document.getElementById(thinkingId);
    if (thinkingEl) thinkingEl.remove();
    
    if (response.data.ok) {
      window.chatEditState.patchRequestId = response.data.patch_request_id;
      window.chatEditState.dryRunResult = response.data;
      
      history.innerHTML += `
        <div class="bg-green-50 rounded-lg p-3 border border-green-200 mb-2">
          <p class="text-sm text-green-700">
            <i class="fas fa-check-circle mr-1"></i>
            ${response.data.resolved_ops}件の変更を検出しました
          </p>
        </div>
      `;
      
      showDryRunResult(response.data);
      
      input.value = '';
      input.disabled = false;
      sendBtn.disabled = false;
      input.focus();
      
    } else {
      let errorMsg = response.data.errors?.join(', ') || '変更を適用できません';
      
      // ユーザーフレンドリーなエラーメッセージに変換
      if (errorMsg.includes('ops array is empty')) {
        errorMsg = '指示を理解できませんでした。より具体的に教えてください。';
      }
      
      history.innerHTML += `
        <div class="bg-amber-50 rounded-lg p-3 border border-amber-200 mb-2">
          <p class="text-sm text-amber-700">
            <i class="fas fa-info-circle mr-1"></i>
            ${escapeHtml(errorMsg)}
          </p>
          <p class="text-xs text-gray-600 mt-2">
            💡 ヒント: 「BGMを50%に下げて」「シーン1のテロップをOFF」のように具体的に指示してください
          </p>
          ${response.data.warnings?.length ? `<p class="text-xs text-amber-600 mt-1">${response.data.warnings.join(', ')}</p>` : ''}
        </div>
      `;
      input.value = '';
      input.disabled = false;
      sendBtn.disabled = false;
      input.focus();
    }
    
  } catch (error) {
    const thinkingEl = document.getElementById(thinkingId);
    if (thinkingEl) thinkingEl.remove();
    
    console.error('[ChatEdit] Dry-run error:', error);
    let errorMsg = extractErrorMessage(error, '変更の確認に失敗しました');
    const statusCode = error.response?.status;
    
    // SSOT: ユーザーフレンドリーなエラーメッセージに変換
    errorMsg = convertToUserFriendlyError(errorMsg);
    const stageInfo = error.response?.data?.stage ? `(${error.response.data.stage})` : '';
    
    history.innerHTML += `
      <div class="bg-red-50 rounded-lg p-3 border border-red-200 mb-2">
        <p class="text-sm text-red-700">
          <i class="fas fa-exclamation-triangle mr-1"></i>
          ${escapeHtml(errorMsg)}
        </p>
        ${statusCode ? `<p class="text-xs text-red-400 mt-1">ステータス: ${statusCode} ${stageInfo}</p>` : ''}
      </div>
    `;
    input.value = '';
    input.disabled = false;
    sendBtn.disabled = false;
    input.focus();
  } finally {
    window.chatEditSendInFlight = false;
  }
  
  history.scrollTop = history.scrollHeight;
}

// グローバルに公開
window.confirmSuggestion = confirmSuggestion;
window.dismissSuggestion = dismissSuggestion;

/**
 * Show dry-run result in the modal (v1)
 * @param {Object} result 
 */
function showDryRunResult(result) {
  // v1 Modal elements
  const dryBox = document.getElementById('chatEditDryRunBox');
  const badge = document.getElementById('chatEditDryRunBadge');
  const changesEl = document.getElementById('chatEditDryRunChanges');
  const errorsEl = document.getElementById('chatEditDryRunErrors');
  const applyBtn = document.getElementById('btnChatEditApply');
  
  if (!dryBox || !changesEl) return;
  
  // Phase 3-A: 漫画再生成が必要かどうかを判定
  const hasComicRegeneration = result.comic_regeneration_required?.length > 0;
  const requiresConfirmation = result.requires_confirmation === true;
  
  // Update status badge
  if (result.ok) {
    badge.textContent = `${result.resolved_ops || 0}件の変更`;
    badge.className = 'text-xs px-2 py-1 rounded-full bg-green-100 text-green-700 font-medium';
    applyBtn.disabled = false;
    
    // Phase 3-A: 漫画再生成が必要な場合はボタン文言を変更
    if (hasComicRegeneration) {
      applyBtn.innerHTML = '<i class="fas fa-sync mr-1"></i>確認して適用（漫画は再生成）';
      applyBtn.className = applyBtn.className.replace('bg-green-500', 'bg-amber-500').replace('hover:bg-green-600', 'hover:bg-amber-600');
    } else {
      applyBtn.innerHTML = '<i class="fas fa-magic mr-1"></i>この変更を適用する';
    }
  } else {
    badge.textContent = '適用できません';
    badge.className = 'text-xs px-2 py-1 rounded-full bg-red-100 text-red-700';
    applyBtn.disabled = true;
    applyBtn.innerHTML = '<i class="fas fa-times mr-1"></i>適用できません';
  }
  
  // Render changes
  if (result.summary?.changes?.length > 0) {
    changesEl.innerHTML = result.summary.changes.map(change => `
      <div class="flex items-center gap-2 p-2 bg-white rounded-lg border border-gray-200">
        <span class="text-lg">
          ${change.type === 'balloon' ? '💬' : change.type === 'sfx' ? '🔊' : '🎵'}
        </span>
        <div class="flex-1 min-w-0">
          <p class="text-sm font-medium text-gray-800">${escapeHtml(change.target)}</p>
          <p class="text-xs text-gray-500">${escapeHtml(change.detail)}</p>
        </div>
      </div>
    `).join('');
  } else {
    changesEl.innerHTML = '<p class="text-sm text-gray-500">変更内容なし</p>';
  }
  
  // Show errors if any
  if (result.errors?.length > 0) {
    errorsEl.textContent = result.errors.join('\n');
    errorsEl.classList.remove('hidden');
  } else {
    errorsEl.classList.add('hidden');
  }
  
  // Phase 3-A: 適用先の表示（telopアクションの場合）
  if (result.telop_settings_override || hasComicRegeneration) {
    let scopeLabel = '';
    let scopeClass = '';
    
    if (hasComicRegeneration) {
      // 漫画再生成が必要な場合
      const comicItems = result.comic_regeneration_required;
      const hasComic = comicItems.some(i => i.scope === 'comic');
      const hasBoth = comicItems.some(i => i.scope === 'both');
      
      if (hasBoth) {
        scopeLabel = '適用先：両方（まるっとムービー字幕＋漫画焼き込み）';
        scopeClass = 'bg-amber-100 text-amber-800 border-amber-300';
      } else if (hasComic) {
        scopeLabel = '適用先：漫画焼き込み（再生成が必要）';
        scopeClass = 'bg-orange-100 text-orange-800 border-orange-300';
      }
    } else if (result.telop_settings_override) {
      // Remotion字幕のみ
      scopeLabel = '適用先：まるっとムービー字幕（即時反映）';
      scopeClass = 'bg-blue-100 text-blue-800 border-blue-300';
    }
    
    if (scopeLabel) {
      changesEl.innerHTML += `
        <div class="p-2 ${scopeClass} rounded-lg border text-xs font-medium flex items-center gap-2">
          <i class="fas fa-crosshairs"></i>
          ${scopeLabel}
        </div>
      `;
    }
  }
  
  // Show warnings if any
  if (result.warnings?.length > 0) {
    changesEl.innerHTML += `
      <div class="p-2 bg-amber-50 rounded-lg border border-amber-200 text-xs text-amber-700">
        <i class="fas fa-exclamation-triangle mr-1"></i>
        ${result.warnings.join('<br>')}
      </div>
    `;
  }
  
  dryBox.classList.remove('hidden');
  
  // C3: Render Explain block
  renderExplainBlock();
}

/**
 * C3: Render Explain block showing interpretation details
 */
function renderExplainBlock() {
  const explainBox = document.getElementById('chatEditExplainBox');
  const explainContent = document.getElementById('chatEditExplainContent');
  
  if (!explainBox || !explainContent) return;
  
  const explain = window.chatEditState?.explain;
  if (!explain) {
    explainBox.classList.add('hidden');
    return;
  }
  
  let html = '';
  
  // Mode indicator
  const modeLabel = explain.mode === 'ai' ? 
    '<span class="inline-flex items-center px-2 py-0.5 rounded bg-purple-100 text-purple-700 text-xs font-medium"><i class="fas fa-robot mr-1"></i>AI解釈</span>' :
    '<span class="inline-flex items-center px-2 py-0.5 rounded bg-blue-100 text-blue-700 text-xs font-medium"><i class="fas fa-code mr-1"></i>ルール解釈</span>';
  
  html += `<div class="mb-2">${modeLabel}</div>`;
  
  // User input
  if (explain.userMessage) {
    html += `
      <div class="mb-2">
        <p class="text-xs font-medium text-gray-500 mb-1">入力</p>
        <p class="text-sm text-gray-700 bg-white rounded p-2 border border-gray-200">${escapeHtml(explain.userMessage)}</p>
      </div>
    `;
  }
  
  // Context
  // C3: 後方互換（sceneIdx/balloonNo と scene_idx/balloon_no の両対応）
  if (explain.context) {
    const ctxScene = explain.context.sceneIdx ?? explain.context.scene_idx ?? '-';
    const ctxBalloon = explain.context.balloonNo ?? explain.context.balloon_no ?? '-';
    
    html += `
      <div class="mb-2">
        <p class="text-xs font-medium text-gray-500 mb-1">文脈</p>
        <p class="text-xs text-gray-600 bg-gray-50 rounded p-2">
          シーン: ${ctxScene}, バブル: ${ctxBalloon}
        </p>
      </div>
    `;
  }
  
  // Actions (intent)
  if (explain.intent?.actions?.length > 0) {
    html += `
      <div class="mb-2">
        <p class="text-xs font-medium text-gray-500 mb-1">解釈結果 (${explain.intent.actions.length}件)</p>
        <div class="space-y-1">
    `;
    
    explain.intent.actions.forEach((action, idx) => {
      const actionType = action.action || 'unknown';
      const emoji = actionType.startsWith('balloon') ? '💬' : 
                    actionType.startsWith('sfx') ? '🔊' : 
                    actionType.startsWith('bgm') ? '🎵' :
                    actionType.startsWith('telop') ? '📝' : '⚙️';
      
      // Format action params (exclude 'action' key)
      const params = Object.entries(action)
        .filter(([k]) => k !== 'action')
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        .join(', ');
      
      html += `
        <div class="text-xs bg-white rounded p-2 border border-gray-200">
          <span class="font-mono">${emoji} ${escapeHtml(actionType)}</span>
          ${params ? `<span class="text-gray-500 ml-1">(${escapeHtml(params)})</span>` : ''}
        </div>
      `;
    });
    
    html += `</div></div>`;
  }
  
  // Rejected actions (warning)
  if (explain.rejectedActions?.length > 0) {
    html += `
      <div class="mb-2">
        <p class="text-xs font-medium text-amber-600 mb-1">
          <i class="fas fa-exclamation-triangle mr-1"></i>除外されたアクション (${explain.rejectedActions.length}件)
        </p>
        <div class="space-y-1">
    `;
    
    explain.rejectedActions.forEach(action => {
      html += `
        <div class="text-xs bg-amber-50 rounded p-2 border border-amber-200 text-amber-700">
          <span class="font-mono">${escapeHtml(action.action || JSON.stringify(action))}</span>
        </div>
      `;
    });
    
    html += `</div></div>`;
  }
  
  // C3: Error display (AI parse failure)
  if (explain.error) {
    html += `
      <div class="mb-2">
        <p class="text-xs font-medium text-red-600 mb-1">
          <i class="fas fa-times-circle mr-1"></i>エラー
        </p>
        <div class="text-xs bg-red-50 rounded p-2 border border-red-200 text-red-700">
          ${escapeHtml(explain.error)}
        </div>
      </div>
    `;
  }
  
  explainContent.innerHTML = html;
  explainBox.classList.remove('hidden');
}

/**
 * C3: Copy Explain data to clipboard
 */
function copyExplainToClipboard() {
  const explain = window.chatEditState?.explain;
  if (!explain) {
    showToast('コピーするデータがありません', 'info');
    return;
  }
  
  const copyData = {
    mode: explain.mode,
    userMessage: explain.userMessage,
    context: explain.context,
    intent: explain.intent,
    rejectedActions: explain.rejectedActions,
    error: explain.error || null,
  };
  
  navigator.clipboard.writeText(JSON.stringify(copyData, null, 2))
    .then(() => showToast('クリップボードにコピーしました', 'success'))
    .catch(err => {
      console.error('Copy failed:', err);
      showToast('コピーに失敗しました', 'error');
    });
}

/**
 * C3: Toggle Explain block visibility
 */
function toggleExplainBlock() {
  const content = document.getElementById('chatEditExplainContent');
  const toggleIcon = document.getElementById('chatEditExplainToggle');
  
  if (!content || !toggleIcon) return;
  
  const isHidden = content.classList.contains('hidden');
  if (isHidden) {
    content.classList.remove('hidden');
    toggleIcon.classList.remove('fa-chevron-down');
    toggleIcon.classList.add('fa-chevron-up');
  } else {
    content.classList.add('hidden');
    toggleIcon.classList.remove('fa-chevron-up');
    toggleIcon.classList.add('fa-chevron-down');
  }
}

/**
 * Cancel dry-run and return to input mode (v1 Modal)
 */
function cancelChatEditDryRun() {
  // v1 Modal elements
  const dryBox = document.getElementById('chatEditDryRunBox');
  const input = document.getElementById('chatEditInput');
  const sendBtn = document.getElementById('btnChatEditSend');
  
  // Hide dry-run box
  if (dryBox) dryBox.classList.add('hidden');
  
  // Re-enable input
  if (input) {
    input.value = '';
    input.disabled = false;
    input.focus();
  }
  if (sendBtn) sendBtn.disabled = false;
  
  // Clear state
  window.chatEditState.patchRequestId = null;
  window.chatEditState.dryRunResult = null;
}

/**
 * Apply the chat edit (after successful dry-run)
 * PR-4-4: 二重送信ガード + extractErrorMessage統一
 */
async function applyChatEdit() {
  const applyBtn = document.getElementById('btnChatEditApply');
  const history = document.getElementById('chatEditHistory');
  
  if (!window.chatEditState.patchRequestId) {
    showToast('パッチIDが見つかりません', 'error');
    return;
  }
  
  // PR-4-4: 二重送信ガード
  if (window.chatEditApplyInFlight) {
    console.log('[ChatEdit] Apply already in flight');
    return;
  }
  window.chatEditApplyInFlight = true;
  
  applyBtn.disabled = true;
  applyBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>適用中...';
  
  try {
    const response = await axios.post(`${API_BASE}/projects/${PROJECT_ID}/chat-edits/apply`, {
      patch_request_id: window.chatEditState.patchRequestId,
    });
    
    if (response.data.ok) {
      // PR-Chat-Telop-Scope-AutoRebake: 自動rebake結果を表示
      let autoRebakeHtml = '';
      const autoRebake = response.data.auto_rebake;
      if (autoRebake) {
        if (autoRebake.requested) {
          autoRebakeHtml = `
            <p class="text-sm text-green-600 mt-1">
              <i class="fas fa-sync mr-1"></i>
              ${autoRebake.message}
            </p>
          `;
        } else if (autoRebake.cooldown_remaining_sec) {
          autoRebakeHtml = `
            <p class="text-sm text-amber-600 mt-1">
              <i class="fas fa-clock mr-1"></i>
              ${autoRebake.message}
            </p>
          `;
        } else if (autoRebake.error) {
          autoRebakeHtml = `
            <p class="text-sm text-red-600 mt-1">
              <i class="fas fa-exclamation-triangle mr-1"></i>
              ${autoRebake.message}
            </p>
          `;
        }
      }
      
      // Success - show message and close panel
      history.innerHTML += `
        <div class="bg-green-50 rounded-lg p-3 border border-green-200">
          <p class="text-sm text-green-700">
            <i class="fas fa-check-circle mr-1"></i>
            ${response.data.applied_count}件の変更を適用しました
          </p>
          ${response.data.new_video_build_id ? `
            <p class="text-sm text-green-600 mt-1">
              <i class="fas fa-video mr-1"></i>
              新しいビルド #${response.data.new_video_build_id} を作成しました
            </p>
          ` : ''}
          ${autoRebakeHtml}
        </div>
      `;
      
      showToast(response.data.next_action || '修正を適用しました', 'success');
      
      // PR-Chat-Telop-Scope-AutoRebake: rebake予約があった場合、キャッシュを無効化
      if (response.data.auto_rebake?.requested) {
        invalidateRebakeStatusCache();
      }
      
      // PR-4-2: 新ビルドIDを待ち受けスクロール用に設定
      if (response.data.new_video_build_id) {
        window.pendingScrollToBuildId = Number(response.data.new_video_build_id);
      }
      
      // Reload video builds list (will trigger scroll if newId is set)
      await loadVideoBuilds();
      
      // Reload patch history
      await loadPatchHistory();
      
      // Close modal after a short delay
      setTimeout(() => {
        closeChatEditModal();
      }, 1500);
      
    } else {
      throw new Error(response.data.errors?.join(', ') || '適用に失敗しました');
    }
    
  } catch (error) {
    console.error('[ChatEdit] Apply error:', error);
    // PR-4-4: エラー表示統一
    const errorMsg = extractErrorMessage(error, '修正の適用に失敗しました');
    
    history.innerHTML += `
      <div class="bg-red-50 rounded-lg p-3 border border-red-200">
        <p class="text-sm text-red-700">
          <i class="fas fa-times-circle mr-1"></i>
          ${escapeHtml(errorMsg)}
        </p>
      </div>
    `;
    
    applyBtn.disabled = false;
    applyBtn.innerHTML = '<i class="fas fa-check mr-1"></i>適用して新ビルド生成';
    
    showToast(errorMsg, 'error');
  } finally {
    // PR-4-4: 必ずフラグを戻す
    window.chatEditApplyInFlight = false;
  }
  
  history.scrollTop = history.scrollHeight;
}

/**
 * Handle Enter key in chat input
 * FIX1: Enter委譲のみ（clickはHTML onclick属性に任せる → 二重発火リスク解消）
 */
document.addEventListener('DOMContentLoaded', () => {
  // イベント委譲: document レベルでキャプチャし、chatEditInput のみ反応
  document.addEventListener('keydown', (e) => {
    const chatInput = document.getElementById('chatEditInput');
    // chatEditInput にフォーカスがある場合のみ処理
    if (e.target === chatInput && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChatEditMessage();
    }
  });
  // NOTE: 送信ボタンのclickはHTML側のonclick="sendChatEditMessage()"に任せる
  // click委譲は二重発火リスクがあるため削除済み
});

// ============================================
// Chat Edit Helper Functions
// ============================================

/**
 * Insert template text into chat input (Quick Actions)
 * PR-5-2: 追記モード対応（既存テキストがあれば改行して追加）
 * FIX4: chatEditState から文脈取得（window.currentXXX は使わない）
 * @param {string} text 
 */
function insertChatTemplate(text) {
  const input = document.getElementById('chatEditInput');
  if (!input) return;
  
  // FIX4: chatEditState から文脈を取得（SSOT）
  // フォールバックはシーン1/バブル1（明示的）
  const state = window.chatEditState || {};
  const currentScene = state.contextSceneIdx ?? 1;
  const currentBalloon = state.contextBalloonNo ?? 1;
  
  // プレースホルダを置換
  let resolvedText = text;
  resolvedText = resolvedText.replace(/\{scene\}/gi, String(currentScene));
  resolvedText = resolvedText.replace(/\{balloon\}/gi, String(currentBalloon));
  
  // 既存テキストがあれば追記、なければ上書き
  const existing = input.value.trim();
  if (existing) {
    input.value = existing + '\n' + resolvedText;
  } else {
    input.value = resolvedText;
  }
  
  // カーソルを末尾に移動
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  
  // テキストエリアの高さを自動調整（もしautoリサイズが必要な場合）
  if (input.scrollHeight > input.clientHeight) {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 150) + 'px';
  }
}

/**
 * Open pre-build chat (before video generation)
 * - No buildId/videoUrl since we're editing before generation
 */
function openPreBuildChat() {
  openChatEditModal(null, null);
  const buildLabel = document.getElementById('chatEditBuildLabel');
  const projectLabel = document.getElementById('chatEditProjectLabel');
  if (buildLabel) buildLabel.textContent = 'Pre-build';
  if (projectLabel) projectLabel.textContent = `Project #${PROJECT_ID}`;
  
  // Update modal title to indicate pre-build mode
  const titleEl = document.querySelector('#chatEditModal h2');
  if (titleEl) {
    titleEl.innerHTML = '<i class="fas fa-comments mr-2"></i>生成前に整える';
  }
}

/**
 * C1-3: Open chat edit modal from scene edit modal
 * - Automatically uses the current scene from SceneEditModal
 * - Finds the latest video build for that project
 */
async function openChatEditFromSceneModal() {
  const sceneIdx = window.SceneEditModal?.currentSceneIdx || 1;
  const sceneId = window.SceneEditModal?.currentSceneId;
  
  console.log(`[C1-3] Opening chat edit from scene modal: sceneIdx=${sceneIdx}, sceneId=${sceneId}`);
  
  // Close scene edit modal first
  const sceneModal = document.getElementById('scene-edit-modal');
  if (sceneModal) {
    sceneModal.classList.add('hidden');
    document.body.classList.remove('overflow-hidden');
  }
  
  // Try to find the latest video build
  let buildId = null;
  let videoUrl = null;
  
  try {
    const res = await axios.get(`${API_BASE}/projects/${PROJECT_ID}/video-builds?limit=1`);
    if (res.data?.builds?.length > 0) {
      const latestBuild = res.data.builds[0];
      buildId = latestBuild.id;
      videoUrl = latestBuild.download_url;
    }
  } catch (e) {
    console.warn('[C1-3] Could not fetch latest video build:', e);
  }
  
  // Open chat edit modal with scene context
  openChatEditModal(buildId, videoUrl, { sceneIdx, balloonNo: 1 });
  
  // Update modal title to indicate scene-specific mode
  const titleEl = document.querySelector('#chatEditModal h3');
  if (titleEl) {
    titleEl.innerHTML = '<i class="fas fa-comments mr-2"></i>チャットで修正';
  }
}

// Make chat edit functions globally available (v1 Modal)
window.openChatEditModal = openChatEditModal;
window.closeChatEditModal = closeChatEditModal;
window.openChatEditPanel = openChatEditPanel;   // Backward compatibility
window.closeChatEditPanel = closeChatEditPanel; // Backward compatibility
window.sendChatEditMessage = sendChatEditMessage;
window.cancelChatEditDryRun = cancelChatEditDryRun;
window.applyChatEdit = applyChatEdit;
window.insertChatTemplate = insertChatTemplate;
window.openPreBuildChat = openPreBuildChat;
window.openChatEditFromSceneModal = openChatEditFromSceneModal; // C1-3
window.copyExplainToClipboard = copyExplainToClipboard; // C3
window.toggleExplainBlock = toggleExplainBlock; // C3

// ===============================
// Safe Chat v1: Builder Wizard (preflight-based)
// ===============================

/**
 * Refresh the Builder Wizard UI based on preflight validation
 */
async function refreshBuilderWizard() {
  const stepsEl = document.getElementById('builderWizardSteps');
  const tipsEl = document.getElementById('builderWizardTips');
  if (!stepsEl || !tipsEl) return;

  stepsEl.innerHTML = '<div class="text-gray-400 text-sm p-2">読み込み中...</div>';
  tipsEl.textContent = '';

  try {
    const res = await axios.get(`${API_BASE}/projects/${PROJECT_ID}/video-builds/preflight`);
    const v = res.data.validation || {};

    // Extract validation data
    const errors = v.errors || [];
    const warnings = v.warnings || [];
    const hasBgm = v.has_bgm === true;
    const hasSfx = v.has_sfx === true;
    const hasVoice = v.summary?.has_voice === true;
    const canGenerate = res.data.can_generate === true;
    
    // Output preset and balloon policy summary
    const outputPreset = res.data.output_preset || {};
    const balloonSummary = res.data.balloon_policy_summary || {};

    // Build step cards
    const stepCards = [];

    // Step 1: 素材
    // Handle errors that could be objects or strings
    const firstError = errors[0];
    const errorMsg = typeof firstError === 'string' ? firstError 
                   : (firstError?.message || firstError?.reason || '素材が足りません');
    stepCards.push(renderWizardCard(
      '1) 素材（必須）',
      errors.length === 0 ? '✅ 準備OK' : '🔴 不足',
      errors.length === 0 ? '画像/漫画/動画が揃っています（不足があると動画生成できません）' : errorMsg,
      errors.length === 0 ? 'green' : 'red'
    ));

    // Step 2: 音（BGM/SFX/Voice）
    const audioLayers = [hasBgm && 'BGM', hasSfx && 'SFX', hasVoice && 'Voice'].filter(Boolean);
    stepCards.push(renderWizardCard(
      '2) 音（任意）',
      audioLayers.length ? '✅ 音あり' : '🟡 無音',
      audioLayers.length ? `音あり: ${audioLayers.join(' + ')}` : '音なしでも生成できます（無音動画になります）',
      audioLayers.length ? 'green' : 'amber'
    ));

    // Step 3: 表現（バブル/モーション）
    const balloonTotal = balloonSummary.total || 0;
    const balloonDesc = balloonTotal > 0
      ? `💬 バブル: 出しっぱなし ${balloonSummary.always_on || 0} / 喋る時 ${balloonSummary.voice_window || 0} / 手動 ${balloonSummary.manual_window || 0}`
      : 'バブル未設定（動画生成は可能）';
    stepCards.push(renderWizardCard(
      '3) バブル/表現（任意）',
      balloonTotal > 0 ? `💬 設定あり (${balloonTotal})` : '🟡 未設定',
      `${balloonDesc}（生成後に「修正（チャット）」で調整できます）`,
      'indigo'
    ));

    // Step 4: 生成
    stepCards.push(renderWizardCard(
      '4) 動画生成',
      canGenerate ? '🚀 可能' : '⛔ 不可',
      canGenerate ? 'Video Buildタブで「動画を生成」を実行できます' : '素材（必須）が不足しています',
      canGenerate ? 'purple' : 'gray'
    ));

    stepsEl.innerHTML = stepCards.join('');

    // Tips with output_preset info
    let tipsHtml = '';
    if (errors.length > 0) {
      tipsHtml = '<span class="text-red-600"><i class="fas fa-exclamation-circle mr-1"></i><b>必須:</b> 素材が不足しています。該当シーンの画像/漫画/動画を用意してください（ここが満たされないと動画生成できません）。</span>';
    } else if (!audioLayers.length) {
      tipsHtml = '<span class="text-amber-600"><i class="fas fa-lightbulb mr-1"></i><b>任意:</b> 音（BGM/SFX/Voice）が未設定なので無音動画になります。必要ならBGM/SFX/音声を追加してください。</span>';
    } else if (warnings.length > 0) {
      const firstWarn = warnings[0];
      const warnMsg = typeof firstWarn === 'string' ? firstWarn 
                    : (firstWarn?.message || firstWarn?.reason || '注意事項があります');
      tipsHtml = `<span class="text-amber-600"><i class="fas fa-info-circle mr-1"></i>${warnMsg}</span>`;
    } else {
      tipsHtml = '<span class="text-green-600"><i class="fas fa-check-circle mr-1"></i>素材が揃っています。Video Buildタブで動画生成できます（生成後は「修正（チャット）」で調整）。</span>';
    }
    
    // Output preset info line
    if (outputPreset.id) {
      const presetLabel = outputPreset.label || outputPreset.id;
      const aspectRatio = outputPreset.aspect_ratio || '';
      tipsHtml += `<div class="mt-1 text-xs text-gray-500">
        <i class="fas fa-info-circle mr-1"></i>参考: 出力プリセット（${escapeHtml(presetLabel)} / ${aspectRatio}）は Video Build で最終決定します
      </div>`;
    }
    
    tipsEl.innerHTML = tipsHtml;

  } catch (e) {
    console.warn('[Wizard] Preflight fetch failed:', e);
    stepsEl.innerHTML = '<div class="text-gray-500 text-sm p-2">プロジェクトが完了状態になると表示されます</div>';
    tipsEl.innerHTML = '';
  }
}

/**
 * Render a wizard step card
 */
function renderWizardCard(title, badge, desc, color) {
  const colorMap = {
    green: 'border-green-200 bg-green-50 text-green-800',
    red: 'border-red-200 bg-red-50 text-red-800',
    amber: 'border-amber-200 bg-amber-50 text-amber-800',
    indigo: 'border-indigo-200 bg-indigo-50 text-indigo-800',
    purple: 'border-purple-200 bg-purple-50 text-purple-800',
    gray: 'border-gray-200 bg-gray-50 text-gray-600',
  };
  const cls = colorMap[color] || colorMap.indigo;
  return `
    <div class="p-3 rounded-xl border ${cls}">
      <div class="flex items-center justify-between">
        <div class="font-semibold text-sm">${title}</div>
        <span class="text-xs px-2 py-0.5 rounded-full bg-white/60 border">${badge}</span>
      </div>
      <div class="mt-2 text-xs">${desc}</div>
    </div>
  `;
}

// Export wizard function
window.refreshBuilderWizard = refreshBuilderWizard;

// ========================================
// Output Preset Management
// ========================================

/**
 * Output preset definitions
 * Matches src/utils/output-presets.ts
 */
const OUTPUT_PRESETS = {
  yt_long: {
    id: 'yt_long',
    label: 'YouTube長尺',
    description: '16:9 横型、字幕下部、標準音圧',
    aspect_ratio: '16:9',
    orientation: 'landscape',
    safe_zones: { top: 0, bottom: 80, left: 0, right: 0 },
    text_scale: 1.0,
    motion_default: 'kenburns_soft',
    telop_style: 'bottom_bar',
    bgm_volume_default: 0.25
  },
  short_vertical: {
    id: 'short_vertical',
    label: '縦型ショート汎用',
    description: '9:16 縦型、Shorts/Reels/TikTok共通',
    aspect_ratio: '9:16',
    orientation: 'portrait',
    safe_zones: { top: 60, bottom: 160, left: 20, right: 20 },
    text_scale: 1.3,
    motion_default: 'kenburns_medium',
    telop_style: 'center_large',
    bgm_volume_default: 0.20
  },
  yt_shorts: {
    id: 'yt_shorts',
    label: 'YouTube Shorts',
    description: '9:16 縦型、YouTube UI最適化',
    aspect_ratio: '9:16',
    orientation: 'portrait',
    safe_zones: { top: 50, bottom: 140, left: 20, right: 60 },
    text_scale: 1.25,
    motion_default: 'kenburns_medium',
    telop_style: 'center_large',
    bgm_volume_default: 0.20
  },
  reels: {
    id: 'reels',
    label: 'Instagram Reels',
    description: '9:16 縦型、Instagram UI最適化',
    aspect_ratio: '9:16',
    orientation: 'portrait',
    safe_zones: { top: 80, bottom: 200, left: 20, right: 20 },
    text_scale: 1.3,
    motion_default: 'kenburns_medium',
    telop_style: 'center_large',
    bgm_volume_default: 0.18
  },
  tiktok: {
    id: 'tiktok',
    label: 'TikTok',
    description: '9:16 縦型、TikTok UI最適化',
    aspect_ratio: '9:16',
    orientation: 'portrait',
    safe_zones: { top: 100, bottom: 180, left: 20, right: 80 },
    text_scale: 1.35,
    motion_default: 'kenburns_medium',
    telop_style: 'top_small',
    bgm_volume_default: 0.18
  }
};

/**
 * Load output_preset from API and update selector
 */
async function loadOutputPreset() {
  try {
    const response = await axios.get(`${API_BASE}/projects/${PROJECT_ID}/output-preset`);
    const { output_preset } = response.data;
    
    const selector = document.getElementById('outputPresetSelector');
    if (selector && output_preset) {
      selector.value = output_preset;
      updateOutputPresetPreview(output_preset);
    }
  } catch (error) {
    console.error('Failed to load output preset:', error);
    // Default to yt_long if failed
    const selector = document.getElementById('outputPresetSelector');
    if (selector) {
      selector.value = 'yt_long';
      updateOutputPresetPreview('yt_long');
    }
  }
}

/**
 * P0-1: ナレーションデフォルトボイス設定
 */
function toggleNarrationVoicePanel() {
  const panel = document.getElementById('narrationVoicePanel');
  if (panel) {
    panel.classList.toggle('hidden');
  }
}
window.toggleNarrationVoicePanel = toggleNarrationVoicePanel;

async function loadNarrationVoiceSettings() {
  try {
    const res = await axios.get(`${API_BASE}/projects/${PROJECT_ID}/narration-voice`);
    const data = res.data;
    const voice = data.default_narration_voice;
    const statusEl = document.getElementById('narrationVoiceStatus');
    const selectEl = document.getElementById('narrationVoiceSelect');
    const currentEl = document.getElementById('narrationVoiceCurrent');
    
    if (voice && voice.voice_id) {
      const provider = voice.provider || 'google';
      const voiceId = voice.voice_id;
      const selectValue = `${provider}:${voiceId}`;
      
      if (statusEl) {
        statusEl.textContent = voiceId;
        statusEl.className = 'text-xs px-2 py-0.5 bg-green-100 text-green-700 rounded-full';
      }
      if (selectEl) selectEl.value = selectValue;
      if (currentEl) currentEl.textContent = `現在: ${voiceId}（${data.is_custom ? 'カスタム設定' : 'デフォルト'}）`;
    } else {
      if (statusEl) {
        statusEl.textContent = 'ja-JP-Neural2-B（デフォルト）';
        statusEl.className = 'text-xs px-2 py-0.5 bg-gray-100 text-gray-500 rounded-full';
      }
      if (currentEl) currentEl.textContent = '現在: ja-JP-Neural2-B（フォールバック）';
    }
  } catch (err) {
    console.warn('[loadNarrationVoiceSettings] Failed:', err.message);
  }
}

async function saveNarrationVoice() {
  const selectEl = document.getElementById('narrationVoiceSelect');
  if (!selectEl || !selectEl.value) {
    showToast('音声を選択してください', 'warning');
    return;
  }
  
  const [provider, voiceId] = selectEl.value.split(':');
  const btn = document.getElementById('narrationVoiceSaveBtn');
  if (btn) btn.disabled = true;
  
  try {
    await axios.put(`${API_BASE}/projects/${PROJECT_ID}/narration-voice`, {
      provider: provider,
      voice_id: voiceId
    });
    showToast('ナレーション音声を保存しました', 'success');
    await loadNarrationVoiceSettings();
    // パネルを閉じる
    const panel = document.getElementById('narrationVoicePanel');
    if (panel) panel.classList.add('hidden');
  } catch (err) {
    console.error('[saveNarrationVoice] Error:', err);
    showToast('保存に失敗しました: ' + (err.response?.data?.error?.message || err.message), 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}
window.saveNarrationVoice = saveNarrationVoice;

/**
 * Phase 1-1: 漫画の文字セクションを漫画モードシーンの有無で表示/非表示制御
 * プロジェクト内に display_asset_type === 'comic' のシーンが1つでもあれば表示、なければ非表示
 */
function updateComicTelopVisibility() {
  const section = document.getElementById('comicTelopSection');
  if (!section) return;
  
  const scenes = window.lastLoadedScenes || [];
  const hasComicScene = scenes.some(s => s.display_asset_type === 'comic');
  
  section.style.display = hasComicScene ? '' : 'none';
  console.log(`[Phase1-1] Comic telop section visibility: ${hasComicScene ? 'shown' : 'hidden'} (${scenes.filter(s => s.display_asset_type === 'comic').length}/${scenes.length} comic scenes)`);
}
window.updateComicTelopVisibility = updateComicTelopVisibility;

/**
 * Phase 2-1: Load comic telop settings from project.settings
 */
async function loadComicTelopSettings() {
  try {
    // Phase 1-1: 漫画モード判定で表示/非表示を更新
    updateComicTelopVisibility();
    
    // currentProject.settings は GET /api/projects/:id から返される
    const settings = currentProject?.settings || {};
    const telopComic = settings.telops_comic || {};
    
    // UI に反映（デフォルト値を使用）
    const styleSelect = document.getElementById('vbComicTelopStyle');
    const sizeSelect = document.getElementById('vbComicTelopSize');
    const positionSelect = document.getElementById('vbComicTelopPosition');
    
    if (styleSelect) styleSelect.value = telopComic.style_preset || 'outline';
    if (sizeSelect) sizeSelect.value = telopComic.size_preset || 'md';
    if (positionSelect) positionSelect.value = telopComic.position_preset || 'bottom';
    
    console.log('[ComicTelop] Phase2-1: Settings loaded:', telopComic);
  } catch (error) {
    console.error('[ComicTelop] Failed to load comic telop settings:', error);
  }
}
window.loadComicTelopSettings = loadComicTelopSettings;

/**
 * Phase 2-1: Save comic telop settings to project.settings_json
 */
async function saveComicTelopSettings() {
  try {
    const styleSelect = document.getElementById('vbComicTelopStyle');
    const sizeSelect = document.getElementById('vbComicTelopSize');
    const positionSelect = document.getElementById('vbComicTelopPosition');
    
    const payload = {
      style_preset: styleSelect?.value || 'outline',
      size_preset: sizeSelect?.value || 'md',
      position_preset: positionSelect?.value || 'bottom',
    };
    
    const response = await axios.put(`${API_BASE}/projects/${PROJECT_ID}/comic-telop-settings`, payload);
    
    if (response.data.success) {
      showToast('漫画の文字設定を保存しました。次回の漫画生成から反映されます。', 'success');
      console.log('[ComicTelop] Phase2-1: Settings saved:', response.data.telops_comic);
    }
  } catch (error) {
    console.error('[ComicTelop] Failed to save comic telop settings:', error);
    showToast('漫画の文字設定の保存に失敗しました', 'error');
  }
}
window.saveComicTelopSettings = saveComicTelopSettings;

// =============================================================================
// Phase B-2: 全シーン一括モーション適用
// =============================================================================

/**
 * Video Build UI のモーションプリセットを全シーンに一括適用
 * POST /api/projects/:id/motion/bulk を呼ぶ
 */
async function applyMotionToAllScenes() {
  const select = document.getElementById('vbMotionPreset');
  const btn = document.getElementById('vbMotionApplyAll');
  const status = document.getElementById('vbMotionApplyStatus');
  
  if (!select || !PROJECT_ID) return;
  
  const presetId = select.value || 'kenburns_soft';
  const presetLabel = select.options[select.selectedIndex]?.text || presetId;
  
  // 確認ダイアログ
  if (!confirm(`モーション「${presetLabel}」を全シーンに適用しますか？\n\n※ シーン個別に設定したモーションも上書きされます。`)) {
    return;
  }
  
  // ボタンを無効化
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>適用中...';
  }
  if (status) {
    status.classList.remove('hidden');
    status.textContent = '処理中...';
    status.className = 'text-xs text-gray-500';
  }
  
  try {
    const res = await axios.post(`${API_BASE}/projects/${PROJECT_ID}/motion/bulk`, {
      motion_preset_id: presetId,
    });
    
    const data = res.data;
    const msg = `${data.success_count}/${data.total_scenes}シーンに「${presetLabel}」を適用しました`;
    
    if (status) {
      status.textContent = msg;
      status.className = 'text-xs text-green-600';
    }
    showToast(msg, 'success');
    
    // ビルダーシーンカードを再描画（モーションバッジ更新のため）
    if (window.lastLoadedScenes) {
      // scene_motion の motion_preset_id を更新
      window.lastLoadedScenes.forEach(s => {
        s.motion_preset_id = presetId;
      });
      renderBuilderScenes(window.lastLoadedScenes, window.builderPagination?.currentPage || 1);
    }
    
    console.log(`[applyMotionToAllScenes] Success: ${data.success_count}/${data.total_scenes} scenes`);
  } catch (error) {
    console.error('[applyMotionToAllScenes] Error:', error);
    const errMsg = error.response?.data?.error?.message || '一括適用に失敗しました';
    if (status) {
      status.textContent = errMsg;
      status.className = 'text-xs text-red-600';
    }
    showToast(errMsg, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-layer-group mr-1"></i>全シーンに適用';
    }
  }
}
window.applyMotionToAllScenes = applyMotionToAllScenes;

// =============================================================================
// PR-Remotion-Telop-DefaultSave: Remotionテロップ設定の永続化
// =============================================================================

/**
 * Load Remotion telop settings from project.settings and apply to UI
 * Called from loadProject() when page loads
 */
async function loadRemotionTelopSettings() {
  try {
    const settings = currentProject?.settings || {};
    const telopsRemotion = settings.telops_remotion || {};
    
    console.log('[RemotionTelop] Loading saved settings:', telopsRemotion);
    
    // Apply preset settings
    const styleSelect = document.getElementById('vbTelopStylePreset');
    const sizeSelect = document.getElementById('vbTelopSizePreset');
    const positionSelect = document.getElementById('vbTelopPositionPreset');
    const enabledCheckbox = document.getElementById('vbTelopEnabled');
    
    if (styleSelect && telopsRemotion.style_preset) styleSelect.value = telopsRemotion.style_preset;
    if (sizeSelect && telopsRemotion.size_preset) sizeSelect.value = telopsRemotion.size_preset;
    if (positionSelect && telopsRemotion.position_preset) positionSelect.value = telopsRemotion.position_preset;
    if (enabledCheckbox && telopsRemotion.enabled !== undefined) enabledCheckbox.checked = telopsRemotion.enabled;
    
    // Apply custom_style (Vrew風カスタム)
    const customStyle = telopsRemotion.custom_style;
    if (customStyle) {
      const textColorPicker = document.getElementById('vbTelopTextColor');
      const textColorHex = document.getElementById('vbTelopTextColorHex');
      const strokeColorPicker = document.getElementById('vbTelopStrokeColor');
      const strokeColorHex = document.getElementById('vbTelopStrokeColorHex');
      const strokeWidthSlider = document.getElementById('vbTelopStrokeWidth');
      const strokeWidthValue = document.getElementById('vbTelopStrokeWidthValue');
      const bgColorPicker = document.getElementById('vbTelopBgColor');
      const bgColorHex = document.getElementById('vbTelopBgColorHex');
      const bgOpacitySlider = document.getElementById('vbTelopBgOpacity');
      const bgOpacityValue = document.getElementById('vbTelopBgOpacityValue');
      const fontSelect = document.getElementById('vbTelopFontFamily');
      const weightSelect = document.getElementById('vbTelopFontWeight');
      
      if (customStyle.text_color) {
        if (textColorPicker) textColorPicker.value = customStyle.text_color;
        if (textColorHex) textColorHex.value = customStyle.text_color;
      }
      if (customStyle.stroke_color) {
        if (strokeColorPicker) strokeColorPicker.value = customStyle.stroke_color;
        if (strokeColorHex) strokeColorHex.value = customStyle.stroke_color;
      }
      if (customStyle.stroke_width !== undefined) {
        if (strokeWidthSlider) strokeWidthSlider.value = customStyle.stroke_width;
        if (strokeWidthValue) strokeWidthValue.textContent = customStyle.stroke_width;
      }
      if (customStyle.bg_color) {
        if (bgColorPicker) bgColorPicker.value = customStyle.bg_color;
        if (bgColorHex) bgColorHex.value = customStyle.bg_color;
      }
      if (customStyle.bg_opacity !== undefined) {
        // bg_opacity is stored as 0-1, display as 0-100%
        const opacityPercent = Math.round(customStyle.bg_opacity * 100);
        if (bgOpacitySlider) bgOpacitySlider.value = opacityPercent;
        if (bgOpacityValue) bgOpacityValue.textContent = opacityPercent;
      }
      if (customStyle.font_family) {
        if (fontSelect) fontSelect.value = customStyle.font_family;
      }
      if (customStyle.font_weight) {
        if (weightSelect) weightSelect.value = customStyle.font_weight;
      }
    }
    
    // Apply typography settings
    const typography = telopsRemotion.typography;
    if (typography) {
      const maxLinesSelect = document.getElementById('vbTelopMaxLines');
      const lineHeightSlider = document.getElementById('vbTelopLineHeight');
      const lineHeightValue = document.getElementById('vbTelopLineHeightValue');
      const letterSpacingSlider = document.getElementById('vbTelopLetterSpacing');
      const letterSpacingValue = document.getElementById('vbTelopLetterSpacingValue');
      
      if (typography.max_lines !== undefined && maxLinesSelect) {
        maxLinesSelect.value = typography.max_lines;
      }
      if (typography.line_height !== undefined) {
        if (lineHeightSlider) lineHeightSlider.value = typography.line_height;
        if (lineHeightValue) lineHeightValue.textContent = typography.line_height;
      }
      if (typography.letter_spacing !== undefined) {
        if (letterSpacingSlider) letterSpacingSlider.value = typography.letter_spacing;
        if (letterSpacingValue) letterSpacingValue.textContent = typography.letter_spacing;
      }
    }
    
    console.log('[RemotionTelop] Settings applied to UI');
  } catch (error) {
    console.error('[RemotionTelop] Failed to load settings:', error);
  }
}
window.loadRemotionTelopSettings = loadRemotionTelopSettings;

/**
 * Save Remotion telop settings to project.settings_json.telops_remotion
 * Called when "Save default" checkbox is ON and video build starts
 */
async function saveRemotionTelopSettings() {
  try {
    // Gather current UI values
    const styleSelect = document.getElementById('vbTelopStylePreset');
    const sizeSelect = document.getElementById('vbTelopSizePreset');
    const positionSelect = document.getElementById('vbTelopPositionPreset');
    const enabledCheckbox = document.getElementById('vbTelopEnabled');
    
    const payload = {
      enabled: enabledCheckbox?.checked ?? true,
      style_preset: styleSelect?.value || 'outline',
      size_preset: sizeSelect?.value || 'md',
      position_preset: positionSelect?.value || 'bottom',
      custom_style: getTelopCustomStyle(),  // null if default
      typography: getTelopTypography(),      // null if default
    };
    
    const response = await axios.put(`${API_BASE}/projects/${PROJECT_ID}/telop-settings`, payload);
    
    if (response.data.success) {
      console.log('[RemotionTelop] DefaultSave: Settings saved:', response.data.telops_remotion);
      return true;
    }
    return false;
  } catch (error) {
    console.error('[RemotionTelop] Failed to save settings:', error);
    // Don't show toast here - let caller decide
    return false;
  }
}
window.saveRemotionTelopSettings = saveRemotionTelopSettings;

// =============================================================================
// PR-Comic-Rebake-All: 全シーン一括「再焼き込み」予約
// =============================================================================

/**
 * 一括再焼き込みモーダルを開く（Step1: 確認画面）
 */
async function openBulkRebakeModal() {
  const btn = document.getElementById('btnBulkRebakeComic');
  if (btn) btn.disabled = true;
  
  try {
    // ステータスを取得
    const statusRes = await axios.get(`${API_BASE}/projects/${PROJECT_ID}/comic/rebake-status`);
    const { project_telops_comic, scenes, summary } = statusRes.data;
    
    if (summary.total === 0) {
      showToast('対象の漫画シーンがありません。', 'warning');
      if (btn) btn.disabled = false;
      return;
    }
    
    // 既存のモーダルがあれば削除
    const existingModal = document.getElementById('bulkRebakeModal');
    if (existingModal) existingModal.remove();
    
    // モーダル作成
    const modal = document.createElement('div');
    modal.id = 'bulkRebakeModal';
    modal.className = 'fixed inset-0 bg-black/60 flex items-center justify-center z-[9999]';
    
    // ステータスバッジのHTML
    const statusBadges = `
      <div class="grid grid-cols-4 gap-2 text-center text-sm">
        <div class="p-2 bg-yellow-100 rounded">
          <div class="font-bold text-yellow-700">${summary.pending}</div>
          <div class="text-xs text-yellow-600">予約中 🟡</div>
        </div>
        <div class="p-2 bg-orange-100 rounded">
          <div class="font-bold text-orange-700">${summary.outdated}</div>
          <div class="text-xs text-orange-600">未反映 🟠</div>
        </div>
        <div class="p-2 bg-green-100 rounded">
          <div class="font-bold text-green-700">${summary.current}</div>
          <div class="text-xs text-green-600">最新 ✅</div>
        </div>
        <div class="p-2 bg-gray-100 rounded">
          <div class="font-bold text-gray-700">${summary.no_publish}</div>
          <div class="text-xs text-gray-600">未公開</div>
        </div>
      </div>
    `;
    
    // 現在の設定
    const currentStyle = project_telops_comic?.style_preset || 'outline';
    const currentSize = project_telops_comic?.size_preset || 'md';
    const currentPosition = project_telops_comic?.position_preset || 'bottom';
    const styleLabels = { outline: 'アウトライン', minimal: 'ミニマル', band: '帯付き', pop: 'ポップ', cinematic: 'シネマティック' };
    const sizeLabels = { sm: '小', md: '中', lg: '大' };
    const positionLabels = { bottom: '下', center: '中央', top: '上' };
    
    modal.innerHTML = `
      <div class="bg-white rounded-xl shadow-2xl max-w-md w-full mx-4 overflow-hidden">
        <!-- ヘッダー -->
        <div class="bg-amber-600 text-white px-6 py-4">
          <h3 class="text-lg font-bold flex items-center gap-2">
            <i class="fas fa-sync-alt"></i>全シーンに文字設定を反映予約
          </h3>
          <p class="text-amber-100 text-sm mt-1">漫画シーン ${summary.total}件が対象です</p>
        </div>
        
        <!-- ボディ -->
        <div class="p-6 space-y-4">
          <!-- 現在の設定 -->
          <div class="p-3 bg-gray-50 rounded-lg">
            <div class="text-sm font-semibold text-gray-700 mb-2">適用する設定:</div>
            <div class="flex gap-4 text-sm text-gray-600">
              <span><i class="fas fa-palette text-rose-500 mr-1"></i>${styleLabels[currentStyle] || currentStyle}</span>
              <span><i class="fas fa-text-height text-rose-500 mr-1"></i>${sizeLabels[currentSize] || currentSize}</span>
              <span><i class="fas fa-arrows-alt-v text-rose-500 mr-1"></i>${positionLabels[currentPosition] || currentPosition}</span>
            </div>
          </div>
          
          <!-- シーンステータス -->
          <div>
            <div class="text-sm font-semibold text-gray-700 mb-2">現在の状態:</div>
            ${statusBadges}
          </div>
          
          <!-- 注意書き -->
          <div class="p-3 bg-green-50 border border-green-200 rounded-lg">
            <div class="flex items-start gap-2">
              <i class="fas fa-shield-alt text-green-600 mt-0.5"></i>
              <div class="text-sm text-green-800">
                <strong>AI画像は変わりません</strong><br/>
                文字の見た目（スタイル・サイズ・位置）のみが変更されます。<br/>
                各シーンで「公開」すると新しい設定で再焼き込みされます。
              </div>
            </div>
          </div>
        </div>
        
        <!-- フッター -->
        <div class="bg-gray-50 px-6 py-4 flex gap-3 justify-end">
          <button onclick="closeBulkRebakeModal()" 
            class="px-4 py-2 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-100 transition-colors">
            キャンセル
          </button>
          <button onclick="executeBulkRebake()" id="btnExecuteBulkRebake"
            class="px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 transition-colors font-medium flex items-center gap-2">
            <i class="fas fa-check"></i>${summary.total}シーンに反映予約
          </button>
        </div>
      </div>
    `;
    
    document.body.appendChild(modal);
    
    // 背景クリックで閉じる
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeBulkRebakeModal();
    });
    
  } catch (error) {
    console.error('[BulkRebake] Failed to open modal:', error);
    showToast('ステータスの取得に失敗しました', 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}
window.openBulkRebakeModal = openBulkRebakeModal;

/**
 * 一括再焼き込みモーダルを閉じる
 */
function closeBulkRebakeModal() {
  const modal = document.getElementById('bulkRebakeModal');
  if (modal) modal.remove();
}
window.closeBulkRebakeModal = closeBulkRebakeModal;

/**
 * 一括再焼き込みを実行
 */
async function executeBulkRebake() {
  const execBtn = document.getElementById('btnExecuteBulkRebake');
  if (execBtn) {
    execBtn.disabled = true;
    execBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>処理中...';
  }
  
  try {
    const response = await axios.post(`${API_BASE}/projects/${PROJECT_ID}/comic/rebake`);
    
    if (response.data.success) {
      const count = response.data.affected_scenes;
      showToast(`${count}シーンに設定を反映予約しました`, 'success');
      console.log('[BulkRebake] Success:', response.data);
      closeBulkRebakeModal();
      
      // PR-Comic-Rebake-DiffBadge: キャッシュ無効化してバッジ再読み込み
      invalidateRebakeStatusCache();
      await refreshAllRebakeBadges();
    } else {
      throw new Error(response.data.error?.message || 'Unknown error');
    }
  } catch (error) {
    console.error('[BulkRebake] Failed:', error);
    const errorMsg = error.response?.data?.error?.message || error.message || '一括反映予約に失敗しました';
    showToast(errorMsg, 'error');
    
    if (execBtn) {
      execBtn.disabled = false;
      execBtn.innerHTML = '<i class="fas fa-check"></i>再試行';
    }
  }
}
window.executeBulkRebake = executeBulkRebake;

// =============================================================================
// PR-Comic-Rebake-DiffBadge: 差分検知バッジ共通関数
// SSOT: rebake-status API のみを参照、UIで判定ロジックを持たない
// =============================================================================

/**
 * rebake-status キャッシュ（30秒）
 */
let rebakeStatusCache = {
  data: null,
  timestamp: 0,
  TTL: 30000 // 30秒
};

/**
 * rebake-status を取得（キャッシュ付き）
 * @param {boolean} forceRefresh - trueならキャッシュを無視して再取得
 */
async function loadRebakeStatus(forceRefresh = false) {
  const now = Date.now();
  
  // キャッシュが有効かチェック
  if (!forceRefresh && rebakeStatusCache.data && (now - rebakeStatusCache.timestamp < rebakeStatusCache.TTL)) {
    return rebakeStatusCache.data;
  }
  
  try {
    const response = await axios.get(`${API_BASE}/projects/${PROJECT_ID}/comic/rebake-status`);
    rebakeStatusCache.data = response.data;
    rebakeStatusCache.timestamp = now;
    console.log('[RebakeBadge] Status loaded:', response.data.summary);
    return response.data;
  } catch (error) {
    console.error('[RebakeBadge] Failed to load status:', error);
    return null;
  }
}
window.loadRebakeStatus = loadRebakeStatus;

/**
 * キャッシュを無効化（操作後に呼ぶ）
 */
function invalidateRebakeStatusCache() {
  rebakeStatusCache.data = null;
  rebakeStatusCache.timestamp = 0;
  console.log('[RebakeBadge] Cache invalidated');
}
window.invalidateRebakeStatusCache = invalidateRebakeStatusCache;

/**
 * 指定シーンのrebakeステータスを取得
 * @param {number} sceneId
 * @param {object|null} statusData - 既にロード済みの場合は渡す
 */
async function getSceneRebakeStatus(sceneId, statusData = null) {
  const data = statusData || await loadRebakeStatus();
  if (!data || !data.scenes) return null;
  
  const sceneStatus = data.scenes.find(s => s.scene_id === sceneId);
  return sceneStatus || null;
}
window.getSceneRebakeStatus = getSceneRebakeStatus;

/**
 * rebakeステータスに応じたバッジHTMLを生成（SSOT: status値をそのまま表示）
 * @param {string} status - 'pending' | 'outdated' | 'current' | 'no_publish'
 * @param {string} size - 'sm' | 'md' (デフォルト: 'sm')
 */
function renderRebakeBadge(status, size = 'sm') {
  const badges = {
    pending: {
      icon: '🟡',
      label: '予約中',
      bgClass: 'bg-yellow-100',
      textClass: 'text-yellow-700',
      borderClass: 'border-yellow-300'
    },
    outdated: {
      icon: '🟠',
      label: '未反映',
      bgClass: 'bg-orange-100',
      textClass: 'text-orange-700',
      borderClass: 'border-orange-300'
    },
    current: {
      icon: '✅',
      label: '最新',
      bgClass: 'bg-green-100',
      textClass: 'text-green-700',
      borderClass: 'border-green-300'
    },
    no_publish: {
      icon: '⚪',
      label: '未公開',
      bgClass: 'bg-gray-100',
      textClass: 'text-gray-600',
      borderClass: 'border-gray-300'
    }
  };
  
  const badge = badges[status];
  if (!badge) return '';
  
  const sizeClasses = size === 'md' 
    ? 'px-2 py-1 text-xs' 
    : 'px-1.5 py-0.5 text-[10px]';
  
  return `
    <span class="inline-flex items-center gap-1 ${sizeClasses} ${badge.bgClass} ${badge.textClass} border ${badge.borderClass} rounded-full font-medium"
          title="漫画文字設定: ${badge.label}">
      <span>${badge.icon}</span>
      <span>${badge.label}</span>
    </span>
  `;
}
window.renderRebakeBadge = renderRebakeBadge;

/**
 * シーンIDに対応するバッジをDOMに挿入（Scene Split用）
 * @param {number} sceneId
 * @param {string} targetSelector - バッジを挿入する要素のセレクタ
 */
async function insertRebakeBadgeForScene(sceneId, targetSelector) {
  const target = document.querySelector(targetSelector);
  if (!target) return;
  
  const sceneStatus = await getSceneRebakeStatus(sceneId);
  if (!sceneStatus) {
    target.innerHTML = '';
    return;
  }
  
  target.innerHTML = renderRebakeBadge(sceneStatus.status, 'sm');
}
window.insertRebakeBadgeForScene = insertRebakeBadgeForScene;

/**
 * Scene Splitの全シーンにバッジを適用
 */
async function refreshAllRebakeBadges() {
  const statusData = await loadRebakeStatus(true); // 強制リフレッシュ
  if (!statusData || !statusData.scenes) return;
  
  for (const sceneStatus of statusData.scenes) {
    const badgeContainer = document.querySelector(`[data-rebake-badge="${sceneStatus.scene_id}"]`);
    if (badgeContainer) {
      badgeContainer.innerHTML = renderRebakeBadge(sceneStatus.status, 'sm');
    }
  }
  console.log('[RebakeBadge] All badges refreshed:', statusData.summary);
}
window.refreshAllRebakeBadges = refreshAllRebakeBadges;

/**
 * Save output_preset to API
 */
async function saveOutputPreset(presetId) {
  try {
    const response = await axios.put(`${API_BASE}/projects/${PROJECT_ID}/output-preset`, {
      output_preset: presetId
    });
    
    if (response.data.ok) {
      showToast(`配信先プリセットを「${OUTPUT_PRESETS[presetId]?.label || presetId}」に設定しました`, 'success');
      updateOutputPresetPreview(presetId);
      
      // Refresh preflight to show updated preset info
      refreshBuilderWizard();
    }
  } catch (error) {
    console.error('Failed to save output preset:', error);
    showToast('プリセットの保存に失敗しました', 'error');
  }
}

/**
 * Update output preset preview display
 */
function updateOutputPresetPreview(presetId) {
  const preset = OUTPUT_PRESETS[presetId];
  const previewContainer = document.getElementById('outputPresetPreview');
  const previewText = document.getElementById('outputPresetPreviewText');
  
  if (!previewContainer || !previewText || !preset) {
    if (previewContainer) previewContainer.classList.add('hidden');
    return;
  }
  
  const orientationLabel = preset.orientation === 'landscape' ? '横型' : '縦型';
  const details = [
    `画角: ${preset.aspect_ratio} (${orientationLabel})`,
    `字幕: ${preset.subtitle.position}`,
    `音圧: ${preset.audio.loudness_target}LUFS`
  ];
  
  previewText.textContent = details.join(' / ');
  previewContainer.classList.remove('hidden');
}

// ============================================================
// Phase1: Builder Scene Card UI Restructure
// トップは「結果確認」のみ。編集はモーダルに集約。
// ============================================================

/**
 * Phase1: セリフ概要（参照専用・短縮表示）
 * 画像モード: scene.dialogue
 * 漫画モード: comic_data.utterances を結合
 */
function renderDialogueSummary(scene) {
  const displayAssetType = scene.display_asset_type || 'image';
  const isComicMode = displayAssetType === 'comic';

  // 漫画モード: 発話を分割表示（合算しない）
  if (isComicMode) {
    const utterances =
      scene.comic_data?.published?.utterances ||
      scene.comic_data?.draft?.utterances ||
      [];
    
    if (utterances.length === 0) {
      return `
        <div>
          <label class="block text-sm font-semibold text-gray-700 mb-2">
            <i class="fas fa-comment-alt mr-1 text-orange-500"></i>発話（漫画）
          </label>
          <div class="p-3 bg-gray-50 rounded-lg border border-gray-200 text-sm">
            <span class="text-gray-400">発話なし</span>
          </div>
        </div>
      `;
    }
    
    // 最大3件を表示、それ以上は「…他n件」
    const maxDisplay = 3;
    const displayUtterances = utterances.slice(0, maxDisplay);
    const remaining = utterances.length - maxDisplay;
    
    const utteranceRows = displayUtterances.map((u, idx) => {
      const text = u.text || '';
      const truncated = text.length > 60 ? text.slice(0, 60) + '…' : text;
      return `
        <div class="flex items-start gap-2 py-1 ${idx > 0 ? 'border-t border-gray-100' : ''}">
          <span class="text-xs font-bold text-orange-600 whitespace-nowrap">発話${idx + 1}:</span>
          <span class="text-gray-800">${escapeHtml(truncated)}</span>
        </div>
      `;
    }).join('');
    
    const remainingText = remaining > 0 
      ? `<div class="text-xs text-gray-500 mt-1">…他 ${remaining}件</div>` 
      : '';
    
    // P2-1: scene_utterances（音声読み上げ用）との不整合を表示
    const audioUtterances = scene.utterance_list || [];
    const audioVsComicNote = audioUtterances.length > 0 && audioUtterances.length !== utterances.length
      ? `<div class="mt-2 px-2 py-1.5 bg-blue-50 border border-blue-200 rounded text-xs text-blue-800">
          <i class="fas fa-info-circle mr-1"></i>
          <strong>吹き出し: ${utterances.length}件</strong>（漫画に表示） / 
          <strong>音声読み上げ: ${audioUtterances.length}件</strong>（動画で再生）
          ${audioUtterances.length > utterances.length 
            ? '<br/><span class="text-blue-600">※ 吹き出しに収まらない分はテロップ/音声のみで再生されます</span>' 
            : ''}
         </div>`
      : '';
    
    return `
      <div>
        <label class="block text-sm font-semibold text-gray-700 mb-2">
          <i class="fas fa-comment-alt mr-1 text-orange-500"></i>発話（漫画）
          <span class="text-xs font-normal text-gray-500 ml-2">${utterances.length}件</span>
        </label>
        <div class="p-3 bg-orange-50 rounded-lg border border-orange-200 text-sm">
          ${utteranceRows}
          ${remainingText}
          ${audioVsComicNote}
        </div>
      </div>
    `;
  }
  
  // 画像モード: utterance_list があれば発話プレビューを表示（P0-2）
  const utteranceList = scene.utterance_list || [];
  
  if (utteranceList.length > 0) {
    const maxDisplay = 5;
    const displayItems = utteranceList.slice(0, maxDisplay);
    const remaining = utteranceList.length - maxDisplay;
    
    const utteranceRows = displayItems.map((u, idx) => {
      const isNarration = u.role === 'narration';
      const speaker = isNarration ? 'ナレーション' : (u.character_name || u.character_key || '不明');
      const speakerColor = isNarration ? 'text-gray-600 bg-gray-100' : 'text-blue-700 bg-blue-100';
      const truncatedText = (u.text || '').length > 50 ? u.text.slice(0, 50) + '…' : (u.text || '');
      const audioIcon = u.has_audio 
        ? '<i class="fas fa-volume-up text-green-500 ml-1" title="音声生成済み"></i>' 
        : '<i class="fas fa-volume-mute text-gray-300 ml-1" title="音声未生成"></i>';
      
      return `
        <div class="flex items-start gap-2 py-1.5 ${idx > 0 ? 'border-t border-gray-100' : ''}">
          <span class="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-bold ${speakerColor} whitespace-nowrap flex-shrink-0">
            <i class="fas ${isNarration ? 'fa-book-reader' : 'fa-user'} mr-1 text-[10px]"></i>
            ${escapeHtml(speaker)}
            ${audioIcon}
          </span>
          <span class="text-gray-700 text-sm leading-tight">${escapeHtml(truncatedText) || '<span class="text-gray-400">（空）</span>'}</span>
        </div>
      `;
    }).join('');
    
    const remainingText = remaining > 0 
      ? `<div class="text-xs text-gray-500 mt-1 text-right">…他 ${remaining}件の発話</div>` 
      : '';
    
    return `
      <div>
        <label class="block text-sm font-semibold text-gray-700 mb-2">
          <i class="fas fa-comment-alt mr-1 text-blue-500"></i>発話一覧
          <span class="text-xs font-normal text-gray-500 ml-2">${utteranceList.length}件</span>
        </label>
        <div class="p-3 bg-blue-50 rounded-lg border border-blue-200 text-sm">
          ${utteranceRows}
          ${remainingText}
        </div>
      </div>
    `;
  }
  
  // フォールバック: utterance_list がない場合は dialogue テキストを表示
  const text = scene.dialogue || '';
  const truncated = text.length > 120 ? text.slice(0, 120) + '…' : text;

  return `
    <div>
      <label class="block text-sm font-semibold text-gray-700 mb-2">
        <i class="fas fa-comment-alt mr-1 text-blue-500"></i>セリフ概要
      </label>
      <div class="p-3 bg-gray-50 rounded-lg border border-gray-200 text-sm whitespace-pre-wrap">
        ${truncated ? escapeHtml(truncated) : '<span class="text-gray-400">未設定</span>'}
      </div>
    </div>
  `;
}

/**
 * Phase1: 映像タイプ表示（画像 / 漫画）
 */
function renderAssetTypeIndicator(scene) {
  const t = scene.display_asset_type || 'image';
  const isComic = t === 'comic';

  return `
    <div class="flex items-center gap-2 text-sm">
      <span class="font-semibold text-gray-700">
        <i class="fas fa-${isComic ? 'book-open' : 'image'} mr-1 ${isComic ? 'text-orange-500' : 'text-green-600'}"></i>
        映像：
      </span>
      <span class="px-2 py-1 rounded-full text-xs font-medium ${
        isComic ? 'bg-orange-100 text-orange-700' : 'bg-green-100 text-green-700'
      }">
        ${isComic ? '漫画' : '画像'}
      </span>
    </div>
  `;
}

/**
 * Phase1: 詳細（折りたたみ・編集可能なプロンプト）
 * スタイル、画像プロンプト（編集可能）、要点を表示
 */
function renderSceneDetailsFold(scene, imageStatus, disableVideoGen) {
  const bullets = scene.bullets || [];
  const styleLabel = scene.style_preset_name || (scene.style_preset_id ? `スタイルID: ${scene.style_preset_id}` : 'デフォルト');
  const prompt = scene.image_prompt || scene.prompt || '';
  
  const displayAssetType = scene.display_asset_type || 'image';
  const isComicMode = displayAssetType === 'comic';

  // --- 動画プロンプト用の変数 ---
  const activeVideo = scene.active_video || null;
  const hasCompletedVideo = activeVideo && activeVideo.status === 'completed' && activeVideo.r2_url;
  const isGeneratingVideo = window.videoGenerating && window.videoGenerating[scene.id];
  const existingVideoPrompt = activeVideo?.prompt || '';
  const existingModel = activeVideo?.model || '';
  const isVeo3 = existingModel.includes('veo-3');

  // 動画プロンプトセクション（状態別）
  let videoPromptHtml = '';
  if (disableVideoGen) {
    videoPromptHtml = `
      <div class="flex items-center justify-between">
        <div class="text-xs font-semibold text-gray-400">
          <i class="fas fa-video mr-1"></i>動画プロンプト
        </div>
        <button id="videoHistoryBtn-${scene.id}" onclick="viewVideoHistory(${scene.id})"
          class="text-xs px-2 py-1 bg-gray-500 text-white rounded hover:bg-gray-600 transition-colors" title="動画履歴">
          <i class="fas fa-film mr-1"></i>履歴
        </button>
      </div>
      <p class="text-xs text-orange-600 mt-2">
        <i class="fas fa-lock mr-1"></i>漫画採用中は動画化できません。まるっとムービーで動画化されます。
      </p>
    `;
  } else if (imageStatus !== 'completed') {
    videoPromptHtml = `
      <div class="flex items-center justify-between">
        <div class="text-xs font-semibold text-gray-400">
          <i class="fas fa-video mr-1"></i>動画プロンプト
        </div>
        <button id="videoHistoryBtn-${scene.id}" onclick="viewVideoHistory(${scene.id})"
          class="text-xs px-2 py-1 bg-gray-500 text-white rounded hover:bg-gray-600 transition-colors" title="動画履歴">
          <i class="fas fa-film mr-1"></i>履歴
        </button>
      </div>
      <p class="text-xs text-gray-500 mt-2">
        <i class="fas fa-info-circle mr-1"></i>画像生成が完了すると、動画プロンプトを入力して動画化できます
      </p>
    `;
  } else {
    videoPromptHtml = `
      <div class="flex items-center justify-between">
        <div class="text-xs font-semibold text-purple-700">
          <i class="fas fa-video mr-1"></i>動画プロンプト
          ${hasCompletedVideo ? '<span class="ml-1 text-green-600"><i class="fas fa-check-circle"></i></span>' : ''}
        </div>
        <div class="flex items-center gap-2">
          ${hasCompletedVideo ? '<span class="text-xs text-green-600 font-medium"><i class="fas fa-check mr-1"></i>動画あり</span>' : ''}
          <button id="videoHistoryBtn-${scene.id}" onclick="viewVideoHistory(${scene.id})"
            class="text-xs px-2 py-1 bg-gray-500 text-white rounded hover:bg-gray-600 transition-colors" title="動画履歴">
            <i class="fas fa-film mr-1"></i>履歴
          </button>
        </div>
      </div>
      <textarea id="videoPromptInline-${scene.id}" rows="2"
        class="w-full px-3 py-2 text-sm border border-purple-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 resize-y bg-white"
        placeholder="動きや演出の指示を入力（例: カメラがゆっくりズームイン、表情変化、光の動き）"
        ${isGeneratingVideo ? 'disabled' : ''}
      >${escapeHtml(existingVideoPrompt)}</textarea>
      <p class="text-xs text-gray-500">空欄の場合はシンプルなモーションが適用されます</p>
      <div class="flex items-center gap-2">
        <select id="videoEngineInline-${scene.id}" 
          class="text-xs px-2 py-2 border border-purple-300 rounded-lg bg-white focus:ring-2 focus:ring-purple-500"
          ${isGeneratingVideo ? 'disabled' : ''}>
          <option value="veo2" ${!isVeo3 ? 'selected' : ''}>🎬 Veo2 (5秒)</option>
          <option value="veo3" ${isVeo3 ? 'selected' : ''}>🚀 Veo3 (8秒)</option>
        </select>
        <button id="videoBtn-${scene.id}" onclick="generateVideoInline(${scene.id})"
          class="flex-1 px-3 py-2 rounded-lg font-semibold text-sm touch-manipulation ${
            isGeneratingVideo
              ? 'bg-yellow-500 text-white opacity-75 cursor-not-allowed'
              : 'bg-purple-600 text-white hover:bg-purple-700 transition-colors'
          }" ${isGeneratingVideo ? 'disabled' : ''}>
          ${isGeneratingVideo 
            ? '<i class="fas fa-spinner fa-spin mr-1"></i>生成中...'
            : hasCompletedVideo 
              ? '<i class="fas fa-redo mr-1"></i>プロンプトで再生成'
              : '<i class="fas fa-magic mr-1"></i>動画化'
          }
        </button>
      </div>
      ${hasCompletedVideo && existingVideoPrompt ? `
        <div class="text-xs text-purple-600 bg-purple-100 rounded px-2 py-1">
          <i class="fas fa-info-circle mr-1"></i>現在の動画は上記プロンプトで生成されました。変更して再生成できます。
        </div>
      ` : ''}
    `;
  }

  return `
    <details class="bg-gray-50 rounded-lg border border-gray-200" id="details-fold-${scene.id}">
      <summary class="px-4 py-3 cursor-pointer text-sm font-semibold text-gray-700 hover:bg-gray-100">
        <i class="fas fa-chevron-right mr-2"></i>プロンプト編集
      </summary>
      <div class="px-4 pb-4 space-y-4 border-t border-gray-200 pt-3">

        <!-- スタイル -->
        <div>
          <div class="text-xs font-semibold text-gray-600 mb-1">
            <i class="fas fa-palette mr-1 text-purple-500"></i>スタイル
          </div>
          <select id="style-select-${scene.id}"
            class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-transparent"
            onchange="onStyleSelectChange(${scene.id}, this.value)">
            <option value="">デフォルト</option>
            ${(window.builderStylePresets || []).map(style => `
              <option value="${style.id}" ${scene.style_preset_id === style.id ? 'selected' : ''}>
                ${escapeHtml(style.name)}
              </option>
            `).join('')}
          </select>
        </div>

        <!-- ────── 🎨 画像プロンプト ────── -->
        <div class="bg-green-50 rounded-lg border border-green-200 p-3 space-y-2">
          <div class="flex items-center justify-between">
            <div class="text-xs font-semibold text-green-700">
              <i class="fas fa-image mr-1"></i>画像プロンプト
            </div>
            <span id="prompt-saved-indicator-${scene.id}" class="text-xs text-green-600 hidden">
              <i class="fas fa-check-circle mr-1"></i>保存済み
            </span>
          </div>
          <textarea id="prompt-edit-${scene.id}" rows="3"
            class="w-full px-3 py-2 text-sm border border-green-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-green-500 resize-y bg-white"
            placeholder="画像生成のプロンプトを入力してください..."
            oninput="onPromptEditInput(${scene.id})"
          >${escapeHtml(prompt)}</textarea>
          <p class="text-xs text-amber-600">
            <i class="fas fa-exclamation-triangle mr-1"></i>
            ※画像内のテキストを日本語にしたい場合は「文字は日本語で」と追記
          </p>
          <div class="flex gap-2">
            <button id="save-prompt-btn-${scene.id}" onclick="saveScenePrompt(${scene.id})"
              class="px-3 py-1.5 text-xs font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:bg-gray-300 disabled:cursor-not-allowed"
              disabled>
              <i class="fas fa-save mr-1"></i>保存
            </button>
            <button id="save-and-regenerate-btn-${scene.id}" onclick="savePromptAndRegenerate(${scene.id})"
              class="px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
                isComicMode 
                  ? 'bg-gray-300 text-gray-500 cursor-not-allowed' 
                  : 'bg-green-600 text-white hover:bg-green-700'
              }" ${isComicMode ? 'disabled title="漫画採用中は画像を再生成できません"' : ''}>
              <i class="fas fa-magic mr-1"></i>保存して再生成
            </button>
          </div>
          ${isComicMode ? '<p class="text-xs text-orange-600"><i class="fas fa-info-circle mr-1"></i>漫画採用中は画像の再生成ができません</p>' : ''}
        </div>

        <!-- ────── 🎬 動画プロンプト ────── -->
        <div class="bg-purple-50 rounded-lg border border-purple-200 p-3 space-y-2" id="videoPromptSection-${scene.id}">
          ${videoPromptHtml}
        </div>

        ${bullets.length ? `
          <div>
            <div class="text-xs font-semibold text-gray-600 mb-1">
              <i class="fas fa-list mr-1 text-blue-600"></i>要点
            </div>
            <ul class="list-disc list-inside text-sm space-y-1">
              ${bullets.map(b => `<li>${escapeHtml(b)}</li>`).join('')}
            </ul>
          </div>
        ` : ''}

      </div>
    </details>
  `;
}

/**
 * プロンプト編集時のハンドラー（変更検知）
 * @param {number} sceneId 
 */
function onPromptEditInput(sceneId) {
  const textarea = document.getElementById(`prompt-edit-${sceneId}`);
  const saveBtn = document.getElementById(`save-prompt-btn-${sceneId}`);
  const savedIndicator = document.getElementById(`prompt-saved-indicator-${sceneId}`);
  
  if (textarea && saveBtn) {
    // 変更があれば保存ボタンを有効化
    saveBtn.disabled = false;
    saveBtn.classList.remove('bg-gray-300', 'cursor-not-allowed');
    saveBtn.classList.add('bg-blue-600', 'hover:bg-blue-700');
  }
  
  // 保存済みインジケーターを非表示
  if (savedIndicator) {
    savedIndicator.classList.add('hidden');
  }
}

/**
 * プロンプトのみを保存
 * @param {number} sceneId 
 */
async function saveScenePrompt(sceneId) {
  const textarea = document.getElementById(`prompt-edit-${sceneId}`);
  const saveBtn = document.getElementById(`save-prompt-btn-${sceneId}`);
  const savedIndicator = document.getElementById(`prompt-saved-indicator-${sceneId}`);
  
  if (!textarea) return;
  
  const newPrompt = textarea.value.trim();
  
  // ボタンをローディング状態に
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>保存中...';
  }
  
  try {
    const response = await axios.put(`${API_BASE}/scenes/${sceneId}`, {
      image_prompt: newPrompt
    });
    
    if (response.data.id) {
      showToast('プロンプトを保存しました', 'success');
      
      // 保存済みインジケーター表示
      if (savedIndicator) {
        savedIndicator.classList.remove('hidden');
      }
      
      // ボタンを無効化（変更がないため）
      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.classList.remove('bg-blue-600', 'hover:bg-blue-700');
        saveBtn.classList.add('bg-gray-300', 'cursor-not-allowed');
        saveBtn.innerHTML = '<i class="fas fa-save mr-1"></i>プロンプトを保存';
      }
      
      // キャッシュ更新
      if (window.lastLoadedScenes) {
        const idx = window.lastLoadedScenes.findIndex(s => s.id === sceneId);
        if (idx !== -1) {
          window.lastLoadedScenes[idx].image_prompt = newPrompt;
        }
      }
    } else {
      throw new Error('保存に失敗しました');
    }
  } catch (error) {
    console.error('[saveScenePrompt] Error:', error);
    showToast('プロンプトの保存に失敗しました', 'error');
    
    // ボタンを元に戻す
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.classList.add('bg-blue-600', 'hover:bg-blue-700');
      saveBtn.classList.remove('bg-gray-300', 'cursor-not-allowed');
      saveBtn.innerHTML = '<i class="fas fa-save mr-1"></i>プロンプトを保存';
    }
  }
}

/**
 * プロンプトを保存して画像を再生成
 * @param {number} sceneId 
 */
async function savePromptAndRegenerate(sceneId) {
  const textarea = document.getElementById(`prompt-edit-${sceneId}`);
  const regenBtn = document.getElementById(`save-and-regenerate-btn-${sceneId}`);
  
  if (!textarea) return;
  
  const newPrompt = textarea.value.trim();
  
  // ボタンをローディング状態に
  if (regenBtn) {
    regenBtn.disabled = true;
    regenBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>保存中...';
  }
  
  try {
    // 1. プロンプトを保存
    const saveResponse = await axios.put(`${API_BASE}/scenes/${sceneId}`, {
      image_prompt: newPrompt
    });
    
    if (!saveResponse.data.id) {
      throw new Error('プロンプトの保存に失敗しました');
    }
    
    showToast('プロンプトを保存しました。画像を再生成中...', 'info');
    
    // 保存ボタンの状態をリセット
    const saveBtn = document.getElementById(`save-prompt-btn-${sceneId}`);
    const savedIndicator = document.getElementById(`prompt-saved-indicator-${sceneId}`);
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.classList.remove('bg-blue-600', 'hover:bg-blue-700');
      saveBtn.classList.add('bg-gray-300', 'cursor-not-allowed');
    }
    if (savedIndicator) {
      savedIndicator.classList.remove('hidden');
    }
    
    // キャッシュ更新
    if (window.lastLoadedScenes) {
      const idx = window.lastLoadedScenes.findIndex(s => s.id === sceneId);
      if (idx !== -1) {
        window.lastLoadedScenes[idx].image_prompt = newPrompt;
      }
    }
    
    // 2. 画像を再生成（既存の関数を使用）
    if (regenBtn) {
      regenBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>再生成中...';
    }
    
    // generateImage関数を呼び出し
    if (typeof window.generateImage === 'function') {
      await window.generateImage(sceneId);
    } else if (typeof generateImage === 'function') {
      await generateImage(sceneId);
    } else {
      // フォールバック: 直接APIを呼び出し
      const genResponse = await axios.post(`${API_BASE}/scenes/${sceneId}/generate-image`);
      if (genResponse.data.success || genResponse.data.generation_id) {
        showToast('画像生成を開始しました', 'success');
        // ポーリング開始
        if (typeof watchSceneGeneration === 'function') {
          watchSceneGeneration(sceneId);
        }
      }
    }
    
  } catch (error) {
    console.error('[savePromptAndRegenerate] Error:', error);
    showToast(error.message || '処理中にエラーが発生しました', 'error');
  } finally {
    // ボタンを元に戻す
    if (regenBtn) {
      regenBtn.disabled = false;
      regenBtn.innerHTML = '<i class="fas fa-magic mr-1"></i>保存して再生成';
    }
  }
}

// グローバルに公開
window.onPromptEditInput = onPromptEditInput;
window.saveScenePrompt = saveScenePrompt;
window.savePromptAndRegenerate = savePromptAndRegenerate;

// Export output preset functions
window.loadOutputPreset = loadOutputPreset;
window.saveOutputPreset = saveOutputPreset;
window.updateOutputPresetPreview = updateOutputPresetPreview;

// ========== Vrew風カスタムテロップスタイル ==========

/**
 * カスタムスタイル設定をUIから取得
 * @returns {object|null} カスタムスタイル設定（未設定ならnull）
 */
function getTelopCustomStyle() {
  const textColor = document.getElementById('vbTelopTextColorHex')?.value || '#FFFFFF';
  const strokeColor = document.getElementById('vbTelopStrokeColorHex')?.value || '#000000';
  const strokeWidth = parseFloat(document.getElementById('vbTelopStrokeWidth')?.value || '2');
  const bgColor = document.getElementById('vbTelopBgColorHex')?.value || '#000000';
  const bgOpacity = parseInt(document.getElementById('vbTelopBgOpacity')?.value || '0', 10) / 100;
  const fontFamily = document.getElementById('vbTelopFontFamily')?.value || 'noto-sans';
  const fontWeight = document.getElementById('vbTelopFontWeight')?.value || '600';
  
  // デフォルト値と比較して、変更がなければnullを返す
  const isDefault = (
    textColor === '#FFFFFF' &&
    strokeColor === '#000000' &&
    strokeWidth === 2 &&
    bgOpacity === 0 &&
    fontFamily === 'noto-sans' &&
    fontWeight === '600'
  );
  
  if (isDefault) {
    return null; // プリセットをそのまま使用
  }
  
  return {
    text_color: textColor,
    stroke_color: strokeColor,
    stroke_width: strokeWidth,
    bg_color: bgColor,
    bg_opacity: bgOpacity,
    font_family: fontFamily,
    font_weight: fontWeight,
  };
}

/**
 * PR-Remotion-Typography: Typography設定を取得
 * @returns {object|null} Typography設定（デフォルト値なら null）
 */
function getTelopTypography() {
  const maxLines = parseInt(document.getElementById('vbTelopMaxLines')?.value || '2', 10);
  const lineHeight = parseInt(document.getElementById('vbTelopLineHeight')?.value || '140', 10) / 100;
  const letterSpacing = parseFloat(document.getElementById('vbTelopLetterSpacing')?.value || '0');
  const overflowMode = document.getElementById('vbTelopOverflowMode')?.value || 'truncate';
  
  // デフォルト値と比較して、変更がなければnullを返す
  const isDefault = (
    maxLines === 2 &&
    lineHeight === 1.4 &&
    letterSpacing === 0 &&
    overflowMode === 'truncate'
  );
  
  if (isDefault) {
    return null; // デフォルト設定を使用
  }
  
  return {
    max_lines: maxLines,
    line_height: lineHeight,
    letter_spacing: letterSpacing,
    overflow_mode: overflowMode,
  };
}
window.getTelopTypography = getTelopTypography;

/**
 * カスタムスタイルUIの初期化
 * - カラーピッカーとテキスト入力の同期
 * - スライダーの値表示
 */
function initTelopCustomStyleUI() {
  // カラーピッカー ↔ テキスト入力の同期
  const colorPairs = [
    ['vbTelopTextColor', 'vbTelopTextColorHex'],
    ['vbTelopStrokeColor', 'vbTelopStrokeColorHex'],
    ['vbTelopBgColor', 'vbTelopBgColorHex'],
  ];
  
  colorPairs.forEach(([pickerId, hexId]) => {
    const picker = document.getElementById(pickerId);
    const hex = document.getElementById(hexId);
    
    if (picker && hex) {
      picker.addEventListener('input', () => {
        hex.value = picker.value.toUpperCase();
      });
      hex.addEventListener('change', () => {
        // 有効なHEX値かチェック
        if (/^#[0-9A-Fa-f]{6}$/.test(hex.value)) {
          picker.value = hex.value;
        }
      });
    }
  });
  
  // 縁取り太さスライダー
  const strokeWidthSlider = document.getElementById('vbTelopStrokeWidth');
  const strokeWidthValue = document.getElementById('vbTelopStrokeWidthValue');
  if (strokeWidthSlider && strokeWidthValue) {
    strokeWidthSlider.addEventListener('input', () => {
      strokeWidthValue.textContent = strokeWidthSlider.value;
    });
  }
  
  // 背景透過度スライダー
  const bgOpacitySlider = document.getElementById('vbTelopBgOpacity');
  const bgOpacityValue = document.getElementById('vbTelopBgOpacityValue');
  if (bgOpacitySlider && bgOpacityValue) {
    bgOpacitySlider.addEventListener('input', () => {
      bgOpacityValue.textContent = bgOpacitySlider.value;
    });
  }
  
  // プリセットに戻すボタン
  const resetBtn = document.getElementById('vbTelopResetCustom');
  if (resetBtn) {
    resetBtn.addEventListener('click', resetTelopCustomStyle);
  }
  
  // PR-Remotion-Typography: 行間スライダー
  const lineHeightSlider = document.getElementById('vbTelopLineHeight');
  const lineHeightValue = document.getElementById('vbTelopLineHeightValue');
  if (lineHeightSlider && lineHeightValue) {
    lineHeightSlider.addEventListener('input', () => {
      lineHeightValue.textContent = lineHeightSlider.value;
    });
  }
  
  // PR-Remotion-Typography: 文字間スライダー
  const letterSpacingSlider = document.getElementById('vbTelopLetterSpacing');
  const letterSpacingValue = document.getElementById('vbTelopLetterSpacingValue');
  if (letterSpacingSlider && letterSpacingValue) {
    letterSpacingSlider.addEventListener('input', () => {
      letterSpacingValue.textContent = letterSpacingSlider.value;
      updateTelopPreview();
    });
  }
  
  // ========== テロッププレビュー機能 ==========
  // 全ての設定変更でプレビューを更新（漏れなく全て登録）
  const previewTriggers = [
    // 基本設定
    'vbTelopStyle', 'vbTelopSize', 'vbTelopPosition', 'vbTelopsToggle',
    // カラー設定
    'vbTelopTextColor', 'vbTelopTextColorHex',
    'vbTelopStrokeColor', 'vbTelopStrokeColorHex',
    'vbTelopBgColor', 'vbTelopBgColorHex',
    // スライダー
    'vbTelopStrokeWidth', 'vbTelopBgOpacity',
    'vbTelopLineHeight', 'vbTelopLetterSpacing',
    // フォント
    'vbTelopFontFamily', 'vbTelopFontWeight',
    // Typography追加
    'vbTelopMaxLines', 'vbTelopOverflowMode'
  ];
  
  let registeredCount = 0;
  previewTriggers.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      // 既存のリスナーを重複登録しないようにする
      el.removeEventListener('input', updateTelopPreview);
      el.removeEventListener('change', updateTelopPreview);
      el.addEventListener('input', updateTelopPreview);
      el.addEventListener('change', updateTelopPreview);
      registeredCount++;
    } else {
      console.warn(`[TelopPreview] Element not found: ${id}`);
    }
  });
  
  // 初期プレビュー表示
  setTimeout(updateTelopPreview, 200);
  
  console.log(`[Project] Telop preview initialized: ${registeredCount}/${previewTriggers.length} elements`);
}

/**
 * カスタムスタイルをデフォルトにリセット
 */
function resetTelopCustomStyle() {
  // 文字色
  const textColorPicker = document.getElementById('vbTelopTextColor');
  const textColorHex = document.getElementById('vbTelopTextColorHex');
  if (textColorPicker) textColorPicker.value = '#FFFFFF';
  if (textColorHex) textColorHex.value = '#FFFFFF';
  
  // 縁取り色
  const strokeColorPicker = document.getElementById('vbTelopStrokeColor');
  const strokeColorHex = document.getElementById('vbTelopStrokeColorHex');
  if (strokeColorPicker) strokeColorPicker.value = '#000000';
  if (strokeColorHex) strokeColorHex.value = '#000000';
  
  // 縁取り太さ
  const strokeWidthSlider = document.getElementById('vbTelopStrokeWidth');
  const strokeWidthValue = document.getElementById('vbTelopStrokeWidthValue');
  if (strokeWidthSlider) strokeWidthSlider.value = '2';
  if (strokeWidthValue) strokeWidthValue.textContent = '2';
  
  // 背景色
  const bgColorPicker = document.getElementById('vbTelopBgColor');
  const bgColorHex = document.getElementById('vbTelopBgColorHex');
  if (bgColorPicker) bgColorPicker.value = '#000000';
  if (bgColorHex) bgColorHex.value = '#000000';
  
  // 背景透過度
  const bgOpacitySlider = document.getElementById('vbTelopBgOpacity');
  const bgOpacityValue = document.getElementById('vbTelopBgOpacityValue');
  if (bgOpacitySlider) bgOpacitySlider.value = '0';
  if (bgOpacityValue) bgOpacityValue.textContent = '0';
  
  // フォント
  const fontFamilySelect = document.getElementById('vbTelopFontFamily');
  if (fontFamilySelect) fontFamilySelect.value = 'noto-sans';
  
  // 太さ
  const fontWeightSelect = document.getElementById('vbTelopFontWeight');
  if (fontWeightSelect) fontWeightSelect.value = '600';
  
  // PR-Remotion-Typography: Typography設定リセット
  const maxLinesSelect = document.getElementById('vbTelopMaxLines');
  if (maxLinesSelect) maxLinesSelect.value = '2';
  
  const lineHeightSlider = document.getElementById('vbTelopLineHeight');
  const lineHeightValue = document.getElementById('vbTelopLineHeightValue');
  if (lineHeightSlider) lineHeightSlider.value = '140';
  if (lineHeightValue) lineHeightValue.textContent = '140';
  
  const letterSpacingSlider = document.getElementById('vbTelopLetterSpacing');
  const letterSpacingValue = document.getElementById('vbTelopLetterSpacingValue');
  if (letterSpacingSlider) letterSpacingSlider.value = '0';
  if (letterSpacingValue) letterSpacingValue.textContent = '0';
  
  const overflowModeSelect = document.getElementById('vbTelopOverflowMode');
  if (overflowModeSelect) overflowModeSelect.value = 'truncate';
  
  showToast('カスタム設定をリセットしました', 'success');
  updateTelopPreview();
}

/**
 * テロッププレビューを更新
 * 設定変更時にリアルタイムでプレビュー表示を更新
 */
function updateTelopPreview() {
  const previewContainer = document.getElementById('vbTelopPreviewContainer');
  const previewText = document.getElementById('vbTelopPreviewText');
  if (!previewContainer || !previewText) {
    console.log('[TelopPreview] Container not found');
    return;
  }
  
  // 表示/非表示
  const enabled = document.getElementById('vbTelopsToggle')?.checked ?? true;
  previewText.style.display = enabled ? 'block' : 'none';
  if (!enabled) return;
  
  // スタイルプリセット
  const stylePreset = document.getElementById('vbTelopStyle')?.value || 'outline';
  const sizePreset = document.getElementById('vbTelopSize')?.value || 'md';
  const positionPreset = document.getElementById('vbTelopPosition')?.value || 'bottom';
  
  // カスタムスタイル
  const textColor = document.getElementById('vbTelopTextColorHex')?.value || '#FFFFFF';
  const strokeColor = document.getElementById('vbTelopStrokeColorHex')?.value || '#000000';
  const strokeWidth = parseFloat(document.getElementById('vbTelopStrokeWidth')?.value || '2');
  const bgColor = document.getElementById('vbTelopBgColorHex')?.value || '#000000';
  const bgOpacity = parseInt(document.getElementById('vbTelopBgOpacity')?.value || '0', 10) / 100;
  const fontFamily = document.getElementById('vbTelopFontFamily')?.value || 'noto-sans';
  const fontWeight = document.getElementById('vbTelopFontWeight')?.value || '600';
  const lineHeight = parseInt(document.getElementById('vbTelopLineHeight')?.value || '140', 10) / 100;
  const letterSpacing = parseFloat(document.getElementById('vbTelopLetterSpacing')?.value || '0');
  
  console.log('[TelopPreview] Updating:', { stylePreset, sizePreset, positionPreset, strokeWidth, bgOpacity, letterSpacing });
  
  // サイズマッピング（より大きな差をつける）
  const fontSizeMap = { sm: '14px', md: '18px', lg: '24px' };
  const fontSize = fontSizeMap[sizePreset] || '18px';
  
  // フォントファミリーマッピング
  const fontFamilyMap = {
    'noto-sans': '"Noto Sans JP", "Hiragino Sans", "Yu Gothic", sans-serif',
    'noto-serif': '"Noto Serif JP", "Yu Mincho", serif',
    'rounded': '"M PLUS Rounded 1c", "Hiragino Maru Gothic ProN", sans-serif',
    'zen-maru': '"Zen Maru Gothic", "Hiragino Maru Gothic ProN", sans-serif'
  };
  const fontFamilyCSS = fontFamilyMap[fontFamily] || fontFamilyMap['noto-sans'];
  
  // 位置設定（リセットしてから設定）
  previewText.style.top = 'auto';
  previewText.style.bottom = 'auto';
  previewText.style.transform = 'translateX(-50%)';
  
  if (positionPreset === 'top') {
    previewText.style.top = '12px';
  } else if (positionPreset === 'center') {
    previewText.style.top = '50%';
    previewText.style.transform = 'translate(-50%, -50%)';
  } else {
    previewText.style.bottom = '12px';
  }
  
  // スタイルプリセットに応じた設定（より明確な違い）
  let textShadowStyle = '';
  let bgStyle = 'transparent';
  let paddingStyle = '6px 16px';
  let borderRadiusStyle = '4px';
  let borderStyle = 'none';
  
  // 縁取りのtext-shadow生成（strokeWidthを使用）
  const sw = Math.max(strokeWidth, 0);
  const outlineShadow = sw > 0 ? `
    -${sw}px -${sw}px 0 ${strokeColor},
    ${sw}px -${sw}px 0 ${strokeColor},
    -${sw}px ${sw}px 0 ${strokeColor},
    ${sw}px ${sw}px 0 ${strokeColor},
    -${sw}px 0 0 ${strokeColor},
    ${sw}px 0 0 ${strokeColor},
    0 -${sw}px 0 ${strokeColor},
    0 ${sw}px 0 ${strokeColor}
  ` : 'none';
  
  switch (stylePreset) {
    case 'outline':
      // アウトライン：縁取り + 任意の背景
      textShadowStyle = outlineShadow;
      bgStyle = bgOpacity > 0 ? `rgba(${hexToRgb(bgColor)}, ${bgOpacity})` : 'transparent';
      borderRadiusStyle = '4px';
      break;
      
    case 'minimal':
      // ミニマル：影のみ、シンプル
      textShadowStyle = '0 2px 8px rgba(0,0,0,0.8)';
      bgStyle = 'transparent';
      paddingStyle = '4px 12px';
      borderRadiusStyle = '0';
      break;
      
    case 'band':
      // 帯付き：背景帯が特徴（常に70%以上の背景）
      textShadowStyle = 'none';
      bgStyle = `rgba(${hexToRgb(bgColor)}, ${Math.max(bgOpacity, 0.75)})`;
      paddingStyle = '8px 24px';
      borderRadiusStyle = '0';
      // 帯は画面幅いっぱいに
      previewText.style.width = '100%';
      previewText.style.maxWidth = '100%';
      previewText.style.left = '0';
      previewText.style.transform = positionPreset === 'center' ? 'translateY(-50%)' : 'none';
      break;
      
    case 'pop':
      // ポップ：カラフル、ドロップシャドウ、丸角
      textShadowStyle = `${outlineShadow}, 3px 3px 6px rgba(0,0,0,0.4)`;
      bgStyle = bgOpacity > 0 ? `rgba(${hexToRgb(bgColor)}, ${bgOpacity})` : 'transparent';
      paddingStyle = '8px 20px';
      borderRadiusStyle = '12px';
      borderStyle = `2px solid ${strokeColor}`;
      break;
      
    case 'cinematic':
      // シネマティック：グロー効果、広い文字間隔
      textShadowStyle = `0 0 20px rgba(255,255,255,0.6), 0 0 40px rgba(255,255,255,0.3), 0 4px 8px rgba(0,0,0,0.8)`;
      bgStyle = 'transparent';
      paddingStyle = '6px 16px';
      borderRadiusStyle = '0';
      break;
      
    default:
      textShadowStyle = outlineShadow;
      bgStyle = 'transparent';
  }
  
  // band以外は通常の中央寄せに戻す
  if (stylePreset !== 'band') {
    previewText.style.width = 'auto';
    previewText.style.maxWidth = '90%';
    previewText.style.left = '50%';
    if (positionPreset !== 'center') {
      previewText.style.transform = 'translateX(-50%)';
    }
  }
  
  // プレビューテキストのスタイルを適用
  const spanEl = previewText.querySelector('span');
  if (spanEl) {
    spanEl.style.color = textColor;
    spanEl.style.fontSize = fontSize;
    spanEl.style.fontFamily = fontFamilyCSS;
    spanEl.style.fontWeight = fontWeight;
    spanEl.style.textShadow = textShadowStyle;
    spanEl.style.lineHeight = String(lineHeight);
    spanEl.style.letterSpacing = `${letterSpacing}px`;
    spanEl.style.display = 'inline-block';
  }
  
  previewText.style.background = bgStyle;
  previewText.style.padding = paddingStyle;
  previewText.style.borderRadius = borderRadiusStyle;
  previewText.style.border = borderStyle;
  previewText.style.transition = 'all 0.2s ease';
}

/**
 * HEX色をRGB文字列に変換
 */
function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (result) {
    return `${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}`;
  }
  return '0, 0, 0';
}

// 初期化時に呼び出す
document.addEventListener('DOMContentLoaded', () => {
  // 遅延初期化（UIがレンダリングされた後）
  setTimeout(initTelopCustomStyleUI, 500);
});

window.getTelopCustomStyle = getTelopCustomStyle;
window.initTelopCustomStyleUI = initTelopCustomStyleUI;
window.resetTelopCustomStyle = resetTelopCustomStyle;
window.updateTelopPreview = updateTelopPreview;

// ========== PR-Audio-Direct: シーンカードから直接音声生成 ==========
/**
 * シーンの音声を一括生成
 * - シーン編集モーダルを開かずに直接音声を生成
 * - utterancesがあれば、未生成分をまとめて生成
 * - 進捗をボタンに表示
 * 
 * @param {number} sceneId 
 */
async function generateSceneAudio(sceneId) {
  const btn = document.getElementById(`audioGenBtn-${sceneId}`);
  const originalContent = btn?.innerHTML || '';
  
  // ボタン連打防止
  if (btn?.disabled) {
    return;
  }
  
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>準備中...';
    btn.className = 'px-3 py-1.5 bg-yellow-500 text-white rounded-lg text-xs font-semibold flex items-center gap-1 cursor-wait';
  }
  
  try {
    // 1. シーンのutterances一覧を取得
    const response = await axios.get(`${API_BASE}/scenes/${sceneId}/utterances`);
    const utterances = response.data.utterances || [];
    
    if (utterances.length === 0) {
      showToast('このシーンには発話がありません', 'warning');
      return;
    }
    
    // 2. 未生成のutterancesをフィルタ
    const pendingUtterances = utterances.filter(u => 
      !u.audio_generation_id || u.audio_status !== 'completed'
    );
    
    if (pendingUtterances.length === 0) {
      showToast('すべての音声が生成済みです', 'success');
      return;
    }
    
    // 3. 各utteranceに対して音声生成APIを呼び出し
    let successCount = 0;
    let errorCount = 0;
    const total = pendingUtterances.length;
    
    for (let i = 0; i < pendingUtterances.length; i++) {
      const utt = pendingUtterances[i];
      
      // 進捗更新
      if (btn) {
        btn.innerHTML = `<i class="fas fa-spinner fa-spin mr-1"></i>${i + 1}/${total}生成中...`;
      }
      
      try {
        // PR-Audio-Fix: utterance個別の音声生成APIを使用
        // このAPIはキャラクターの音声設定を自動で取得し、
        // utteranceに音声生成IDを紐付ける
        const genResponse = await axios.post(`${API_BASE}/utterances/${utt.id}/generate-audio`, {});
        
        if (genResponse.data.success && genResponse.data.audio_generation_id) {
          successCount++;
          console.log(`[Audio] Utterance ${utt.id} audio generation started: ${genResponse.data.audio_generation_id}`);
        }
        
        // レート制限対策: 少し待機
        if (i < pendingUtterances.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
        
      } catch (err) {
        console.error(`[Audio] Failed to generate for utterance ${utt.id}:`, err);
        errorCount++;
      }
    }
    
    // 4. 結果通知
    if (errorCount === 0) {
      showToast(`${successCount}件の音声生成を開始しました`, 'success');
    } else {
      showToast(`${successCount}件成功 / ${errorCount}件失敗`, errorCount > 0 ? 'warning' : 'success');
    }
    
    // 5. シーンリストを更新（音声ステータス反映）
    setTimeout(async () => {
      if (typeof window.initBuilderTab === 'function') {
        await window.initBuilderTab();
      }
    }, 2000);
    
  } catch (error) {
    console.error('[generateSceneAudio] Error:', error);
    showToast(error.response?.data?.error?.message || '音声生成に失敗しました', 'error');
  } finally {
    // ボタンを元に戻す
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = originalContent;
      btn.className = 'px-3 py-1.5 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors text-xs font-semibold flex items-center gap-1';
    }
  }
}

// グローバルに公開
window.generateSceneAudio = generateSceneAudio;

// ========== PR-Audio-Bulk: Preflight画面から一括音声生成 ==========
// Step3-PR3: バックエンドのbulk-audio APIを使用（SSOT: project_audio_jobs）

// 一括音声生成のジョブ状態をポーリング
let bulkAudioPollingInterval = null;

/**
 * 全シーンの未生成音声を一括生成（バックエンドAPI版）
 * - POST /api/projects/:projectId/audio/bulk-generate を呼び出し
 * - ジョブの進捗をポーリングで監視
 * @param {boolean} skipConfirm - trueの場合、確認ダイアログをスキップ
 */
async function generateAllMissingAudio(skipConfirm = false) {
  const btn = document.getElementById('btnBulkAudioGenerate');
  const originalContent = btn?.innerHTML || '';
  const projectId = window.currentProjectId;
  
  if (!projectId) {
    showToast('プロジェクトが選択されていません', 'error');
    return;
  }
  
  // 対象シーン取得（表示用）
  const sceneIds = window.missingAudioSceneIds || [];
  
  // 確認ダイアログ（skipConfirmがtrueの場合はスキップ）
  if (!skipConfirm && sceneIds.length > 0) {
    const confirmed = confirm(`${sceneIds.length}シーンの音声を一括生成します。\n\n続行しますか？`);
    if (!confirmed) return;
  }
  
  // PR-Audio-UI: 音声生成中フラグを立てる（動画ビルドボタン非活性化用）
  window.isGeneratingAudio = true;
  updateVideoBuildButtonState();
  
  // ボタン無効化
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>開始中...';
    btn.className = 'ml-3 px-3 py-1 text-xs bg-gray-400 text-white rounded-lg cursor-not-allowed whitespace-nowrap';
  }
  
  try {
    // バックエンドAPIでジョブを開始
    const response = await axios.post(`${API_BASE}/projects/${projectId}/audio/bulk-generate`, {
      mode: 'missing',  // 未生成のみ
      force_regenerate: false
    });
    
    if (!response.data.success) {
      throw new Error(response.data.error?.message || 'ジョブの開始に失敗しました');
    }
    
    const jobId = response.data.job_id;
    console.log(`[BulkAudio] Started job ${jobId} for project ${projectId}`);
    showToast('一括音声生成を開始しました', 'success');
    
    // ポーリング開始
    startBulkAudioPolling(projectId, btn, originalContent);
    
  } catch (error) {
    console.error('[generateAllMissingAudio] Error:', error);
    
    // 409の場合は既存ジョブがある
    if (error.response?.status === 409) {
      const existingJobId = error.response?.data?.existing_job_id;
      showToast('既に一括生成が実行中です', 'warning');
      // 既存ジョブのポーリングを開始
      startBulkAudioPolling(projectId, btn, originalContent);
      return;
    }
    
    showToast(error.response?.data?.error?.message || '一括音声生成に失敗しました', 'error');
    
    // エラー時はフラグをリセット
    window.isGeneratingAudio = false;
    updateVideoBuildButtonState();
    
    if (btn) {
      btn.innerHTML = originalContent;
      btn.className = 'ml-3 px-3 py-1 text-xs bg-purple-500 hover:bg-purple-600 text-white rounded-lg transition-colors whitespace-nowrap';
      btn.disabled = false;
    }
  }
}

/**
 * 一括音声生成のポーリングを開始
 */
function startBulkAudioPolling(projectId, btn, originalContent) {
  // 既存のポーリングがあれば停止
  if (bulkAudioPollingInterval) {
    clearInterval(bulkAudioPollingInterval);
  }
  
  bulkAudioPollingInterval = setInterval(async () => {
    try {
      const statusResponse = await axios.get(`${API_BASE}/projects/${projectId}/audio/bulk-status`);
      const data = statusResponse.data;
      
      if (!data.has_job) {
        stopBulkAudioPolling(btn, originalContent, false);
        return;
      }
      
      const job = data.job;
      console.log(`[BulkAudio] Job ${job.id} status: ${job.status}, progress: ${job.processed_utterances}/${job.total_utterances}`);
      
      // ボタンの進捗表示を更新
      if (btn && (job.status === 'running' || job.status === 'queued')) {
        const progressPercent = job.progress_percent || 0;
        btn.innerHTML = `<i class="fas fa-spinner fa-spin mr-1"></i>${progressPercent}% (${job.processed_utterances}/${job.total_utterances})`;
      }
      
      // ジョブ完了チェック
      if (job.status === 'completed' || job.status === 'failed' || job.status === 'canceled') {
        const isSuccess = job.status === 'completed' && job.failed_count === 0;
        const hasPartialSuccess = job.success_count > 0;
        
        // 結果通知
        if (isSuccess) {
          showToast(`${job.success_count}件の音声生成が完了しました`, 'success');
        } else if (hasPartialSuccess) {
          showToast(`${job.success_count}件成功 / ${job.failed_count}件失敗`, 'warning');
        } else if (job.status === 'canceled') {
          showToast('音声生成がキャンセルされました', 'info');
        } else {
          showToast('音声生成に失敗しました', 'error');
        }
        
        stopBulkAudioPolling(btn, originalContent, hasPartialSuccess || isSuccess);
        
        // Preflightを再チェック
        await updateVideoBuildRequirements();
      }
      
    } catch (error) {
      console.error('[BulkAudio Polling] Error:', error);
      // ポーリングエラーは無視して続行（一時的なネットワークエラーの可能性）
    }
  }, 2000); // 2秒ごとにポーリング
}

/**
 * 一括音声生成のポーリングを停止
 */
function stopBulkAudioPolling(btn, originalContent, wasSuccessful) {
  if (bulkAudioPollingInterval) {
    clearInterval(bulkAudioPollingInterval);
    bulkAudioPollingInterval = null;
  }
  
  // フラグをリセット
  window.isGeneratingAudio = false;
  updateVideoBuildButtonState();
  
  // ボタンを更新
  if (btn) {
    if (wasSuccessful) {
      btn.innerHTML = `<i class="fas fa-check mr-1"></i>音声生成完了`;
      btn.className = 'ml-3 px-3 py-1 text-xs bg-green-500 text-white rounded-lg whitespace-nowrap';
      btn.disabled = true;
    } else {
      btn.innerHTML = originalContent;
      btn.className = 'ml-3 px-3 py-1 text-xs bg-purple-500 hover:bg-purple-600 text-white rounded-lg transition-colors whitespace-nowrap';
      btn.disabled = false;
    }
  }
  
  // missingAudioSceneIds をクリア
  window.missingAudioSceneIds = [];
}

/**
 * 一括音声生成をキャンセル
 */
async function cancelBulkAudioGeneration() {
  const projectId = window.currentProjectId;
  if (!projectId) return;
  
  try {
    await axios.post(`${API_BASE}/projects/${projectId}/audio/bulk-cancel`);
    showToast('一括音声生成をキャンセルしました', 'info');
  } catch (error) {
    console.error('[cancelBulkAudioGeneration] Error:', error);
    showToast('キャンセルに失敗しました', 'error');
  }
}

// グローバルに公開
window.cancelBulkAudioGeneration = cancelBulkAudioGeneration;

/**
 * ページ読み込み時に実行中の一括音声ジョブがあれば再開
 */
async function checkAndResumeBulkAudioJob() {
  const projectId = window.currentProjectId;
  if (!projectId) return;
  
  try {
    const response = await axios.get(`${API_BASE}/projects/${projectId}/audio/bulk-status`);
    const data = response.data;
    
    if (!data.has_job) return;
    
    const job = data.job;
    
    // 実行中のジョブがあればポーリングを再開
    if (job.status === 'queued' || job.status === 'running') {
      console.log(`[BulkAudio] Found running job ${job.id}, resuming polling`);
      
      window.isGeneratingAudio = true;
      updateVideoBuildButtonState();
      
      const btn = document.getElementById('btnBulkAudioGenerate');
      const originalContent = btn?.innerHTML || '<i class="fas fa-volume-up mr-1"></i>音声を一括生成';
      
      if (btn) {
        btn.disabled = true;
        btn.className = 'ml-3 px-3 py-1 text-xs bg-gray-400 text-white rounded-lg cursor-not-allowed whitespace-nowrap';
        const progressPercent = job.progress_percent || 0;
        btn.innerHTML = `<i class="fas fa-spinner fa-spin mr-1"></i>${progressPercent}%`;
      }
      
      startBulkAudioPolling(projectId, btn, originalContent);
    }
  } catch (error) {
    console.warn('[checkAndResumeBulkAudioJob] Error:', error);
  }
}

// グローバルに公開
window.checkAndResumeBulkAudioJob = checkAndResumeBulkAudioJob;

// グローバルに公開
window.generateAllMissingAudio = generateAllMissingAudio;

/**
 * PR-Audio-Bulk: 未生成音声確認ダイアログ
 * 動画ビルド時に未生成音声がある場合に表示
 * @param {number} missingCount - 未生成シーン数
 * @returns {Promise<'generate'|'skip'|'cancel'>}
 */
async function showAudioConfirmDialog(missingCount) {
  return new Promise((resolve) => {
    // モーダルを作成
    const modalHtml = `
      <div id="audioConfirmModal" class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
        <div class="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 overflow-hidden">
          <div class="bg-amber-500 px-4 py-3">
            <h3 class="text-lg font-bold text-white flex items-center">
              <i class="fas fa-exclamation-triangle mr-2"></i>
              未生成の音声があります
            </h3>
          </div>
          <div class="p-4">
            <p class="text-gray-700 mb-4">
              <strong>${missingCount}シーン</strong>で音声が生成されていません。<br>
              このまま動画を作成すると、該当シーンは無音になります。
            </p>

            <div class="flex flex-col gap-2">
              <button 
                id="audioConfirmGenerate" 
                class="w-full px-4 py-3 bg-purple-600 hover:bg-purple-700 text-white rounded-lg font-semibold transition-colors"
              >
                <i class="fas fa-volume-up mr-2"></i>先に音声を生成する（推奨）
              </button>
              <button 
                id="audioConfirmSkip" 
                class="w-full px-4 py-3 bg-gray-500 hover:bg-gray-600 text-white rounded-lg font-semibold transition-colors"
              >
                <i class="fas fa-volume-mute mr-2"></i>無音のまま動画を作成
              </button>
              <button 
                id="audioConfirmCancel" 
                class="w-full px-4 py-2 bg-gray-200 hover:bg-gray-300 text-gray-700 rounded-lg transition-colors"
              >
                キャンセル
              </button>
            </div>
          </div>
        </div>
      </div>
    `;
    
    document.body.insertAdjacentHTML('beforeend', modalHtml);
    
    const modal = document.getElementById('audioConfirmModal');
    const btnGenerate = document.getElementById('audioConfirmGenerate');
    const btnSkip = document.getElementById('audioConfirmSkip');
    const btnCancel = document.getElementById('audioConfirmCancel');
    
    const cleanup = () => {
      modal.remove();
    };
    
    btnGenerate.addEventListener('click', () => {
      cleanup();
      resolve('generate');
    });
    
    btnSkip.addEventListener('click', () => {
      cleanup();
      resolve('skip');
    });
    
    btnCancel.addEventListener('click', () => {
      cleanup();
      resolve('cancel');
    });
    
    // モーダル外クリックでキャンセル
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        cleanup();
        resolve('cancel');
      }
    });
    
    // ESCキーでキャンセル
    const handleEsc = (e) => {
      if (e.key === 'Escape') {
        cleanup();
        document.removeEventListener('keydown', handleEsc);
        resolve('cancel');
      }
    };
    document.addEventListener('keydown', handleEsc);
  });
}

// グローバルに公開
window.showAudioConfirmDialog = showAudioConfirmDialog;

// ==========================================
// Scene Hide/Restore Management (PR-SceneSplit-HiddenManager)
// ==========================================

// 現在選択中のタブ
let currentSceneTab = 'visible';
// 非表示シーンのキャッシュ
let hiddenScenesCache = [];
// 復元待ちのシーンID
let pendingRestoreSceneId = null;
let pendingRestoreSceneData = null;

/**
 * シーンタブの切り替え
 * @param {string} tab - 'visible' または 'hidden'
 */
window.switchSceneTab = async function(tab) {
  currentSceneTab = tab;
  
  const visibleTab = document.getElementById('visibleScenesTab');
  const hiddenTab = document.getElementById('hiddenScenesTab');
  const visibleContent = document.getElementById('visibleScenesContent');
  const hiddenContent = document.getElementById('hiddenScenesContent');
  
  // タブのスタイル更新
  if (tab === 'visible') {
    visibleTab.className = 'px-4 py-2 rounded-md font-semibold transition-all text-sm bg-white shadow text-gray-800';
    hiddenTab.className = 'px-4 py-2 rounded-md font-semibold transition-all text-sm text-gray-500 hover:text-gray-700';
    visibleContent.classList.remove('hidden');
    hiddenContent.classList.add('hidden');
    // シーン追加ボタン表示
    document.getElementById('addSceneBtn').classList.remove('hidden');
  } else {
    visibleTab.className = 'px-4 py-2 rounded-md font-semibold transition-all text-sm text-gray-500 hover:text-gray-700';
    hiddenTab.className = 'px-4 py-2 rounded-md font-semibold transition-all text-sm bg-white shadow text-gray-800';
    visibleContent.classList.add('hidden');
    hiddenContent.classList.remove('hidden');
    // 非表示タブではシーン追加ボタン非表示
    document.getElementById('addSceneBtn').classList.add('hidden');
    // 非表示シーンを読み込み
    await loadHiddenScenes();
  }
};

/**
 * 非表示シーン一覧を読み込み
 */
async function loadHiddenScenes() {
  try {
    const response = await axios.get(`${API_BASE}/projects/${PROJECT_ID}/scenes/hidden`);
    const hiddenScenes = response.data.hidden_scenes || [];
    hiddenScenesCache = hiddenScenes;
    
    // カウント更新
    document.getElementById('hiddenScenesCount').textContent = hiddenScenes.length;
    
    // レンダリング
    renderHiddenScenes(hiddenScenes);
  } catch (error) {
    console.error('Load hidden scenes error:', error);
    showToast('非表示シーンの読み込みに失敗しました', 'error');
  }
}
window.loadHiddenScenes = loadHiddenScenes;

/**
 * 非表示シーン一覧のレンダリング
 * @param {Array} scenes - 非表示シーンの配列
 */
function renderHiddenScenes(scenes) {
  const container = document.getElementById('hiddenScenesList');
  const emptyState = document.getElementById('hiddenScenesEmpty');
  
  if (scenes.length === 0) {
    container.classList.add('hidden');
    emptyState.classList.remove('hidden');
    return;
  }
  
  container.classList.remove('hidden');
  emptyState.classList.add('hidden');
  
  container.innerHTML = scenes.map(scene => {
    const hiddenDate = scene.hidden_at ? new Date(scene.hidden_at).toLocaleString('ja-JP') : '不明';
    const isManual = scene.is_manual;
    
    return `
      <div class="bg-white rounded-lg border border-gray-200 p-4 hover:border-blue-300 transition-colors" id="hidden-scene-${scene.id}">
        <div class="flex items-start justify-between">
          <div class="flex-1">
            <div class="flex items-center gap-2 mb-2">
              <span class="text-sm font-semibold text-gray-400">#(${Math.abs(scene.idx)})</span>
              <span class="font-semibold text-gray-800">${escapeHtml(scene.title || '無題')}</span>
              ${isManual ? `
                <span class="px-2 py-0.5 text-xs bg-green-100 text-green-700 rounded-full">手動追加</span>
              ` : `
                <span class="px-2 py-0.5 text-xs bg-gray-100 text-gray-600 rounded-full">原文由来</span>
              `}
            </div>
            <p class="text-sm text-gray-600 mb-2 line-clamp-2">
              ${scene.dialogue ? escapeHtml(scene.dialogue) : '<span class="text-gray-400 italic">セリフなし</span>'}
            </p>
            <div class="flex items-center gap-4 text-xs text-gray-500">
              <span><i class="fas fa-clock mr-1"></i>非表示日時: ${hiddenDate}</span>
              <span><i class="fas fa-image mr-1"></i>画像: ${scene.stats?.image_count || 0}枚</span>
              <span><i class="fas fa-comment mr-1"></i>発話: ${scene.stats?.utterance_count || 0}件</span>
            </div>
          </div>
          <button 
            onclick="showRestoreSceneModal(${scene.id})"
            class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-semibold text-sm"
          >
            <i class="fas fa-undo mr-1"></i>復元
          </button>
        </div>
      </div>
    `;
  }).join('');
}

/**
 * シーン復元確認モーダルを表示（2段階確認）
 * @param {number} sceneId - 復元対象のシーンID
 */
window.showRestoreSceneModal = function(sceneId) {
  const scene = hiddenScenesCache.find(s => s.id === sceneId);
  if (!scene) {
    showToast('シーン情報が見つかりません', 'error');
    return;
  }
  
  pendingRestoreSceneId = sceneId;
  pendingRestoreSceneData = scene;
  
  // モーダル内容を更新
  document.getElementById('restoreSceneTitle').innerHTML = `
    <i class="fas fa-file-alt mr-1"></i>
    ${escapeHtml(scene.title || '無題')}
    <span class="ml-2 text-xs text-blue-600 font-normal">${scene.is_manual ? '（手動追加）' : '（原文由来）'}</span>
  `;
  
  document.getElementById('restoreSceneStats').innerHTML = `
    <div class="flex gap-4">
      <span class="px-2 py-1 bg-gray-100 rounded">
        <i class="fas fa-image mr-1 text-blue-500"></i>画像: ${scene.stats?.image_count || 0}枚
      </span>
      <span class="px-2 py-1 bg-gray-100 rounded">
        <i class="fas fa-comment mr-1 text-green-500"></i>発話: ${scene.stats?.utterance_count || 0}件
      </span>
    </div>
  `;
  
  // モーダル表示
  document.getElementById('restoreSceneModal').classList.remove('hidden');
};

/**
 * シーン復元確認モーダルを閉じる
 */
window.closeRestoreSceneModal = function() {
  document.getElementById('restoreSceneModal').classList.add('hidden');
  pendingRestoreSceneId = null;
  pendingRestoreSceneData = null;
};

/**
 * シーン復元を実行（確認後）
 */
window.confirmRestoreScene = async function() {
  if (!pendingRestoreSceneId) {
    showToast('復元対象が選択されていません', 'error');
    return;
  }
  
  const sceneId = pendingRestoreSceneId;
  const btn = document.getElementById('restoreSceneConfirmBtn');
  const originalText = btn.innerHTML;
  
  try {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>復元中...';
    
    const response = await axios.post(`${API_BASE}/scenes/${sceneId}/restore`);
    
    if (response.data.success) {
      showToast(`シーンを復元しました（idx: ${response.data.new_idx}）`, 'success');
      closeRestoreSceneModal();
      
      // 非表示シーン一覧を再読み込み
      await loadHiddenScenes();
      
      // カウントを更新
      await updateSceneCounts();
    } else {
      throw new Error(response.data.error?.message || '復元に失敗しました');
    }
  } catch (error) {
    console.error('Restore scene error:', error);
    const errorMessage = error.response?.data?.error?.message || error.message || '復元に失敗しました';
    showToast(errorMessage, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
};

/**
 * シーン数を更新（表示中・非表示両方）
 */
async function updateSceneCounts() {
  try {
    // 表示中シーン数
    const visibleRes = await axios.get(`${API_BASE}/projects/${PROJECT_ID}/scenes?view=edit`);
    const visibleCount = visibleRes.data.total_scenes || 0;
    document.getElementById('scenesCount').textContent = visibleCount;
    
    // 非表示シーン数
    const hiddenRes = await axios.get(`${API_BASE}/projects/${PROJECT_ID}/scenes/hidden`);
    const hiddenCount = hiddenRes.data.total_hidden || 0;
    document.getElementById('hiddenScenesCount').textContent = hiddenCount;
  } catch (error) {
    console.error('Update scene counts error:', error);
  }
}

/**
 * シーン非表示後のカウント更新
 * hideScene完了後に呼び出される
 */
window.updateSceneCountsAfterHide = async function() {
  await updateSceneCounts();
};

// ページ読み込み時にタブ初期化
document.addEventListener('DOMContentLoaded', () => {
  // デフォルトで表示中タブを選択状態にする
  const visibleTab = document.getElementById('visibleScenesTab');
  if (visibleTab) {
    visibleTab.className = 'px-4 py-2 rounded-md font-semibold transition-all text-sm bg-white shadow text-gray-800';
  }
});
