// API Base URL
const API_BASE = '/api';

// Global state
let currentProject = null;
let isProcessing = false; // ボタン連打防止用フラグ
let mediaRecorder = null;
let audioChunks = [];
let recordingStartTime = 0;

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  loadProjects();
});

// Show toast notification
function showToast(message, type = 'success') {
  const toast = document.getElementById('toast');
  const icon = document.getElementById('toastIcon');
  const messageEl = document.getElementById('toastMessage');
  
  // Set icon and color
  if (type === 'success') {
    icon.className = 'fas fa-check-circle text-2xl mr-3 text-green-500';
  } else if (type === 'error') {
    icon.className = 'fas fa-exclamation-circle text-2xl mr-3 text-red-500';
  } else if (type === 'info') {
    icon.className = 'fas fa-info-circle text-2xl mr-3 text-blue-500';
  } else if (type === 'warning') {
    icon.className = 'fas fa-exclamation-triangle text-2xl mr-3 text-yellow-500';
  }
  
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

// Create new project
async function createProject() {
  if (isProcessing) {
    showToast('処理中です。しばらくお待ちください', 'warning');
    return;
  }
  
  const titleInput = document.getElementById('projectTitle');
  const title = titleInput.value.trim();
  
  if (!title) {
    showToast('プロジェクトタイトルを入力してください', 'error');
    return;
  }
  
  isProcessing = true;
  setButtonLoading('createProjectBtn', true);
  
  try {
    const response = await axios.post(`${API_BASE}/projects`, { title });
    
    if (response.data.id) {
      showToast('プロジェクトが作成されました', 'success');
      titleInput.value = '';
      loadProjects();
    } else {
      showToast(response.data.error?.message || 'プロジェクト作成に失敗しました', 'error');
    }
  } catch (error) {
    console.error('Create project error:', error);
    showToast('プロジェクト作成中にエラーが発生しました', 'error');
  } finally {
    isProcessing = false;
    setButtonLoading('createProjectBtn', false);
  }
}

// Load projects list
async function loadProjects() {
  const projectsList = document.getElementById('projectsList');
  
  try {
    const response = await axios.get(`${API_BASE}/projects`);
    
    if (response.data.projects && response.data.projects.length > 0) {
      projectsList.innerHTML = response.data.projects.map(project => `
        <div class="border border-gray-200 rounded-lg p-4 hover:shadow-md transition-shadow">
          <div class="flex items-center justify-between">
            <div class="flex-1">
              <h3 class="font-semibold text-gray-800">${escapeHtml(project.title)}</h3>
              <div class="flex items-center gap-4 mt-2 text-sm text-gray-600">
                <span class="flex items-center">
                  <i class="fas fa-info-circle mr-1"></i>
                  ステータス: <span class="ml-1 font-medium ${getStatusColor(project.status)}">${getStatusText(project.status)}</span>
                </span>
                <span class="flex items-center">
                  <i class="fas fa-clock mr-1"></i>
                  ${new Date(project.created_at).toLocaleString('ja-JP')}
                </span>
              </div>
            </div>
            <button 
              onclick="viewProject(${project.id})"
              class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            >
              <i class="fas fa-arrow-right mr-1"></i>詳細
            </button>
          </div>
        </div>
      `).join('');
    } else {
      projectsList.innerHTML = `
        <p class="text-gray-500 text-center py-8">
          <i class="fas fa-inbox text-4xl mb-2"></i><br>
          プロジェクトがありません
        </p>
      `;
    }
  } catch (error) {
    console.error('Load projects error:', error);
    projectsList.innerHTML = `
      <p class="text-red-500 text-center py-8">
        <i class="fas fa-exclamation-triangle text-4xl mb-2"></i><br>
        プロジェクトの読み込みに失敗しました
      </p>
    `;
  }
}

// View project detail
async function viewProject(projectId) {
  try {
    const response = await axios.get(`${API_BASE}/projects/${projectId}`);
    currentProject = response.data;
    
    // Show project detail modal
    showProjectDetail(currentProject);
  } catch (error) {
    console.error('Load project error:', error);
    showToast('プロジェクトの読み込みに失敗しました', 'error');
  }
}

// Show project detail modal
function showProjectDetail(project) {
  const modal = document.getElementById('projectModal');
  const modalContent = document.getElementById('modalContent');
  
  modalContent.innerHTML = `
    <div class="mb-6">
      <div class="flex items-start justify-between mb-2">
        <h2 class="text-2xl font-bold text-gray-800">${escapeHtml(project.title)}</h2>
        <button 
          onclick="confirmDeleteProject(${project.id})"
          class="px-3 py-1 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors text-sm"
        >
          <i class="fas fa-trash mr-1"></i>削除
        </button>
      </div>
      <div class="flex items-center gap-4 text-sm text-gray-600">
        <span class="flex items-center">
          <i class="fas fa-info-circle mr-1"></i>
          ステータス: <span class="ml-1 font-medium ${getStatusColor(project.status)}">${getStatusText(project.status)}</span>
        </span>
        <span class="flex items-center">
          <i class="fas fa-clock mr-1"></i>
          ${new Date(project.created_at).toLocaleString('ja-JP')}
        </span>
      </div>
    </div>
    
    ${getProjectActions(project)}
  `;
  
  modal.classList.remove('hidden');
}

// Get project actions based on status
function getProjectActions(project) {
  const actions = [];
  
  // Phase 2: Upload Audio (with Microphone Recording)
  if (project.status === 'created') {
    actions.push(`
      <div class="mb-6 p-4 bg-blue-50 rounded-lg">
        <h3 class="font-semibold text-gray-800 mb-3">
          <i class="fas fa-microphone mr-2 text-blue-600"></i>
          Step 1: 音声を録音またはアップロード
        </h3>
        
        <!-- Grid layout for PC, Stack for mobile -->
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <!-- Microphone Recording -->
          <div class="p-4 bg-white rounded-lg border-2 border-blue-200">
            <h4 class="font-semibold text-gray-700 mb-3 flex items-center">
              <i class="fas fa-microphone-alt mr-2 text-blue-600"></i>
              マイク録音
              <span class="ml-2 text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded">スマホ推奨</span>
            </h4>
            <div id="recordingStatus" class="mb-3 text-sm text-gray-600 hidden">
              <div class="flex items-center justify-center mb-2">
                <div class="w-4 h-4 bg-red-500 rounded-full animate-pulse mr-2"></div>
                <span class="font-semibold">録音中...</span>
                <span id="recordingTime" class="ml-2">0:00</span>
              </div>
              <div class="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
                <div id="recordingProgress" class="bg-blue-600 h-full transition-all duration-300" style="width: 0%"></div>
              </div>
            </div>
            <div class="flex flex-col gap-2">
              <button 
                id="startRecordBtn"
                onclick="startRecording(${project.id})"
                class="w-full px-6 py-3 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors text-base font-semibold touch-manipulation"
              >
                <i class="fas fa-microphone mr-2"></i>録音開始
              </button>
              <button 
                id="stopRecordBtn"
                onclick="stopRecording(${project.id})"
                class="w-full px-6 py-3 bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition-colors text-base font-semibold hidden touch-manipulation"
              >
                <i class="fas fa-stop mr-2"></i>録音停止
              </button>
            </div>
            <p class="text-xs text-gray-500 mt-3">
              <i class="fas fa-info-circle mr-1"></i>
              ブラウザでマイク許可が必要です
            </p>
          </div>
          
          <!-- File Upload -->
          <div class="p-4 bg-white rounded-lg border-2 border-gray-200">
            <h4 class="font-semibold text-gray-700 mb-3 flex items-center">
              <i class="fas fa-upload mr-2 text-gray-600"></i>
              ファイルアップロード
              <span class="ml-2 text-xs bg-gray-100 text-gray-800 px-2 py-1 rounded">PC推奨</span>
            </h4>
            <input type="file" id="audioFile" accept="audio/*,audio/webm,audio/mp3,audio/wav,audio/m4a,audio/ogg" 
              class="block w-full text-sm text-gray-600 mb-3
              file:mr-4 file:py-3 file:px-6 file:rounded-lg file:border-0
              file:text-base file:font-semibold file:bg-blue-600 file:text-white
              hover:file:bg-blue-700 cursor-pointer touch-manipulation"/>
            <button 
              id="uploadAudioBtn"
              onclick="uploadAudio(${project.id})"
              class="w-full px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors text-base font-semibold touch-manipulation"
            >
              <i class="fas fa-upload mr-2"></i>アップロード
            </button>
            <p class="text-xs text-gray-500 mt-3">
              <i class="fas fa-info-circle mr-1"></i>
              対応形式: MP3, WAV, M4A, OGG, WebM
            </p>
          </div>
        </div>
      </div>
    `);
  }
  
  // Phase 2: Transcribe
  if (project.status === 'uploaded') {
    actions.push(`
      <div class="mb-6 p-4 bg-green-50 rounded-lg">
        <h3 class="font-semibold text-gray-800 mb-3">
          <i class="fas fa-microphone mr-2 text-green-600"></i>
          Step 2: 音声を文字起こし
        </h3>
        <p class="text-sm text-gray-600 mb-3">OpenAI Whisperで音声をテキストに変換します（1-2分）</p>
        <button 
          id="transcribeBtn"
          onclick="transcribeAudio(${project.id})"
          class="px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
        >
          <i class="fas fa-play mr-2"></i>文字起こし開始
        </button>
      </div>
    `);
  }
  
  // Phase 3: Format & Split Scenes
  if (project.status === 'transcribed') {
    actions.push(`
      <div class="mb-6 p-4 bg-purple-50 rounded-lg">
        <h3 class="font-semibold text-gray-800 mb-3">
          <i class="fas fa-cut mr-2 text-purple-600"></i>
          Step 3: シーン分割
        </h3>
        <p class="text-sm text-gray-600 mb-3">OpenAI Chat APIでRILARCシナリオを生成します（30秒-1分）</p>
        <button 
          id="formatBtn"
          onclick="formatAndSplit(${project.id})"
          class="px-6 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors"
        >
          <i class="fas fa-magic mr-2"></i>シーン分割開始
        </button>
      </div>
    `);
  }
  
  // Phase 4: Generate Images
  if (project.status === 'formatted' || project.status === 'generating_images') {
    actions.push(`
      <div class="mb-6 p-4 bg-yellow-50 rounded-lg">
        <h3 class="font-semibold text-gray-800 mb-3">
          <i class="fas fa-image mr-2 text-yellow-600"></i>
          Step 4: 画像生成
        </h3>
        <p class="text-sm text-gray-600 mb-3">Gemini APIで各シーンの画像を生成します（3-5分）</p>
        <div class="flex gap-3">
          <button 
            id="generateAllBtn"
            onclick="generateAllImages(${project.id}, 'all')"
            class="px-6 py-2 bg-yellow-600 text-white rounded-lg hover:bg-yellow-700 transition-colors"
          >
            <i class="fas fa-images mr-2"></i>全て生成
          </button>
          <button 
            id="generatePendingBtn"
            onclick="generateAllImages(${project.id}, 'pending')"
            class="px-6 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 transition-colors"
          >
            <i class="fas fa-hourglass-half mr-2"></i>未生成のみ
          </button>
          <button 
            id="generateFailedBtn"
            onclick="generateAllImages(${project.id}, 'failed')"
            class="px-6 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
          >
            <i class="fas fa-redo mr-2"></i>失敗のみ再生成
          </button>
        </div>
      </div>
    `);
  }
  
  // Phase 5: Download
  if (project.status === 'completed') {
    actions.push(`
      <div class="mb-6 p-4 bg-green-50 rounded-lg">
        <h3 class="font-semibold text-gray-800 mb-3">
          <i class="fas fa-download mr-2 text-green-600"></i>
          Step 5: ダウンロード
        </h3>
        <p class="text-sm text-gray-600 mb-3">完成したファイルをダウンロードできます</p>
        <div class="flex gap-3">
          <a 
            href="${API_BASE}/projects/${project.id}/download/images"
            class="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors inline-block"
            download
          >
            <i class="fas fa-image mr-2"></i>画像ZIP
          </a>
          <a 
            href="${API_BASE}/projects/${project.id}/download/csv"
            class="px-6 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors inline-block"
            download
          >
            <i class="fas fa-file-csv mr-2"></i>セリフCSV
          </a>
          <a 
            href="${API_BASE}/projects/${project.id}/download/all"
            class="px-6 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors inline-block"
            download
          >
            <i class="fas fa-archive mr-2"></i>全ファイルZIP
          </a>
        </div>
      </div>
    `);
  }
  
  return actions.join('');
}

// Close modal
function closeModal() {
  const modal = document.getElementById('projectModal');
  modal.classList.add('hidden');
  currentProject = null;
}

// Confirm delete project
function confirmDeleteProject(projectId) {
  if (confirm('このプロジェクトを削除してもよろしいですか？\n\n関連するすべてのデータ（音声、シーン、画像）が削除されます。この操作は取り消せません。')) {
    deleteProject(projectId);
  }
}

// Delete project
async function deleteProject(projectId) {
  if (isProcessing) {
    showToast('処理中です。しばらくお待ちください', 'warning');
    return;
  }
  
  isProcessing = true;
  
  try {
    const response = await axios.delete(`${API_BASE}/projects/${projectId}`);
    
    if (response.data.success) {
      showToast('プロジェクトを削除しました', 'success');
      closeModal();
      loadProjects();
    } else {
      showToast(response.data.error?.message || 'プロジェクト削除に失敗しました', 'error');
    }
  } catch (error) {
    console.error('Delete project error:', error);
    showToast('プロジェクト削除中にエラーが発生しました', 'error');
  } finally {
    isProcessing = false;
  }
}

// Start recording audio
async function startRecording(projectId) {
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
      await uploadAudioFile(projectId, audioFile);
    };
    
    mediaRecorder.start();
    
    // UI updates
    document.getElementById('startRecordBtn').classList.add('hidden');
    document.getElementById('stopRecordBtn').classList.remove('hidden');
    document.getElementById('recordingStatus').classList.remove('hidden');
    
    // Update recording time
    const timerInterval = setInterval(() => {
      if (!mediaRecorder || mediaRecorder.state !== 'recording') {
        clearInterval(timerInterval);
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

// Stop recording audio
function stopRecording(projectId) {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    
    // UI updates
    document.getElementById('startRecordBtn').classList.remove('hidden');
    document.getElementById('stopRecordBtn').classList.add('hidden');
    document.getElementById('recordingStatus').classList.add('hidden');
    
    showToast('録音を停止しました。アップロード中...', 'info');
  }
}

// Upload audio file (common function for both file upload and recording)
async function uploadAudioFile(projectId, file) {
  isProcessing = true;
  setButtonLoading('uploadAudioBtn', true);
  setButtonLoading('startRecordBtn', true);
  
  try {
    const formData = new FormData();
    formData.append('audio', file);
    
    const response = await axios.post(`${API_BASE}/projects/${projectId}/upload`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    });
    
    if (response.data.id) {
      showToast('音声ファイルがアップロードされました', 'success');
      closeModal();
      loadProjects();
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

// Upload audio file (from file input)
async function uploadAudio(projectId) {
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
  
  await uploadAudioFile(projectId, file);
}

// Transcribe audio
async function transcribeAudio(projectId) {
  if (isProcessing) {
    showToast('処理中です。しばらくお待ちください', 'warning');
    return;
  }
  
  isProcessing = true;
  setButtonLoading('transcribeBtn', true);
  
  try {
    const response = await axios.post(`${API_BASE}/projects/${projectId}/transcribe`);
    
    if (response.data.id) {
      showToast('文字起こしが完了しました', 'success');
      closeModal();
      loadProjects();
    } else {
      showToast(response.data.error?.message || '文字起こしに失敗しました', 'error');
    }
  } catch (error) {
    console.error('Transcribe error:', error);
    showToast('文字起こし中にエラーが発生しました', 'error');
  } finally {
    isProcessing = false;
    setButtonLoading('transcribeBtn', false);
  }
}

// Format and split scenes
async function formatAndSplit(projectId) {
  if (isProcessing) {
    showToast('処理中です。しばらくお待ちください', 'warning');
    return;
  }
  
  isProcessing = true;
  setButtonLoading('formatBtn', true);
  
  try {
    const response = await axios.post(`${API_BASE}/projects/${projectId}/format`);
    
    if (response.data.project_id) {
      showToast('シーン分割が完了しました', 'success');
      closeModal();
      loadProjects();
    } else {
      showToast(response.data.error?.message || 'シーン分割に失敗しました', 'error');
    }
  } catch (error) {
    console.error('Format error:', error);
    showToast('シーン分割中にエラーが発生しました', 'error');
  } finally {
    isProcessing = false;
    setButtonLoading('formatBtn', false);
  }
}

// Generate all images
async function generateAllImages(projectId, mode) {
  if (isProcessing) {
    showToast('処理中です。しばらくお待ちください', 'warning');
    return;
  }
  
  const buttonId = mode === 'all' ? 'generateAllBtn' : mode === 'pending' ? 'generatePendingBtn' : 'generateFailedBtn';
  
  isProcessing = true;
  setButtonLoading(buttonId, true);
  
  try {
    const response = await axios.post(`${API_BASE}/projects/${projectId}/generate-all-images`, { mode });
    
    if (response.data.project_id) {
      showToast(`画像生成が完了しました（成功: ${response.data.success_count}, 失敗: ${response.data.failed_count}）`, 'success');
      closeModal();
      loadProjects();
    } else {
      showToast(response.data.error?.message || '画像生成に失敗しました', 'error');
    }
  } catch (error) {
    console.error('Generate images error:', error);
    showToast('画像生成中にエラーが発生しました', 'error');
  } finally {
    isProcessing = false;
    setButtonLoading(buttonId, false);
  }
}

// Get status color class
function getStatusColor(status) {
  const colors = {
    'created': 'text-gray-600',
    'uploaded': 'text-blue-600',
    'transcribing': 'text-yellow-600',
    'transcribed': 'text-blue-600',
    'formatting': 'text-yellow-600',
    'formatted': 'text-blue-600',
    'generating_images': 'text-yellow-600',
    'completed': 'text-green-600',
    'failed': 'text-red-600'
  };
  return colors[status] || 'text-gray-600';
}

// Get status text
function getStatusText(status) {
  const texts = {
    'created': '作成済み',
    'uploaded': '音声アップロード済み',
    'transcribing': '文字起こし中',
    'transcribed': '文字起こし完了',
    'formatting': 'フォーマット中',
    'formatted': 'フォーマット完了',
    'generating_images': '画像生成中',
    'completed': '完了',
    'failed': 'エラー'
  };
  return texts[status] || status;
}

// Escape HTML
function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return text.replace(/[&<>"']/g, m => map[m]);
}
