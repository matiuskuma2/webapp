// API Base URL
const API_BASE = '/api';

// Global state
let currentProject = null;

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
  }
  
  messageEl.textContent = message;
  toast.classList.remove('hidden');
  
  setTimeout(() => {
    toast.classList.add('hidden');
  }, 3000);
}

// Create new project
async function createProject() {
  const titleInput = document.getElementById('projectTitle');
  const title = titleInput.value.trim();
  
  if (!title) {
    showToast('プロジェクトタイトルを入力してください', 'error');
    return;
  }
  
  try {
    const response = await axios.post(`${API_BASE}/projects`, { title });
    
    if (response.data.success) {
      showToast('プロジェクトが作成されました', 'success');
      titleInput.value = '';
      loadProjects();
    } else {
      showToast(response.data.error || 'プロジェクト作成に失敗しました', 'error');
    }
  } catch (error) {
    console.error('Create project error:', error);
    showToast('プロジェクト作成中にエラーが発生しました', 'error');
  }
}

// Load projects list
async function loadProjects() {
  const projectsList = document.getElementById('projectsList');
  
  try {
    const response = await axios.get(`${API_BASE}/projects`);
    
    if (response.data.success && response.data.projects.length > 0) {
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
                  作成日時: ${new Date(project.created_at).toLocaleString('ja-JP')}
                </span>
              </div>
            </div>
            <button 
              onclick="viewProject('${project.id}')"
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
function viewProject(projectId) {
  // Phase 1では単にプロジェクトIDを表示
  showToast(`プロジェクトID: ${projectId} の詳細画面は次フェーズで実装します`, 'info');
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
    'error': 'text-red-600'
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
    'error': 'エラー'
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
