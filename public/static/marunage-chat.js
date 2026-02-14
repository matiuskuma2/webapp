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
  selectedSceneCount: 5,
  
  // Auth
  currentUser: null,

  // Progress tracking (for chat dedup)
  _lastProgressMsg: '',
  _progressBubble: null,

  // Advance debounce
  _lastAdvanceTime: 0,

  // Track when 'generating' status was first seen (for stale detection)
  _generatingSeenSince: 0,

  // Polling guard (prevent concurrent mcPoll execution)
  _isPolling: false,

  // One-shot notification guards (video build)
  _videoDoneNotified: false,
  _videoFailedNotified: false,
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
    case 'ready': {
      const vs = p?.video?.state;
      if (vs === 'running') msg = '🎬 動画レンダリング中... ' + (p.video.progress_percent || 0) + '%';
      else if (vs === 'done') msg = '✅ 動画が完成しました！';
      else if (vs === 'failed') msg = '⚠️ 動画生成に失敗';
      else if (vs === 'pending') msg = '⏳ 動画ビルド準備中...';
      else msg = '✅ 素材が完成しました';
      break;
    }
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
    
    // Check URL for ?run=:runId (from dashboard)
    const urlParams = new URLSearchParams(window.location.search);
    const runParam = urlParams.get('run');
    
    if (runParam) {
      // Resume specific run from dashboard
      await mcResumeRun(parseInt(runParam));
    }
    // If no ?run= param, stay in idle (new creation mode)
  } catch (err) {
    console.error('Auth check failed:', err);
    window.location.href = '/login';
  }
}

// ============================================================
// Resume specific run (from dashboard link)
// ============================================================

async function mcResumeRun(runId) {
  try {
    // Step 1: Try /active first (for in-progress runs)
    const res = await axios.get('/api/marunage/active');
    console.log('[Marunage] Resume via /active:', res.data);
    MC.runId = res.data.run_id;
    MC.projectId = res.data.project_id;
    MC.phase = res.data.phase;
    
    document.getElementById('mcProjectTitle').textContent = 'Project #' + MC.projectId;
    mcAddSystemMessage('処理を再開しています... (Phase: ' + MC.phase + ')');
    mcSetUIState('processing');
    mcStartPolling();
  } catch (activeErr) {
    // Step 2: /active returned 404 → try direct run lookup (for ready/failed/canceled runs)
    if (activeErr.response?.status !== 404) {
      console.warn('Resume run failed (non-404):', activeErr);
      return;
    }
    
    try {
      const runRes = await axios.get('/api/marunage/runs/' + runId);
      console.log('[Marunage] Resume via /runs/:runId:', runRes.data);
      MC.runId = runRes.data.run_id;
      MC.projectId = runRes.data.project_id;
      MC.phase = runRes.data.phase;
      
      document.getElementById('mcProjectTitle').textContent = 'Project #' + MC.projectId;
      
      if (MC.phase === 'ready') {
        // Ready run: fetch full status and show Result View
        mcAddSystemMessage('完成した処理を表示しています...');
        mcSetUIState('processing'); // temporary
        mcStartPolling(); // will trigger mcUpdateFromStatus → mcSetUIState('ready') → mcShowReadyActions()
      } else if (MC.phase === 'failed') {
        mcAddSystemMessage('この処理はエラーで停止しています。', 'error');
        mcSetUIState('error');
        mcStartPolling(); // fetch full status once
      } else if (MC.phase === 'canceled') {
        mcAddSystemMessage('この処理は中断されています。');
      } else {
        // Unexpected terminal state
        mcAddSystemMessage('処理状態: ' + MC.phase);
        mcSetUIState('processing');
        mcStartPolling();
      }
    } catch (runErr) {
      if (runErr.response?.status === 404) {
        mcAddSystemMessage('指定された処理が見つかりませんでした。新しくテキストを入力してください。', 'error');
      } else if (runErr.response?.status === 403) {
        mcAddSystemMessage('この処理へのアクセス権がありません。', 'error');
      } else {
        console.warn('Resume run lookup failed:', runErr);
        mcAddSystemMessage('処理の読み込みに失敗しました。', 'error');
      }
    }
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
      target_scene_count: MC.selectedSceneCount,
    });
    
    MC.runId = res.data.run_id;
    MC.projectId = res.data.project_id;
    MC.phase = res.data.phase;
    MC.config = res.data.config;
    
    document.getElementById('mcProjectTitle').textContent = `Project #${MC.projectId}`;
    
    mcAddSystemMessage('テキストをシーンに分割中...');
    mcSetUIState('processing');
    mcStartPolling();
    
    // Hide voice/preset/scene selectors
    document.getElementById('mcVoiceSelect').classList.add('hidden');
    document.getElementById('mcOutputPreset').classList.add('hidden');
    document.getElementById('mcSceneCount').classList.add('hidden');
    
  } catch (err) {
    console.error('Start error:', err);
    const errMsg = err.response?.data?.error?.message || 'エラーが発生しました';
    
    if (err.response?.status === 409) {
      // Already has an active run — guide to dashboard
      const details = err.response?.data?.error?.details;
      const container = document.getElementById('mcChatMessages');
      const div = document.createElement('div');
      div.className = 'flex justify-start';
      div.innerHTML = '<div class="chat-bubble bg-yellow-50 text-yellow-800 border border-yellow-200">'
        + '<p class="font-semibold mb-2"><i class="fas fa-exclamation-triangle mr-1"></i>処理中のプロジェクトがあります</p>'
        + '<p class="text-sm mb-3">前回の処理がまだ進行中です。先にそちらを完了または中断してから、新しく作成できます。</p>'
        + '<div class="flex gap-2">'
        + (details?.run_id
          ? '<a href="/marunage-chat?run=' + details.run_id + '" class="px-3 py-1.5 bg-purple-600 text-white rounded-lg text-xs font-semibold hover:bg-purple-700 no-underline"><i class="fas fa-play mr-1"></i>続ける</a>'
          : '')
        + '<a href="/marunage" class="px-3 py-1.5 bg-gray-200 text-gray-700 rounded-lg text-xs hover:bg-gray-300 no-underline"><i class="fas fa-list mr-1"></i>一覧を見る</a>'
        + '</div>'
        + '</div>';
      container.appendChild(div);
      container.scrollTop = container.scrollHeight;
      document.getElementById('mcSendBtn').disabled = false;
      input.disabled = false;
      return;
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
  if (MC._isPolling) return; // Prevent concurrent polls
  MC._isPolling = true;
  
  try {
    const res = await axios.get(`/api/marunage/${MC.projectId}/status`);
    const data = res.data;
    
    console.log('[Marunage Poll]', data.phase, 'images:', JSON.stringify(data.progress?.images), 'audio:', JSON.stringify(data.progress?.audio));
    
    MC.phase = data.phase;
    MC.config = data.config;
    
    // Update UI based on phase
    mcUpdateFromStatus(data);
    
    // Check shouldAdvance (debounce: min 10s between advance calls)
    if (mcShouldAdvance(data)) {
      const now = Date.now();
      if (now - MC._lastAdvanceTime >= 5000) {
        MC._lastAdvanceTime = now;
        console.log('[Marunage] shouldAdvance=true, calling mcAdvance()');
        await mcAdvance();
      } else {
        console.log('[Marunage] shouldAdvance=true but debounced, waiting...');
      }
    }
    
    // Check terminal
    if (['failed', 'canceled'].includes(data.phase)) {
      mcStopPolling();
    }
    if (data.phase === 'ready') {
      const vs = data.progress?.video?.state;
      if (!vs || vs === 'off' || vs === 'done' || vs === 'failed') {
        mcStopPolling();
      }
      // running/pending → continue polling for video build progress
    }
    
  } catch (err) {
    console.error('Poll error:', err);
    if (err.response?.status === 404) {
      mcStopPolling();
      mcAddSystemMessage('処理が見つかりませんでした。', 'error');
      mcSetUIState('idle');
    }
  } finally {
    MC._isPolling = false;
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
      // Advance when:
      // 1. All done (state='done') → audio transition
      // 2. Some completed, none generating, none pending → audio transition  
      // 3. Pending images exist, none generating → kick 1 image
      // 4. Failed images exist, none generating/pending → trigger retry
      // 5. Generating stuck >2min → call advance to trigger stale detection
      if (p.images.state === 'done') return true;
      if (p.images.generating > 0) {
        // Track when we first saw generating status
        if (!MC._generatingSeenSince) MC._generatingSeenSince = Date.now();
        // If generating for >60s, allow advance so backend can detect stale records
        if (Date.now() - MC._generatingSeenSince > 60000) {
          console.log('[Marunage] Generating stuck >60s, allowing advance for stale detection');
          return true;
        }
        return false; // wait while generating (normal case)
      }
      // Reset generating timer when no longer generating
      MC._generatingSeenSince = 0;
      if (p.images.pending > 0) return true; // kick next image
      if (p.images.completed > 0 && p.images.failed === 0) return true; // all done
      if (p.images.failed > 0) return true; // trigger retry logic
      return false;
      
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
    // Longer timeout: advance may generate 1 image synchronously (10-30s)
    const res = await axios.post(`/api/marunage/${MC.projectId}/advance`, {}, { timeout: 60000 });
    const data = res.data;
    
    if (data.action === 'waiting' || data.action === 'already_advanced') {
      // No-op, will be picked up next poll
      return;
    }
    
    if (data.action === 'stale_fixed') {
      // Stale generating records were cleaned up — reset timer and let next poll re-kick
      MC._generatingSeenSince = 0;
      mcAddSystemMessage(data.message || '停滞画像を検出、再生成します');
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
        MC._generatingSeenSince = Date.now(); // Reset: new image is being generated
        mcAddSystemMessage(data.message || '画像生成中...');
        break;
      case 'audio_started':
        mcAddSystemMessage('ナレーション音声を生成中...');
        break;
      case 'audio_retrigger':
        mcAddSystemMessage('音声生成を再起動しました...');
        break;
      case 'completed':
        // Message adapts to whether video build is enabled
        // (next poll will reveal video.state; for now, generic success)
        mcAddSystemMessage(
          '<div>🎉 素材が完成しました！</div>'
          + '<div class="mt-2 text-sm">画像 + ナレーション音声が揃いました。</div>'
          + '<div class="mt-2 text-sm text-gray-500">動画の自動合成を確認中...</div>',
          'success'
        );
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
    if (err.response) {
      console.error('Advance error response:', JSON.stringify(err.response.data));
      // 409 CONFLICT (lock): don't treat as fatal — next poll cycle will retry
      if (err.response.status === 409) {
        console.log('[Marunage] Advance blocked by lock (409). Will retry on next poll.');
        return; // Do not break the polling loop
      }
    }
  }
}

// ============================================================
// Update UI from status
// ============================================================

function mcUpdateFromStatus(data) {
  const phase = data.phase;
  const p = data.progress;
  
  // Update phase badge (pass video.state for ready phase)
  mcUpdatePhaseBadge(phase, p?.video?.state);
  
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
  
  // Handle ready — store latest status for Result View
  if (phase === 'ready') {
    MC._lastStatus = data;
    mcSetUIState('ready');
    // Update video status panel if already shown
    mcUpdateVideoPanel(data.progress?.video);
    
    // One-shot chat bubble when video.state transitions to done/failed
    const vs = data.progress?.video?.state;
    if (vs === 'done' && !MC._videoDoneNotified) {
      MC._videoDoneNotified = true;
      mcAddSystemMessage(
        '<div>✅ 動画が完成しました！</div>'
        + '<div class="mt-1 text-sm">下のパネルからダウンロードできます。</div>',
        'success'
      );
    }
    if (vs === 'failed' && !MC._videoFailedNotified) {
      MC._videoFailedNotified = true;
      mcAddSystemMessage('⚠️ 動画の生成に失敗しました。', 'error');
    }
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

function mcUpdatePhaseBadge(phase, videoState) {
  const badge = document.getElementById('mcPhaseBadge');
  
  // For ready phase, badge varies by video.state (Spec §2.1)
  if (phase === 'ready' && videoState) {
    const videoMap = {
      'off':     { text: '素材完成', bg: 'bg-green-100', fg: 'text-green-700' },
      'pending': { text: '動画準備中', bg: 'bg-yellow-100', fg: 'text-yellow-700' },
      'running': { text: '動画レンダリング中', bg: 'bg-blue-100', fg: 'text-blue-700' },
      'done':    { text: '動画完成', bg: 'bg-green-200', fg: 'text-green-800' },
      'failed':  { text: '動画エラー', bg: 'bg-red-100', fg: 'text-red-700' },
    };
    const vm = videoMap[videoState] || { text: '完成', bg: 'bg-green-100', fg: 'text-green-700' };
    badge.textContent = vm.text;
    badge.className = `text-xs px-2 py-0.5 rounded-full font-semibold ${vm.bg} ${vm.fg}`;
    return;
  }
  
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
      ? `<img src="${scene.image_url}" alt="Scene ${idx + 1}" class="scene-card-img" style="object-fit:cover;display:block;" loading="lazy"
           onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
         <div class="scene-card-img text-gray-400" style="display:none;">
           <div class="text-center">
             <i class="fas fa-exclamation-triangle text-3xl mb-1"></i>
             <p class="text-xs">画像読込エラー</p>
           </div>
         </div>`
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
    // Show dashboard link
    const container = document.getElementById('mcChatMessages');
    const div = document.createElement('div');
    div.className = 'flex justify-start';
    div.innerHTML = '<div class="chat-bubble bg-gray-50 text-gray-700">'
      + '<a href="/marunage" class="text-purple-600 hover:underline font-semibold"><i class="fas fa-list mr-1"></i>ダッシュボードに戻る</a>'
      + '</div>';
    container.appendChild(div);
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
      // Note: polling stop is now handled in mcPoll based on video.state
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
  
  const status = MC._lastStatus;
  const p = status?.progress;
  const imgDone = p?.images?.completed || 0;
  const imgTotal = p?.images?.total || 0;
  const audioDone = p?.audio?.completed || 0;
  const audioTotal = p?.audio?.total_utterances || 0;
  
  const videoState = p?.video?.state;
  // Title adapts to video build status
  let readyTitle, readySubtitle;
  if (videoState === 'done') {
    readyTitle = '動画が完成しました！';
    readySubtitle = '下のパネルからダウンロードできます。';
  } else if (videoState === 'running' || videoState === 'pending') {
    readyTitle = '素材完成 — 動画を自動合成中...';
    readySubtitle = '左のボードでシーン画像を確認できます。動画は自動的に生成されます。';
  } else if (videoState === 'failed') {
    readyTitle = '素材完成 — 動画生成エラー';
    readySubtitle = '左のボードでシーン画像を確認できます。';
  } else {
    readyTitle = '素材が完成しました！';
    readySubtitle = '左のボードでシーン画像を確認できます。';
  }
  
  const div = document.createElement('div');
  div.className = 'flex justify-start';
  div.setAttribute('data-ready-actions', 'true');
  div.innerHTML = `
    <div class="chat-bubble bg-green-50 text-green-800 border border-green-200 w-full">
      <p class="font-bold mb-2"><i class="fas fa-check-circle mr-1"></i>${readyTitle}</p>
      <p class="text-sm mb-2">${readySubtitle}</p>
      
      <div class="grid grid-cols-2 gap-2 mb-3 text-sm">
        <div class="bg-white rounded px-2 py-1.5 border">
          <i class="fas fa-image text-blue-500 mr-1"></i>画像: <strong>${imgDone}/${imgTotal}</strong>
        </div>
        <div class="bg-white rounded px-2 py-1.5 border">
          <i class="fas fa-microphone text-purple-500 mr-1"></i>音声: <strong>${audioDone}/${audioTotal}</strong>
        </div>
      </div>
      
      <div id="mcVideoPanel" class="mb-3 p-2.5 bg-white rounded border">
        ${mcRenderVideoPanel(p?.video)}
      </div>
      
      <div class="flex flex-wrap gap-2">
        <button onclick="mcStartNew()" class="px-3 py-1.5 bg-purple-600 text-white rounded-lg text-sm font-semibold hover:bg-purple-700">
          <i class="fas fa-plus mr-1"></i>新しく作る
        </button>
        <a href="/marunage" class="inline-flex items-center px-3 py-1.5 bg-gray-200 text-gray-700 rounded-lg text-sm hover:bg-gray-300 no-underline">
          <i class="fas fa-list mr-1"></i>一覧に戻る
        </a>
      </div>
    </div>
  `;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

// ── Video Build Panel Renderer ──
function mcRenderVideoPanel(video) {
  if (!video || video.state === 'off') {
    return '<div class="text-sm text-gray-400"><i class="fas fa-video-slash mr-1"></i>動画ビルドは無効です</div>';
  }
  
  switch (video.state) {
    case 'pending':
      return '<div class="text-sm text-yellow-600"><i class="fas fa-clock mr-1 animate-pulse"></i>動画ビルド準備中...</div>';
    
    case 'running': {
      const pct = video.progress_percent || 0;
      return `
        <div class="text-sm text-blue-600 mb-1"><i class="fas fa-spinner fa-spin mr-1"></i>動画レンダリング中...</div>
        <div class="w-full bg-gray-200 rounded-full h-2.5">
          <div class="bg-blue-600 h-2.5 rounded-full transition-all duration-500" style="width:${pct}%"></div>
        </div>
        <div class="text-xs text-gray-500 mt-1 text-right">${pct}%</div>
      `;
    }
    
    case 'done': {
      const url = video.download_url;
      return `
        <div class="text-sm text-green-600 mb-2"><i class="fas fa-check-circle mr-1"></i>動画が完成しました！</div>
        ${url ? '<a href="' + url + '" target="_blank" rel="noopener" class="inline-flex items-center px-3 py-1.5 bg-green-600 text-white rounded-lg text-sm font-semibold hover:bg-green-700 no-underline"><i class="fas fa-download mr-1"></i>動画をダウンロード</a>' : '<div class="text-xs text-gray-400">ダウンロードリンク準備中...</div>'}
      `;
    }
    
    case 'failed':
      return '<div class="text-sm text-red-600"><i class="fas fa-exclamation-triangle mr-1"></i>動画ビルドに失敗しました</div>';
    
    default:
      return '<div class="text-sm text-gray-400"><i class="fas fa-film mr-1"></i>動画: ' + (video.state || '不明') + '</div>';
  }
}

// ── Update video panel in-place (called on each poll while ready + video running) ──
function mcUpdateVideoPanel(video) {
  const panel = document.getElementById('mcVideoPanel');
  if (!panel) return;
  panel.innerHTML = mcRenderVideoPanel(video);
}

function mcStartNew() {
  // Confirmation dialog to prevent accidental data loss perception
  if (!confirm('現在の結果を閉じて新しく作りますか？\n（作成済みの作品は一覧から再表示できます）')) return;
  
  // Reset everything
  MC.runId = null;
  MC.projectId = null;
  MC.phase = null;
  MC.config = null;
  MC._retryShown = false;
  MC._lastProgressMsg = '';
  MC._progressBubble = null;
  MC._videoDoneNotified = false;
  MC._videoFailedNotified = false;
  
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

function selectSceneCount(el) {
  document.querySelectorAll('#mcSceneCount .voice-chip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  MC.selectedSceneCount = parseInt(el.dataset.scenes) || 5;
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
