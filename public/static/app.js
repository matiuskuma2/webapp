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

// Global selection state
let selectedProjects = new Set();

// Load projects list
async function loadProjects() {
  const projectsList = document.getElementById('projectsList');
  selectedProjects.clear();
  
  try {
    const response = await axios.get(`${API_BASE}/projects`);
    
    if (response.data.projects && response.data.projects.length > 0) {
      // Bulk action toolbar
      projectsList.innerHTML = `
        <div id="bulkActions" class="mb-4 p-3 bg-gray-50 rounded-lg border-2 border-gray-200 hidden">
          <div class="flex items-center justify-between">
            <div class="flex items-center gap-3">
              <input 
                type="checkbox" 
                id="selectAll"
                onchange="toggleSelectAll()"
                class="w-5 h-5 text-blue-600 rounded focus:ring-2 focus:ring-blue-500"
              />
              <label for="selectAll" class="text-sm font-semibold text-gray-700 cursor-pointer">
                すべて選択 (<span id="selectedCount">0</span> / <span id="totalCount">0</span>)
              </label>
            </div>
            <button 
              onclick="bulkDeleteProjects()"
              class="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors touch-manipulation"
            >
              <i class="fas fa-trash mr-2"></i>一括削除
            </button>
          </div>
        </div>
      ` + response.data.projects.map(project => `
        <div class="border ${project.is_template ? 'border-green-400 bg-green-50' : 'border-gray-200'} rounded-lg p-4 hover:shadow-md transition-shadow">
          <div class="flex items-center gap-3">
            <input 
              type="checkbox" 
              id="select-${project.id}"
              onchange="toggleProjectSelection(${project.id})"
              class="w-5 h-5 text-blue-600 rounded focus:ring-2 focus:ring-blue-500"
            />
            <div class="flex-1">
              <div class="flex items-center gap-2">
                <h3 class="font-semibold text-gray-800">${escapeHtml(project.title)}</h3>
                ${project.is_template ? '<span class="px-2 py-0.5 bg-green-600 text-white text-xs rounded-full"><i class="fas fa-copy mr-1"></i>テンプレート</span>' : ''}
              </div>
              <div class="flex items-center gap-4 mt-2 text-sm text-gray-600 flex-wrap">
                <span class="flex items-center">
                  <i class="fas fa-info-circle mr-1"></i>
                  <span class="ml-1 font-medium ${getStatusColor(project.status)}">${getStatusText(project.status)}</span>
                </span>
                <span class="flex items-center">
                  <i class="fas fa-clock mr-1"></i>
                  ${new Date(project.created_at).toLocaleString('ja-JP')}
                </span>
                ${project.user_id && window.currentUser?.role === 'superadmin' ? `<span class="flex items-center text-purple-600"><i class="fas fa-user mr-1"></i>ID: ${project.user_id}</span>` : ''}
              </div>
            </div>
            <div class="flex gap-2 flex-wrap justify-end">
              ${window.currentUser?.role === 'superadmin' ? `
                ${project.is_template ? `
                  <button 
                    onclick="editTemplate(${project.id}, '${escapeHtml(project.template_label || project.title)}', '${escapeHtml(project.template_description || '')}')"
                    class="px-3 py-2 bg-yellow-500 text-white rounded-lg hover:bg-yellow-600 transition-colors touch-manipulation"
                    title="テンプレート編集"
                  >
                    <i class="fas fa-edit"></i>
                  </button>
                ` : ''}
                <button 
                  onclick="toggleTemplate(${project.id}, ${!project.is_template}, '${escapeHtml(project.title)}')"
                  class="px-3 py-2 ${project.is_template ? 'bg-gray-500' : 'bg-green-600'} text-white rounded-lg hover:opacity-80 transition-colors touch-manipulation"
                  title="${project.is_template ? 'テンプレート解除' : 'テンプレートに設定'}"
                >
                  <i class="fas ${project.is_template ? 'fa-times' : 'fa-star'}"></i>
                </button>
              ` : ''}
              <button 
                onclick="deleteProjectDirect(${project.id})"
                class="px-3 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors touch-manipulation"
                title="削除"
              >
                <i class="fas fa-trash"></i>
              </button>
              <button 
                onclick="viewProject(${project.id})"
                class="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors touch-manipulation"
              >
                <i class="fas fa-arrow-right mr-1"></i>開く
              </button>
            </div>
          </div>
        </div>
      `).join('');
    } else {
      // No projects - show onboarding guide and auto-open template modal
      projectsList.innerHTML = `
        <div class="text-center py-12">
          <div class="mb-6">
            <i class="fas fa-rocket text-6xl text-green-500 mb-4"></i>
            <h3 class="text-xl font-bold text-gray-800 mb-2">最初のプロジェクトを作成しましょう！</h3>
            <p class="text-gray-600 mb-6">テンプレートから始めると、すぐにビルダーで編集できます</p>
          </div>
          <button 
            onclick="openTemplateModal()"
            class="px-8 py-4 bg-green-600 text-white text-lg rounded-lg hover:bg-green-700 transition-colors shadow-lg"
          >
            <i class="fas fa-copy mr-2"></i>テンプレートから作成する
          </button>
          <p class="text-sm text-gray-500 mt-4">
            または、上部の入力欄から空のプロジェクトを作成できます
          </p>
        </div>
      `;
      
      // Auto-open template modal for first-time users
      // Check if this is first visit (no localStorage flag)
      if (!localStorage.getItem('onboarding_seen')) {
        localStorage.setItem('onboarding_seen', 'true');
        // Small delay to let the UI render first
        setTimeout(() => {
          openTemplateModal();
        }, 500);
      }
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

// Toggle select all
function toggleSelectAll() {
  const selectAllCheckbox = document.getElementById('selectAll');
  const allCheckboxes = document.querySelectorAll('[id^="select-"]:not(#selectAll)');
  
  if (selectAllCheckbox.checked) {
    // Select all
    allCheckboxes.forEach(checkbox => {
      checkbox.checked = true;
      const projectId = parseInt(checkbox.id.replace('select-', ''));
      selectedProjects.add(projectId);
    });
  } else {
    // Deselect all
    allCheckboxes.forEach(checkbox => {
      checkbox.checked = false;
    });
    selectedProjects.clear();
  }
  
  updateBulkActionsUI();
}

// Toggle project selection
function toggleProjectSelection(projectId) {
  const checkbox = document.getElementById(`select-${projectId}`);
  
  if (checkbox.checked) {
    selectedProjects.add(projectId);
  } else {
    selectedProjects.delete(projectId);
  }
  
  // Update select all checkbox state
  const allCheckboxes = document.querySelectorAll('[id^="select-"]:not(#selectAll)');
  const selectAllCheckbox = document.getElementById('selectAll');
  if (selectAllCheckbox) {
    const allChecked = Array.from(allCheckboxes).every(cb => cb.checked);
    selectAllCheckbox.checked = allChecked;
  }
  
  updateBulkActionsUI();
}

// Update bulk actions UI
function updateBulkActionsUI() {
  const bulkActions = document.getElementById('bulkActions');
  const selectedCount = document.getElementById('selectedCount');
  const totalCount = document.getElementById('totalCount');
  const allCheckboxes = document.querySelectorAll('[id^="select-"]:not(#selectAll)');
  
  bulkActions.classList.remove('hidden'); // Always show toolbar when projects exist
  selectedCount.textContent = selectedProjects.size;
  totalCount.textContent = allCheckboxes.length;
}

// Bulk delete projects
async function bulkDeleteProjects() {
  if (selectedProjects.size === 0) return;
  
  if (!confirm(`選択した ${selectedProjects.size} 件のプロジェクトを削除してもよろしいですか？\n\nこの操作は取り消せません。`)) {
    return;
  }
  
  const projectIds = Array.from(selectedProjects);
  let successCount = 0;
  let failCount = 0;
  
  for (const projectId of projectIds) {
    try {
      await axios.delete(`${API_BASE}/projects/${projectId}`);
      successCount++;
    } catch (error) {
      // 404 = 見つからない, 409 = 既に削除済み → 成功としてカウント
      if (error.response?.status === 404 || error.response?.status === 409) {
        console.warn(`Project ${projectId} already deleted (${error.response?.status})`);
        successCount++;
      } else {
        console.error(`Failed to delete project ${projectId}:`, error);
        failCount++;
      }
    }
  }
  
  if (successCount > 0) {
    showToast(`${successCount} 件のプロジェクトを削除しました`, 'success');
  }
  
  if (failCount > 0) {
    showToast(`${failCount} 件の削除に失敗しました（サーバーエラー）`, 'error');
  }
  
  selectedProjects.clear();
  loadProjects();
}

// Delete single project directly
async function deleteProjectDirect(projectId) {
  if (!confirm('このプロジェクトを削除してもよろしいですか？\n\nこの操作は取り消せません。')) {
    return;
  }
  
  try {
    await axios.delete(`${API_BASE}/projects/${projectId}`);
    showToast('プロジェクトを削除しました', 'success');
    loadProjects();
  } catch (error) {
    // 404 = 見つからない, 409 = 既に削除済み → 成功として処理
    if (error.response?.status === 404 || error.response?.status === 409) {
      console.warn(`Project ${projectId} already deleted (${error.response?.status})`);
      showToast('プロジェクトを削除しました（既に削除済み）', 'success');
      loadProjects();
    } else {
      console.error('Delete project error:', error);
      showToast('プロジェクト削除に失敗しました（サーバーエラー）', 'error');
    }
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

// =============================================================================
// Template Functions (Phase D-3)
// =============================================================================

let templateList = [];

// Open template modal
async function openTemplateModal() {
  const modal = document.getElementById('templateModal');
  const listEl = document.getElementById('templateList');
  
  modal.classList.remove('hidden');
  listEl.innerHTML = '<p class="text-gray-500 text-center py-4"><i class="fas fa-spinner fa-spin mr-2"></i>読み込み中...</p>';
  
  try {
    const response = await axios.get(`${API_BASE}/templates`);
    templateList = response.data.templates || [];
    
    if (templateList.length === 0) {
      listEl.innerHTML = `
        <div class="text-center py-8 text-gray-500">
          <i class="fas fa-folder-open text-4xl mb-4"></i>
          <p>利用可能なテンプレートがありません</p>
          <p class="text-sm mt-2">管理者にテンプレートの作成をご依頼ください</p>
        </div>
      `;
      return;
    }
    
    listEl.innerHTML = templateList.map(t => `
      <div 
        class="border border-gray-200 rounded-lg p-4 hover:bg-green-50 hover:border-green-300 cursor-pointer transition-colors"
        onclick="cloneTemplate(${t.id}, '${escapeHtml(t.template_label || t.title)}')"
      >
        <div class="flex items-center justify-between">
          <div class="flex-1">
            <h3 class="font-semibold text-gray-800">${escapeHtml(t.template_label || t.title)}</h3>
            ${t.template_description ? `<p class="text-sm text-gray-600 mt-1">${escapeHtml(t.template_description)}</p>` : ''}
            <p class="text-sm text-gray-500 mt-1">
              <i class="fas fa-film mr-1"></i>${t.scene_count} シーン
              <span class="mx-2">•</span>
              <i class="fas fa-user mr-1"></i>${escapeHtml(t.owner_name)}
            </p>
          </div>
          <i class="fas fa-chevron-right text-gray-400 ml-2"></i>
        </div>
      </div>
    `).join('');
    
  } catch (error) {
    console.error('Load templates error:', error);
    listEl.innerHTML = `
      <div class="text-center py-8 text-red-500">
        <i class="fas fa-exclamation-circle text-4xl mb-4"></i>
        <p>テンプレートの読み込みに失敗しました</p>
      </div>
    `;
  }
}

// Close template modal
function closeTemplateModal() {
  document.getElementById('templateModal').classList.add('hidden');
  document.getElementById('templateProjectTitle').value = '';
}

// Clone template
async function cloneTemplate(templateId, templateName) {
  if (isProcessing) {
    showToast('処理中です。しばらくお待ちください', 'warning');
    return;
  }
  
  const titleInput = document.getElementById('templateProjectTitle');
  const customTitle = titleInput.value.trim();
  
  isProcessing = true;
  
  // Show loading in modal
  const listEl = document.getElementById('templateList');
  const originalContent = listEl.innerHTML;
  listEl.innerHTML = `
    <div class="text-center py-8">
      <i class="fas fa-spinner fa-spin text-4xl text-green-600 mb-4"></i>
      <p class="text-gray-600">「${escapeHtml(templateName)}」をコピー中...</p>
    </div>
  `;
  
  try {
    const response = await axios.post(`${API_BASE}/projects/${templateId}/clone`, {
      title: customTitle || undefined
    });
    
    if (response.data.success) {
      showToast('テンプレートからプロジェクトを作成しました', 'success');
      closeTemplateModal();
      
      // Auto-navigate to the new project (Builder)
      const newProjectId = response.data.new_project_id;
      if (newProjectId) {
        window.location.href = `/projects/${newProjectId}`;
      } else {
        loadProjects();
      }
    } else {
      throw new Error(response.data.error?.message || 'Unknown error');
    }
    
  } catch (error) {
    console.error('Clone template error:', error);
    showToast(error.response?.data?.error?.message || 'テンプレートのコピーに失敗しました', 'error');
    listEl.innerHTML = originalContent;
  } finally {
    isProcessing = false;
  }
}

// Toggle template status (superadmin only)
async function toggleTemplate(projectId, setAsTemplate, projectTitle) {
  if (isProcessing) {
    showToast('処理中です', 'warning');
    return;
  }
  
  // If setting as template, open edit modal instead
  if (setAsTemplate) {
    openTemplateEditModal(projectId, projectTitle, '', '');
    return;
  }
  
  // Unsetting template
  if (!confirm(`「${projectTitle}」のテンプレートを解除しますか？`)) {
    return;
  }
  
  isProcessing = true;
  
  try {
    const response = await axios.put(`${API_BASE}/projects/${projectId}/template`, {
      is_template: false,
      template_label: null,
      template_description: null
    });
    
    if (response.data.success) {
      showToast('テンプレートを解除しました', 'success');
      loadProjects();
    } else {
      throw new Error(response.data.error?.message || 'Unknown error');
    }
    
  } catch (error) {
    console.error('Toggle template error:', error);
    showToast(error.response?.data?.error?.message || 'テンプレート解除に失敗しました', 'error');
  } finally {
    isProcessing = false;
  }
}

// =============================================================================
// Template Edit Modal (superadmin only)
// =============================================================================

let editingTemplateProjectId = null;

function openTemplateEditModal(projectId, currentLabel, currentDescription, projectTitle) {
  editingTemplateProjectId = projectId;
  
  // Create modal if not exists
  let modal = document.getElementById('templateEditModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'templateEditModal';
    modal.className = 'fixed inset-0 bg-black bg-opacity-50 hidden z-50 flex items-center justify-center';
    modal.innerHTML = `
      <div class="bg-white rounded-lg shadow-xl max-w-md w-full mx-4">
        <div class="p-6 border-b">
          <div class="flex justify-between items-center">
            <h2 class="text-xl font-bold text-gray-800">
              <i class="fas fa-star mr-2 text-yellow-500"></i>
              テンプレート設定
            </h2>
            <button onclick="closeTemplateEditModal()" class="text-gray-500 hover:text-gray-700">
              <i class="fas fa-times text-xl"></i>
            </button>
          </div>
        </div>
        <div class="p-6">
          <div class="mb-4">
            <label class="block text-sm font-medium text-gray-700 mb-2">テンプレート名</label>
            <input 
              type="text" 
              id="templateEditLabel" 
              placeholder="テンプレートの表示名"
              maxlength="50"
              class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-yellow-500"
            />
          </div>
          <div class="mb-4">
            <label class="block text-sm font-medium text-gray-700 mb-2">説明文（推奨: 50〜200文字）</label>
            <textarea 
              id="templateEditDescription" 
              placeholder="新規ユーザーがテンプレートを選ぶ際のガイドになります"
              maxlength="500"
              rows="3"
              class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-yellow-500"
            ></textarea>
            <p class="text-xs text-gray-500 mt-1" id="templateDescCharCount">0 / 500</p>
          </div>
        </div>
        <div class="p-4 border-t bg-gray-50 flex justify-end gap-2">
          <button 
            onclick="closeTemplateEditModal()" 
            class="px-4 py-2 bg-gray-300 text-gray-700 rounded-lg hover:bg-gray-400"
          >
            キャンセル
          </button>
          <button 
            onclick="saveTemplateSettings()" 
            class="px-4 py-2 bg-yellow-500 text-white rounded-lg hover:bg-yellow-600"
          >
            <i class="fas fa-save mr-2"></i>保存
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    
    // Add character count listener
    document.getElementById('templateEditDescription').addEventListener('input', (e) => {
      document.getElementById('templateDescCharCount').textContent = `${e.target.value.length} / 500`;
    });
  }
  
  // Set values
  document.getElementById('templateEditLabel').value = currentLabel || projectTitle || '';
  document.getElementById('templateEditDescription').value = currentDescription || '';
  document.getElementById('templateDescCharCount').textContent = `${(currentDescription || '').length} / 500`;
  
  modal.classList.remove('hidden');
}

function closeTemplateEditModal() {
  const modal = document.getElementById('templateEditModal');
  if (modal) {
    modal.classList.add('hidden');
  }
  editingTemplateProjectId = null;
}

async function saveTemplateSettings() {
  if (!editingTemplateProjectId || isProcessing) return;
  
  const label = document.getElementById('templateEditLabel').value.trim();
  const description = document.getElementById('templateEditDescription').value.trim();
  
  if (!label) {
    showToast('テンプレート名を入力してください', 'error');
    return;
  }
  
  isProcessing = true;
  
  try {
    const response = await axios.put(`${API_BASE}/projects/${editingTemplateProjectId}/template`, {
      is_template: true,
      template_label: label,
      template_description: description || null
    });
    
    if (response.data.success) {
      showToast('テンプレート設定を保存しました', 'success');
      closeTemplateEditModal();
      loadProjects();
    } else {
      throw new Error(response.data.error?.message || 'Unknown error');
    }
    
  } catch (error) {
    console.error('Save template settings error:', error);
    showToast(error.response?.data?.error?.message || 'テンプレート設定の保存に失敗しました', 'error');
  } finally {
    isProcessing = false;
  }
}

// Edit existing template (superadmin only)
function editTemplate(projectId, currentLabel, currentDescription) {
  openTemplateEditModal(projectId, currentLabel, currentDescription, currentLabel);
}
