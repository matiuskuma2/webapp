// API Base URL
const API_BASE = '/api';

// Global state
let currentProject = null;
let isProcessing = false; // ボタン連打防止用フラグ
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
  } catch (error) {
    console.error('Load project error:', error);
    showToast('プロジェクトの読み込みに失敗しました', 'error');
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
