// API Base URL
const API_BASE = '/api';

// Global state
let currentProject = null;
let isProcessing = false; // ボタン連打防止用フラグ

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
      <h2 class="text-2xl font-bold text-gray-800 mb-2">${escapeHtml(project.title)}</h2>
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
  
  // Phase 2: Upload Audio
  if (project.status === 'created') {
    actions.push(`
      <div class="mb-6 p-4 bg-blue-50 rounded-lg">
        <h3 class="font-semibold text-gray-800 mb-3">
          <i class="fas fa-upload mr-2 text-blue-600"></i>
          Step 1: 音声ファイルをアップロード
        </h3>
        <input type="file" id="audioFile" accept="audio/*" class="block w-full text-sm text-gray-600 mb-3
          file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0
          file:text-sm file:font-semibold file:bg-blue-600 file:text-white
          hover:file:bg-blue-700 cursor-pointer"/>
        <button 
          id="uploadAudioBtn"
          onclick="uploadAudio(${project.id})"
          class="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        >
          <i class="fas fa-upload mr-2"></i>アップロード
        </button>
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

// Upload audio file
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
  
  isProcessing = true;
  setButtonLoading('uploadAudioBtn', true);
  
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
  }
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
