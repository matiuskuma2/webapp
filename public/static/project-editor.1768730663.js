// API Base URL
const API_BASE = '/api';

// Global state
let currentProject = null;
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
document.addEventListener('DOMContentLoaded', () => {
  loadProject();
  
  // Text character counter
  const sourceText = document.getElementById('sourceText');
  if (sourceText) {
    sourceText.addEventListener('input', () => {
      const charCount = sourceText.value.length;
      document.getElementById('textCharCount').textContent = charCount;
    });
  }
  
  // Restore last active tab from localStorage
  const lastTab = localStorage.getItem('lastActiveTab');
  if (lastTab && ['input', 'sceneTab', 'builder', 'export'].includes(lastTab)) {
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
    currentProject = response.data;
    
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
    }
    
    // Enable/disable tabs based on status
    updateTabsAvailability();
    
    // Also update tab states for Export button
    updateTabStates(currentProject.status);
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

// Initialize Scene Split tab
async function initSceneSplitTab() {
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
    document.getElementById('goToBuilderBtn').classList.remove('hidden');
    // Hide character warning if scenes already exist
    document.getElementById('characterWarningSection')?.classList.add('hidden');
    renderScenes(scenes);
    document.getElementById('scenesCount').textContent = scenes.length;
    
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
      showToast('テキストが保存されました', 'success');
      await loadProject(); // Reload project to update status
      document.getElementById('nextStepGuide').classList.remove('hidden');
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

// Global polling state
let formatPollingInterval = null;
let formatPollingStartTime = null;
let currentFormatRunNo = null; // サポート用: 現在のrun_no
const FORMAT_TIMEOUT_MS = 10 * 60 * 1000; // 10分タイムアウト

// Format and split scenes with progress monitoring
async function formatAndSplit() {
  if (isProcessing) {
    showToast('処理中です。しばらくお待ちください', 'warning');
    return;
  }
  
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
    
    // Initial format call
    const response = await axios.post(`${API_BASE}/projects/${PROJECT_ID}/format`);
    
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
    
    // Start polling for progress
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
    
    // Hide progress UI and show format section
    document.getElementById('formatProgressUI')?.classList.add('hidden');
    document.getElementById('formatSection')?.classList.remove('hidden');
    
    // INVALID_STATUS (failed) の場合、復帰導線を表示
    if (error.response?.status === 400 && 
        error.response?.data?.error?.code === 'INVALID_STATUS' &&
        error.response?.data?.error?.details?.current_status === 'failed') {
      showFailedProjectRecoveryUI();
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
      
      console.log('Format polling status:', data.status, 'processed:', data.processed, 'pending:', data.pending, 'elapsed:', Math.round(elapsed/1000), 's');
      
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
      } else if (data.status === 'formatting') {
        // Continue polling and trigger next batch if pending > 0
        if (data.pending > 0 && data.processing === 0) {
          // Still have pending chunks, trigger next batch
          try {
            console.log('Triggering next batch: pending =', data.pending);
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
    
    // Reload project to get fresh status
    const projectResponse = await axios.get(`${API_BASE}/projects/${PROJECT_ID}`);
    currentProject = projectResponse.data;
    
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
  
  // Calculate failed count from either chunk_stats or direct failed field
  const failedCount = chunk_stats?.failed ?? failed ?? 0;
  
  // Show completion message
  if (failedCount > 0) {
    showToast(`完了！${total_scenes || 0}シーンを生成しました（一部チャンク失敗: ${failedCount}件）`, 'warning');
  } else {
    showToast(`完了！${total_scenes || 0}シーンを生成しました`, 'success');
  }
  
  // キャッシュクリア（新しいシーンが生成された）
  window.sceneSplitInitialized = false;
  
  // Reload project and scenes
  await loadProject();
  await loadScenes();
  
  // Hide format section
  document.getElementById('formatSection').classList.add('hidden');
  document.getElementById('scenesSection').classList.remove('hidden');
  
  isProcessing = false;
  setButtonLoading('formatBtn', false);
  
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
      
      // Format section を元に戻す
      const formatSection = document.getElementById('formatSection');
      formatSection.innerHTML = `
        <div class="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div>
            <h3 class="font-semibold text-gray-800 mb-1">RILARCシナリオ生成</h3>
            <p class="text-sm text-gray-600">OpenAI Chat APIで入力テキストをシーン分割します（30秒-1分）</p>
          </div>
          <button 
            id="formatBtn"
            onclick="formatAndSplit()"
            class="px-6 py-3 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors font-semibold whitespace-nowrap touch-manipulation"
          >
            <i class="fas fa-magic mr-2"></i>シーン分割を実行
          </button>
        </div>
      `;
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
    document.getElementById('goToBuilderBtn').classList.remove('hidden');
    
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
            id="deleteBtn-${scene.id}"
            onclick="deleteScene(${scene.id})"
            class="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors touch-manipulation"
          >
            <i class="fas fa-trash mr-1"></i>削除
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
          <label class="block text-sm font-semibold text-gray-700 mb-2">要点（1行1項目）</label>
          <textarea 
            id="bullets-${scene.id}"
            rows="3"
            placeholder="項目1&#10;項目2&#10;項目3"
            class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
          >${scene.bullets.join('\n')}</textarea>
        </div>
        
        <div>
          <label class="block text-sm font-semibold text-gray-700 mb-2">画像プロンプト</label>
          <textarea 
            id="imagePrompt-${scene.id}"
            rows="3"
            class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
          >${escapeHtml(scene.image_prompt)}</textarea>
        </div>
        
        ${charDisplay}
      </div>
    </div>
  `}).join('');
}

/**
 * Phase F-5: Open scene character edit modal
 * Uses WorldCharacterModal's assign feature, dynamically loading if needed
 */
async function openSceneCharacterEdit(sceneId) {
  // If WorldCharacterModal is not loaded, load it dynamically
  if (!window.WorldCharacterModal || typeof window.WorldCharacterModal.openAssign !== 'function') {
    showToast('キャラ割り当て画面を準備中...', 'info');
    
    try {
      // Load required scripts dynamically
      const scripts = [
        '/static/world-character-client.js',
        '/static/world-character-modal.js'
      ];
      
      for (const src of scripts) {
        if (document.querySelector(`script[src="${src}"]`)) continue;
        await new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = src;
          script.onload = resolve;
          script.onerror = reject;
          document.body.appendChild(script);
        });
      }
      
      // Wait for initialization (WorldCharacterModal may need time to setup)
      await new Promise(resolve => setTimeout(resolve, 300));
    } catch (err) {
      console.error('[openSceneCharacterEdit] Failed to load WorldCharacterModal:', err);
      showToast('キャラ割り当て機能の読み込みに失敗しました。Stylesタブを一度開いてから再試行してください。', 'error');
      return;
    }
  }
  
  // Now try to use WorldCharacterModal
  if (window.WorldCharacterModal && typeof window.WorldCharacterModal.openAssign === 'function') {
    window.WorldCharacterModal.openAssign(sceneId);
  } else {
    showToast('キャラ割り当て機能が利用できません。Stylesタブを一度開いてから再試行してください。', 'warning');
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

// Delete scene (行単位ロック)
async function deleteScene(sceneId) {
  if (!confirm('このシーンを削除してもよろしいですか？')) {
    return;
  }
  
  // 行単位チェック
  if (window.sceneProcessing[sceneId]) {
    showToast('このシーンは処理中です', 'warning');
    return;
  }
  
  window.sceneProcessing[sceneId] = true;
  setButtonLoading(`deleteBtn-${sceneId}`, true);
  
  try {
    const response = await axios.delete(`${API_BASE}/scenes/${sceneId}`);
    
    if (response.data.success) {
      showToast('シーンを削除しました', 'success');
      // キャッシュクリア（削除を反映）
      window.sceneSplitInitialized = false;
      await loadScenes(); // Reload scenes (idx will be re-numbered)
    } else {
      showToast('シーンの削除に失敗しました', 'error');
    }
  } catch (error) {
    console.error('Delete scene error:', error);
    showToast('シーン削除中にエラーが発生しました', 'error');
  } finally {
    window.sceneProcessing[sceneId] = false;
    setButtonLoading(`deleteBtn-${sceneId}`, false);
  }
}

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
    
    // ✅ Bind Auto-Assign button in Builder tab (Phase F-6 fix)
    bindBuilderAutoAssignButton();
    
    // Update tab states based on current project status
    const projectResponse = await axios.get(`${API_BASE}/projects/${PROJECT_ID}`);
    updateTabStates(projectResponse.data.status);
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
  '</div>';
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
 * Render scene text content (dialogue, bullets, prompt, style)
 * @param {object} scene 
 * @returns {string} HTML
 */
function renderSceneTextContent(scene) {
  // Phase1.7: display_asset_type に応じてセリフ表示を切替
  const displayAssetType = scene.display_asset_type || 'image';
  const isComicMode = displayAssetType === 'comic';
  const hasComicUtterances = scene.comic_data?.published?.utterances?.length > 0 || scene.comic_data?.draft?.utterances?.length > 0;
  
  return `
    <div class="space-y-4">
      <!-- セリフ -->
      <div>
        <label class="block text-sm font-semibold text-gray-700 mb-2">
          ${isComicMode && hasComicUtterances 
            ? '<i class="fas fa-comment-alt mr-1 text-orange-500"></i>発話（漫画用・最大3件）'
            : 'セリフ'
          }
        </label>
        ${isComicMode && hasComicUtterances
          ? `<div class="p-3 bg-orange-50 rounded-lg border border-orange-200">
               ${renderComicUtterances(scene)}
             </div>`
          : `<div class="p-3 bg-gray-50 rounded-lg border border-gray-200 text-gray-800 whitespace-pre-wrap text-sm">
${escapeHtml(scene.dialogue)}
             </div>`
        }
      </div>
      
      <!-- ★ Phase F-7: Audio section moved directly under dialogue -->
      <!-- Phase1.7: 漫画モード時は音声セクションを発話ごとの形式に変更 -->
      ${isComicMode && hasComicUtterances
        ? renderComicAudioSection(scene)
        : renderSceneAudioSection(scene)
      }
      
      ${scene.bullets && scene.bullets.length > 0 ? `
      <div>
        <label class="block text-sm font-semibold text-gray-700 mb-2">要点</label>
        <ul class="list-disc list-inside space-y-1 text-sm text-gray-700">
          ${scene.bullets.map(b => `<li>${escapeHtml(b)}</li>`).join('')}
        </ul>
      </div>
      ` : ''}
      
      <div>
        <label class="block text-sm font-semibold text-gray-700 mb-2">画像プロンプト</label>
        <textarea 
          id="builderPrompt-${scene.id}"
          rows="3"
          class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
        >${escapeHtml(scene.image_prompt)}</textarea>
      </div>
      
      <!-- Image Characters (Phase F-6: Moved here, under prompt) -->
      ${renderImageCharacterSection(scene)}
      
      <!-- Style Selector -->
      <div>
        <label class="block text-sm font-semibold text-gray-700 mb-2">
          <i class="fas fa-palette mr-1 text-purple-600"></i>スタイル
        </label>
        <div class="flex gap-2">
          <select 
            id="sceneStyle-${scene.id}"
            class="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 text-sm"
            onchange="setSceneStyle(${scene.id})"
          >
            ${renderStyleOptions(scene.style_preset_id)}
          </select>
          ${scene.style_preset_id 
            ? `<button 
                 onclick="clearSceneStyle(${scene.id})"
                 class="px-3 py-2 bg-gray-300 text-gray-700 rounded-lg hover:bg-gray-400 transition-colors text-sm whitespace-nowrap"
                 title="デフォルトに戻す"
               >
                 <i class="fas fa-times"></i>
               </button>`
            : ''
          }
        </div>
        <p class="text-xs text-gray-500 mt-1">
          ${scene.style_preset_id 
            ? 'シーン専用スタイル設定中' 
            : window.builderProjectDefaultStyle 
              ? 'プロジェクトデフォルトを使用' 
              : '未設定（オリジナルプロンプト）'}
        </p>
      </div>
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
  
  // Phase1.5: display_asset_type に基づく表示切替
  const displayAssetType = scene.display_asset_type || 'image';
  const activeComic = scene.active_comic || null;
  const comicUrl = activeComic?.r2_url || activeComic?.image_url || null;
  const hasPublishedComic = !!comicUrl;
  
  // Phase1.7: latest_image からもフォールバック
  const latestImage = scene.latest_image || null;
  const latestImageUrl = (latestImage?.status === 'completed') ? (latestImage?.r2_url || latestImage?.image_url) : null;
  
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
  
  return `
    <!-- 画像/漫画エリア（常に表示） -->
    <div class="scene-image-container relative aspect-video bg-gray-100 rounded-lg border-2 ${isShowingComic ? 'border-orange-400' : 'border-gray-300'} overflow-hidden">
      ${displayUrl 
        ? `<img 
             id="sceneImage-${scene.id}" 
             src="${displayUrl}" 
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
    

    
    <!-- Phase1.7: 採用切替ボタン（公開漫画がある場合に表示、imageUrlの有無は問わない） -->
    ${hasPublishedComic ? `
    <div class="flex gap-2 mt-2">
      <button 
        onclick="switchDisplayAssetType(${scene.id}, 'image')"
        class="flex-1 px-3 py-1.5 rounded-lg text-sm font-semibold transition-colors ${
          displayAssetType === 'image' 
            ? 'bg-blue-600 text-white' 
            : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
        }"
        ${!imageUrl && !latestImageUrl ? 'disabled title="AI画像がありません"' : ''}
      >
        <i class="fas fa-image mr-1"></i>画像を採用
      </button>
      <button 
        onclick="switchDisplayAssetType(${scene.id}, 'comic')"
        class="flex-1 px-3 py-1.5 rounded-lg text-sm font-semibold transition-colors ${
          displayAssetType === 'comic' 
            ? 'bg-orange-600 text-white' 
            : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
        }"
      >
        <i class="fas fa-comment-alt mr-1"></i>漫画を採用
      </button>
    </div>
    ` : ''}
    
    <!-- 動画エリア（completedの場合のみ表示） -->
    <!-- Phase1.7: 動画サムネイルは常にAI画像を使用（動画は元画像から生成されたため） -->
    ${hasCompletedVideo 
      ? `<div class="scene-video-container relative aspect-video bg-gray-900 rounded-lg border-2 border-purple-400 overflow-hidden mt-3">
           <video 
             id="sceneVideo-${scene.id}" 
             src="${activeVideo.r2_url}" 
             class="w-full h-full object-contain"
             controls
             preload="metadata"
             poster="${imageUrl || ''}"
             onerror="refreshVideoUrl(${activeVideo.id}, ${scene.id})"
           >
             <source src="${activeVideo.r2_url}" type="video/mp4">
           </video>
           <div class="absolute top-2 left-2 px-2 py-1 bg-purple-600 text-white text-xs rounded-full font-semibold">
             <i class="fas fa-video mr-1"></i>動画 (${activeVideo.duration_sec || 5}秒)
           </div>
         </div>`
      : ''
    }
  `;
}

/**
 * Phase1.5: 採用切替（画像 ↔ 漫画）
 * Phase1.7: リアルタイムUI更新（スクロール位置を維持）
 */
async function switchDisplayAssetType(sceneId, newType) {
  try {
    showToast(`${newType === 'comic' ? '漫画' : '画像'}に切り替え中...`, 'info');
    
    const res = await axios.put(`/api/scenes/${sceneId}/display-asset-type`, {
      display_asset_type: newType
    });
    
    if (res.data.success) {
      showToast(`${newType === 'comic' ? '漫画' : '画像'}を採用しました`, 'success');
      
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
  console.log(`[refreshVideoUrl] Refreshing video ${videoId} for scene ${sceneId}`);
  try {
    // ステータスAPIを呼び出して最新のpresigned URLを取得
    const res = await axios.get(`${API_BASE}/videos/${videoId}/status`);
    if (res.data.r2_url) {
      const videoEl = document.getElementById(`sceneVideo-${sceneId}`);
      if (videoEl) {
        // onerrorを一時的に無効化して無限ループを防ぐ
        videoEl.onerror = null;
        videoEl.src = res.data.r2_url;
        // sourceタグも更新
        const source = videoEl.querySelector('source');
        if (source) {
          source.src = res.data.r2_url;
        }
        videoEl.load();
        console.log(`[refreshVideoUrl] Updated video URL for scene ${sceneId}`);
        showToast('動画URLを更新しました', 'success');
      }
    } else if (res.data.status === 'failed') {
      showToast('動画の生成に失敗しています', 'error');
    } else {
      showToast('動画URLの取得に失敗しました', 'error');
    }
  } catch (e) {
    console.error('[refreshVideoUrl] Error:', e);
    showToast('動画の再読み込みに失敗しました', 'error');
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
          ${renderSceneTextContent(scene)}
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
          
          <!-- 動画エリア（completedの場合のみ表示）の後に動画化ボタン -->
          <div class="flex gap-2">
            <button 
              id="videoBtn-${scene.id}"
              onclick="openVideoModal(${scene.id})"
              class="flex-1 px-4 py-2 rounded-lg font-semibold touch-manipulation ${
                disableVideoGen
                  ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                  : (window.videoGenerating && window.videoGenerating[scene.id])
                    ? 'bg-yellow-500 text-white opacity-75 cursor-not-allowed'
                    : (imageStatus === 'completed' 
                      ? 'bg-purple-600 text-white hover:bg-purple-700 transition-colors' 
                      : 'bg-gray-300 text-gray-500 cursor-not-allowed')
              }"
              ${disableVideoGen || (imageStatus !== 'completed') || (window.videoGenerating && window.videoGenerating[scene.id]) ? 'disabled' : ''}
              title="${
                disableVideoGen 
                  ? '漫画採用中は動画化できません。漫画の動画化はRemotionで行います。'
                  : (window.videoGenerating && window.videoGenerating[scene.id]) 
                    ? '動画生成中...' 
                    : (imageStatus !== 'completed' ? '画像生成完了後に利用可能' : '動画を生成')
              }"
            >
              <i class="fas fa-video mr-2"></i>${disableVideoGen ? '動画化不可' : '動画化'}
            </button>
            <button 
              id="videoHistoryBtn-${scene.id}"
              onclick="viewVideoHistory(${scene.id})"
              class="px-4 py-2 rounded-lg font-semibold touch-manipulation bg-gray-600 text-white hover:bg-gray-700 transition-colors"
              title="動画履歴"
            >
              <i class="fas fa-film"></i>
            </button>
          </div>
          
          ${isFailed && errorMessage ? `
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
      
      // ✅ Also disable video button during image generation
      const videoBtn = document.getElementById(`videoBtn-${sceneId}`);
      if (videoBtn) {
        videoBtn.disabled = true;
        videoBtn.classList.remove('bg-purple-600', 'hover:bg-purple-700');
        videoBtn.classList.add('bg-gray-300', 'text-gray-500', 'cursor-not-allowed');
      }
      break;

    case 'completed':
    case 'done':
      // Green button: "再生成"
      primaryBtn.classList.add('bg-green-600', 'hover:bg-green-700');
      primaryBtn.disabled = false;
      primaryBtn.onclick = () => regenerateSceneImage(sceneId);
      primaryBtn.innerHTML = `<i class="fas fa-redo mr-2"></i>再生成`;
      
      // ✅ Enable video button when image is completed
      const videoBtnDone = document.getElementById(`videoBtn-${sceneId}`);
      if (videoBtnDone) {
        videoBtnDone.disabled = false;
        videoBtnDone.classList.remove('bg-gray-300', 'text-gray-500', 'cursor-not-allowed');
        videoBtnDone.classList.add('bg-purple-600', 'text-white', 'hover:bg-purple-700');
      }
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
      const errorMsg = error.response.data?.error?.message || error.message || '画像生成中にエラーが発生しました';
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
  
  if (mode === 'all' && stats.completed === total && total > 0) {
    showToast('すべての画像は生成済みです', 'info');
    return;
  }
  if (mode === 'pending' && stats.pending === 0) {
    showToast('未生成の画像はありません', 'info');
    return;
  }
  if (mode === 'failed' && stats.failed === 0) {
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
    
    // 5秒ごとにステータスポーリング & 自動再実行
    let pollCount = 0;
    const maxPolls = 300; // 最大25分（5秒 x 300回）
    
    while (pollCount < maxPolls) {
      // 1) 現在のステータス取得
      const statusRes = await axios.get(`${API_BASE}/projects/${PROJECT_ID}/generate-images/status`);
      const { processed, pending, failed, generating, status } = statusRes.data;
      
      // UI更新（進捗表示）
      const progressText = `画像生成中... (${processed}/${processed + pending + failed})`;
      const btn = document.getElementById(buttonId);
      if (btn) {
        btn.innerHTML = `<i class="fas fa-spinner fa-spin mr-2"></i>${progressText}`;
      }
      
      // 🎯 BULK PROGRESS: Update per-scene progress
      try {
        const scenesRes = await axios.get(`${API_BASE}/projects/${PROJECT_ID}/scenes?view=board`);
        const scenes = scenesRes.data.scenes || [];
        
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
            
            return `
              <div class="border-2 ${img.is_active ? 'border-blue-600' : 'border-gray-200'} rounded-lg overflow-hidden relative">
                ${typeLabel}
                <div class="aspect-video bg-gray-100">
                  <img src="${img.image_url}" alt="Generated image" class="w-full h-full object-cover" />
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
  if (!text) return '';
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

// HTML escape utility
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
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
      if (imageUrl && (imageStatus === 'completed' || activeImage)) {
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
      
      if (isGenerating || isProcessing) {
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
        const existingBtn = document.getElementById(`primaryBtn-${sceneId}`);
        console.log(`[UpdateScene] Complete/Failed/Idle state - existingBtn: ${!!existingBtn}, hasImage: ${hasImage}, isFailed: ${isFailed}`);
        
        if (!existingBtn) {
          console.log(`[UpdateScene] Creating new buttons for scene ${sceneId}`);
          actionBtnContainer.innerHTML = `
            <button id="primaryBtn-${sceneId}" class="flex-1 px-4 py-2 bg-gray-300 text-white rounded-lg font-semibold touch-manipulation">
              <i class="fas fa-spinner fa-spin mr-2"></i>読み込み中...
            </button>
            <button id="historyBtn-${sceneId}" onclick="viewImageHistory(${sceneId})" class="px-4 py-2 bg-gray-300 text-white rounded-lg font-semibold touch-manipulation">
              <i class="fas fa-history mr-2"></i>履歴
            </button>
          `;
        } else {
          console.log(`[UpdateScene] Keeping existing buttons for scene ${sceneId}`);
        }
        
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
    let errorContainer = sceneCard.querySelector('.scene-error-message');
    if (imageStatus === 'failed' && errorMessage) {
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
    
    // If all images are completed but project status is still "generating_images"
    if (pending === 0 && generating === 0 && status === 'generating_images') {
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

// Get scene status badge HTML
function getSceneStatusBadge(status) {
  const statusMap = {
    'pending': '<span class="px-2 py-1 bg-gray-100 text-gray-800 text-xs rounded">未生成</span>',
    'generating': '<span class="px-2 py-1 bg-yellow-100 text-yellow-800 text-xs rounded">生成中</span>',
    'completed': '<span class="px-2 py-1 bg-green-100 text-green-800 text-xs rounded">生成済み</span>',
    'failed': '<span class="px-2 py-1 bg-red-100 text-red-800 text-xs rounded">失敗</span>'
  };
  return statusMap[status] || statusMap['pending'];
}

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
        // ⚠️ DON'T stop watch (allow manual resume)
        
        showToast(`画像生成に時間がかかっています（シーン${sceneId}）。通信状況を確認してください`, 'warning');
        console.warn(`[Poll] Scene ${sceneId} timeout after ${maxAttempts} attempts. Watch NOT removed (can resume).`);
        
        // Reset attempts to allow continuation
        watch.attempts = 0;
        watch.startedAt = Date.now();
        return;
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
function openSceneEditModal(sceneId) {
  if (window.SceneEditModal) {
    window.SceneEditModal.open(sceneId);
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
    videoBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>キュー待ち...';
    videoBtn.className = 'flex-1 px-4 py-2 rounded-lg font-semibold touch-manipulation bg-yellow-500 text-white opacity-75 cursor-not-allowed';
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
        videoBtn.innerHTML = `<i class="fas fa-spinner fa-spin mr-2"></i>${stageInfo.text} (${elapsedStr})`;
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
        
        showToast('動画生成が完了しました！履歴ボタンから確認できます', 'success');
        
        // Update button
        if (videoBtn) {
          videoBtn.disabled = false;
          videoBtn.innerHTML = '<i class="fas fa-video mr-2"></i>動画化';
          videoBtn.className = 'flex-1 px-4 py-2 rounded-lg font-semibold touch-manipulation bg-purple-600 text-white hover:bg-purple-700 transition-colors';
        }
        
        restorePrimaryBtn();
        
        // NOTE: Do NOT auto-open video history modal - it's disruptive
        // User can click the history button to view completed video
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
          videoBtn.innerHTML = '<i class="fas fa-video mr-2"></i>動画化';
          videoBtn.className = 'flex-1 px-4 py-2 rounded-lg font-semibold touch-manipulation bg-purple-600 text-white hover:bg-purple-700 transition-colors';
        }
        
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
          videoBtn.innerHTML = '<i class="fas fa-video mr-2"></i>動画化';
          videoBtn.className = 'flex-1 px-4 py-2 rounded-lg font-semibold touch-manipulation bg-purple-600 text-white hover:bg-purple-700 transition-colors';
        }
        
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
               onerror="this.parentElement.innerHTML='<div class=\\'flex items-center justify-center h-full text-gray-500 text-sm\\'><i class=\\'fas fa-exclamation-triangle mr-2 text-yellow-500\\'></i>動画URLが期限切れです。再生成してください</div>'"
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
        ${video.prompt ? `
          <p class="text-xs text-gray-600 line-clamp-2">${escapeHtml(video.prompt)}</p>
        ` : ''}
        <div class="text-xs text-gray-500 space-y-1">
          <p><i class="fas fa-clock mr-1"></i>${createdAt}</p>
          ${video.status === 'completed' ? `
            <p class="text-orange-600">
              <i class="fas fa-hourglass-half mr-1"></i>あと${daysLeft}日で削除
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
 * Phase R1: 新しい preflight API を使用
 */
async function updateVideoBuildRequirements() {
  const reqEl = document.getElementById('videoBuildRequirements');
  if (!reqEl) return;
  
  // Usage info
  const usage = window.videoBuildUsageCache || {};
  const isAtLimit = (usage.monthly_builds || 0) >= 30;
  const hasConcurrent = (usage.concurrent_builds || 0) >= 1;
  
  let html = '<div class="space-y-1">';
  
  // Call preflight API for accurate check
  try {
    const response = await axios.get(`${API_BASE}/projects/${PROJECT_ID}/video-builds/preflight`);
    const preflight = response.data;
    
    // Store preflight result for button state
    window.videoBuildPreflightCache = preflight;
    
    if (preflight.total_count === 0) {
      html += '<div class="flex items-center text-amber-600"><i class="fas fa-exclamation-triangle mr-2"></i>シーンがありません</div>';
    } else if (!preflight.is_ready) {
      html += '<div class="flex items-center text-amber-600"><i class="fas fa-exclamation-triangle mr-2"></i>素材が不足しています（' + preflight.ready_count + '/' + preflight.total_count + '）</div>';
      
      // Show missing details
      if (preflight.missing && preflight.missing.length > 0) {
        html += '<div class="ml-4 mt-1 text-sm text-gray-500">';
        preflight.missing.slice(0, 3).forEach(m => {
          html += '<div>• シーン' + m.scene_idx + ': ' + m.reason + '</div>';
        });
        if (preflight.missing.length > 3) {
          html += '<div>• 他 ' + (preflight.missing.length - 3) + ' 件...</div>';
        }
        html += '</div>';
      }
    } else {
      html += '<div class="flex items-center text-green-600"><i class="fas fa-check-circle mr-2"></i>' + preflight.total_count + 'シーン準備完了</div>';
    }
    
    // Show warnings (audio missing etc)
    if (preflight.warnings && preflight.warnings.length > 0) {
      html += '<div class="flex items-center text-amber-500 mt-1"><i class="fas fa-info-circle mr-2"></i>音声未生成: ' + preflight.warnings.length + 'シーン（動画生成は可能）</div>';
    }
    
    // Scene count warning (Phase 1: warn for large videos)
    const SCENE_WARN_THRESHOLD = 50;
    const SCENE_LIMIT_THRESHOLD = 100;
    if (preflight.total_count > SCENE_LIMIT_THRESHOLD) {
      html += '<div class="flex items-center text-red-600 mt-2"><i class="fas fa-exclamation-circle mr-2"></i><span>' + preflight.total_count + 'シーンは現在の上限（' + SCENE_LIMIT_THRESHOLD + '）を超えています。</span></div>';
    } else if (preflight.total_count > SCENE_WARN_THRESHOLD) {
      html += '<div class="flex items-center text-amber-600 mt-2"><i class="fas fa-clock mr-2"></i><span>' + preflight.total_count + 'シーン: レンダリングに時間がかかる場合があります</span></div>';
    }
    
  } catch (error) {
    console.error('[VideoBuild] Preflight error:', error);
    // Fallback to local check
    const scenes = window.lastLoadedScenes || [];
    const hasScenes = scenes.length > 0;
    
    // SSOT: display_asset_type に応じたチェック
    const scenesReady = scenes.filter(s => {
      const displayType = s.display_asset_type || 'image';
      if (displayType === 'comic') return s.active_comic?.r2_url;
      if (displayType === 'video') return s.active_video?.status === 'completed' && s.active_video?.r2_url;
      return s.active_image?.r2_url;
    }).length;
    
    window.videoBuildPreflightCache = {
      is_ready: hasScenes && scenesReady === scenes.length,
      ready_count: scenesReady,
      total_count: scenes.length,
      missing: [],
      warnings: []
    };
    
    if (!hasScenes) {
      html += '<div class="flex items-center text-amber-600"><i class="fas fa-exclamation-triangle mr-2"></i>シーンがありません</div>';
    } else if (scenesReady < scenes.length) {
      html += '<div class="flex items-center text-amber-600"><i class="fas fa-exclamation-triangle mr-2"></i>素材が不足しています（' + scenesReady + '/' + scenes.length + '）</div>';
    } else {
      html += '<div class="flex items-center text-green-600"><i class="fas fa-check-circle mr-2"></i>' + scenes.length + 'シーン準備完了</div>';
    }
  }
  
  // Usage check
  if (isAtLimit) {
    html += '<div class="flex items-center text-red-600"><i class="fas fa-ban mr-2"></i>今月の上限に達しています</div>';
  }
  
  // Concurrent check
  if (hasConcurrent) {
    html += '<div class="flex items-center text-amber-600"><i class="fas fa-hourglass-half mr-2"></i>現在処理中のビルドがあります</div>';
  }
  
  html += '</div>';
  reqEl.innerHTML = html;
  
  // Update button state
  updateVideoBuildButtonState();
}

/**
 * Update video build button state
 * Phase R1: Use preflight cache from updateVideoBuildRequirements()
 */
function updateVideoBuildButtonState() {
  const btn = document.getElementById('btnStartVideoBuild');
  if (!btn) return;
  
  // Use preflight cache (SSOT-based validation)
  const preflight = window.videoBuildPreflightCache || {};
  const hasScenes = (preflight.total_count || 0) > 0;
  const allScenesReady = preflight.is_ready === true;
  
  const usage = window.videoBuildUsageCache || {};
  const isAtLimit = (usage.monthly_builds || 0) >= 30;
  const hasConcurrent = (usage.concurrent_builds || 0) >= 1;
  
  // Phase 1: Limit to 100 scenes until segment rendering is implemented
  const SCENE_LIMIT_THRESHOLD = 100;
  const exceedsSceneLimit = (preflight.total_count || 0) > SCENE_LIMIT_THRESHOLD;
  
  const canStart = allScenesReady && !isAtLimit && !hasConcurrent && !exceedsSceneLimit;
  btn.disabled = !canStart;
  
  console.log('[VideoBuild] Button state:', { 
    canStart, allScenesReady, isAtLimit, hasConcurrent, exceedsSceneLimit,
    preflight_ready: preflight.is_ready,
    preflight_count: preflight.ready_count + '/' + preflight.total_count
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

/**
 * Render a single video build item
 */
function renderVideoBuildItem(build) {
  const statusInfo = getVideoBuildStatusInfo(build.status);
  // Parse UTC datetime and convert to Japan timezone
  const createdAtUtc = build.created_at.replace(' ', 'T') + 'Z';
  const createdAt = new Date(createdAtUtc).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
  
  let actionHtml = '';
  let expiryHtml = '';
  
  if (build.status === 'completed' && build.download_url) {
    // Calculate expiry
    const expiry = formatDownloadExpiry(build);
    
    if (expiry === 'expired') {
      // URL expired - show refresh button
      actionHtml = `
        <div class="flex flex-col items-end gap-2">
          <button 
            onclick="refreshVideoBuildDownload(${build.id})"
            class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm font-semibold flex items-center gap-2"
          >
            <i class="fas fa-sync-alt"></i>URL再取得
          </button>
          <span class="text-xs text-amber-600">
            <i class="fas fa-exclamation-triangle mr-1"></i>URLの期限が切れています
          </span>
        </div>
      `;
    } else {
      // Valid URL
      actionHtml = `
        <a 
          href="${build.download_url}" 
          target="_blank"
          class="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors text-sm font-semibold flex items-center gap-2"
        >
          <i class="fas fa-download"></i>ダウンロード
        </a>
      `;
      
      if (expiry) {
        expiryHtml = `
          <p class="text-xs text-gray-500 mt-1">
            <i class="fas fa-clock mr-1"></i>期限: ${expiry}
          </p>
        `;
      }
    }
  } else if (build.status === 'completed' && !build.download_url) {
    // Completed but no URL yet - need to refresh
    actionHtml = `
      <button 
        onclick="refreshVideoBuildDownload(${build.id})"
        class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-sm font-semibold flex items-center gap-2"
      >
        <i class="fas fa-sync-alt"></i>URL取得
      </button>
    `;
  } else if (build.status === 'failed') {
    actionHtml = `
      <div class="flex items-center gap-2">
        <button 
          onclick="toggleVideoBuildError(${build.id})"
          class="px-3 py-2 text-red-600 hover:bg-red-50 rounded-lg transition-colors text-sm flex items-center gap-1"
        >
          <i class="fas fa-info-circle"></i>詳細
        </button>
        <button 
          onclick="retryVideoBuild(${build.id})"
          class="px-4 py-2 bg-amber-600 text-white rounded-lg hover:bg-amber-700 transition-colors text-sm font-semibold flex items-center gap-2"
        >
          <i class="fas fa-redo"></i>再試行
        </button>
      </div>
    `;
  }
  
  let progressHtml = '';
  if (['rendering', 'uploading'].includes(build.status) && build.progress_percent !== null) {
    progressHtml = `
      <div class="mt-2 w-full bg-gray-200 rounded-full h-2">
        <div class="h-full bg-blue-500 rounded-full transition-all" style="width: ${build.progress_percent}%"></div>
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
            <button 
              onclick="navigator.clipboard.writeText('${errorCode}: ${errorMessage.replace(/'/g, "\\'")}'); showToast('エラー情報をコピーしました', 'success');"
              class="mt-2 text-xs text-red-500 hover:text-red-700 underline"
            >
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
    retryHtml = `
      <p class="text-xs text-amber-600 mt-1">
        <i class="fas fa-hourglass-half mr-1"></i>自動再試行中（あと最大${remaining}回）
      </p>
    `;
  }
  
  return `
    <div class="p-4 hover:bg-gray-50 transition-colors" data-build-id="${build.id}">
      <div class="flex items-center justify-between gap-4">
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-3">
            <span class="text-2xl">${statusInfo.icon}</span>
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="font-mono text-gray-500 text-sm">#${build.id}</span>
                <span class="text-sm font-semibold ${statusInfo.textColor}">${statusInfo.label}</span>
                ${build.is_delegation ? '<span class="text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded" title="管理者代行で実行">🔁 代行</span>' : ''}
              </div>
              <p class="text-xs text-gray-500">${createdAt}</p>
              ${expiryHtml}
              ${retryHtml}
            </div>
          </div>
          ${progressHtml}
        </div>
        <div class="flex-shrink-0">
          ${actionHtml}
        </div>
      </div>
      ${errorHtml}
    </div>
  `;
}

/**
 * Refresh video build to get new presigned URL
 * @param {number} buildId 
 */
async function refreshVideoBuildDownload(buildId) {
  try {
    showToast('ダウンロードURLを取得中...', 'info');
    
    const response = await axios.post(`${API_BASE}/video-builds/${buildId}/refresh`);
    
    if (response.data.status === 'completed' && response.data.output?.presigned_url) {
      // Update cache
      const idx = window.videoBuildListCache.findIndex(b => b.id === buildId);
      if (idx >= 0) {
        window.videoBuildListCache[idx].download_url = response.data.output.presigned_url;
        window.videoBuildListCache[idx].render_completed_at = window.videoBuildListCache[idx].render_completed_at || new Date().toISOString();
      }
      
      // Reload list
      await loadVideoBuilds();
      
      showToast('新しいダウンロードURLを取得しました', 'success');
    } else {
      throw new Error('URLの取得に失敗しました');
    }
  } catch (error) {
    console.error('[VideoBuild] Refresh download error:', error);
    showToast('ダウンロードURLの取得に失敗しました', 'error');
  }
}

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
 * Show progress section
 */
function showVideoBuildProgress(build) {
  const progressEl = document.getElementById('videoBuildProgress');
  if (!progressEl) return;
  
  const statusInfo = getVideoBuildStatusInfo(build.status);
  
  document.getElementById('videoBuildProgressIcon').textContent = statusInfo.icon;
  document.getElementById('videoBuildProgressTitle').textContent = statusInfo.label;
  document.getElementById('videoBuildProgressPercent').textContent = `${build.progress_percent || 0}%`;
  document.getElementById('videoBuildProgressBar').style.width = `${build.progress_percent || 0}%`;
  document.getElementById('videoBuildProgressStage').textContent = build.progress_stage || '準備中...';
  document.getElementById('videoBuildProgressId').textContent = `#${build.id}`;
  
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
 * Start video build
 */
async function startVideoBuild() {
  const btn = document.getElementById('btnStartVideoBuild');
  if (!btn || btn.disabled) return;
  
  // Gather settings
  const buildSettings = {
    captions: {
      enabled: document.getElementById('videoBuildCaptions')?.checked ?? true
    },
    background_music: {
      enabled: document.getElementById('videoBuildBgm')?.checked ?? false,
      ducking: true
    },
    motion: {
      ken_burns: document.getElementById('videoBuildMotion')?.checked ?? true
    }
  };
  
  // Confirm
  if (!confirm('動画生成を開始しますか？\\n\\n処理には数分かかる場合があります。')) {
    return;
  }
  
  // Disable button
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i>送信中...';
  
  try {
    const response = await axios.post(`${API_BASE}/projects/${PROJECT_ID}/video-builds`, {
      build_settings: buildSettings
    });
    
    if (response.data.success) {
      showToast('動画生成を開始しました', 'success');
      
      // Reload builds
      await loadVideoBuilds();
      
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
    } else if (errorCode === 'AWS_ORCHESTRATOR_ERROR') {
      const awsError = error.response?.data?.error?.details?.aws_error || '';
      if (awsError.includes('Rate') || awsError.includes('Concurrency')) {
        errorMsg = '現在、動画生成が混み合っています。\n数分後に自動で再試行されます。';
      }
    }
    
    showToast(errorMsg, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-film mr-2"></i>動画生成を開始';
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
      
      const response = await axios.post(`${API_BASE}/video-builds/${build.id}/refresh`);
      const updatedBuild = response.data.video_build;
      
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
      
      // Update project status in cache (both local and window scope)
      currentProject.status = response.data.reset_to;
      if (window.currentProject) {
        window.currentProject.status = response.data.reset_to;
      }
      
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
