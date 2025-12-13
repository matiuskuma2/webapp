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

// View project detail (redirect to Project Editor)
function viewProject(projectId) {
  window.location.href = `/projects/${projectId}`;
}

// These functions are no longer needed (moved to project-editor.js)
// Keeping placeholders for backward compatibility

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
