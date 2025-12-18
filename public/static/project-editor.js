// API Base URL
const API_BASE = '/api';

// Global state
let currentProject = null;
let isProcessing = false; // ボタン連打防止用フラグ（グローバル処理用）
let sceneProcessing = {}; // 行単位ロック用 { sceneId: boolean }
let mediaRecorder = null;
let audioChunks = [];
let recordingStartTime = 0;
let recordingTimer = null;

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
    sceneSplitTab.classList.remove('opacity-50', 'cursor-not-allowed');
  }
  
  // Builder tab: enabled if formatted or later
  if (currentProject.status === 'formatted' || currentProject.status === 'generating_images' || 
      currentProject.status === 'completed') {
    builderTab.disabled = false;
    builderTab.classList.remove('opacity-50', 'cursor-not-allowed');
  }
  
  // Export tab: enabled if completed
  if (currentProject.status === 'completed') {
    exportTab.disabled = false;
    exportTab.classList.remove('opacity-50', 'cursor-not-allowed');
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
  const tabs = ['Input', 'SceneSplit', 'Builder', 'Export', 'Styles'];
  tabs.forEach(tab => {
    document.getElementById(`tab${tab}`).classList.remove('tab-active');
    document.getElementById(`tab${tab}`).classList.add('tab-inactive');
    document.getElementById(`content${tab}`).classList.add('hidden');
  });
  
  // Add active class to selected tab
  const targetTab = tabName.charAt(0).toUpperCase() + tabName.slice(1);
  document.getElementById(`tab${targetTab}`).classList.add('tab-active');
  document.getElementById(`tab${targetTab}`).classList.remove('tab-inactive');
  document.getElementById(`content${targetTab}`).classList.remove('hidden');
  
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
  }
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
    return;
  }
  
  document.getElementById('sceneSplitGuide').classList.add('hidden');
  
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
  
  // Check if scenes already exist（軽量版API使用）
  const scenesResponse = await axios.get(`${API_BASE}/projects/${PROJECT_ID}/scenes?view=edit`);
  const scenes = scenesResponse.data.scenes || [];
  window.sceneSplitLoaded = true;
  
  if (scenes.length === 0) {
    // Show format button
    document.getElementById('formatSection').classList.remove('hidden');
    document.getElementById('scenesSection').classList.add('hidden');
    document.getElementById('scenesEmptyState').classList.add('hidden');
  } else {
    // Show scenes
    document.getElementById('formatSection').classList.add('hidden');
    document.getElementById('scenesSection').classList.remove('hidden');
    document.getElementById('scenesEmptyState').classList.add('hidden');
    document.getElementById('goToBuilderBtn').classList.remove('hidden');
    renderScenes(scenes);
    document.getElementById('scenesCount').textContent = scenes.length;
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
          showToast('テキスト分割中にエラーが発生しました', 'error');
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
          showToast('テキスト分割中にエラーが発生しました', 'error');
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
        </div>
      </div>
    </div>
  `;
  
  formatSection.classList.remove('hidden');
}

// Start polling for format progress
function startFormatPolling() {
  // Clear any existing interval
  if (formatPollingInterval) {
    clearInterval(formatPollingInterval);
  }
  
  // Poll every 5 seconds
  formatPollingInterval = setInterval(async () => {
    try {
      const response = await axios.get(`${API_BASE}/projects/${PROJECT_ID}/format/status`);
      const data = response.data;
      
      updateFormatProgress(data);
      
      console.log('Format polling status:', data.status, 'processed:', data.processed, 'pending:', data.pending);
      
      // Check if completed
      if (data.status === 'formatted') {
        console.log('Format completed, stopping polling');
        clearInterval(formatPollingInterval);
        formatPollingInterval = null;
        
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
        // Continue polling, check if all chunks are done
        if (data.pending === 0 && data.processing === 0) {
          // All chunks done, trigger one more format call to merge
          try {
            await axios.post(`${API_BASE}/projects/${PROJECT_ID}/format`);
          } catch (error) {
            console.error('Final format call error:', error);
          }
        }
      }
      
    } catch (error) {
      console.error('Polling error:', error);
      clearInterval(formatPollingInterval);
      formatPollingInterval = null;
      showToast('進捗確認中にエラーが発生しました', 'error');
      isProcessing = false;
    }
  }, 5000);
}

// Update format progress UI
function updateFormatProgress(data) {
  const progressText = document.getElementById('formatProgressText');
  const progressBar = document.getElementById('formatProgressBar');
  const progressDetails = document.getElementById('formatProgressDetails');
  
  if (!progressText || !progressBar || !progressDetails) return;
  
  const { status, total_chunks, processed, failed, processing, pending } = data;
  
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
      progressDetails.innerHTML = `<span class="text-yellow-600"><i class="fas fa-exclamation-triangle mr-1"></i>一部のチャンクで失敗しました（続行できます）</span>`;
    } else if (pending === 0 && processing === 0) {
      progressDetails.textContent = '最終処理中...';
    } else {
      progressDetails.textContent = `処理済み: ${processed}, 処理中: ${processing}, 待機中: ${pending}, 失敗: ${failed}`;
    }
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

// Load scenes
async function loadScenes() {
  try {
    const response = await axios.get(`${API_BASE}/projects/${PROJECT_ID}/scenes`);
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
  
  container.innerHTML = scenes.map((scene, index) => `
    <div class="bg-white rounded-lg border-2 border-gray-200 p-6" id="scene-${scene.id}">
      <div class="flex items-center justify-between mb-4">
        <div class="flex items-center gap-4">
          <span class="text-2xl font-bold text-gray-400">#${scene.idx}</span>
          <select 
            id="role-${scene.id}"
            class="px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500"
          >
            <option value="hook" ${scene.role === 'hook' ? 'selected' : ''}>Hook</option>
            <option value="context" ${scene.role === 'context' ? 'selected' : ''}>Context</option>
            <option value="main_point" ${scene.role === 'main_point' ? 'selected' : ''}>Main Point</option>
            <option value="evidence" ${scene.role === 'evidence' ? 'selected' : ''}>Evidence</option>
            <option value="timeline" ${scene.role === 'timeline' ? 'selected' : ''}>Timeline</option>
            <option value="analysis" ${scene.role === 'analysis' ? 'selected' : ''}>Analysis</option>
            <option value="summary" ${scene.role === 'summary' ? 'selected' : ''}>Summary</option>
            <option value="cta" ${scene.role === 'cta' ? 'selected' : ''}>CTA</option>
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
      </div>
    </div>
  `).join('');
}

// Save scene (行単位ロック)
async function saveScene(sceneId) {
  // 行単位チェック
  if (sceneProcessing[sceneId]) {
    showToast('このシーンは処理中です', 'warning');
    return;
  }
  
  sceneProcessing[sceneId] = true;
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
    sceneProcessing[sceneId] = false;
    setButtonLoading(`saveBtn-${sceneId}`, false);
  }
}

// Delete scene (行単位ロック)
async function deleteScene(sceneId) {
  if (!confirm('このシーンを削除してもよろしいですか？')) {
    return;
  }
  
  // 行単位チェック
  if (sceneProcessing[sceneId]) {
    showToast('このシーンは処理中です', 'warning');
    return;
  }
  
  sceneProcessing[sceneId] = true;
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
    sceneProcessing[sceneId] = false;
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
async function initBuilderTab() {
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
    // Load style presets and scenes in parallel
    const [scenesResponse, stylesResponse, projectStyleResponse] = await Promise.all([
      axios.get(`${API_BASE}/projects/${PROJECT_ID}/scenes?view=board`),
      axios.get(`${API_BASE}/style-presets`),
      axios.get(`${API_BASE}/projects/${PROJECT_ID}/style-settings`)
    ]);
    
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
      
      // Set project default style as selected
      if (window.builderProjectDefaultStyle) {
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
  
  // 再描画
  initBuilderTab();
}

// Render builder scene cards
function renderBuilderScenes(scenes) {
  const container = document.getElementById('builderScenesList');
  
  // フィルタリング適用（グローバル変数 currentFilter）
  const filteredScenes = filterScenes(scenes, window.currentFilter || 'all');
  
  container.innerHTML = filteredScenes.map((scene) => {
    const activeImage = scene.active_image || null;
    const latestImage = scene.latest_image || null;
    const imageUrl = activeImage ? activeImage.image_url : null;
    
    // ステータスは latest_image を優先（SSOT）
    const imageStatus = latestImage ? latestImage.status : 'pending';
    const errorMessage = latestImage?.error_message || null;
    
    return `
      <div class="bg-white rounded-lg border-2 border-gray-200 shadow-md overflow-hidden" id="builder-scene-${scene.id}" data-status="${imageStatus}">
        <!-- Header -->
        <div class="bg-gradient-to-r from-blue-600 to-purple-600 px-6 py-3 flex items-center justify-between">
          <div class="flex items-center gap-3">
            <span class="text-white font-bold text-xl">#${scene.idx}</span>
            <span class="px-3 py-1 bg-white bg-opacity-20 rounded-full text-white text-sm font-semibold">
              ${getRoleText(scene.role)}
            </span>
          </div>
          ${getSceneStatusBadge(imageStatus)}
        </div>
        
        <!-- Content: Left-Right Split (PC) / Top-Bottom (Mobile) -->
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-6 p-6">
          <!-- Left: Text Content -->
          <div class="space-y-4">
            <div>
              <label class="block text-sm font-semibold text-gray-700 mb-2">セリフ</label>
              <div class="p-3 bg-gray-50 rounded-lg border border-gray-200 text-gray-800 whitespace-pre-wrap text-sm">
${escapeHtml(scene.dialogue)}
              </div>
            </div>
            
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
          
          <!-- Right: Image Preview & Actions -->
          <div class="space-y-4">
            <!-- Image Preview -->
            <div class="relative aspect-video bg-gray-100 rounded-lg border-2 border-gray-300 overflow-hidden">
              ${imageUrl 
                ? `<img src="${imageUrl}" alt="Scene ${scene.idx}" class="w-full h-full object-cover" id="sceneImage-${scene.id}" />`
                : `<div class="flex items-center justify-center h-full text-gray-400">
                     <div class="text-center">
                       <i class="fas fa-image text-6xl mb-3"></i>
                       <p class="text-sm">画像未生成</p>
                     </div>
                   </div>`
              }
              ${imageStatus === 'generating' 
                ? `<div class="absolute inset-0 bg-black bg-opacity-50 flex items-center justify-center">
                     <div class="text-white text-center">
                       <i class="fas fa-spinner fa-spin text-4xl mb-2"></i>
                       <p>生成中...</p>
                     </div>
                   </div>`
                : ''
              }
            </div>
            
            <!-- Action Buttons -->
            <div class="flex flex-wrap gap-2">
              ${!activeImage || imageStatus === 'failed'
                ? `<button 
                     id="generateBtn-${scene.id}"
                     onclick="generateSceneImage(${scene.id})"
                     class="flex-1 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors font-semibold touch-manipulation"
                   >
                     <i class="fas fa-magic mr-2"></i>画像生成
                   </button>`
                : `<button 
                     id="regenerateBtn-${scene.id}"
                     onclick="regenerateSceneImage(${scene.id})"
                     class="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-semibold touch-manipulation"
                   >
                     <i class="fas fa-redo mr-2"></i>再生成
                   </button>`
              }
              <button 
                onclick="viewImageHistory(${scene.id})"
                class="px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition-colors font-semibold touch-manipulation"
                ${!activeImage ? 'disabled' : ''}
              >
                <i class="fas fa-history mr-2"></i>履歴
              </button>
            </div>
            
            ${imageStatus === 'failed' && errorMessage
              ? `<div class="p-3 bg-red-50 border-l-4 border-red-600 rounded text-sm text-red-800">
                   <i class="fas fa-exclamation-circle mr-2"></i>
                   <strong>失敗理由:</strong><br/>
                   <div class="mt-2 font-mono text-xs bg-red-100 p-2 rounded overflow-x-auto">
                     ${escapeHtml(errorMessage)}
                   </div>
                   ${(() => {
                     try {
                       const parsed = JSON.parse(errorMessage);
                       return `<div class="mt-2 space-y-1">
                         ${parsed.status ? `<div><strong>HTTP Status:</strong> ${parsed.status}</div>` : ''}
                         ${parsed.code ? `<div><strong>Error Code:</strong> ${parsed.code}</div>` : ''}
                         ${parsed.message ? `<div><strong>Message:</strong> ${escapeHtml(parsed.message)}</div>` : ''}
                       </div>`;
                     } catch(e) {
                       return '';
                     }
                   })()}
                 </div>`
              : imageStatus === 'failed' 
                ? `<div class="p-3 bg-red-50 border-l-4 border-red-600 rounded text-sm text-red-800">
                     <i class="fas fa-exclamation-circle mr-2"></i>
                     画像生成に失敗しました
                   </div>`
                : ''
            }
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// Get role text
function getRoleText(role) {
  const roleMap = {
    'hook': 'Hook',
    'context': 'Context',
    'main_point': 'Main Point',
    'evidence': 'Evidence',
    'timeline': 'Timeline',
    'analysis': 'Analysis',
    'summary': 'Summary',
    'cta': 'CTA'
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
  if (sceneProcessing[sceneId]) {
    showToast('このシーンは処理中です', 'warning');
    return;
  }
  
  sceneProcessing[sceneId] = true;
  setButtonLoading(`generateBtn-${sceneId}`, true);
  
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
  
  try {
    const response = await axios.post(`${API_BASE}/scenes/${sceneId}/generate-image`);
    
    if (response.data.id) {
      showToast('画像生成を開始しました', 'success');
      // Refresh builder to show generating status
      await initBuilderTab();
      
      // Start polling for completion
      pollSceneImageGeneration(sceneId);
    } else {
      showToast('画像生成に失敗しました', 'error');
    }
  } catch (error) {
    console.error('Generate image error:', error);
    
    // Log detailed error information
    if (error.response) {
      console.error('Error response data:', error.response.data);
      console.error('Error response status:', error.response.status);
      
      // Show detailed error message
      const errorMsg = error.response.data?.error?.message || error.message || '画像生成中にエラーが発生しました';
      showToast(errorMsg, 'error');
    } else {
      showToast('画像生成中にエラーが発生しました', 'error');
    }
  } finally {
    sceneProcessing[sceneId] = false;
    setButtonLoading(`generateBtn-${sceneId}`, false);
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
  
  isProcessing = true;
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
      
      // 2) 完了判定
      if (pending === 0 && generating === 0) {
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
    setButtonLoading(buttonId, false);
  }
}

// View image history
async function viewImageHistory(sceneId) {
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
          ${images.map(img => `
            <div class="border-2 ${img.is_active ? 'border-blue-600' : 'border-gray-200'} rounded-lg overflow-hidden">
              <div class="aspect-video bg-gray-100">
                <img src="${img.image_url}" alt="Generated image" class="w-full h-full object-cover" />
              </div>
              <div class="p-3 space-y-2">
                <p class="text-xs text-gray-600 line-clamp-2">${escapeHtml(img.prompt)}</p>
                <div class="flex items-center justify-between text-xs text-gray-500">
                  <span>${new Date(img.created_at).toLocaleString('ja-JP')}</span>
                  ${img.is_active 
                    ? '<span class="px-2 py-1 bg-blue-100 text-blue-800 rounded">現在使用中</span>'
                    : `<button 
                         onclick="activateImage(${img.id}, ${sceneId})"
                         class="px-3 py-1 bg-green-600 text-white rounded hover:bg-green-700 transition-colors"
                       >
                         この画像を採用
                       </button>`
                  }
                </div>
              </div>
            </div>
          `).join('')}
        </div>
      `;
    }
    
    modal.classList.remove('hidden');
  } catch (error) {
    console.error('Load image history error:', error);
    showToast('画像履歴の読み込みに失敗しました', 'error');
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
  
  if (!confirm(`すべてのシーンに同じスタイルを適用しますか？\n\n選択したスタイル: ${select.options[select.selectedIndex].text}`)) {
    return;
  }
  
  try {
    // Get all scenes
    const response = await axios.get(`${API_BASE}/projects/${PROJECT_ID}/scenes`);
    const scenes = response.data.scenes || [];
    
    if (scenes.length === 0) {
      showToast('シーンがありません', 'warning');
      return;
    }
    
    showToast(`${scenes.length}シーンにスタイルを適用中...`, 'info');
    
    // Apply style to each scene
    let successCount = 0;
    for (const scene of scenes) {
      try {
        await axios.put(`${API_BASE}/scenes/${scene.id}/style`, {
          style_preset_id: styleId
        });
        successCount++;
      } catch (error) {
        console.error(`Failed to apply style to scene ${scene.id}:`, error);
      }
    }
    
    showToast(`${successCount}/${scenes.length}シーンにスタイルを適用しました`, 'success');
    
    // Reload builder
    await initBuilderTab();
    
  } catch (error) {
    console.error('Apply bulk style error:', error);
    showToast('一括スタイル適用に失敗しました', 'error');
  }
}

// Poll for single scene image generation completion
function pollSceneImageGeneration(sceneId) {
  const maxAttempts = 60; // 5 minutes (5s interval)
  let attempts = 0;
  
  const pollInterval = setInterval(async () => {
    attempts++;
    
    try {
      // Get scene details
      const response = await axios.get(`${API_BASE}/projects/${PROJECT_ID}/scenes?view=board`);
      const scene = response.data.scenes?.find(s => s.id === sceneId);
      
      if (!scene) {
        console.error('Scene not found:', sceneId);
        clearInterval(pollInterval);
        return;
      }
      
      const imageStatus = scene.latest_image?.status;
      
      console.log(`Scene ${sceneId} image status:`, imageStatus);
      
      if (imageStatus === 'completed') {
        clearInterval(pollInterval);
        showToast('画像生成が完了しました', 'success');
        await initBuilderTab();
      } else if (imageStatus === 'failed') {
        clearInterval(pollInterval);
        const errorMsg = scene.latest_image?.error_message || '画像生成に失敗しました';
        showToast(errorMsg, 'error');
        await initBuilderTab();
      } else if (attempts >= maxAttempts) {
        clearInterval(pollInterval);
        showToast('画像生成がタイムアウトしました。ページを再読み込みしてください。', 'warning');
        await initBuilderTab();
      }
      
    } catch (error) {
      console.error('Poll scene image error:', error);
      clearInterval(pollInterval);
    }
  }, 5000); // Poll every 5 seconds
}
