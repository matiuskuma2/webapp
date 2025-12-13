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
  const tabs = ['Input', 'SceneSplit', 'Builder', 'Export'];
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
  
  // Initialize tab content based on tab type
  if (tabName === 'sceneSplit') {
    initSceneSplitTab();
  } else if (tabName === 'builder') {
    initBuilderTab();
  } else if (tabName === 'export') {
    initExportTab();
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
  
  // Check if scenes already exist
  const scenesResponse = await axios.get(`${API_BASE}/projects/${PROJECT_ID}/scenes`);
  const scenes = scenesResponse.data.scenes || [];
  
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

// Format and split scenes
async function formatAndSplit() {
  if (isProcessing) {
    showToast('処理中です。しばらくお待ちください', 'warning');
    return;
  }
  
  isProcessing = true;
  setButtonLoading('formatBtn', true);
  
  try {
    const response = await axios.post(`${API_BASE}/projects/${PROJECT_ID}/format`);
    
    if (response.data.project_id) {
      showToast('シーン分割が完了しました', 'success');
      await loadProject(); // Reload project to update status
      await loadScenes(); // Load scenes
      document.getElementById('formatSection').classList.add('hidden');
      document.getElementById('scenesSection').classList.remove('hidden');
    } else {
      showToast(response.data.error?.message || 'シーン分割に失敗しました', 'error');
    }
  } catch (error) {
    console.error('Format error:', error);
    
    // INVALID_STATUS (failed) の場合、復帰導線を表示
    if (error.response?.status === 400 && 
        error.response?.data?.error?.code === 'INVALID_STATUS' &&
        error.response?.data?.error?.details?.current_status === 'failed') {
      showFailedProjectRecoveryUI();
    } else {
      showToast('シーン分割中にエラーが発生しました', 'error');
    }
  } finally {
    isProcessing = false;
    setButtonLoading('formatBtn', false);
  }
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
  try {
    const response = await axios.get(`${API_BASE}/projects/${PROJECT_ID}/scenes`);
    const scenes = response.data.scenes || [];
    
    if (scenes.length === 0) {
      document.getElementById('builderScenesList').classList.add('hidden');
      document.getElementById('builderEmptyState').classList.remove('hidden');
      return;
    }
    
    document.getElementById('builderScenesList').classList.remove('hidden');
    document.getElementById('builderEmptyState').classList.add('hidden');
    
    renderBuilderScenes(scenes);
  } catch (error) {
    console.error('Load builder scenes error:', error);
    showToast('シーンの読み込みに失敗しました', 'error');
  }
}

// Render builder scene cards
function renderBuilderScenes(scenes) {
  const container = document.getElementById('builderScenesList');
  
  container.innerHTML = scenes.map((scene) => {
    const activeImage = scene.active_image || null;
    const imageUrl = activeImage ? activeImage.image_url : null;
    const imageStatus = activeImage ? activeImage.status : 'pending';
    
    return `
      <div class="bg-white rounded-lg border-2 border-gray-200 shadow-md overflow-hidden" id="builder-scene-${scene.id}">
        <!-- Header -->
        <div class="bg-gradient-to-r from-blue-600 to-purple-600 px-6 py-3 flex items-center justify-between">
          <div class="flex items-center gap-3">
            <span class="text-white font-bold text-xl">#${scene.idx}</span>
            <span class="px-3 py-1 bg-white bg-opacity-20 rounded-full text-white text-sm font-semibold">
              ${getRoleText(scene.role)}
            </span>
          </div>
          <span class="text-white text-sm">
            ${getImageStatusBadge(imageStatus)}
          </span>
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
            
            ${imageStatus === 'failed' 
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
    } else {
      showToast('画像生成に失敗しました', 'error');
    }
  } catch (error) {
    console.error('Generate image error:', error);
    showToast('画像生成中にエラーが発生しました', 'error');
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
  
  try {
    const response = await axios.post(`${API_BASE}/projects/${PROJECT_ID}/generate-all-images`, {
      mode
    });
    
    if (response.data.success) {
      const modeText = mode === 'all' ? '全シーン' 
                     : mode === 'pending' ? '未生成シーン'
                     : '失敗シーン';
      showToast(`${modeText}の画像生成を開始しました`, 'success');
      await initBuilderTab();
    } else {
      showToast('画像生成に失敗しました', 'error');
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
