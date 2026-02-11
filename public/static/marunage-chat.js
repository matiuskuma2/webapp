/**
 * Marunage Chat MVP - Frontend Controller
 * 
 * Experience C (体験C): テキスト → 5シーン → 画像 → 音声 → Ready
 * Ref: docs/MARUNAGE_EXPERIENCE_SPEC_v1.md
 * 
 * UI State Machine: idle → processing → ready → error
 * SSOT: marunage_runs.phase (via GET /api/marunage/:projectId/status)
 */

// ============================================================
// Global State
// ============================================================

const MC = {
  // UI state
  uiState: 'idle', // idle | processing | ready | error
  
  // Run data
  runId: null,
  projectId: null,
  phase: null,
  config: null,
  
  // Polling
  pollTimer: null,
  pollInterval: 3000, // 3s
  
  // Settings (pre-start)
  selectedVoice: { provider: 'google', voice_id: 'ja-JP-Neural2-B' },
  selectedPreset: 'yt_long',
  
  // Auth
  currentUser: null,

  // Progress tracking (for chat dedup)
  _lastProgressMsg: '',
  _progressBubble: null,
};

// ============================================================
// Live Progress Ticker — updates both board detail + chat bubble
// ============================================================

function mcUpdateLiveProgress(data) {
  const phase = data.phase;
  const p = data.progress;
  const detailEl = document.getElementById('mcPhaseDetail');
  let msg = '';

  switch (phase) {
    case 'formatting': {
      const c = p.format.chunks;
      if (c.total > 0) {
        msg = '整形中: ' + c.done + '/' + c.total + ' チャンク完了';
      } else {
        msg = '整形開始中...';
      }
      break;
    }
    case 'awaiting_ready': {
      const sr = p.scenes_ready;
      msg = sr.visible_count + ' シーン確認中';
      if (sr.utterances_ready) msg += ' — 準備OK';
      break;
    }
    case 'generating_images': {
      const im = p.images;
      const parts = ['画像: ' + im.completed + '/' + im.total + '枚完了'];
      if (im.generating > 0) parts.push(im.generating + '枚生成中');
      if (im.failed > 0) parts.push(im.failed + '枚失敗');
      if (im.pending > 0) parts.push(im.pending + '枚待機');
      msg = parts.join(' / ');
      break;
    }
    case 'generating_audio': {
      const au = p.audio;
      if (au.total_utterances > 0) {
        const done = au.completed || 0;
        msg = '音声: ' + done + '/' + au.total_utterances + '個完了';
        if (au.failed > 0) msg += ' (' + au.failed + '失敗)';
      } else {
        msg = au.job_id ? '音声生成開始中...' : '音声ジョブ準備中...';
      }
      break;
    }
    case 'ready':
      msg = '完成しました！';
      break;
    case 'failed':
      msg = 'エラーが発生しました';
      break;
  }

  // Debug log for progress visibility
  if (msg) {
    console.log('[Marunage Progress]', phase, msg, JSON.stringify(p.images || {}));
  }

  // Update board detail text
  if (detailEl) {
    if (msg) {
      detailEl.textContent = msg;
      detailEl.classList.remove('hidden');
    } else {
      detailEl.classList.add('hidden');
    }
  }

  // Update or create a single live-progress chat bubble (no duplication)
  if (msg && msg !== MC._lastProgressMsg && phase !== 'ready' && phase !== 'failed') {
    MC._lastProgressMsg = msg;
    if (!MC._progressBubble || !MC._progressBubble.isConnected) {
      MC._progressBubble = mcAddSystemMessage(msg);
      MC._progressBubble.setAttribute('data-live-progress', 'true');
    } else {
      // Update existing bubble in-place
      const inner = MC._progressBubble.querySelector('.chat-bubble');
      if (inner) inner.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>' + msg;
    }
  }
}

// ============================================================
// Axios config
// ============================================================
axios.defaults.withCredentials = true;

// ============================================================
// Auth Check
// ============================================================

async function mcCheckAuth() {
  try {
    const res = await axios.get('/api/auth/me');
    if (!res.data.authenticated) {
      window.location.href = '/login';
      return;
    }
    MC.currentUser = res.data.user;
    document.getElementById('mcAuthLoading').classList.add('hidden');
    document.getElementById('mcShell').classList.remove('hidden');
    
    // Check for active run
    await mcCheckActiveRun();
  } catch (err) {
    console.error('Auth check failed:', err);
    window.location.href = '/login';
  }
}

// ============================================================
// Check Active Run (resume on revisit)
// ============================================================

async function mcCheckActiveRun() {
  try {
    const res = await axios.get('/api/marunage/active');
    if (res.data.run_id) {
      MC.runId = res.data.run_id;
      MC.projectId = res.data.project_id;
      MC.phase = res.data.phase;
      
      mcAddSystemMessage('前回の処理を再開しています...');
      mcSetUIState('processing');
      mcStartPolling();
    }
  } catch (err) {
    if (err.response?.status === 404) {
      // No active run - stay in idle
      return;
    }
    console.warn('Active run check failed:', err);
  }
}

// ============================================================
// Send Message (Start Run)
// ============================================================

async function mcSendMessage() {
  const input = document.getElementById('mcChatInput');
  const text = input.value.trim();
  
  if (!text) return;
  if (text.length < 100) {
    mcAddSystemMessage(`テキストが短すぎます（現在${text.length}文字、最低100文字必要です）`, 'error');
    return;
  }
  if (text.length > 50000) {
    mcAddSystemMessage(`テキストが長すぎます（最大50,000文字）`, 'error');
    return;
  }
  
  // If already running, ignore
  if (MC.uiState === 'processing') return;
  
  // Show user message
  mcAddUserMessage(text.length > 300 ? text.substring(0, 300) + '...' : text);
  
  // Disable input
  input.value = '';
  updateCharCount();
  document.getElementById('mcSendBtn').disabled = true;
  input.disabled = true;
  
  mcAddSystemMessage('処理を開始しています...');
  
  try {
    const res = await axios.post('/api/marunage/start', {
      text: text,
      title: `丸投げ ${new Date().toLocaleDateString('ja-JP')}`,
      narration_voice: MC.selectedVoice,
      output_preset: MC.selectedPreset,
    });
    
    MC.runId = res.data.run_id;
    MC.projectId = res.data.project_id;
    MC.phase = res.data.phase;
    MC.config = res.data.config;
    
    document.getElementById('mcProjectTitle').textContent = `Project #${MC.projectId}`;
    
    mcAddSystemMessage('テキストをシーンに分割中...');
    mcSetUIState('processing');
    mcStartPolling();
    
    // Hide voice/preset selectors
    document.getElementById('mcVoiceSelect').classList.add('hidden');
    document.getElementById('mcOutputPreset').classList.add('hidden');
    
  } catch (err) {
    console.error('Start error:', err);
    const errMsg = err.response?.data?.error?.message || 'エラーが発生しました';
    
    if (err.response?.status === 409) {
      // Already has an active run
      const details = err.response?.data?.error?.details;
      if (details?.run_id) {
        MC.runId = details.run_id;
        MC.projectId = details.project_id;
        MC.phase = details.phase;
        mcAddSystemMessage('既存の処理を再開しています...');
        mcSetUIState('processing');
        mcStartPolling();
        return;
      }
    }
    
    mcAddSystemMessage(`エラー: ${errMsg}`, 'error');
    document.getElementById('mcSendBtn').disabled = false;
    input.disabled = false;
  }
}

// ============================================================
// Polling
// ============================================================

function mcStartPolling() {
  mcStopPolling();
  mcPoll(); // immediate
  MC.pollTimer = setInterval(mcPoll, MC.pollInterval);
}

function mcStopPolling() {
  if (MC.pollTimer) {
    clearInterval(MC.pollTimer);
    MC.pollTimer = null;
  }
}

async function mcPoll() {
  if (!MC.projectId) return;
  
  try {
    const res = await axios.get(`/api/marunage/${MC.projectId}/status`);
    const data = res.data;
    
    MC.phase = data.phase;
    MC.config = data.config;
    
    // Update UI based on phase
    mcUpdateFromStatus(data);
    
    // Check shouldAdvance
    if (mcShouldAdvance(data)) {
      await mcAdvance();
    }
    
    // Check terminal
    if (['ready', 'failed', 'canceled'].includes(data.phase)) {
      mcStopPolling();
    }
    
  } catch (err) {
    console.error('Poll error:', err);
    if (err.response?.status === 404) {
      mcStopPolling();
      mcAddSystemMessage('処理が見つかりませんでした。', 'error');
      mcSetUIState('idle');
    }
  }
}

// ============================================================
// shouldAdvance logic (Ref: v3 §10-3)
// ============================================================

function mcShouldAdvance(data) {
  const phase = data.phase;
  const p = data.progress;
  
  switch (phase) {
    case 'formatting':
      return p.format.state === 'done';
      
    case 'awaiting_ready':
      return p.scenes_ready.utterances_ready && p.scenes_ready.visible_count > 0;
      
    case 'generating_images':
      return p.images.state === 'done' || 
             (p.images.generating === 0 && p.images.completed > 0);
      
    case 'generating_audio':
      return p.audio.state === 'done';
      
    default:
      return false;
  }
}

// ============================================================
// Advance
// ============================================================

async function mcAdvance() {
  if (!MC.projectId) return;
  
  try {
    const res = await axios.post(`/api/marunage/${MC.projectId}/advance`);
    const data = res.data;
    
    if (data.action === 'waiting' || data.action === 'already_advanced') {
      // No-op, will be picked up next poll
      return;
    }
    
    MC.phase = data.new_phase;
    
    // Reset live progress bubble on phase transition
    MC._lastProgressMsg = '';
    MC._progressBubble = null;
    
    // Phase transition messages
    switch (data.action) {
      case 'scenes_confirmed':
        mcAddSystemMessage(`${data.message}`);
        break;
      case 'images_started':
        mcAddSystemMessage('画像生成を開始しました...');
        break;
      case 'audio_started':
        mcAddSystemMessage('ナレーション音声を生成中...');
        break;
      case 'audio_retrigger':
        mcAddSystemMessage('音声生成を再起動しました...');
        break;
      case 'completed':
        mcAddSystemMessage('完成しました！左のボードで結果を確認してください。', 'success');
        mcSetUIState('ready');
        break;
      case 'failed':
      case 'failed_no_scenes':
        mcAddSystemMessage(`エラー: ${data.message}`, 'error');
        mcSetUIState('error');
        break;
      case 'retrying':
      case 'auto_retry':
        mcAddSystemMessage(data.message || '自動リトライ中...');
        break;
    }
    
  } catch (err) {
    console.error('Advance error:', err);
  }
}

// ============================================================
// Update UI from status
// ============================================================

function mcUpdateFromStatus(data) {
  const phase = data.phase;
  const p = data.progress;
  
  // Update phase badge
  mcUpdatePhaseBadge(phase);
  
  // Update progress bar
  mcUpdateProgress(data);
  
  // Update live progress text (board + chat)
  mcUpdateLiveProgress(data);
  
  // Update scene cards
  mcUpdateSceneCards(p.scenes_ready.scenes, p.images, p.audio);
  
  // Update timestamp
  if (data.timestamps.updated_at) {
    const d = new Date(data.timestamps.updated_at);
    document.getElementById('mcUpdatedAt').textContent = `更新: ${d.toLocaleTimeString('ja-JP')}`;
  }
  
  // Handle error state
  if (phase === 'failed') {
    mcSetUIState('error');
    if (data.error) {
      mcShowRetryOption(data);
    }
  }
  
  // Handle ready
  if (phase === 'ready') {
    mcSetUIState('ready');
  }
  
  // Handle canceled
  if (phase === 'canceled') {
    mcAddSystemMessage('処理が中断されました。');
    mcSetUIState('idle');
  }
  
  // Show cancel button during processing
  const cancelBtn = document.getElementById('mcCancelBtn');
  if (['formatting', 'awaiting_ready', 'generating_images', 'generating_audio'].includes(phase)) {
    cancelBtn.classList.remove('hidden');
  } else {
    cancelBtn.classList.add('hidden');
  }
}

// ============================================================
// Phase Badge
// ============================================================

function mcUpdatePhaseBadge(phase) {
  const badge = document.getElementById('mcPhaseBadge');
  const map = {
    'init':              { text: '初期化中', bg: 'bg-gray-200', fg: 'text-gray-700' },
    'formatting':        { text: '整形中', bg: 'bg-blue-100', fg: 'text-blue-700' },
    'awaiting_ready':    { text: '確認待ち', bg: 'bg-yellow-100', fg: 'text-yellow-700' },
    'generating_images': { text: '画像生成中', bg: 'bg-purple-100', fg: 'text-purple-700' },
    'generating_audio':  { text: '音声生成中', bg: 'bg-indigo-100', fg: 'text-indigo-700' },
    'ready':             { text: '完成', bg: 'bg-green-100', fg: 'text-green-700' },
    'failed':            { text: 'エラー', bg: 'bg-red-100', fg: 'text-red-700' },
    'canceled':          { text: '中断', bg: 'bg-gray-200', fg: 'text-gray-600' },
  };
  const m = map[phase] || { text: phase, bg: 'bg-gray-200', fg: 'text-gray-600' };
  badge.textContent = m.text;
  badge.className = `text-xs px-2 py-0.5 rounded-full font-semibold ${m.bg} ${m.fg}`;
}

// ============================================================
// Progress bar (Ref: Experience Spec §9)
// ============================================================

function mcUpdateProgress(data) {
  const phase = data.phase;
  const p = data.progress;
  
  let percent = 0;
  
  switch (phase) {
    case 'init':
    case 'formatting':
      // 0-20%: based on chunk progress
      if (p.format.chunks.total > 0) {
        percent = Math.round((p.format.chunks.done / p.format.chunks.total) * 20);
      } else {
        percent = 5;
      }
      break;
      
    case 'awaiting_ready':
      percent = 20;
      if (p.scenes_ready.utterances_ready) percent = 25;
      break;
      
    case 'generating_images':
      // 25-65%
      if (p.images.total > 0) {
        const imgProgress = p.images.completed / p.images.total;
        percent = 25 + Math.round(imgProgress * 40);
      } else {
        percent = 30;
      }
      break;
      
    case 'generating_audio':
      // 65-95%
      if (p.audio.total_utterances > 0) {
        const audioProgress = p.audio.completed / p.audio.total_utterances;
        percent = 65 + Math.round(audioProgress * 30);
      } else {
        percent = 70;
      }
      break;
      
    case 'ready':
      percent = 100;
      break;
      
    case 'failed':
    case 'canceled':
      // Keep current
      break;
  }
  
  document.getElementById('mcProgressFill').style.width = `${percent}%`;
  document.getElementById('mcProgressPercent').textContent = `${percent}%`;
  
  // Update step indicators
  const steps = ['mcStep1', 'mcStep2', 'mcStep3', 'mcStep4', 'mcStep5'];
  const phaseStepMap = {
    'init': 0, 'formatting': 0, 'awaiting_ready': 1,
    'generating_images': 2, 'generating_audio': 3, 'ready': 4,
  };
  const activeStep = phaseStepMap[phase] ?? -1;
  
  steps.forEach((id, i) => {
    const el = document.getElementById(id);
    if (i < activeStep) {
      el.className = 'text-[10px] text-green-600 font-bold';
    } else if (i === activeStep) {
      el.className = 'text-[10px] text-purple-600 font-bold';
    } else {
      el.className = 'text-[10px] text-gray-400';
    }
  });
}

// ============================================================
// Scene Cards
// ============================================================

function mcUpdateSceneCards(scenes, imageProgress, audioProgress) {
  if (!scenes || scenes.length === 0) {
    document.getElementById('mcSceneCards').classList.add('hidden');
    return;
  }
  
  document.getElementById('mcBoardIdle').classList.add('hidden');
  const container = document.getElementById('mcSceneCards');
  container.classList.remove('hidden');
  
  container.innerHTML = scenes.map((scene, idx) => {
    // Determine image badge
    let imgBadgeClass, imgBadgeText, imgBadgeIcon;
    if (scene.has_image) {
      imgBadgeClass = 'bg-green-100 text-green-700';
      imgBadgeText = '画像OK';
      imgBadgeIcon = 'fa-check-circle';
    } else if (scene.image_status === 'generating') {
      imgBadgeClass = 'bg-yellow-100 text-yellow-700 animate-pulse';
      imgBadgeText = '生成中';
      imgBadgeIcon = 'fa-spinner fa-spin';
    } else if (scene.image_status === 'failed') {
      imgBadgeClass = 'bg-red-100 text-red-700';
      imgBadgeText = '失敗';
      imgBadgeIcon = 'fa-exclamation-circle';
    } else {
      imgBadgeClass = 'bg-gray-100 text-gray-500';
      imgBadgeText = '待機中';
      imgBadgeIcon = 'fa-clock';
    }
    
    // Determine audio badge
    let audioBadge = '';
    if (scene.has_audio) {
      audioBadge = '<span class="scene-badge bg-green-100 text-green-700 ml-1"><i class="fas fa-check-circle mr-0.5"></i>音声OK</span>';
    }
    
    const imgContent = scene.image_url
      ? `<img src="${scene.image_url}" alt="Scene ${idx + 1}" class="w-full aspect-video object-cover" loading="lazy">`
      : `<div class="scene-card-img text-gray-400">
           <div class="text-center">
             <i class="fas ${scene.image_status === 'generating' ? 'fa-spinner fa-spin' : 'fa-image'} text-3xl mb-1"></i>
             <p class="text-xs">${imgBadgeText}</p>
           </div>
         </div>`;
    
    return `
      <div class="scene-card">
        ${imgContent}
        <div class="p-3">
          <div class="flex items-center justify-between mb-1">
            <span class="text-xs font-bold text-gray-500">Scene ${idx + 1}</span>
            <div class="flex items-center">
              <span class="scene-badge ${imgBadgeClass}"><i class="fas ${imgBadgeIcon} mr-0.5"></i>${imgBadgeText}</span>
              ${audioBadge}
            </div>
          </div>
          <p class="text-sm font-semibold text-gray-800 line-clamp-2">${scene.title || 'シーン ' + (idx + 1)}</p>
          <p class="text-xs text-gray-500 mt-1">
            <i class="fas fa-comment mr-1"></i>${scene.utterance_count} 発話
          </p>
        </div>
      </div>
    `;
  }).join('');
}

// ============================================================
// Chat Messages
// ============================================================

function mcAddSystemMessage(text, type = 'info') {
  const container = document.getElementById('mcChatMessages');
  const bubble = document.createElement('div');
  bubble.className = 'flex justify-start';
  
  let bgClass = 'chat-system';
  let icon = '<i class="fas fa-robot mr-1"></i>';
  
  if (type === 'error') {
    bgClass = 'chat-bubble bg-red-50 text-red-700';
    icon = '<i class="fas fa-exclamation-triangle mr-1"></i>';
  } else if (type === 'success') {
    bgClass = 'chat-bubble bg-green-50 text-green-700';
    icon = '<i class="fas fa-check-circle mr-1"></i>';
  }
  
  bubble.innerHTML = `<div class="chat-bubble ${bgClass}">${icon}${text}</div>`;
  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;
  
  // Remove duplicate messages if same text
  return bubble;
}

function mcAddUserMessage(text) {
  const container = document.getElementById('mcChatMessages');
  const bubble = document.createElement('div');
  bubble.className = 'flex justify-end';
  bubble.innerHTML = `<div class="chat-bubble chat-user">${escapeHtml(text)}</div>`;
  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;
}

// ============================================================
// Retry
// ============================================================

function mcShowRetryOption(data) {
  if (MC._retryShown) return;
  MC._retryShown = true;
  
  const errorMsg = data.error?.message || '不明なエラー';
  const retryCount = data.config?.retry_count || 0;
  
  const container = document.getElementById('mcChatMessages');
  const div = document.createElement('div');
  div.className = 'flex justify-start';
  div.innerHTML = `
    <div class="chat-bubble bg-red-50 text-red-700 border border-red-200">
      <p class="font-semibold mb-2"><i class="fas fa-exclamation-triangle mr-1"></i>エラーが発生しました</p>
      <p class="text-sm mb-3">${escapeHtml(errorMsg)}</p>
      <div class="flex gap-2">
        <button onclick="mcRetry()" class="px-3 py-1.5 bg-red-600 text-white rounded-lg text-sm font-semibold hover:bg-red-700">
          <i class="fas fa-redo mr-1"></i>再試行
        </button>
        <button onclick="mcCancel()" class="px-3 py-1.5 bg-gray-200 text-gray-700 rounded-lg text-sm hover:bg-gray-300">
          中断
        </button>
      </div>
    </div>
  `;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

async function mcRetry() {
  if (!MC.projectId) return;
  MC._retryShown = false;
  
  try {
    mcAddSystemMessage('再試行を開始しています...');
    const res = await axios.post(`/api/marunage/${MC.projectId}/retry`);
    MC.phase = res.data.new_phase;
    mcSetUIState('processing');
    mcStartPolling();
  } catch (err) {
    const msg = err.response?.data?.error?.message || '再試行に失敗しました';
    mcAddSystemMessage(`エラー: ${msg}`, 'error');
  }
}

// ============================================================
// Cancel
// ============================================================

document.getElementById('mcCancelBtn').addEventListener('click', mcCancel);

async function mcCancel() {
  if (!MC.projectId) return;
  
  if (!confirm('処理を中断しますか？')) return;
  
  try {
    await axios.post(`/api/marunage/${MC.projectId}/cancel`);
    mcStopPolling();
    mcAddSystemMessage('処理を中断しました。');
    mcSetUIState('idle');
  } catch (err) {
    console.error('Cancel error:', err);
  }
}

// ============================================================
// UI State Machine
// ============================================================

function mcSetUIState(state) {
  MC.uiState = state;
  
  const input = document.getElementById('mcChatInput');
  const sendBtn = document.getElementById('mcSendBtn');
  const voiceSelect = document.getElementById('mcVoiceSelect');
  const outputPreset = document.getElementById('mcOutputPreset');
  const boardIdle = document.getElementById('mcBoardIdle');
  
  switch (state) {
    case 'idle':
      input.disabled = false;
      sendBtn.disabled = false;
      input.placeholder = 'シナリオテキストを貼り付けてください...';
      voiceSelect.classList.remove('hidden');
      outputPreset.classList.remove('hidden');
      boardIdle.classList.remove('hidden');
      document.getElementById('mcSceneCards').classList.add('hidden');
      MC.runId = null;
      MC.projectId = null;
      MC.phase = null;
      MC._retryShown = false;
      break;
      
    case 'processing':
      input.disabled = true;
      sendBtn.disabled = true;
      input.placeholder = '処理中...';
      voiceSelect.classList.add('hidden');
      outputPreset.classList.add('hidden');
      break;
      
    case 'ready':
      input.disabled = true;
      sendBtn.disabled = true;
      input.placeholder = '完成しました';
      mcStopPolling();
      mcShowReadyActions();
      break;
      
    case 'error':
      input.disabled = true;
      sendBtn.disabled = true;
      input.placeholder = 'エラーが発生しました';
      break;
  }
}

function mcShowReadyActions() {
  const container = document.getElementById('mcChatMessages');
  
  // Check if ready actions already shown
  if (container.querySelector('[data-ready-actions]')) return;
  
  const div = document.createElement('div');
  div.className = 'flex justify-start';
  div.setAttribute('data-ready-actions', 'true');
  div.innerHTML = `
    <div class="chat-bubble bg-green-50 text-green-800 border border-green-200 w-full">
      <p class="font-bold mb-2"><i class="fas fa-check-circle mr-1"></i>素材が完成しました！</p>
      <p class="text-sm mb-3">左のボードでシーン画像を確認できます。</p>
      <div class="flex flex-wrap gap-2">
        <a href="/projects/${MC.projectId}" class="inline-flex items-center px-3 py-1.5 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-700 no-underline">
          <i class="fas fa-edit mr-1"></i>プロジェクトを開く
        </a>
        <button onclick="mcStartNew()" class="px-3 py-1.5 bg-purple-600 text-white rounded-lg text-sm font-semibold hover:bg-purple-700">
          <i class="fas fa-plus mr-1"></i>新しく作る
        </button>
      </div>
    </div>
  `;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function mcStartNew() {
  // Reset everything
  MC.runId = null;
  MC.projectId = null;
  MC.phase = null;
  MC.config = null;
  MC._retryShown = false;
  MC._lastProgressMsg = '';
  MC._progressBubble = null;
  
  // Clear chat
  const container = document.getElementById('mcChatMessages');
  container.innerHTML = `
    <div class="flex justify-start">
      <div class="chat-bubble chat-system">
        <p class="font-semibold mb-1"><i class="fas fa-hand-sparkles mr-1"></i>丸投げチャットへようこそ！</p>
        <p class="text-sm">シナリオテキストを貼り付けてください。<br>5シーンの画像とナレーション音声を自動で生成します。</p>
        <p class="text-xs mt-2 text-purple-400">
          <i class="fas fa-info-circle mr-1"></i>100文字以上のテキストが必要です
        </p>
      </div>
    </div>
  `;
  
  // Reset UI
  document.getElementById('mcProjectTitle').textContent = '新しい動画素材を作成';
  mcUpdatePhaseBadge('idle');
  document.getElementById('mcProgressFill').style.width = '0%';
  document.getElementById('mcProgressPercent').textContent = '0%';
  const phaseDetail = document.getElementById('mcPhaseDetail');
  if (phaseDetail) { phaseDetail.textContent = ''; phaseDetail.classList.add('hidden'); }
  
  mcSetUIState('idle');
}

// ============================================================
// Voice / Preset Selection
// ============================================================

function selectVoice(el) {
  document.querySelectorAll('#mcVoiceSelect .voice-chip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  
  const [provider, voiceId] = el.dataset.voice.split(':');
  MC.selectedVoice = { provider, voice_id: voiceId };
}

function selectPreset(el) {
  document.querySelectorAll('#mcOutputPreset .voice-chip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  MC.selectedPreset = el.dataset.preset;
}

// ============================================================
// Chat Input
// ============================================================

const chatInput = document.getElementById('mcChatInput');

chatInput.addEventListener('input', updateCharCount);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    mcSendMessage();
  }
});

function updateCharCount() {
  const len = chatInput.value.length;
  document.getElementById('mcCharCount').textContent = `${len.toLocaleString()}文字`;
}

// ============================================================
// Mobile View Toggle
// ============================================================

document.getElementById('mcToggleView')?.addEventListener('click', () => {
  const left = document.getElementById('mcLeft');
  const right = document.getElementById('mcRight');
  left.classList.toggle('mc-expanded');
  right.classList.toggle('mc-expanded');
});

// ============================================================
// Utility
// ============================================================

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ============================================================
// Init
// ============================================================

mcCheckAuth();
