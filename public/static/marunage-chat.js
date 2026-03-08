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
  selectedStylePresetId: null,   // Phase 1: style preset ID
  selectedCharacterIds: [],      // Phase 2: user_character IDs (max 3)
  
  // Loaded options cache
  _stylePresets: [],
  _userCharacters: [],
  _allVoices: [],        // All loaded TTS voices (flat array)
  _voiceFilter: 'all',   // Provider filter: 'all' | 'google' | 'elevenlabs' | 'fish'
  _voiceSearch: '',      // Text search filter
  
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

  // T2.5: Scene regeneration tracking
  _regeneratingSceneId: null,
  _lastEditInstruction: null,

  // T3: Production panel — dirty tracking & change log
  _dirtyChanges: [],  // [{type, sceneIdx, label, ts}] — cleared on rebuild
  _lastRebuildTs: null,

  // I2V: Image-to-Video generation tracking
  // { sceneId, sceneIdx, videoId, pollTimer }
  _i2vGenerating: null,
  _i2vChecked: false,

  // Comic: Comic generation state
  _comicGenerating: null, // { sceneId, sceneIdx }
  // Comic v2: Bubble edit mode (list → number+text edit)
  _comicEditMode: null, // { sceneId, sceneIdx, comicData, imageUrl, baseImageGenId }
  
  // SE timing edit mode
  _seTimingEditMode: null, // { sceneId, sceneIdx }
  
  // Batch comic state
  _batchComicRunning: false,
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
    
    // Load style presets, user characters, and voices (non-blocking)
    mcLoadStylePresets();
    mcLoadUserCharacters();
    mcLoadVoices();
    
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
  
  // P-2: If in ready phase, check for scene edit commands
  // Route to scene edit if: (a) a scene is selected, OR (b) text contains a scene reference like "シーン3", "scene 3", "3番"
  if (MC.phase === 'ready') {
    // P-4: BGM intent detection
    const isBgmIntent = /bgm|BGM|音楽|ミュージック|曲|サウンド|バック.?ミュージック/i.test(text);
    if (isBgmIntent) {
      await mcHandleBgmIntent(text);
      input.value = '';
      updateCharCount();
      return;
    }
    
    // P-4.5: SE timing edit mode reply (must be checked before general SE intent)
    if (MC._seTimingEditMode) {
      await mcHandleSeTimingEditReply(text);
      input.value = '';
      updateCharCount();
      return;
    }
    
    // P-4.5: SE timing edit intent (e.g., "シーン3のSE +2秒", "SE タイミング", "SE 開始時間")
    const isSeTimingIntent = /(?:SE|効果音)\s*(?:タイミング|開始|時間|start|timing|遅延|ディレイ|delay|\+\d|＋\d|-\d|ー\d)/i.test(text)
      || /(?:シーン|scene|Scene)\s*\d+\s*(?:の)?\s*(?:SE|効果音)\s*(?:\+|-|＋|ー|\d+\s*秒)/i.test(text);
    if (isSeTimingIntent) {
      await mcHandleSeTimingIntent(text);
      input.value = '';
      updateCharCount();
      return;
    }
    
    // P-4.5: SE (sound effect) intent detection
    const isSeIntent = /効果音|SE |se |サウンドエフェクト|足音|ドア|爆発|風|雷|鐘|拍手|水|波|鳥|虫|ベル|チャイム|クラクション|sfx/i.test(text);
    if (isSeIntent) {
      await mcHandleSeIntent(text);
      input.value = '';
      updateCharCount();
      return;
    }
    
    // P-5: Dialogue/utterance edit intent detection
    const isDialogueIntent = /セリフ|台詞|発話|ナレーション|音声.?修正|音声.?変更|言い回し|言い方/i.test(text);
    // P-5 "dialogue list" mode: if we're waiting for a dialogue edit, process it
    if (MC._dialogueEditMode) {
      await mcHandleDialogueEditReply(text);
      input.value = '';
      updateCharCount();
      return;
    }
    if (isDialogueIntent) {
      await mcHandleDialogueIntent(text);
      input.value = '';
      updateCharCount();
      return;
    }
    
    // I2V: Image-to-Video generation intent
    const isI2vIntent = /(?:シーン|scene|Scene)\s*\d+\s*(?:を|の)?\s*(?:動画化|動画にして|動画生成|I2V|i2v|ショート動画|短尺動画|ビデオ化|映像化|アニメーション化|動く|動かして)/i.test(text)
      || /(?:動画化|I2V|i2v|動画生成|ビデオ生成|ショート動画生成|映像化|アニメーション化)/i.test(text);
    if (isI2vIntent) {
      await mcHandleI2vIntent(text);
      input.value = '';
      updateCharCount();
      return;
    }
    
    // Comic v2: If in bubble edit mode, process the edit reply first
    if (MC._comicEditMode) {
      await mcHandleComicEditReply(text);
      input.value = '';
      updateCharCount();
      return;
    }
    
    // Comic: Comic generation intent (漫画化 / コミック化 / 吹き出し付き)
    const isComicIntent = /(?:シーン|scene|Scene)\s*\d+\s*(?:を|の)?\s*(?:漫画化|コミック化|漫画にして|コミックにして|吹き出し|吹き出し付き)/i.test(text)
      || /(?:漫画化|コミック化|吹き出しつけて|吹き出し付きにして|吹き出しをつけて)/i.test(text);
    if (isComicIntent) {
      await mcHandleComicIntent(text);
      input.value = '';
      updateCharCount();
      return;
    }
    
    // Comic v2: Bubble edit / list intent
    const isComicEditIntent = /(?:吹き出し|バブル|漫画.?修正|漫画.?編集|吹き出し.?一覧|吹き出し.?修正|吹き出し.?変更|吹き出し.?編集)/i.test(text);
    if (isComicEditIntent) {
      await mcHandleComicEditIntent(text);
      input.value = '';
      updateCharCount();
      return;
    }
    
    // Batch comic: "全シーン漫画化" / "シーン1-5を漫画化" etc.
    const isBatchComicIntent = /(?:全シーン|全部|まとめて|一括|シーン\s*\d+\s*[-~～]\s*\d+)\s*(?:を|の)?\s*(?:漫画化|コミック化|漫画にして)/i.test(text)
      || /(?:漫画化|コミック化)\s*(?:全部|全シーン|まとめて|一括)/i.test(text);
    if (isBatchComicIntent) {
      await mcHandleBatchComicIntent(text);
      input.value = '';
      updateCharCount();
      return;
    }
    
    // DAT: display_asset_type switch intent
    const isDatIntent = /(?:漫画|コミック|comic)\s*(?:表示|モード|に切替|にして|に変更)/i.test(text)
      || /(?:画像|image)\s*(?:表示|モード)?\s*(?:に切替|にして|に変更|に戻)/i.test(text)
      || /(?:動画|video|ビデオ)\s*(?:表示|モード)?\s*(?:に切替|にして|に変更)/i.test(text);
    if (isDatIntent) {
      await mcHandleDatIntent(text);
      input.value = '';
      updateCharCount();
      return;
    }
    
    const hasSceneRef = /(?:シーン|scene|Scene|)\s*\d+\s*(?:番|枚)?/i.test(text);
    if (MC._selectedSceneId || hasSceneRef) {
      await mcHandleSceneEdit(text);
      input.value = '';
      updateCharCount();
      return;
    }
  }
  
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
    // Build request body with style + character selections
    const startBody = {
      text: text,
      title: `丸投げ ${new Date().toLocaleDateString('ja-JP')}`,
      narration_voice: MC.selectedVoice,
      output_preset: MC.selectedPreset,
      target_scene_count: MC.selectedSceneCount,
    };
    // Phase 1: style preset
    if (MC.selectedStylePresetId) {
      startBody.style_preset_id = MC.selectedStylePresetId;
    }
    // Phase 2: character selection
    if (MC.selectedCharacterIds.length > 0) {
      startBody.selected_character_ids = MC.selectedCharacterIds;
    }
    const res = await axios.post('/api/marunage/start', startBody);
    
    MC.runId = res.data.run_id;
    MC.projectId = res.data.project_id;
    MC.phase = res.data.phase;
    MC.config = res.data.config;
    
    document.getElementById('mcProjectTitle').textContent = `Project #${MC.projectId}`;
    
    mcAddSystemMessage('テキストをシーンに分割中...');
    mcSetUIState('processing');
    mcStartPolling();
    
    // Lock left board (B-spec: no edits after start)
    mcLockBoard();
    
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
      // Only stop polling when video is truly terminal (done/failed)
      // 'pending' means flag ON, waiting for trigger → keep polling
      // 'running' means build in progress → keep polling
      // 'off' means flag OFF → stop after timeout
      if (vs === 'done' || vs === 'failed') {
        mcStopPolling();
      }
      // For 'off' (flag disabled): keep polling briefly then stop
      if (vs === 'off') {
        if (!MC._readyPollStart) MC._readyPollStart = Date.now();
        const elapsed = Date.now() - MC._readyPollStart;
        if (elapsed > 120000) { // 2 minutes
          console.log('[Marunage] Video feature off after 2min, stopping poll');
          mcStopPolling();
        }
      }
      // 'pending' / 'running' → continue polling indefinitely for video progress
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
      // Allow advance during formatting to drive parse+format via advance endpoint
      // 'done' = completed, 'running'/'pending' = needs advance to push forward
      return p.format.state === 'done' || p.format.state === 'running' || p.format.state === 'pending';
      
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
    
    if (data.action === 'waiting' || data.action === 'already_advanced' || data.action === 'formatting_in_progress') {
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
        // (next poll will reveal video.state and set MC._lastStatus properly)
        mcAddSystemMessage(
          '<div>🎉 素材が完成しました！</div>'
          + '<div class="mt-2 text-sm">画像 + ナレーション音声が揃いました。</div>'
          + '<div class="mt-2 text-sm text-gray-500">動画の自動合成を確認中...</div>',
          'success'
        );
        // Do NOT call mcSetUIState('ready') here — let the next poll cycle
        // call mcUpdateFromStatus() which properly sets MC._lastStatus
        // before triggering mcShowReadyActions().
        break;
      case 'failed':
      case 'failed_no_scenes':
      case 'failed_parse':
      case 'failed_format':
        mcAddSystemMessage(`エラー: ${data.message}`, 'error');
        mcSetUIState('error');
        break;
      case 'retrying':
      case 'auto_retry':
        mcAddSystemMessage(data.message || '自動リトライ中...');
        break;
      case 'rate_limited':
        // ★ Rate-Limit-Aware: API制限受信時のUI表示
        mcAddSystemMessage(data.message || 'APIレート制限中...しばらくお待ちください', 'warning');
        break;
      case 'stale_fixed':
        mcAddSystemMessage(data.message || '停滞した処理を検出、再試行します...');
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
  
  // P2: Store status early so mcUpdateBoardFromConfirmed can read scene_count
  MC._lastStatus = data;
  
  // Update phase badge (pass video.state for ready phase)
  mcUpdatePhaseBadge(phase, p?.video?.state);
  
  // Update progress bar
  mcUpdateProgress(data);
  
  // Update live progress text (board + chat)
  mcUpdateLiveProgress(data);
  
  // P-0: Update left board video preview
  mcUpdateBoardVideoPreview(p?.video);
  
  // Update scene cards
  mcUpdateSceneCards(p.scenes_ready.scenes, p.images, p.audio);
  
  // B-spec: Update left board confirmed selections from status API
  if (data.confirmed) {
    mcUpdateBoardFromConfirmed(data.confirmed);
  }
  
  // P2: Update assets summary on left board
  mcUpdateAssetsSummary(data.progress);
  
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
  
  // Handle ready — Result View + video panel
  if (phase === 'ready') {
    mcSetUIState('ready');
    // Update video status panel if already shown
    mcUpdateVideoPanel(data.progress?.video);
    
    // P-4: Check and display BGM on first ready (one-shot)
    if (!MC._bgmChecked) {
      MC._bgmChecked = true;
      mcCheckExistingBgm();
    }
    // P-4.5: Check and display SE on first ready (one-shot)
    if (!MC._seChecked) {
      MC._seChecked = true;
      mcCheckExistingSe();
    }
    // I2V: Check for in-progress I2V jobs on first ready (one-shot resume)
    if (!MC._i2vChecked) {
      MC._i2vChecked = true;
      mcCheckExistingI2v();
    }
    
    // One-shot chat bubble when video.state transitions to done/failed
    const vs = data.progress?.video?.state;
    if (vs === 'done' && !MC._videoDoneNotified) {
      MC._videoDoneNotified = true;
      mcAddSystemMessage(
        '<div>✅ 動画が完成しました！</div>'
        + '<div class="mt-1 text-sm">左ボードで再生できます。</div>',
        'success'
      );
      // Update edit banner to reflect video completion
      const instrDone = MC._lastEditInstruction
        ? `<br><span class="text-[10px] text-green-600">指示:「${MC._lastEditInstruction}」→ 動画に反映済み ✅</span>`
        : '';
      mcSetEditBanner(`🎬 動画完成${instrDone}`, true);
      // A-1: One-shot smooth scroll + 10s highlight on video preview
      setTimeout(() => {
        const vp = document.getElementById('mcBoardVideoPreview');
        if (vp && !vp.classList.contains('hidden')) {
          vp.scrollIntoView({ behavior: 'smooth', block: 'center' });
          // Add highlight ring (10s)
          vp.classList.add('ring-2', 'ring-purple-400', 'ring-offset-2');
          setTimeout(() => {
            vp.classList.remove('ring-2', 'ring-purple-400', 'ring-offset-2');
          }, 10000);
        }
      }, 500);
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
      // 0-15%: based on chunk progress
      if (p.format.chunks.total > 0) {
        percent = Math.round((p.format.chunks.done / p.format.chunks.total) * 15);
      } else {
        percent = 5;
      }
      break;
      
    case 'awaiting_ready':
      percent = 15;
      if (p.scenes_ready.utterances_ready) percent = 20;
      break;
      
    case 'generating_images':
      // 20-45%
      if (p.images.total > 0) {
        const imgProgress = p.images.completed / p.images.total;
        percent = 20 + Math.round(imgProgress * 25);
      } else {
        percent = 25;
      }
      break;
      
    case 'generating_audio':
      // 45-70%
      if (p.audio.total_utterances > 0) {
        const audioProgress = p.audio.completed / p.audio.total_utterances;
        percent = 45 + Math.round(audioProgress * 25);
      } else {
        percent = 50;
      }
      break;
      
    case 'ready': {
      // 70-100%: depends on video build state
      const vs = p?.video?.state;
      if (vs === 'done') {
        percent = 100;
      } else if (vs === 'running') {
        const vp = p?.video?.progress_percent || 0;
        percent = 75 + Math.round(vp * 0.25); // 75-100
      } else if (vs === 'pending') {
        percent = 72;
      } else if (vs === 'failed') {
        percent = 75;
      } else {
        // off / waiting — material done, video not started yet
        percent = 70;
      }
      break;
    }
      
    case 'failed':
    case 'canceled':
      // Keep current
      break;
  }
  
  document.getElementById('mcProgressFill').style.width = `${percent}%`;
  document.getElementById('mcProgressPercent').textContent = `${percent}%`;
  
  // Update step indicators (6 steps: 整形→確認→画像→音声→動画→完了)
  const steps = ['mcStep1', 'mcStep2', 'mcStep3', 'mcStep4', 'mcStep5', 'mcStep6'];
  const vs = p?.video?.state;
  const phaseStepMap = {
    'init': 0, 'formatting': 0, 'awaiting_ready': 1,
    'generating_images': 2, 'generating_audio': 3, 'ready': 4,
  };
  let activeStep = phaseStepMap[phase] ?? -1;
  // When ready + video running/pending → step 4 (動画), done → step 5 (完了)
  if (phase === 'ready') {
    if (vs === 'done') activeStep = 5;
    else if (vs === 'running' || vs === 'pending') activeStep = 4;
    else if (vs === 'failed') activeStep = 4;
    else activeStep = 4; // off / waiting
  }
  
  steps.forEach((id, i) => {
    const el = document.getElementById(id);
    if (!el) return;
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
      audioBadge = '<span class="scene-badge bg-green-100 text-green-700 ml-1"><i class="fas fa-check-circle mr-0.5"></i>音声</span>';
    }
    
    // T3: SE badge for this scene
    const seList = MC._currentSeMap?.[scene.id];
    const seBadge = seList && seList.length > 0
      ? `<span class="scene-badge bg-indigo-100 text-indigo-700 ml-1"><i class="fas fa-volume-up mr-0.5"></i>SE×${seList.length}</span>`
      : '';
    
    // DAT: display_asset_type badge (only show if not default 'image')
    const dat = scene.display_asset_type || 'image';
    const datBadge = dat === 'comic'
      ? '<span class="scene-badge bg-pink-100 text-pink-700 ml-1"><i class="fas fa-book-open mr-0.5"></i>漫画</span>'
      : dat === 'video'
      ? '<span class="scene-badge bg-cyan-100 text-cyan-700 ml-1"><i class="fas fa-play-circle mr-0.5"></i>動画</span>'
      : '';
    
    // I2V: Show generating badge if this scene has I2V in progress
    const isI2vScene = MC._i2vGenerating && MC._i2vGenerating.sceneId === scene.id;
    const i2vBadge = isI2vScene
      ? '<span class="scene-badge bg-violet-100 text-violet-700 ml-1"><i class="fas fa-spinner fa-spin mr-0.5"></i>I2V中</span>'
      : '';
    
    // Comic: Show generating badge if this scene has comic generation in progress
    const isComicScene = MC._comicGenerating && MC._comicGenerating.sceneId === scene.id;
    const comicBadge = isComicScene
      ? '<span class="scene-badge bg-pink-100 text-pink-700 ml-1"><i class="fas fa-spinner fa-spin mr-0.5"></i>漫画化中</span>'
      : '';
    
    // T3: Dirty badge — check if this scene has pending changes since last rebuild
    const hasDirty = MC._dirtyChanges?.some(d => d.sceneIdx === idx + 1);
    const dirtyDot = hasDirty ? '<span class="inline-block w-1.5 h-1.5 bg-orange-500 rounded-full ml-1" title="動画に未反映の変更あり"></span>' : '';
    
    const imgContent = (dat === 'video' && scene.video_url)
      ? `<video src="${scene.video_url}" class="scene-card-img" style="object-fit:cover;display:block;" 
           muted autoplay loop playsinline
           onclick="event.stopPropagation(); mcOpenVideoModal('${scene.video_url.replace(/'/g, "\\'")}', ${idx + 1})"
           onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
         </video>
         <div class="scene-card-img text-gray-400" style="display:none;">
           <div class="text-center">
             <i class="fas fa-exclamation-triangle text-3xl mb-1"></i>
             <p class="text-xs">動画読込エラー</p>
           </div>
         </div>`
      : (dat === 'comic' && scene.comic_image_url)
      ? `<div style="position:relative;cursor:pointer;" onclick="event.stopPropagation(); mcOpenComicModal('${scene.comic_image_url.replace(/'/g, "\\'")}', ${idx + 1})">
           <img src="${scene.comic_image_url}" alt="Comic ${idx + 1}" class="scene-card-img" style="object-fit:cover;display:block;" loading="lazy"
                onerror="this.style.display='none';this.parentElement.nextElementSibling.style.display='flex';">
           <div style="position:absolute;bottom:4px;right:4px;background:rgba(236,72,153,0.85);color:#fff;font-size:9px;padding:1px 5px;border-radius:4px;pointer-events:none;">
             <i class="fas fa-book-open" style="margin-right:2px;"></i>漫画
           </div>
         </div>
         <div class="scene-card-img text-gray-400" style="display:none;">
           <div class="text-center">
             <i class="fas fa-exclamation-triangle text-3xl mb-1"></i>
             <p class="text-xs">漫画読込エラー</p>
           </div>
         </div>`
      : scene.image_url
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
      <div class="scene-card" data-scene-id="${scene.id}" data-scene-idx="${idx}" onclick="mcSelectScene(${scene.id}, ${idx})">
        ${imgContent}
        <div class="p-3">
          <div class="flex items-center justify-between mb-1">
            <span class="text-xs font-bold text-gray-500">Scene ${idx + 1}${dirtyDot}</span>
            <div class="flex items-center flex-wrap gap-0.5">
              <span class="scene-badge ${imgBadgeClass}"><i class="fas ${imgBadgeIcon} mr-0.5"></i>${imgBadgeText}</span>
              ${audioBadge}
              ${seBadge}
              ${datBadge}
              ${i2vBadge}
              ${comicBadge}
            </div>
          </div>
          <p class="text-sm font-semibold text-gray-800 line-clamp-2">${scene.title || 'シーン ' + (idx + 1)}</p>
          <p class="text-xs text-gray-500 mt-1">
            <i class="fas fa-comment mr-1"></i>${scene.utterance_count} 発話${scene.speaker_unconfirmed > 0 ? '<span class="ml-1 text-amber-600 font-semibold"><i class="fas fa-exclamation-triangle mr-0.5"></i>話者未確定:' + scene.speaker_unconfirmed + '</span>' : ''}
          </p>
        </div>
      </div>
    `;
  }).join('');
  
  // T2.5: After re-render, check if a regenerating scene has completed
  if (MC._regeneratingSceneId) {
    const regenScene = scenes.find(s => s.id === MC._regeneratingSceneId);
    if (regenScene && regenScene.has_image && regenScene.image_status !== 'generating') {
      // Regeneration completed — clear state and update banner
      const regenIdx = scenes.indexOf(regenScene);
      MC._regeneratingSceneId = null;
      const instrLine = MC._lastEditInstruction ? `<br><span class="text-[10px] text-green-600">指示: 「${MC._lastEditInstruction}」 → 反映済み</span>` : '';
      mcSetEditBanner(`📍 編集中: シーン${regenIdx + 1}（画像 ✅ 更新済み）${instrLine}`, true);
      mcAddSystemMessage(`シーン${regenIdx + 1} の画像が更新されました。再ビルドで動画に反映できます。`, 'success');
      mcTrackChange('image', regenIdx + 1, '画像再生成');
    } else if (regenScene) {
      // Still regenerating — re-apply badge (was lost during innerHTML rebuild)
      mcMarkSceneRegenerating(MC._regeneratingSceneId, true);
    }
  }
  
  // T2: Re-apply selection highlight after re-render
  if (MC._selectedSceneId) {
    document.querySelectorAll('#mcSceneCards .scene-card').forEach(card => {
      if (parseInt(card.dataset.sceneId) === MC._selectedSceneId) {
        card.style.outline = '2px solid #7c3aed';
        card.style.outlineOffset = '-2px';
        card.style.borderRadius = '8px';
      }
    });
  }
}

// ============================================================
// P-2: Scene Selection & Chat-Driven Image Regeneration
// ============================================================

// Currently selected scene for editing
MC._selectedSceneId = null;
MC._selectedSceneIdx = null;

// Step D: Video preview modal — click scene video to enlarge
function mcOpenVideoModal(videoUrl, sceneNum) {
  // Remove any existing modal
  const existing = document.getElementById('mcVideoModal');
  if (existing) existing.remove();
  
  const modal = document.createElement('div');
  modal.id = 'mcVideoModal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;cursor:pointer;';
  modal.onclick = () => modal.remove();
  
  modal.innerHTML = `
    <div style="position:relative;max-width:90vw;max-height:90vh;" onclick="event.stopPropagation()">
      <div style="position:absolute;top:-32px;left:0;right:0;display:flex;justify-content:space-between;align-items:center;">
        <span style="color:#fff;font-size:14px;font-weight:600;">シーン${sceneNum} 動画プレビュー</span>
        <button onclick="document.getElementById('mcVideoModal').remove()" 
                style="color:#fff;background:rgba(255,255,255,0.2);border:none;border-radius:50%;width:28px;height:28px;cursor:pointer;font-size:16px;">✕</button>
      </div>
      <video src="${videoUrl}" style="max-width:90vw;max-height:85vh;border-radius:8px;box-shadow:0 4px 24px rgba(0,0,0,0.5);" 
             controls autoplay loop></video>
    </div>
  `;
  
  document.body.appendChild(modal);
  
  // Close on Escape key
  const handler = (e) => {
    if (e.key === 'Escape') { modal.remove(); document.removeEventListener('keydown', handler); }
  };
  document.addEventListener('keydown', handler);
}

// Comic preview modal — click scene comic to enlarge
function mcOpenComicModal(imageUrl, sceneNum) {
  const existing = document.getElementById('mcComicModal');
  if (existing) existing.remove();
  
  const modal = document.createElement('div');
  modal.id = 'mcComicModal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;cursor:pointer;';
  modal.onclick = () => modal.remove();
  
  modal.innerHTML = `
    <div style="position:relative;max-width:90vw;max-height:90vh;" onclick="event.stopPropagation()">
      <div style="position:absolute;top:-32px;left:0;right:0;display:flex;justify-content:space-between;align-items:center;">
        <span style="color:#fff;font-size:14px;font-weight:600;"><i class="fas fa-book-open" style="margin-right:4px;"></i>シーン${sceneNum} 漫画プレビュー</span>
        <button onclick="document.getElementById('mcComicModal').remove()" 
                style="color:#fff;background:rgba(255,255,255,0.2);border:none;border-radius:50%;width:28px;height:28px;cursor:pointer;font-size:16px;">✕</button>
      </div>
      <img src="${imageUrl}" alt="Comic Scene ${sceneNum}" 
           style="max-width:90vw;max-height:85vh;border-radius:8px;box-shadow:0 4px 24px rgba(0,0,0,0.5);">
    </div>
  `;
  
  document.body.appendChild(modal);
  
  const handler = (e) => {
    if (e.key === 'Escape') { modal.remove(); document.removeEventListener('keydown', handler); }
  };
  document.addEventListener('keydown', handler);
}

function mcSelectScene(sceneId, idx) {
  // Toggle selection
  if (MC._selectedSceneId === sceneId) {
    mcClearSceneSelection();
    return;
  }
  
  MC._selectedSceneId = sceneId;
  MC._selectedSceneIdx = idx;
  
  // Update visual highlight
  document.querySelectorAll('#mcSceneCards .scene-card').forEach(card => {
    if (parseInt(card.dataset.sceneId) === MC._selectedSceneId) {
      card.style.outline = '2px solid #7c3aed';
      card.style.outlineOffset = '-2px';
      card.style.borderRadius = '8px';
    } else {
      card.style.outline = 'none';
    }
  });
  
  // T2: Update edit banner
  mcSetEditBanner(`📍 編集中: シーン${idx + 1}（画像）`, true);
  
  // Update input placeholder based on selection
  const input = document.getElementById('mcChatInput');
  if (MC.phase === 'ready') {
    input.disabled = false;
    document.getElementById('mcSendBtn').disabled = false;
    input.placeholder = `シーン${idx + 1} 選択中: 「もっと明るく」等の指示を入力...`;
  }
}

// T2: Edit banner management
function mcSetEditBanner(text, show) {
  const wrap = document.getElementById('mcEditBanner');
  const t = document.getElementById('mcEditBannerText');
  if (!wrap || !t) return;
  if (show) {
    t.innerHTML = text;
    wrap.classList.remove('hidden');
  } else {
    wrap.classList.add('hidden');
  }
}

function mcClearSceneSelection() {
  MC._selectedSceneId = null;
  MC._selectedSceneIdx = null;
  
  // Remove visual highlight
  document.querySelectorAll('#mcSceneCards .scene-card').forEach(card => {
    card.style.outline = 'none';
  });
  
  // T2: Hide banner
  mcSetEditBanner('', false);
  
  const input = document.getElementById('mcChatInput');
  if (input && MC.phase === 'ready') {
    input.placeholder = '完成しました（シーンをタップして画像再生成）';
  }
}

// T2.5: Mark scene card as regenerating (spinner badge)
function mcMarkSceneRegenerating(sceneId, isOn) {
  const card = document.querySelector(`.scene-card[data-scene-id="${sceneId}"]`);
  if (!card) return;
  card.classList.toggle('opacity-60', isOn);
  let badge = card.querySelector('.mc-regen-badge');
  if (isOn && !badge) {
    badge = document.createElement('div');
    badge.className = 'mc-regen-badge text-[10px] text-purple-700 bg-purple-50 border border-purple-200 rounded px-2 py-0.5 mt-1 mx-3 mb-2 inline-flex items-center gap-1';
    badge.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 再生成中';
    card.appendChild(badge);
  } else if (!isOn && badge) {
    badge.remove();
    card.classList.remove('opacity-60');
  }
}

// T2.5: Force an immediate status poll (don't wait for next interval)
function mcForcePollSoon() {
  if (typeof mcPoll === 'function') {
    setTimeout(() => mcPoll().catch(()=>{}), 800);
    setTimeout(() => mcPoll().catch(()=>{}), 2500);
  }
}

// P-2: Handle chat input during ready phase (scene editing commands)
async function mcHandleSceneEdit(text) {
  // P-2 Lock check: only allow regeneration in 'ready' phase
  const activePhases = ['formatting', 'awaiting_ready', 'generating_images', 'generating_audio'];
  if (activePhases.includes(MC.phase)) {
    mcAddSystemMessage('生成中のため画像再生成はできません。完了後に再試行してください。', 'error');
    return;
  }
  
  // Guard: if a scene is already regenerating, prevent overlapping requests
  if (MC._regeneratingSceneId) {
    mcAddSystemMessage(`シーンの再生成中です。完了後に再試行してください。`, 'error');
    return;
  }
  
  // Parse which scene to edit — explicit reference or selected scene
  let targetSceneId = MC._selectedSceneId;
  let targetSceneIdx = MC._selectedSceneIdx;
  
  // Try to extract scene number from text: "3番", "シーン3", "scene 3" etc.
  const sceneRef = text.match(/(?:シーン|scene|Scene|)\s*(\d+)\s*(?:番|枚)?/i);
  if (sceneRef) {
    const refIdx = parseInt(sceneRef[1]) - 1; // Convert 1-indexed to 0-indexed
    const scenes = MC._lastStatus?.progress?.scenes_ready?.scenes || [];
    const targetScene = scenes[refIdx];
    if (targetScene) {
      targetSceneId = targetScene.id;
      targetSceneIdx = refIdx;
    }
  }
  
  if (!targetSceneId) {
    mcAddSystemMessage('編集対象のシーンを左のボードからタップして選択するか、「シーン3の画像を明るく」のように指定してください。', 'error');
    return;
  }
  
  mcAddUserMessage(text);
  mcAddSystemMessage(`シーン${targetSceneIdx + 1} の画像を再生成中...`);
  
  try {
    const res = await axios.post(`/api/scenes/${targetSceneId}/generate-image`, {
      prompt_override: text,  // Pass user instruction as prompt modifier
      regenerate: true
    }, { timeout: 60000 });
    
    if (res.data?.image_generation_id || res.data?.status === 'completed') {
      mcAddSystemMessage(`シーン${targetSceneIdx + 1} の画像再生成を開始しました。更新まで少々お待ちください。`, 'success');
      // T2: Update banner to "regenerating" + show last instruction
      const shortInstruction = text.length > 20 ? text.substring(0, 20) + '…' : text;
      MC._lastEditInstruction = shortInstruction;
      mcSetEditBanner(`📍 編集中: シーン${targetSceneIdx + 1}（画像再生成中…）<br><span class="text-[10px] text-purple-500">指示: 「${shortInstruction}」</span>`, true);
      // T2.5: Mark scene card as regenerating + force immediate poll
      MC._regeneratingSceneId = targetSceneId;
      mcMarkSceneRegenerating(targetSceneId, true);
      mcForcePollSoon();
    } else {
      mcAddSystemMessage(`シーン${targetSceneIdx + 1} の画像再生成に失敗しました: ${res.data?.error?.message || '不明なエラー'}`, 'error');
    }
  } catch (err) {
    const errMsg = err.response?.data?.error?.message || err.message || '通信エラー';
    mcAddSystemMessage(`画像再生成エラー: ${errMsg}`, 'error');
  }
}

// ============================================================
// P-4: BGM Management via Chat
// ============================================================

// Cached system BGM library
MC._bgmLibrary = null;
MC._bgmChecked = false;
MC._currentBgm = null;

// Check existing BGM on project load (one-shot)
async function mcCheckExistingBgm() {
  const scenes = MC._lastStatus?.progress?.scenes_ready?.scenes || [];
  if (scenes.length === 0) return;
  
  try {
    // Check first scene for BGM assignment
    const res = await axios.get(`/api/scenes/${scenes[0].id}/audio-assignments`);
    const bgmAssignment = (res.data?.assignments || []).find(a => a.audio_type === 'bgm' && a.is_active);
    if (bgmAssignment) {
      const bgmName = bgmAssignment.system_name || bgmAssignment.user_name || bgmAssignment.direct_name || 'BGM';
      MC._currentBgm = { name: bgmName, id: bgmAssignment.system_audio_id || bgmAssignment.id };
      mcUpdateBgmDisplay(MC._currentBgm);
    }
  } catch (_) {}
}

async function mcLoadBgmLibrary() {
  if (MC._bgmLibrary) return MC._bgmLibrary;
  try {
    const res = await axios.get('/api/audio-library/system?category=bgm&limit=50');
    MC._bgmLibrary = res.data?.items || res.data?.results || [];
    return MC._bgmLibrary;
  } catch (err) {
    console.warn('[BGM] Failed to load library:', err);
    return [];
  }
}

// Simple mood matching from user text
function mcGuessBgmMood(text) {
  const t = text.toLowerCase();
  if (/明る|楽し|ポップ|元気|アップ|upbeat|happy|bright/i.test(t)) return 'upbeat';
  if (/落ち着|穏やか|リラックス|ゆったり|calm|relaxed|gentle/i.test(t)) return 'calm';
  if (/悲し|切な|感動|emotional|sad|melancholy/i.test(t)) return 'emotional';
  if (/怖|ホラー|緊張|tension|horror|suspense|dark/i.test(t)) return 'dark';
  if (/壮大|epic|cinematic|ドラマ|drama/i.test(t)) return 'epic';
  if (/ジャズ|jazz|ピアノ|piano|おしゃれ|stylish/i.test(t)) return 'jazz';
  if (/ロック|rock|激し/i.test(t)) return 'rock';
  return null; // No specific mood detected
}

async function mcHandleBgmIntent(text) {
  if (!MC.projectId) {
    mcAddSystemMessage('プロジェクトが選択されていません。', 'error');
    return;
  }
  
  mcAddUserMessage(text);
  mcAddSystemMessage('BGMライブラリを検索中...', 'info');
  
  // Load BGM library
  const library = await mcLoadBgmLibrary();
  if (!library || library.length === 0) {
    mcAddSystemMessage('BGMライブラリが空です。管理画面からBGMを登録してください。', 'error');
    return;
  }
  
  // Check for "BGMを削除/外す/消す" intent
  if (/削除|外す|消す|なくす|なし|remove|off/i.test(text)) {
    await mcRemoveBgm();
    return;
  }
  
  // Match mood from user text
  const mood = mcGuessBgmMood(text);
  let candidates = library;
  if (mood) {
    const moodMatches = library.filter(b => 
      (b.mood && b.mood.toLowerCase().includes(mood)) ||
      (b.tags && b.tags.toLowerCase().includes(mood)) ||
      (b.name && b.name.toLowerCase().includes(mood))
    );
    if (moodMatches.length > 0) candidates = moodMatches;
  }
  
  // Pick a random candidate
  const bgm = candidates[Math.floor(Math.random() * candidates.length)];
  
  // Get first visible scene to attach BGM
  const scenes = MC._lastStatus?.progress?.scenes_ready?.scenes || [];
  if (scenes.length === 0) {
    mcAddSystemMessage('シーンが見つかりません。', 'error');
    return;
  }
  const firstSceneId = scenes[0].id;
  
  mcAddSystemMessage(`「${bgm.name}」をBGMとして設定中...`, 'info');
  
  try {
    // First deactivate any existing BGM assignments on all scenes
    for (const scene of scenes) {
      try {
        // Get existing BGM assignments
        const existing = await axios.get(`/api/scenes/${scene.id}/audio-assignments`);
        const bgmAssignments = (existing.data?.assignments || []).filter(a => a.audio_type === 'bgm' && a.is_active);
        for (const a of bgmAssignments) {
          await axios.delete(`/api/scenes/${scene.id}/audio-assignments/${a.id}`);
        }
      } catch (_) {}
    }
    
    // Assign BGM to first scene (loop=true so it plays across all scenes)
    const res = await axios.post(`/api/scenes/${firstSceneId}/audio-assignments`, {
      audio_library_type: 'system',
      audio_type: 'bgm',
      system_audio_id: bgm.id,
      start_ms: 0,
      volume_override: 0.2,
      loop_override: true,
      fade_in_ms_override: 1000,
      fade_out_ms_override: 1500,
    });
    
    if (res.data?.id || res.data?.assignment) {
      MC._currentBgm = bgm;
      mcAddSystemMessage(
        `♪ BGM「${bgm.name}」を設定しました！` +
        (mood ? ` (${mood}系)` : '') +
        `\n再ビルドで動画に反映されます。`,
        'success'
      );
      mcSetEditBanner(`♪ BGM: ${bgm.name}`, true);
      mcTrackChange('bgm', 0, `BGM: ${bgm.name}`);
      // Update assets display
      mcUpdateBgmDisplay(bgm);
    } else {
      mcAddSystemMessage('BGMの設定に失敗しました。', 'error');
    }
  } catch (err) {
    const errMsg = err.response?.data?.error?.message || err.message || '通信エラー';
    mcAddSystemMessage(`BGM設定エラー: ${errMsg}`, 'error');
  }
}

async function mcRemoveBgm() {
  const scenes = MC._lastStatus?.progress?.scenes_ready?.scenes || [];
  let removed = 0;
  for (const scene of scenes) {
    try {
      const existing = await axios.get(`/api/scenes/${scene.id}/audio-assignments`);
      const bgmAssignments = (existing.data?.assignments || []).filter(a => a.audio_type === 'bgm' && a.is_active);
      for (const a of bgmAssignments) {
        await axios.delete(`/api/scenes/${scene.id}/audio-assignments/${a.id}`);
        removed++;
      }
    } catch (_) {}
  }
  MC._currentBgm = null;
  mcUpdateBgmDisplay(null);
  mcSetEditBanner('', false);
  mcAddSystemMessage(
    removed > 0 ? 'BGMを削除しました。再ビルドで反映されます。' : 'BGMは設定されていません。',
    removed > 0 ? 'success' : 'info'
  );
  if (removed > 0) mcTrackChange('bgm', 0, 'BGM削除');
}

// Update left board BGM display
function mcUpdateBgmDisplay(bgm) {
  let el = document.getElementById('mcBgmDisplay');
  if (!el) {
    // Create BGM display element after Assets summary
    const summary = document.getElementById('mcAssetsSummary');
    if (!summary) return;
    el = document.createElement('div');
    el.id = 'mcBgmDisplay';
    el.className = 'mb-2';
    summary.insertAdjacentElement('afterend', el);
  }
  
  if (!bgm) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  
  el.classList.remove('hidden');
  el.innerHTML = `
    <div class="bg-purple-50 rounded-lg border border-purple-200 px-3 py-2 flex items-center justify-between">
      <div class="flex items-center gap-2 text-xs text-purple-700">
        <i class="fas fa-music"></i>
        <span class="font-semibold">BGM: ${bgm.name}</span>
      </div>
      <button onclick="mcRemoveBgmFromBoard()" class="text-[10px] text-purple-400 hover:text-purple-700">
        <i class="fas fa-times"></i>
      </button>
    </div>
  `;
}

async function mcRemoveBgmFromBoard() {
  await mcRemoveBgm();
}

// ============================================================
// P-4.5: SE (Sound Effects) Management via Chat
// ============================================================

MC._seLibrary = null;
MC._seChecked = false;
MC._currentSeMap = {}; // { sceneId: [{ id, name, assignmentId }] }

// Check existing SE on project load (one-shot)
async function mcCheckExistingSe() {
  const scenes = MC._lastStatus?.progress?.scenes_ready?.scenes || [];
  if (scenes.length === 0) return;
  
  MC._currentSeMap = {};
  let totalSe = 0;
  try {
    for (const scene of scenes) {
      const res = await axios.get(`/api/scenes/${scene.id}/audio-assignments?audio_type=sfx`);
      const sfxList = res.data?.sfx || [];
      if (sfxList.length > 0) {
        MC._currentSeMap[scene.id] = sfxList.map(s => ({
          id: s.system_audio_id || s.id,
          name: s.system_name || s.user_name || s.direct_name || 'SE',
          assignmentId: s.id,
          start_ms: s.start_ms || 0,
        }));
        totalSe += sfxList.length;
      }
    }
    mcUpdateSeDisplay();
  } catch (_) {}
}

async function mcLoadSeLibrary() {
  if (MC._seLibrary) return MC._seLibrary;
  try {
    const res = await axios.get('/api/audio-library/system?category=sfx&limit=100');
    MC._seLibrary = res.data?.items || res.data?.results || [];
    return MC._seLibrary;
  } catch (err) {
    console.warn('[SE] Failed to load library:', err);
    return [];
  }
}

// Extract scene number from text (e.g. "シーン3にドア音" → 3)
function mcExtractSeSceneNum(text) {
  const m = text.match(/(?:シーン|scene|Scene)\s*(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

// Simple keyword matching for SE selection
function mcMatchSe(text, library) {
  const t = text.toLowerCase();
  // Direct name/tag match
  const scored = library.map(item => {
    let score = 0;
    const name = (item.name || '').toLowerCase();
    const tags = (item.tags || '').toLowerCase();
    const desc = (item.description || '').toLowerCase();
    // Check each keyword in user text against item metadata
    const words = t.replace(/[シーン|scene]\s*\d+/gi, '').replace(/効果音|se |sfx|追加|入れ|つけ/gi, '').trim().split(/\s+/);
    for (const w of words) {
      if (w.length < 2) continue;
      if (name.includes(w)) score += 3;
      if (tags.includes(w)) score += 2;
      if (desc.includes(w)) score += 1;
    }
    return { item, score };
  });
  scored.sort((a, b) => b.score - a.score);
  if (scored[0]?.score > 0) return scored[0].item;
  // Fallback: random
  return library[Math.floor(Math.random() * library.length)];
}

async function mcHandleSeIntent(text) {
  if (!MC.projectId) {
    mcAddSystemMessage('プロジェクトが選択されていません。', 'error');
    return;
  }
  
  mcAddUserMessage(text);
  
  const scenes = MC._lastStatus?.progress?.scenes_ready?.scenes || [];
  if (scenes.length === 0) {
    mcAddSystemMessage('シーンが見つかりません。', 'error');
    return;
  }
  
  // Check for "SEを削除/外す/消す" intent
  if (/削除|外す|消す|なくす|なし|全部.?消|remove|off/i.test(text)) {
    await mcRemoveSe(text);
    return;
  }
  
  mcAddSystemMessage('効果音ライブラリを検索中...', 'info');
  
  // Load SE library
  const library = await mcLoadSeLibrary();
  if (!library || library.length === 0) {
    mcAddSystemMessage('効果音ライブラリが空です。管理画面からSEを登録してください。', 'error');
    return;
  }
  
  // Determine target scene
  const sceneNum = mcExtractSeSceneNum(text);
  let targetScene = null;
  if (sceneNum) {
    const idx = sceneNum - 1;
    if (idx >= 0 && idx < scenes.length) {
      targetScene = scenes[idx];
    } else {
      mcAddSystemMessage(`シーン${sceneNum}が見つかりません（全${scenes.length}シーン）。`, 'error');
      return;
    }
  } else if (MC._selectedSceneId) {
    targetScene = scenes.find(s => s.id === MC._selectedSceneId);
  }
  
  if (!targetScene) {
    mcAddSystemMessage('対象のシーンを指定してください。\n例:「シーン3にドアの効果音を追加」「シーン1に足音」', 'info');
    return;
  }
  
  // Match SE from library based on user text
  const se = mcMatchSe(text, library);
  if (!se) {
    mcAddSystemMessage('マッチする効果音が見つかりませんでした。', 'error');
    return;
  }
  
  const sceneIdx = scenes.indexOf(targetScene) + 1;
  mcAddSystemMessage(`シーン${sceneIdx}に「${se.name}」を設定中...`, 'info');
  
  try {
    const res = await axios.post(`/api/scenes/${targetScene.id}/audio-assignments`, {
      audio_library_type: 'system',
      audio_type: 'sfx',
      system_audio_id: se.id,
      start_ms: 0,
      volume_override: 0.5,
      loop_override: false,
      fade_in_ms_override: 100,
      fade_out_ms_override: 200,
    });
    
    if (res.data?.id || res.data?.assignment) {
      // Update local SE map
      if (!MC._currentSeMap[targetScene.id]) MC._currentSeMap[targetScene.id] = [];
      MC._currentSeMap[targetScene.id].push({
        id: se.id,
        name: se.name,
        assignmentId: res.data.id || res.data.assignment?.id,
        start_ms: 0,
      });
      mcAddSystemMessage(
        `🔊 シーン${sceneIdx}に効果音「${se.name}」を追加しました！` +
        `\n再ビルドで動画に反映されます。`,
        'success'
      );
      mcSetEditBanner(`🔊 SE: シーン${sceneIdx} — ${se.name}`, true);
      mcTrackChange('se', sceneIdx, `SE: ${se.name}`);
      mcUpdateSeDisplay();
    } else {
      mcAddSystemMessage('効果音の設定に失敗しました。', 'error');
    }
  } catch (err) {
    const errMsg = err.response?.data?.error?.message || err.message || '通信エラー';
    mcAddSystemMessage(`SE設定エラー: ${errMsg}`, 'error');
  }
}

async function mcRemoveSe(text) {
  const scenes = MC._lastStatus?.progress?.scenes_ready?.scenes || [];
  const sceneNum = mcExtractSeSceneNum(text);
  let targetScenes = scenes;
  
  // If a specific scene is mentioned, only remove from that scene
  if (sceneNum) {
    const idx = sceneNum - 1;
    if (idx >= 0 && idx < scenes.length) {
      targetScenes = [scenes[idx]];
    }
  }
  
  let removed = 0;
  for (const scene of targetScenes) {
    try {
      const existing = await axios.get(`/api/scenes/${scene.id}/audio-assignments?audio_type=sfx`);
      const sfxList = existing.data?.sfx || [];
      for (const s of sfxList) {
        await axios.delete(`/api/scenes/${scene.id}/audio-assignments/${s.id}`);
        removed++;
      }
      delete MC._currentSeMap[scene.id];
    } catch (_) {}
  }
  
  mcUpdateSeDisplay();
  mcSetEditBanner('', false);
  const scopeLabel = sceneNum ? `シーン${sceneNum}の` : '全ての';
  mcAddSystemMessage(
    removed > 0 ? `${scopeLabel}効果音を削除しました（${removed}件）。再ビルドで反映されます。` : `${scopeLabel}効果音は設定されていません。`,
    removed > 0 ? 'success' : 'info'
  );
  if (removed > 0) mcTrackChange('se', sceneNum || 0, `SE削除 ${removed}件`);
}

// Remove a specific SE from the board display
async function mcRemoveSeFromBoard(sceneId, assignmentId) {
  try {
    await axios.delete(`/api/scenes/${sceneId}/audio-assignments/${assignmentId}`);
    // Update local map
    if (MC._currentSeMap[sceneId]) {
      MC._currentSeMap[sceneId] = MC._currentSeMap[sceneId].filter(s => s.assignmentId !== assignmentId);
      if (MC._currentSeMap[sceneId].length === 0) delete MC._currentSeMap[sceneId];
    }
    mcUpdateSeDisplay();
    mcAddSystemMessage('効果音を削除しました。再ビルドで反映されます。', 'success');
    const scenes = MC._lastStatus?.progress?.scenes_ready?.scenes || [];
    const sIdx = scenes.findIndex(s => String(s.id) === String(sceneId)) + 1;
    mcTrackChange('se', sIdx, 'SE削除');
  } catch (err) {
    mcAddSystemMessage('効果音の削除に失敗しました。', 'error');
  }
}

// ============================================================
// Step C: SE Timing Edit via Chat
// Commands: "シーン3のSE +2秒", "SE 3秒後", "SEタイミング"
// Uses: PUT /api/scenes/:sceneId/audio-assignments/:id with { start_ms }
// ============================================================

async function mcHandleSeTimingIntent(text) {
  if (!MC.projectId) {
    mcAddSystemMessage('プロジェクトが選択されていません。', 'error');
    return;
  }
  
  mcAddUserMessage(text);
  
  const scenes = MC._lastStatus?.progress?.scenes_ready?.scenes || [];
  if (scenes.length === 0) {
    mcAddSystemMessage('シーンが見つかりません。', 'error');
    return;
  }
  
  // Try direct timing command: "シーン3のSE +2秒" or "シーン3のSE 2.5秒"
  const directMatch = text.match(/(?:シーン|scene|Scene)\s*(\d+)\s*(?:の)?\s*(?:SE|効果音)\s*(?:\+|＋)?\s*([\d.]+)\s*(?:秒|s)/i);
  if (directMatch) {
    const sceneNum = parseInt(directMatch[1], 10);
    const seconds = parseFloat(directMatch[2]);
    const idx = sceneNum - 1;
    if (idx < 0 || idx >= scenes.length) {
      mcAddSystemMessage(`シーン${sceneNum}が見つかりません（全${scenes.length}シーン）。`, 'error');
      return;
    }
    const targetScene = scenes[idx];
    const seList = MC._currentSeMap?.[targetScene.id];
    if (!seList || seList.length === 0) {
      mcAddSystemMessage(`シーン${sceneNum}にはSEが設定されていません。`, 'error');
      return;
    }
    // If only 1 SE, apply directly. Otherwise show list.
    if (seList.length === 1) {
      await mcUpdateSeTiming(targetScene.id, seList[0], sceneNum, Math.round(seconds * 1000));
      return;
    }
    // Multiple SEs: show list and enter edit mode
    mcShowSeTimingList(targetScene.id, sceneNum, seList, seconds);
    return;
  }
  
  // Determine target scene
  const sceneNumMatch = text.match(/(?:シーン|scene|Scene)\s*(\d+)/i);
  let targetScene = null;
  let sceneIdx = 0;
  
  if (sceneNumMatch) {
    const idx = parseInt(sceneNumMatch[1], 10) - 1;
    if (idx >= 0 && idx < scenes.length) {
      targetScene = scenes[idx];
      sceneIdx = idx + 1;
    } else {
      mcAddSystemMessage(`シーン${sceneNumMatch[1]}が見つかりません（全${scenes.length}シーン）。`, 'error');
      return;
    }
  } else if (MC._selectedSceneId) {
    targetScene = scenes.find(s => s.id === MC._selectedSceneId);
    if (targetScene) sceneIdx = scenes.indexOf(targetScene) + 1;
  }
  
  if (!targetScene) {
    mcAddSystemMessage(
      'SEタイミングを編集するシーンを指定してください。\n例:「シーン3のSE +2秒」「シーン1のSEタイミング」',
      'info'
    );
    return;
  }
  
  const seList = MC._currentSeMap?.[targetScene.id];
  if (!seList || seList.length === 0) {
    mcAddSystemMessage(`シーン${sceneIdx}にはSEが設定されていません。\nまずSEを追加してください（例:「シーン${sceneIdx}に効果音を追加」）。`, 'error');
    return;
  }
  
  // Show list of SEs with timing and enter edit mode
  mcShowSeTimingList(targetScene.id, sceneIdx, seList);
}

function mcShowSeTimingList(sceneId, sceneIdx, seList, pendingSeconds) {
  let listMsg = `🔊 シーン${sceneIdx}のSEタイミング:\n`;
  seList.forEach((se, i) => {
    const t = (se.start_ms || 0) / 1000;
    listMsg += `  ${i + 1}) ${se.name} — 開始: +${t.toFixed(1)}秒\n`;
  });
  listMsg += `\n変更: SE番号 + 秒数を入力\n例: 「1 2.5」→ 1番SEを+2.5秒に\n「やめ」でキャンセル`;
  mcAddSystemMessage(listMsg, 'info');
  
  MC._seTimingEditMode = { sceneId, sceneIdx, seList, pendingSeconds: pendingSeconds || null };
}

async function mcHandleSeTimingEditReply(text) {
  if (!MC._seTimingEditMode) return;
  
  mcAddUserMessage(text);
  
  // Cancel
  if (/やめ|キャンセル|cancel|戻る/i.test(text)) {
    MC._seTimingEditMode = null;
    mcAddSystemMessage('SEタイミング編集を終了しました。', 'info');
    return;
  }
  
  const { sceneId, sceneIdx, seList, pendingSeconds } = MC._seTimingEditMode;
  
  // Parse: "1 2.5" or "2 +3" or just "2.5" (if only 1 SE)
  const match = text.match(/^(\d+)\s+([\d.]+)/) || text.match(/^([\d.]+)\s*(?:秒|s)?$/);
  
  let seIndex, seconds;
  if (match && match.length === 3) {
    // "1 2.5" format
    seIndex = parseInt(match[1], 10) - 1;
    seconds = parseFloat(match[2]);
  } else if (match && match.length === 2 && seList.length === 1) {
    // "2.5" with single SE
    seIndex = 0;
    seconds = parseFloat(match[1]);
  } else if (pendingSeconds !== null && match && match.length === 2) {
    // Just a number with pending seconds
    seIndex = parseInt(match[1], 10) - 1;
    seconds = pendingSeconds;
  } else {
    mcAddSystemMessage('入力形式: 「SE番号 秒数」\n例: 「1 2.5」→ 1番SEを+2.5秒に\n「やめ」でキャンセル', 'info');
    return;
  }
  
  if (seIndex < 0 || seIndex >= seList.length) {
    mcAddSystemMessage(`SE番号${seIndex + 1}が見つかりません（全${seList.length}件）。`, 'error');
    return;
  }
  if (isNaN(seconds) || seconds < 0 || seconds > 30) {
    mcAddSystemMessage('タイミングは0〜30秒の範囲で指定してください。', 'error');
    return;
  }
  
  const se = seList[seIndex];
  await mcUpdateSeTiming(sceneId, se, sceneIdx, Math.round(seconds * 1000));
  MC._seTimingEditMode = null;
}

async function mcUpdateSeTiming(sceneId, se, sceneIdx, startMs) {
  try {
    await axios.put(`/api/scenes/${sceneId}/audio-assignments/${se.assignmentId}`, {
      start_ms: startMs,
    });
    
    // Update local cache
    se.start_ms = startMs;
    mcUpdateSeDisplay();
    
    const label = `+${(startMs / 1000).toFixed(1)}秒`;
    mcAddSystemMessage(
      `✅ シーン${sceneIdx}のSE「${se.name}」の開始タイミングを ${label} に変更しました。\n再ビルドで動画に反映されます。`,
      'success'
    );
    mcSetEditBanner(`🔊 SE: シーン${sceneIdx} — ${se.name} ${label}`, true);
    mcTrackChange('se', sceneIdx, `SEタイミング: ${se.name} → ${label}`);
  } catch (err) {
    const errMsg = err.response?.data?.error?.message || err.message || '通信エラー';
    mcAddSystemMessage(`SEタイミング変更エラー: ${errMsg}`, 'error');
  }
}

// Update left board SE display
function mcUpdateSeDisplay() {
  let el = document.getElementById('mcSeDisplay');
  if (!el) {
    // Create SE display element after BGM display (or after Assets summary)
    const bgmEl = document.getElementById('mcBgmDisplay');
    const anchor = bgmEl || document.getElementById('mcAssetsSummary');
    if (!anchor) return;
    el = document.createElement('div');
    el.id = 'mcSeDisplay';
    el.className = 'mb-2';
    anchor.insertAdjacentElement('afterend', el);
  }
  
  const allSe = Object.entries(MC._currentSeMap);
  const totalSe = allSe.reduce((sum, [, arr]) => sum + arr.length, 0);
  
  if (totalSe === 0) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  
  const scenes = MC._lastStatus?.progress?.scenes_ready?.scenes || [];
  
  let seHtml = '';
  for (const [sceneId, seList] of allSe) {
    const sceneIdx = scenes.findIndex(s => String(s.id) === String(sceneId)) + 1;
    for (const se of seList) {
      const timingLabel = (se.start_ms && se.start_ms > 0)
        ? `+${(se.start_ms / 1000).toFixed(1)}s`
        : '+0.0s';
      seHtml += `
        <div class="flex items-center justify-between py-0.5">
          <span class="text-[11px] text-indigo-700">
            <i class="fas fa-volume-up text-[9px] mr-1"></i>
            S${sceneIdx}: ${escapeHtml(se.name)} <span class="text-indigo-400 font-mono text-[9px]">${timingLabel}</span>
          </span>
          <button onclick="mcRemoveSeFromBoard('${sceneId}', '${se.assignmentId}')" 
                  class="text-[9px] text-indigo-300 hover:text-indigo-600 ml-1" title="削除">
            <i class="fas fa-times"></i>
          </button>
        </div>`;
    }
  }
  
  el.classList.remove('hidden');
  el.innerHTML = `
    <div class="bg-indigo-50 rounded-lg border border-indigo-200 px-3 py-2">
      <div class="flex items-center justify-between mb-1">
        <span class="text-[11px] font-semibold text-indigo-700">
          <i class="fas fa-volume-up mr-1"></i>効果音: ${totalSe}件
        </span>
      </div>
      ${seHtml}
    </div>
  `;
}

// ============================================================
// T3: Production Panel — Dirty Tracking & Change Log
// ============================================================

// Track a change (called by image regen, SE add, BGM add, dialogue edit etc.)
function mcTrackChange(type, sceneIdx, label) {
  MC._dirtyChanges.push({
    type: type,       // 'image' | 'audio' | 'se' | 'bgm' | 'dialogue'
    sceneIdx: sceneIdx, // 1-based, or 0 for project-level
    label: label,
    ts: Date.now(),
  });
  // Keep only last 20
  if (MC._dirtyChanges.length > 20) MC._dirtyChanges = MC._dirtyChanges.slice(-20);
  mcUpdateChangeLog();
}

// Clear dirty changes on rebuild
function mcClearDirtyOnRebuild() {
  MC._lastRebuildTs = Date.now();
  MC._dirtyChanges = [];
  mcUpdateChangeLog();
}

// Update the change log display in the left board
function mcUpdateChangeLog() {
  let el = document.getElementById('mcChangeLog');
  if (!el) {
    // Create change log after SE display (or BGM, or Assets summary)
    const seEl = document.getElementById('mcSeDisplay');
    const bgmEl = document.getElementById('mcBgmDisplay');
    const anchor = seEl || bgmEl || document.getElementById('mcAssetsSummary');
    if (!anchor) return;
    el = document.createElement('div');
    el.id = 'mcChangeLog';
    el.className = 'mb-2';
    anchor.insertAdjacentElement('afterend', el);
  }
  
  const changes = MC._dirtyChanges || [];
  if (changes.length === 0) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  
  const typeIcons = {
    image: '<i class="fas fa-image text-purple-500"></i>',
    audio: '<i class="fas fa-microphone text-blue-500"></i>',
    se: '<i class="fas fa-volume-up text-indigo-500"></i>',
    bgm: '<i class="fas fa-music text-purple-500"></i>',
    dialogue: '<i class="fas fa-comment-dots text-green-500"></i>',
  };
  
  // Show most recent 5 changes (newest first)
  const recent = changes.slice(-5).reverse();
  const logsHtml = recent.map(c => {
    const icon = typeIcons[c.type] || '<i class="fas fa-edit"></i>';
    const scope = c.sceneIdx > 0 ? `S${c.sceneIdx}` : '\u5168\u4f53';
    const ago = mcTimeAgo(c.ts);
    return `<div class="flex items-center gap-1.5 text-[10px] py-0.5">
      ${icon}
      <span class="text-gray-500">${scope}</span>
      <span class="text-gray-700 flex-1 truncate">${escapeHtml(c.label)}</span>
      <span class="text-gray-300 shrink-0">${ago}</span>
    </div>`;
  }).join('');
  
  el.classList.remove('hidden');
  el.innerHTML = `
    <div class="bg-orange-50 rounded-lg border border-orange-200 px-3 py-2">
      <div class="flex items-center justify-between mb-1">
        <span class="text-[11px] font-semibold text-orange-700">
          <i class="fas fa-exclamation-circle mr-1"></i>\u672a\u53cd\u6620\u306e\u5909\u66f4: ${changes.length}\u4ef6
        </span>
        <span class="text-[9px] text-orange-400">\u518d\u30d3\u30eb\u30c9\u3067\u53cd\u6620</span>
      </div>
      ${logsHtml}
    </div>
  `;
}

function mcTimeAgo(ts) {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return '\u305f\u3063\u305f\u4eca';
  if (sec < 3600) return `${Math.floor(sec / 60)}\u5206\u524d`;
  return `${Math.floor(sec / 3600)}\u6642\u9593\u524d`;
}

// ============================================================
// DAT: display_asset_type Switch via Chat
// ============================================================

const DAT_LABELS = {
  image: { icon: 'fa-image', color: 'text-green-700', label: '\u753b\u50cf\u8868\u793a' },
  comic: { icon: 'fa-book-open', color: 'text-pink-700', label: '\u6f2b\u753b\u8868\u793a' },
  video: { icon: 'fa-play-circle', color: 'text-cyan-700', label: '\u52d5\u753b\u8868\u793a' },
};

async function mcHandleDatIntent(text) {
  if (!MC.projectId) {
    mcAddSystemMessage('\u30d7\u30ed\u30b8\u30a7\u30af\u30c8\u304c\u9078\u629e\u3055\u308c\u3066\u3044\u307e\u305b\u3093\u3002', 'error');
    return;
  }
  
  mcAddUserMessage(text);
  
  const scenes = MC._lastStatus?.progress?.scenes_ready?.scenes || [];
  if (scenes.length === 0) {
    mcAddSystemMessage('\u30b7\u30fc\u30f3\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093\u3002', 'error');
    return;
  }
  
  // Determine target type
  let targetType = null;
  if (/\u6f2b\u753b|\u30b3\u30df\u30c3\u30af|comic/i.test(text)) targetType = 'comic';
  else if (/\u52d5\u753b|video|\u30d3\u30c7\u30aa|\u30e0\u30fc\u30d3\u30fc/i.test(text)) targetType = 'video';
  else if (/\u753b\u50cf|image|\u30a4\u30e1\u30fc\u30b8|\u5199\u771f|\u623b/i.test(text)) targetType = 'image';
  
  if (!targetType) {
    mcAddSystemMessage('\u8868\u793a\u30bf\u30a4\u30d7\u3092\u6307\u5b9a\u3057\u3066\u304f\u3060\u3055\u3044\u3002\n\u4f8b:\u300c\u30b7\u30fc\u30f33\u3092\u6f2b\u753b\u8868\u793a\u306b\u3057\u3066\u300d\u300c\u30b7\u30fc\u30f32\u3092\u753b\u50cf\u306b\u623b\u3057\u3066\u300d', 'info');
    return;
  }
  
  // Determine target scene
  const sceneNumMatch = text.match(/(?:\u30b7\u30fc\u30f3|scene|Scene)\s*(\d+)/i);
  let targetScene = null;
  let sceneIdx = 0;
  
  if (sceneNumMatch) {
    const idx = parseInt(sceneNumMatch[1], 10) - 1;
    if (idx >= 0 && idx < scenes.length) {
      targetScene = scenes[idx];
      sceneIdx = idx + 1;
    } else {
      mcAddSystemMessage(`\u30b7\u30fc\u30f3${sceneNumMatch[1]}\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093\uff08\u5168${scenes.length}\u30b7\u30fc\u30f3\uff09\u3002`, 'error');
      return;
    }
  } else if (MC._selectedSceneId) {
    targetScene = scenes.find(s => s.id === MC._selectedSceneId);
    sceneIdx = scenes.indexOf(targetScene) + 1;
  }
  
  if (!targetScene) {
    mcAddSystemMessage('\u5bfe\u8c61\u306e\u30b7\u30fc\u30f3\u3092\u6307\u5b9a\u3057\u3066\u304f\u3060\u3055\u3044\u3002\n\u4f8b:\u300c\u30b7\u30fc\u30f33\u3092\u6f2b\u753b\u8868\u793a\u306b\u3057\u3066\u300d\u300c\u30b7\u30fc\u30f31\u3092\u52d5\u753b\u8868\u793a\u306b\u3057\u3066\u300d', 'info');
    return;
  }
  
  const currentType = targetScene.display_asset_type || 'image';
  if (currentType === targetType) {
    const label = DAT_LABELS[targetType]?.label || targetType;
    mcAddSystemMessage(`\u30b7\u30fc\u30f3${sceneIdx}\u306f\u65e2\u306b${label}\u3067\u3059\u3002`, 'info');
    return;
  }
  
  const label = DAT_LABELS[targetType]?.label || targetType;
  mcAddSystemMessage(`\u30b7\u30fc\u30f3${sceneIdx}\u3092${label}\u306b\u5207\u308a\u66ff\u3048\u4e2d...`, 'info');
  
  try {
    const res = await axios.put(`/api/scenes/${targetScene.id}/display-asset-type`, {
      display_asset_type: targetType,
    });
    
    if (res.data?.success) {
      mcAddSystemMessage(
        `\u2705 \u30b7\u30fc\u30f3${sceneIdx}\u3092${label}\u306b\u5207\u308a\u66ff\u3048\u307e\u3057\u305f\uff01\n\u518d\u30d3\u30eb\u30c9\u3067\u52d5\u753b\u306b\u53cd\u6620\u3055\u308c\u307e\u3059\u3002`,
        'success'
      );
      mcSetEditBanner(`\ud83d\udd04 \u30b7\u30fc\u30f3${sceneIdx}: ${label}\u306b\u5207\u66ff`, true);
      mcTrackChange('image', sceneIdx, `\u8868\u793a\u5207\u66ff: ${label}`);
      // Update local cache for immediate badge update
      targetScene.display_asset_type = targetType;
      // Force re-render of scene cards
      mcForcePollSoon();
    } else {
      mcAddSystemMessage(`\u8868\u793a\u5207\u66ff\u306b\u5931\u6557\u3057\u307e\u3057\u305f\u3002`, 'error');
    }
  } catch (err) {
    const errCode = err.response?.data?.error?.code;
    const errMsg = err.response?.data?.error?.message || err.message || '\u901a\u4fe1\u30a8\u30e9\u30fc';
    
    if (errCode === 'NO_PUBLISHED_COMIC') {
      mcAddSystemMessage(
        `\u30b7\u30fc\u30f3${sceneIdx}\u306b\u306f\u307e\u3060\u6f2b\u753b\u304c\u751f\u6210\u3055\u308c\u3066\u3044\u307e\u305b\u3093\u3002\n\u6f2b\u753b\u5316\u3092\u5148\u306b\u5b9f\u884c\u3057\u3066\u304b\u3089\u5207\u308a\u66ff\u3048\u3066\u304f\u3060\u3055\u3044\u3002`,
        'error'
      );
    } else if (errCode === 'NO_COMPLETED_VIDEO') {
      mcAddSystemMessage(
        `シーン${sceneIdx}にはまだ動画（I2V）が生成されていません。\n「シーン${sceneIdx}を動画にして」でI2V生成を開始できます。`,
        'error'
      );
    } else {
      mcAddSystemMessage(`\u8868\u793a\u5207\u66ff\u30a8\u30e9\u30fc: ${errMsg}`, 'error');
    }
  }
}

// ============================================================
// I2V: Image-to-Video Generation via Chat
// Uses: POST /api/scenes/:sceneId/generate-video → poll status → auto-switch DAT to 'video'
// ============================================================

async function mcHandleI2vIntent(text) {
  if (!MC.projectId) {
    mcAddSystemMessage('プロジェクトが選択されていません。', 'error');
    return;
  }
  
  mcAddUserMessage(text);
  
  const scenes = MC._lastStatus?.progress?.scenes_ready?.scenes || [];
  if (scenes.length === 0) {
    mcAddSystemMessage('シーンが見つかりません。', 'error');
    return;
  }
  
  // Already generating?
  if (MC._i2vGenerating) {
    const g = MC._i2vGenerating;
    mcAddSystemMessage(
      `シーン${g.sceneIdx}のI2V動画を生成中です。完了までお待ちください。`,
      'info'
    );
    return;
  }
  
  // Determine target scene
  const sceneNumMatch = text.match(/(?:シーン|scene|Scene)\s*(\d+)/i);
  let targetScene = null;
  let sceneIdx = 0;
  
  if (sceneNumMatch) {
    const idx = parseInt(sceneNumMatch[1], 10) - 1;
    if (idx >= 0 && idx < scenes.length) {
      targetScene = scenes[idx];
      sceneIdx = idx + 1;
    } else {
      mcAddSystemMessage(`シーン${sceneNumMatch[1]}が見つかりません（全${scenes.length}シーン）。`, 'error');
      return;
    }
  } else if (MC._selectedSceneId) {
    targetScene = scenes.find(s => s.id === MC._selectedSceneId);
    if (targetScene) sceneIdx = scenes.indexOf(targetScene) + 1;
  }
  
  if (!targetScene) {
    mcAddSystemMessage(
      '対象のシーンを指定してください。\n例:「シーン3を動画にして」「シーン1をI2V生成」',
      'info'
    );
    return;
  }
  
  // Check scene has an image
  if (!targetScene.has_image || targetScene.image_status !== 'completed') {
    mcAddSystemMessage(
      `シーン${sceneIdx}にはまだ画像が完成していません。\n画像が完成してからI2V生成を実行してください。`,
      'error'
    );
    return;
  }
  
  // Extract optional prompt from text (after keywords)
  let userPrompt = null;
  const promptMatch = text.match(/(?:プロンプト|prompt|指示|動き)[：:]\s*(.+)/i);
  if (promptMatch) {
    userPrompt = promptMatch[1].trim();
  }
  
  mcAddSystemMessage(`🎥 シーン${sceneIdx}のI2V動画生成を開始します...`, 'info');
  mcSetEditBanner(`🎥 シーン${sceneIdx}: I2V動画生成中...`, true);
  
  try {
    const reqBody = {};
    if (userPrompt) reqBody.prompt = userPrompt;
    
    const res = await axios.post(`/api/scenes/${targetScene.id}/generate-video`, reqBody, { timeout: 30000 });
    const videoId = res.data?.video_generation?.id || res.data?.id;
    
    if (!videoId) {
      mcAddSystemMessage('I2V生成レスポンスからvideo IDを取得できませんでした。', 'error');
      return;
    }
    
    mcAddSystemMessage(
      `🎬 シーン${sceneIdx}のI2V動画生成を開始しました！（ID: ${videoId}）\n自動でステータスを監視します。完了まで数分かかります。`,
      'success'
    );
    
    // Set I2V generating state
    MC._i2vGenerating = {
      sceneId: targetScene.id,
      sceneIdx: sceneIdx,
      videoId: videoId,
      pollTimer: null,
    };
    
    // Start polling
    mcStartI2vPolling();
    
    // Track change
    mcTrackChange('image', sceneIdx, 'I2V動画生成開始');
    
    // Force poll to update scene card badges
    mcForcePollSoon();
    
  } catch (err) {
    const errCode = err.response?.data?.error?.code;
    const errMsg = err.response?.data?.error?.message || err.message || '通信エラー';
    
    if (errCode === 'GENERATION_IN_PROGRESS') {
      mcAddSystemMessage(
        `シーン${sceneIdx}のI2V動画は既に生成中です。完了までお待ちください。`,
        'info'
      );
    } else if (errCode === 'NO_ACTIVE_IMAGE') {
      mcAddSystemMessage(
        `シーン${sceneIdx}にアクティブな画像がありません。\n画像を生成してからI2V生成を実行してください。`,
        'error'
      );
    } else {
      mcAddSystemMessage(`I2V生成エラー: ${errMsg}`, 'error');
    }
    mcSetEditBanner('', false);
  }
}

// I2V: Polling for video generation status
function mcStartI2vPolling() {
  if (!MC._i2vGenerating) return;
  
  // Clear any existing timer
  if (MC._i2vGenerating.pollTimer) {
    clearInterval(MC._i2vGenerating.pollTimer);
  }
  
  const pollInterval = 6000; // 6 seconds
  MC._i2vGenerating.pollTimer = setInterval(async () => {
    await mcPollI2vStatus();
  }, pollInterval);
  
  // Also poll immediately
  mcPollI2vStatus();
}

async function mcPollI2vStatus() {
  if (!MC._i2vGenerating) return;
  
  const { sceneId, sceneIdx, videoId } = MC._i2vGenerating;
  
  try {
    const res = await axios.get(`/api/scenes/${sceneId}/videos/${videoId}/status`, { timeout: 15000 });
    const status = res.data?.status;
    const progressStage = res.data?.progress_stage || '';
    const elapsed = res.data?.elapsed_minutes || 0;
    
    if (status === 'completed') {
      // Success! Stop polling
      mcStopI2vPolling();
      
      const videoUrl = res.data?.r2_url;
      mcAddSystemMessage(
        `✅ シーン${sceneIdx}のI2V動画が完成しました！\n表示タイプを「動画」に自動切替します。`,
        'success'
      );
      
      // Auto-switch display_asset_type to 'video'
      try {
        await axios.put(`/api/scenes/${sceneId}/display-asset-type`, { display_asset_type: 'video' });
        mcAddSystemMessage(
          `🔄 シーン${sceneIdx}を動画表示に切り替えました。再ビルドで全体動画に反映されます。`,
          'success'
        );
        mcTrackChange('image', sceneIdx, 'I2V完了 → 動画表示');
      } catch (datErr) {
        console.warn('[I2V] Auto DAT switch failed:', datErr);
        mcAddSystemMessage(
          `I2V動画は完成しましたが、表示切替に失敗しました。\n「シーン${sceneIdx}を動画表示にして」と入力してください。`,
          'info'
        );
      }
      
      mcSetEditBanner(`✅ シーン${sceneIdx}: I2V動画完成！再ビルドで反映`, true);
      MC._i2vGenerating = null;
      mcForcePollSoon();
      
    } else if (status === 'failed') {
      // Failed — stop polling
      mcStopI2vPolling();
      
      const errMsg = res.data?.error?.message || '不明なエラー';
      mcAddSystemMessage(
        `⚠️ シーン${sceneIdx}のI2V動画生成に失敗しました。\nエラー: ${errMsg}\n再度「シーン${sceneIdx}を動画にして」で再試行できます。`,
        'error'
      );
      mcSetEditBanner(`⚠️ シーン${sceneIdx}: I2V失敗 — 再試行可能`, true);
      MC._i2vGenerating = null;
      mcForcePollSoon();
      
    } else {
      // Still generating — update banner
      let progress = '生成中';
      if (elapsed > 0) progress += `（${elapsed}分経過）`;
      if (progressStage && progressStage !== 'generating') progress += ` [${progressStage}]`;
      mcSetEditBanner(`🎥 シーン${sceneIdx}: I2V ${progress}...`, true);
    }
  } catch (err) {
    console.warn('[I2V] Poll error:', err.message);
    // Don't stop polling on transient errors
  }
}

function mcStopI2vPolling() {
  if (MC._i2vGenerating?.pollTimer) {
    clearInterval(MC._i2vGenerating.pollTimer);
    MC._i2vGenerating.pollTimer = null;
  }
}

// I2V: Check for in-progress I2V jobs on project load (resume polling)
async function mcCheckExistingI2v() {
  if (!MC.projectId) return;
  try {
    const res = await axios.get(`/api/projects/${MC.projectId}/generating-videos`, { timeout: 10000 });
    const generating = res.data?.generating_videos || [];
    
    if (generating.length > 0) {
      const job = generating[0]; // Resume the most recent
      const scenes = MC._lastStatus?.progress?.scenes_ready?.scenes || [];
      const targetScene = scenes.find(s => s.id === job.scene_id);
      const sceneIdx = targetScene ? scenes.indexOf(targetScene) + 1 : 0;
      
      if (sceneIdx > 0) {
        MC._i2vGenerating = {
          sceneId: job.scene_id,
          sceneIdx: sceneIdx,
          videoId: job.id,
          pollTimer: null,
        };
        mcAddSystemMessage(
          `🎥 シーン${sceneIdx}のI2V動画生成が進行中です。自動で監視を再開します。`,
          'info'
        );
        mcSetEditBanner(`🎥 シーン${sceneIdx}: I2V生成中...`, true);
        mcStartI2vPolling();
      }
    }
  } catch (err) {
    console.warn('[I2V] Existing check failed:', err.message);
  }
}

// ============================================================
// Comic: 漫画化（吹き出し付き画像生成）via Chat
// Uses: GET utterances → build draft → offscreen canvas render → POST publish → DAT switch
// SSOT: scenes.comic_data (draft/published), image_generations(asset_type='comic'), scenes.display_asset_type
// ============================================================

async function mcHandleComicIntent(text) {
  if (!MC.projectId) {
    mcAddSystemMessage('プロジェクトが選択されていません。', 'error');
    return;
  }
  
  mcAddUserMessage(text);
  
  const scenes = MC._lastStatus?.progress?.scenes_ready?.scenes || [];
  if (scenes.length === 0) {
    mcAddSystemMessage('シーンが見つかりません。', 'error');
    return;
  }
  
  if (MC._comicGenerating) {
    mcAddSystemMessage(`シーン${MC._comicGenerating.sceneIdx}の漫画化を処理中です。完了までお待ちください。`, 'info');
    return;
  }
  
  // Determine target scene
  const sceneNumMatch = text.match(/(?:シーン|scene|Scene)\s*(\d+)/i);
  let targetScene = null;
  let sceneIdx = 0;
  
  if (sceneNumMatch) {
    const idx = parseInt(sceneNumMatch[1], 10) - 1;
    if (idx >= 0 && idx < scenes.length) {
      targetScene = scenes[idx];
      sceneIdx = idx + 1;
    } else {
      mcAddSystemMessage(`シーン${sceneNumMatch[1]}が見つかりません（全${scenes.length}シーン）。`, 'error');
      return;
    }
  } else if (MC._selectedSceneId) {
    targetScene = scenes.find(s => s.id === MC._selectedSceneId);
    if (targetScene) sceneIdx = scenes.indexOf(targetScene) + 1;
  }
  
  if (!targetScene) {
    mcAddSystemMessage(
      '対象のシーンを指定してください。\n例:「シーン3を漫画化して」「シーン1に吹き出しをつけて」',
      'info'
    );
    return;
  }
  
  // Check scene has a completed image
  if (!targetScene.has_image || targetScene.image_status !== 'completed') {
    mcAddSystemMessage(
      `シーン${sceneIdx}にはまだ画像が完成していません。\n画像が完成してから漫画化を実行してください。`,
      'error'
    );
    return;
  }
  
  MC._comicGenerating = { sceneId: targetScene.id, sceneIdx: sceneIdx };
  mcAddSystemMessage(`📖 シーン${sceneIdx}の漫画化を開始します...`, 'info');
  mcSetEditBanner(`📖 シーン${sceneIdx}: 漫画化中...`, true);
  
  try {
    // Step 1: Fetch scene utterances for bubble text
    const uttRes = await axios.get(`/api/scenes/${targetScene.id}/utterances`, { timeout: 15000 });
    const utterances = uttRes.data?.utterances || [];
    
    if (utterances.length === 0) {
      mcAddSystemMessage(
        `シーン${sceneIdx}にはセリフがありません。\nセリフがあるシーンで漫画化を実行してください。`,
        'error'
      );
      MC._comicGenerating = null;
      mcSetEditBanner('', false);
      return;
    }
    
    // Step 2: Get the scene's active image URL
    const imageUrl = targetScene.image_url;
    if (!imageUrl) {
      mcAddSystemMessage(`シーン${sceneIdx}の画像URLが取得できません。`, 'error');
      MC._comicGenerating = null;
      mcSetEditBanner('', false);
      return;
    }
    
    mcAddSystemMessage(`📝 ${utterances.length}件のセリフから吹き出しを配置中...`, 'info');
    
    // Step 3: Build draft with auto-positioned bubbles
    // Take up to 5 utterances, position them evenly across the image
    const maxBubbles = Math.min(utterances.length, 5);
    const draftUtterances = [];
    const draftBubbles = [];
    
    for (let i = 0; i < maxBubbles; i++) {
      const utt = utterances[i];
      const uttId = `utt_${i}`;
      
      draftUtterances.push({
        id: uttId,
        text: utt.text || '',
        role: utt.role || 'narrator',
        character_key: utt.character_key || null,
      });
      
      // Auto-position: distribute bubbles top-to-bottom, alternating left/right
      const yPos = 0.1 + (0.8 * i / Math.max(maxBubbles - 1, 1));
      const xPos = (i % 2 === 0) ? 0.25 : 0.65;
      
      // Choose bubble type based on role
      const isNarrator = (utt.role === 'narrator' || utt.role === 'narration');
      const bubbleType = isNarrator ? 'caption' : 'speech_round';
      
      draftBubbles.push({
        id: `b_${i}`,
        utterance_id: uttId,
        type: bubbleType,
        size: 'M',
        position: { x: xPos, y: yPos },
        textStyle: {
          writingMode: 'horizontal',
          fontFamily: 'gothic',
          fontWeight: 'normal',
          fontScale: 1.0,
          textAlign: 'center',
          lineHeight: 1.4,
        },
        timing: {
          show_from_ms: 0,
          show_until_ms: -1,
          mode: 'scene_duration',
        },
      });
    }
    
    const draft = {
      utterances: draftUtterances,
      bubbles: draftBubbles,
    };
    
    // Step 4: Render offscreen canvas
    mcAddSystemMessage('🎨 漫画画像をレンダリング中...', 'info');
    
    const imageData = await mcRenderComicOffscreen(imageUrl, draft);
    
    if (!imageData) {
      mcAddSystemMessage('漫画画像のレンダリングに失敗しました。', 'error');
      MC._comicGenerating = null;
      mcSetEditBanner('', false);
      return;
    }
    
    // Step 5: Get base image generation ID (for audit)
    let baseImageGenId = null;
    try {
      const comicRes = await axios.get(`/api/scenes/${targetScene.id}/comic`, { timeout: 10000 });
      baseImageGenId = comicRes.data?.comic_data?.base_image_generation_id || null;
    } catch { /* ok */ }
    
    // Step 6: Publish comic
    mcAddSystemMessage('📤 漫画を公開中...', 'info');
    
    const publishRes = await axios.post(`/api/scenes/${targetScene.id}/comic/publish`, {
      image_data: imageData,
      base_image_generation_id: baseImageGenId,
      draft: draft,
    }, { timeout: 30000 });
    
    if (!publishRes.data?.success) {
      mcAddSystemMessage('漫画の公開に失敗しました。', 'error');
      MC._comicGenerating = null;
      mcSetEditBanner('', false);
      return;
    }
    
    // Step 7: Auto-switch DAT to 'comic'
    try {
      await axios.put(`/api/scenes/${targetScene.id}/display-asset-type`, {
        display_asset_type: 'comic',
      });
      mcAddSystemMessage(
        `✅ シーン${sceneIdx}を漫画化しました！\n${draftBubbles.length}個の吹き出しを配置。表示タイプを「漫画」に切り替えました。\n再ビルドで全体動画に反映されます。`,
        'success'
      );
      // Update local cache
      targetScene.display_asset_type = 'comic';
      mcTrackChange('image', sceneIdx, '漫画化完了 → 漫画表示');
    } catch (datErr) {
      console.warn('[Comic] Auto DAT switch failed:', datErr);
      mcAddSystemMessage(
        `✅ シーン${sceneIdx}の漫画を公開しました！\n表示切替に失敗しました。「シーン${sceneIdx}を漫画表示にして」と入力してください。`,
        'info'
      );
      mcTrackChange('image', sceneIdx, '漫画化完了');
    }
    
    mcSetEditBanner(`✅ シーン${sceneIdx}: 漫画化完了！再ビルドで反映`, true);
    MC._comicGenerating = null;
    mcForcePollSoon();
    
  } catch (err) {
    const errMsg = err.response?.data?.error?.message || err.message || '通信エラー';
    mcAddSystemMessage(`漫画化エラー: ${errMsg}`, 'error');
    mcSetEditBanner('', false);
    MC._comicGenerating = null;
  }
}

// Comic: Offscreen canvas rendering — draws base image + speech bubbles
async function mcRenderComicOffscreen(imageUrl, draft) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const w = img.naturalWidth || img.width;
        const h = img.naturalHeight || img.height;
        
        canvas.width = w;
        canvas.height = h;
        
        // Draw base image
        ctx.drawImage(img, 0, 0, w, h);
        
        // Draw bubbles
        const scale = w / 1000;
        const bubbles = draft.bubbles || [];
        
        for (const bubble of bubbles) {
          const utt = draft.utterances.find(u => u.id === bubble.utterance_id);
          const text = utt?.text || '';
          if (!text) continue;
          
          const bx = bubble.position.x * w;
          const by = bubble.position.y * h;
          
          ctx.save();
          ctx.translate(bx, by);
          mcDrawSimpleBubble(ctx, bubble, text, scale);
          ctx.restore();
        }
        
        // Convert to base64
        canvas.toBlob((blob) => {
          if (!blob) { reject(new Error('Blob作成失敗')); return; }
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.onerror = () => reject(new Error('Blob読み込み失敗'));
          reader.readAsDataURL(blob);
        }, 'image/png', 1.0);
        
      } catch (e) {
        reject(e);
      }
    };
    
    img.onerror = () => reject(new Error('画像読み込み失敗'));
    img.src = imageUrl;
  });
}

// Comic: Simple bubble drawing (speech_round, caption, etc.)
function mcDrawSimpleBubble(ctx, bubble, text, scale) {
  const type = bubble.type || 'speech_round';
  const fontSize = Math.round(14 * scale);
  const padding = Math.round(12 * scale);
  const maxCharsPerLine = 12;
  
  // Wrap text
  const lines = [];
  let remaining = text;
  while (remaining.length > 0) {
    lines.push(remaining.substring(0, maxCharsPerLine));
    remaining = remaining.substring(maxCharsPerLine);
  }
  if (lines.length > 5) lines.length = 5; // max 5 lines
  
  const lineHeight = fontSize * 1.4;
  const textWidth = Math.min(text.length, maxCharsPerLine) * fontSize * 0.6;
  const bw = textWidth + padding * 2;
  const bh = lines.length * lineHeight + padding * 2;
  
  const isCaption = (type === 'caption' || type === 'telop');
  const isThought = (type === 'thought');
  
  // Center the bubble on position
  const x = -bw / 2;
  const y = -bh / 2;
  
  ctx.save();
  
  if (isCaption) {
    // Caption: dark semi-transparent rectangle
    ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
    ctx.fillRect(x, y, bw, bh);
    ctx.fillStyle = '#ffffff';
  } else {
    // Speech/thought bubble
    ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.strokeStyle = '#333333';
    ctx.lineWidth = Math.max(2, scale * 2);
    
    if (isThought) {
      // Thought bubble: rounded with dashed border
      ctx.setLineDash([4 * scale, 3 * scale]);
    }
    
    // Draw rounded rectangle
    const radius = Math.round(10 * scale);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + bw - radius, y);
    ctx.quadraticCurveTo(x + bw, y, x + bw, y + radius);
    ctx.lineTo(x + bw, y + bh - radius);
    ctx.quadraticCurveTo(x + bw, y + bh, x + bw - radius, y + bh);
    ctx.lineTo(x + radius, y + bh);
    ctx.quadraticCurveTo(x, y + bh, x, y + bh - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    
    if (isThought) ctx.setLineDash([]);
    
    // Tail for speech bubbles
    if (!isThought) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
      ctx.strokeStyle = '#333333';
      ctx.beginPath();
      const tailX = bw * 0.3;
      ctx.moveTo(x + tailX, y + bh);
      ctx.lineTo(x + tailX - 5 * scale, y + bh + 15 * scale);
      ctx.lineTo(x + tailX + 10 * scale, y + bh);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    
    ctx.fillStyle = '#1a1a1a';
  }
  
  // Draw text
  ctx.font = `${fontSize}px "Hiragino Kaku Gothic ProN", "Noto Sans JP", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  
  for (let i = 0; i < lines.length; i++) {
    const ty = y + padding + (i + 0.5) * lineHeight;
    ctx.fillText(lines[i], 0, ty);
  }
  
  ctx.restore();
}

// ============================================================
// Comic v2: Bubble text editing via Chat
// Flow: list bubbles → select by number → new text → re-render → re-publish
// SSOT: scenes.comic_data (draft/published) — structure is preserved, only text updated
// ============================================================

// Show bubble list for a scene and enter edit mode
async function mcHandleComicEditIntent(text) {
  if (!MC.projectId) {
    mcAddSystemMessage('プロジェクトが選択されていません。', 'error');
    return;
  }
  
  mcAddUserMessage(text);
  
  const scenes = MC._lastStatus?.progress?.scenes_ready?.scenes || [];
  if (scenes.length === 0) {
    mcAddSystemMessage('シーンが見つかりません。', 'error');
    return;
  }
  
  // Determine target scene
  const sceneNumMatch = text.match(/(?:シーン|scene|Scene)\s*(\d+)/i);
  let targetScene = null;
  let sceneIdx = 0;
  
  if (sceneNumMatch) {
    const idx = parseInt(sceneNumMatch[1], 10) - 1;
    if (idx >= 0 && idx < scenes.length) {
      targetScene = scenes[idx];
      sceneIdx = idx + 1;
    } else {
      mcAddSystemMessage(`シーン${sceneNumMatch[1]}が見つかりません（全${scenes.length}シーン）。`, 'error');
      return;
    }
  } else if (MC._selectedSceneId) {
    targetScene = scenes.find(s => s.id === MC._selectedSceneId);
    if (targetScene) sceneIdx = scenes.indexOf(targetScene) + 1;
  }
  
  if (!targetScene) {
    mcAddSystemMessage(
      '対象のシーンを指定してください。\n例:「シーン3の吹き出し修正」「シーン1の吹き出し一覧」',
      'info'
    );
    return;
  }
  
  // Check for direct edit command: "吹き出し2を〇〇に" or "吹き出し1の文を〇〇に変更"
  const directEditMatch = text.match(/吹き出し\s*(\d+)\s*(?:を|の文を|の文字を|のテキストを)\s*[「『]?(.+?)[」』]?\s*(?:に変更|にして|に修正)?$/);
  
  // v3: Check for direct position command: "吹き出し2を上に" etc.
  const directPosMatch = text.match(/吹き出し\s*(\d+)\s*(?:を)?\s*(上|下|左|右|左上|右上|左下|右下|中央|真ん中|少し上|少し下|少し左|少し右)\s*(?:に|へ)?(?:移動|動かし)?/);
  
  // Fetch existing comic data
  try {
    const comicRes = await axios.get(`/api/scenes/${targetScene.id}/comic`, { timeout: 10000 });
    const comicData = comicRes.data?.comic_data;
    
    if (!comicData || !comicData.published) {
      mcAddSystemMessage(
        `シーン${sceneIdx}にはまだ漫画が作成されていません。\n「シーン${sceneIdx}を漫画化して」で先に漫画を作成してください。`,
        'error'
      );
      return;
    }
    
    // Use published data as the base draft for editing
    const draft = comicData.draft || comicData.published;
    const bubbles = draft.bubbles || [];
    const utterances = draft.utterances || [];
    
    if (bubbles.length === 0) {
      mcAddSystemMessage(`シーン${sceneIdx}の漫画に吹き出しがありません。`, 'error');
      return;
    }
    
    // If direct edit command was matched, process it immediately
    if (directEditMatch) {
      const bubbleNum = parseInt(directEditMatch[1], 10);
      const newText = directEditMatch[2].trim();
      
      if (bubbleNum < 1 || bubbleNum > bubbles.length) {
        mcAddSystemMessage(`吹き出し${bubbleNum}は存在しません（全${bubbles.length}個）。`, 'error');
        return;
      }
      
      if (!newText) {
        mcAddSystemMessage('新しいテキストを指定してください。', 'error');
        return;
      }
      
      await mcEditComicBubbleText(
        targetScene.id, sceneIdx,
        { ...comicData, draft: JSON.parse(JSON.stringify(draft)) },
        targetScene.image_url,
        comicRes.data?.comic_data?.base_image_generation_id,
        bubbleNum, newText
      );
      return;
    }
    
    // v3: If direct position command was matched, process it immediately
    if (directPosMatch) {
      const bubbleNum = parseInt(directPosMatch[1], 10);
      const direction = directPosMatch[2];
      
      if (bubbleNum < 1 || bubbleNum > bubbles.length) {
        mcAddSystemMessage(`吹き出し${bubbleNum}は存在しません（全${bubbles.length}個）。`, 'error');
        return;
      }
      
      await mcMoveComicBubble(
        targetScene.id, sceneIdx,
        { ...comicData, draft: JSON.parse(JSON.stringify(draft)) },
        targetScene.image_url,
        comicRes.data?.comic_data?.base_image_generation_id,
        bubbleNum, direction
      );
      return;
    }
    
    // Show bubble list and enter edit mode
    let listHtml = `📖 シーン${sceneIdx}の吹き出し一覧（${bubbles.length}個）:\n\n`;
    
    for (let i = 0; i < bubbles.length; i++) {
      const b = bubbles[i];
      const utt = utterances.find(u => u.id === b.utterance_id);
      const bText = utt?.text || '(テキストなし)';
      const typeLabel = b.type === 'caption' ? 'テロップ' 
        : b.type === 'thought' ? '思考' 
        : b.type === 'whisper' ? 'ささやき'
        : '吹き出し';
      const truncText = bText.length > 30 ? bText.substring(0, 30) + '…' : bText;
      listHtml += `${i + 1}. [${typeLabel}] ${truncText}\n`;
    }
    
    listHtml += `\n✏️ 編集方法:\n`;
    listHtml += `• テキスト: 「番号 新しいテキスト」\n`;
    listHtml += `• 位置移動: 「番号 上/下/左/右/少し上/中央」\n`;
    listHtml += `• やめる場合: 「やめ」「キャンセル」`;
    
    mcAddSystemMessage(listHtml, 'info');
    
    // Enter edit mode
    MC._comicEditMode = {
      sceneId: targetScene.id,
      sceneIdx: sceneIdx,
      comicData: { ...comicData, draft: JSON.parse(JSON.stringify(draft)) },
      imageUrl: targetScene.image_url,
      baseImageGenId: comicData.base_image_generation_id || null,
    };
    
  } catch (err) {
    const errMsg = err.response?.data?.error?.message || err.message || '通信エラー';
    mcAddSystemMessage(`漫画データ取得エラー: ${errMsg}`, 'error');
  }
}

// Handle replies in comic edit mode
async function mcHandleComicEditReply(text) {
  const mode = MC._comicEditMode;
  if (!mode) return;
  
  mcAddUserMessage(text);
  
  // Cancel
  if (/^(やめ|キャンセル|cancel|戻る|終了)$/i.test(text.trim())) {
    MC._comicEditMode = null;
    mcAddSystemMessage('吹き出し編集を終了しました。', 'info');
    return;
  }
  
  const draft = mode.comicData.draft;
  const bubbles = draft?.bubbles || [];
  
  // v3: Position command — "番号 方向" (e.g., "2 上", "1 少し右", "3 中央")
  const posMatch = text.match(/^(\d+)\s+(上|下|左|右|左上|右上|左下|右下|中央|真ん中|少し上|少し下|少し左|少し右)$/);
  if (posMatch) {
    const bubbleNum = parseInt(posMatch[1], 10);
    const direction = posMatch[2];
    
    if (bubbleNum < 1 || bubbleNum > bubbles.length) {
      mcAddSystemMessage(`吹き出し${bubbleNum}は存在しません（全${bubbles.length}個）。`, 'error');
      return;
    }
    
    await mcMoveComicBubble(
      mode.sceneId, mode.sceneIdx,
      mode.comicData, mode.imageUrl, mode.baseImageGenId,
      bubbleNum, direction
    );
    // Stay in edit mode for further edits
    return;
  }
  
  // Parse text edit: "番号 新テキスト" or "番号「新テキスト」"
  const editMatch = text.match(/^(\d+)\s+(.+)$/) || text.match(/^(\d+)\s*[「『](.+?)[」』]$/);
  
  if (!editMatch) {
    mcAddSystemMessage(
      '入力形式:\n• テキスト: 「番号 新しいテキスト」\n• 位置: 「番号 上/下/左/右/少し上/中央」\n例: 「2 こんにちは！」「1 少し右」\nやめる: 「やめ」',
      'info'
    );
    return;
  }
  
  const bubbleNum = parseInt(editMatch[1], 10);
  const inputText = editMatch[2].trim();
  
  if (bubbleNum < 1 || bubbleNum > bubbles.length) {
    mcAddSystemMessage(`吹き出し${bubbleNum}は存在しません（全${bubbles.length}個）。`, 'error');
    return;
  }
  
  if (!inputText) {
    mcAddSystemMessage('テキストが空です。', 'error');
    return;
  }
  
  await mcEditComicBubbleText(
    mode.sceneId, mode.sceneIdx,
    mode.comicData, mode.imageUrl, mode.baseImageGenId,
    bubbleNum, inputText
  );
  
  // Stay in edit mode for further edits
}

// Core: Edit a bubble's text → re-render → re-publish
async function mcEditComicBubbleText(sceneId, sceneIdx, comicData, imageUrl, baseImageGenId, bubbleNum, newText) {
  const draft = comicData.draft;
  const bubbles = draft.bubbles || [];
  const utterances = draft.utterances || [];
  const bubble = bubbles[bubbleNum - 1];
  
  if (!bubble) {
    mcAddSystemMessage(`吹き出し${bubbleNum}が見つかりません。`, 'error');
    return;
  }
  
  // Find and update the utterance text
  const utt = utterances.find(u => u.id === bubble.utterance_id);
  const oldText = utt?.text || '';
  
  if (utt) {
    utt.text = newText;
  } else {
    mcAddSystemMessage(`吹き出し${bubbleNum}のテキストデータが見つかりません。`, 'error');
    return;
  }
  
  mcAddSystemMessage(`✏️ 吹き出し${bubbleNum}を更新中...\n「${oldText.substring(0, 20)}…」→「${newText.substring(0, 20)}…」`, 'info');
  mcSetEditBanner(`📖 シーン${sceneIdx}: 吹き出し${bubbleNum}更新中...`, true);
  
  try {
    // Step 1: Re-render offscreen
    const imageData = await mcRenderComicOffscreen(imageUrl, draft);
    
    if (!imageData) {
      mcAddSystemMessage('漫画画像のレンダリングに失敗しました。', 'error');
      mcSetEditBanner('', false);
      return;
    }
    
    // Step 2: Re-publish
    const publishRes = await axios.post(`/api/scenes/${sceneId}/comic/publish`, {
      image_data: imageData,
      base_image_generation_id: baseImageGenId,
      draft: draft,
    }, { timeout: 30000 });
    
    if (!publishRes.data?.success) {
      mcAddSystemMessage('漫画の再公開に失敗しました。', 'error');
      mcSetEditBanner('', false);
      return;
    }
    
    mcAddSystemMessage(
      `✅ シーン${sceneIdx}の吹き出し${bubbleNum}を更新しました！\n再ビルドで全体動画に反映されます。`,
      'success'
    );
    mcSetEditBanner(`✅ シーン${sceneIdx}: 吹き出し${bubbleNum}更新完了`, true);
    mcTrackChange('image', sceneIdx, `吹き出し${bubbleNum}テキスト編集`);
    mcForcePollSoon();
    
  } catch (err) {
    const errMsg = err.response?.data?.error?.message || err.message || '通信エラー';
    mcAddSystemMessage(`吹き出し更新エラー: ${errMsg}`, 'error');
    mcSetEditBanner('', false);
  }
}

// Comic v3: Move a bubble's position → re-render → re-publish
async function mcMoveComicBubble(sceneId, sceneIdx, comicData, imageUrl, baseImageGenId, bubbleNum, direction) {
  const draft = comicData.draft;
  const bubbles = draft.bubbles || [];
  const bubble = bubbles[bubbleNum - 1];
  
  if (!bubble || !bubble.position) {
    mcAddSystemMessage(`吹き出し${bubbleNum}の位置データがありません。`, 'error');
    return;
  }
  
  const pos = bubble.position;
  const oldX = pos.x;
  const oldY = pos.y;
  
  // Movement amounts
  const step = 0.10;     // normal move
  const smallStep = 0.05; // "少し" prefix
  
  const isSmall = direction.startsWith('少し');
  const dir = isSmall ? direction.replace('少し', '') : direction;
  const delta = isSmall ? smallStep : step;
  
  switch (dir) {
    case '上':    pos.y = Math.max(0.05, pos.y - delta); break;
    case '下':    pos.y = Math.min(0.95, pos.y + delta); break;
    case '左':    pos.x = Math.max(0.05, pos.x - delta); break;
    case '右':    pos.x = Math.min(0.95, pos.x + delta); break;
    case '左上':  pos.x = Math.max(0.05, pos.x - delta); pos.y = Math.max(0.05, pos.y - delta); break;
    case '右上':  pos.x = Math.min(0.95, pos.x + delta); pos.y = Math.max(0.05, pos.y - delta); break;
    case '左下':  pos.x = Math.max(0.05, pos.x - delta); pos.y = Math.min(0.95, pos.y + delta); break;
    case '右下':  pos.x = Math.min(0.95, pos.x + delta); pos.y = Math.min(0.95, pos.y + delta); break;
    case '中央':
    case '真ん中':
      pos.x = 0.5;
      pos.y = 0.5;
      break;
    default:
      mcAddSystemMessage(`方向「${direction}」は認識できません。上/下/左/右/少し上/中央 等を使ってください。`, 'error');
      return;
  }
  
  // Round to 2 decimal places
  pos.x = Math.round(pos.x * 100) / 100;
  pos.y = Math.round(pos.y * 100) / 100;
  
  const dirLabel = direction;
  mcAddSystemMessage(`↕️ 吹き出し${bubbleNum}を${dirLabel}に移動中...`, 'info');
  mcSetEditBanner(`📖 シーン${sceneIdx}: 吹き出し${bubbleNum}移動中...`, true);
  
  try {
    // Re-render offscreen
    const imageData = await mcRenderComicOffscreen(imageUrl, draft);
    
    if (!imageData) {
      // Revert position
      pos.x = oldX;
      pos.y = oldY;
      mcAddSystemMessage('漫画画像のレンダリングに失敗しました。', 'error');
      mcSetEditBanner('', false);
      return;
    }
    
    // Re-publish
    const publishRes = await axios.post(`/api/scenes/${sceneId}/comic/publish`, {
      image_data: imageData,
      base_image_generation_id: baseImageGenId,
      draft: draft,
    }, { timeout: 30000 });
    
    if (!publishRes.data?.success) {
      pos.x = oldX;
      pos.y = oldY;
      mcAddSystemMessage('漫画の再公開に失敗しました。', 'error');
      mcSetEditBanner('', false);
      return;
    }
    
    mcAddSystemMessage(
      `✅ 吹き出し${bubbleNum}を${dirLabel}に移動しました！\n続けて編集できます（「やめ」で終了）。`,
      'success'
    );
    mcSetEditBanner(`✅ シーン${sceneIdx}: 吹き出し${bubbleNum}移動完了`, true);
    mcTrackChange('image', sceneIdx, `吹き出し${bubbleNum}位置移動(${dirLabel})`);
    mcForcePollSoon();
    
  } catch (err) {
    pos.x = oldX;
    pos.y = oldY;
    const errMsg = err.response?.data?.error?.message || err.message || '通信エラー';
    mcAddSystemMessage(`吹き出し移動エラー: ${errMsg}`, 'error');
    mcSetEditBanner('', false);
  }
}

// ============================================================
// Step B: Batch Comic Conversion via Chat
// Commands: "全シーン漫画化", "シーン1-5を漫画化"
// Runs sequentially on client, stops on first failure
// ============================================================

async function mcHandleBatchComicIntent(text) {
  if (!MC.projectId) {
    mcAddSystemMessage('プロジェクトが選択されていません。', 'error');
    return;
  }
  
  mcAddUserMessage(text);
  
  const scenes = MC._lastStatus?.progress?.scenes_ready?.scenes || [];
  if (scenes.length === 0) {
    mcAddSystemMessage('シーンが見つかりません。', 'error');
    return;
  }
  
  if (MC._batchComicRunning) {
    mcAddSystemMessage('一括漫画化を処理中です。完了までお待ちください。', 'info');
    return;
  }
  
  // Determine range: "シーン1-5を漫画化" or "全シーン漫画化"
  let startIdx = 0;
  let endIdx = scenes.length - 1;
  
  const rangeMatch = text.match(/(?:シーン|scene|Scene)\s*(\d+)\s*[-~～]\s*(\d+)/i);
  if (rangeMatch) {
    startIdx = parseInt(rangeMatch[1], 10) - 1;
    endIdx = parseInt(rangeMatch[2], 10) - 1;
    
    if (startIdx < 0 || endIdx >= scenes.length || startIdx > endIdx) {
      mcAddSystemMessage(`範囲指定が不正です。シーン1〜${scenes.length}で指定してください。`, 'error');
      return;
    }
  }
  
  // Limit to max 10 scenes at once
  const count = endIdx - startIdx + 1;
  if (count > 10) {
    mcAddSystemMessage(`一括漫画化は最大10シーンまでです。範囲を絞ってください。\n例: 「シーン1-10を漫画化」`, 'error');
    return;
  }
  
  // Filter scenes that have completed images
  const targetScenes = [];
  for (let i = startIdx; i <= endIdx; i++) {
    if (scenes[i].has_image && scenes[i].image_status === 'completed') {
      targetScenes.push({ scene: scenes[i], idx: i + 1 });
    }
  }
  
  if (targetScenes.length === 0) {
    mcAddSystemMessage('漫画化できるシーン（画像完成済み）がありません。', 'error');
    return;
  }
  
  mcAddSystemMessage(
    `📖 一括漫画化を開始します（${targetScenes.length}シーン: S${targetScenes[0].idx}〜S${targetScenes[targetScenes.length - 1].idx}）...`,
    'info'
  );
  mcSetEditBanner(`📖 一括漫画化: 0/${targetScenes.length}`, true);
  MC._batchComicRunning = true;
  
  let completed = 0;
  let failed = 0;
  
  for (const { scene, idx } of targetScenes) {
    try {
      mcSetEditBanner(`📖 一括漫画化: ${completed}/${targetScenes.length} (シーン${idx}処理中...)`, true);
      
      // Step 1: Fetch utterances
      const uttRes = await axios.get(`/api/scenes/${scene.id}/utterances`, { timeout: 15000 });
      const utterances = uttRes.data?.utterances || [];
      
      if (utterances.length === 0) {
        mcAddSystemMessage(`⚠️ シーン${idx}: セリフなし（スキップ）`, 'info');
        continue;
      }
      
      // Step 2: Build draft with auto-positioned bubbles
      const maxBubbles = Math.min(utterances.length, 5);
      const draftUtterances = [];
      const draftBubbles = [];
      
      for (let bi = 0; bi < maxBubbles; bi++) {
        const utt = utterances[bi];
        const uttId = `utt_${bi}`;
        
        draftUtterances.push({
          id: uttId,
          text: utt.text || '',
          role: utt.role || 'narrator',
          character_key: utt.character_key || null,
        });
        
        const yPos = 0.1 + (0.8 * bi / Math.max(maxBubbles - 1, 1));
        const xPos = (bi % 2 === 0) ? 0.25 : 0.65;
        const isNarrator = (utt.role === 'narrator' || utt.role === 'narration');
        const bubbleType = isNarrator ? 'caption' : 'speech_round';
        
        draftBubbles.push({
          id: `b_${bi}`,
          utterance_id: uttId,
          type: bubbleType,
          size: 'M',
          position: { x: xPos, y: yPos },
          textStyle: {
            writingMode: 'horizontal',
            fontFamily: 'gothic',
            fontWeight: 'normal',
            fontScale: 1.0,
            textAlign: 'center',
            lineHeight: 1.4,
          },
          timing: {
            show_from_ms: 0,
            show_until_ms: -1,
            mode: 'scene_duration',
          },
        });
      }
      
      const draft = { utterances: draftUtterances, bubbles: draftBubbles };
      
      // Step 3: Render offscreen
      const imageUrl = scene.image_url;
      if (!imageUrl) {
        mcAddSystemMessage(`⚠️ シーン${idx}: 画像URLなし（スキップ）`, 'info');
        continue;
      }
      
      const imageData = await mcRenderComicOffscreen(imageUrl, draft);
      if (!imageData) {
        mcAddSystemMessage(`❌ シーン${idx}: レンダリング失敗`, 'error');
        failed++;
        mcAddSystemMessage(`一括漫画化をシーン${idx}で中止しました（${completed}/${targetScenes.length}完了）。`, 'error');
        break;
      }
      
      // Step 4: Publish
      const publishRes = await axios.post(`/api/scenes/${scene.id}/comic/publish`, {
        image_data: imageData,
        base_image_generation_id: null,
        draft: draft,
      }, { timeout: 30000 });
      
      if (!publishRes.data?.success) {
        mcAddSystemMessage(`❌ シーン${idx}: 公開失敗`, 'error');
        failed++;
        mcAddSystemMessage(`一括漫画化をシーン${idx}で中止しました（${completed}/${targetScenes.length}完了）。`, 'error');
        break;
      }
      
      // Step 5: Auto-switch DAT
      try {
        await axios.put(`/api/scenes/${scene.id}/display-asset-type`, {
          display_asset_type: 'comic',
        });
        scene.display_asset_type = 'comic';
      } catch { /* DAT switch is optional */ }
      
      completed++;
      mcTrackChange('image', idx, '一括漫画化');
      
    } catch (err) {
      const errMsg = err.response?.data?.error?.message || err.message || '通信エラー';
      mcAddSystemMessage(`❌ シーン${idx}: ${errMsg}`, 'error');
      failed++;
      mcAddSystemMessage(`一括漫画化をシーン${idx}で中止しました（${completed}/${targetScenes.length}完了）。`, 'error');
      break;
    }
  }
  
  MC._batchComicRunning = false;
  
  if (failed === 0) {
    mcAddSystemMessage(
      `✅ 一括漫画化が完了しました！（${completed}シーン）\n再ビルドで全体動画に反映されます。`,
      'success'
    );
    mcSetEditBanner(`✅ 一括漫画化: ${completed}シーン完了`, true);
  } else {
    mcSetEditBanner(`⚠️ 一括漫画化: ${completed}完了 / ${failed}失敗`, true);
  }
  
  mcForcePollSoon();
}

// ============================================================
// P-5: Dialogue / Utterance Edit via Chat
// ============================================================

MC._dialogueEditMode = null; // { sceneId, sceneIdx, utterances }

// Show utterance list for a scene and enter edit mode
async function mcHandleDialogueIntent(text) {
  if (!MC.projectId) {
    mcAddSystemMessage('プロジェクトが選択されていません。', 'error');
    return;
  }
  
  mcAddUserMessage(text);
  
  const scenes = MC._lastStatus?.progress?.scenes_ready?.scenes || [];
  if (scenes.length === 0) {
    mcAddSystemMessage('シーンが見つかりません。', 'error');
    return;
  }
  
  // Determine target scene
  const sceneNumMatch = text.match(/(?:シーン|scene|Scene)\s*(\d+)/i);
  let targetScene = null;
  let sceneIdx = 0;
  
  if (sceneNumMatch) {
    const idx = parseInt(sceneNumMatch[1], 10) - 1;
    if (idx >= 0 && idx < scenes.length) {
      targetScene = scenes[idx];
      sceneIdx = idx + 1;
    } else {
      mcAddSystemMessage(`シーン${sceneNumMatch[1]}が見つかりません（全${scenes.length}シーン）。`, 'error');
      return;
    }
  } else if (MC._selectedSceneId) {
    targetScene = scenes.find(s => s.id === MC._selectedSceneId);
    sceneIdx = scenes.indexOf(targetScene) + 1;
  }
  
  if (!targetScene) {
    mcAddSystemMessage('対象のシーンを指定してください。\n例:「シーン3のセリフを修正」「シーン1の台詞を変更」', 'info');
    return;
  }
  
  // Check if the text contains a direct edit instruction like:
  // "シーン3の1番目のセリフを〔新しいテキスト〕に変更"
  const directEditMatch = text.match(/(\d+)\s*(?:番目?|つ目)\s*(?:の)?\s*(?:セリフ|台詞|発話|ナレーション)?\s*(?:を|は)?\s*(?:「|『|“|"|\[)?\s*(.+?)\s*(?:」|』|”|"|\])?\s*(?:に)?\s*(?:変更|修正|差し替え|書き換え)/i);
  
  // Fetch utterances for this scene
  mcAddSystemMessage(`シーン${sceneIdx}のセリフ一覧を取得中...`, 'info');
  
  try {
    const res = await axios.get(`/api/scenes/${targetScene.id}/utterances`);
    const utterances = res.data?.utterances || [];
    
    if (utterances.length === 0) {
      mcAddSystemMessage(`シーン${sceneIdx}にはセリフがありません。`, 'info');
      return;
    }
    
    // If direct edit instruction, process immediately
    if (directEditMatch) {
      const utteranceNum = parseInt(directEditMatch[1], 10);
      const newText = directEditMatch[2].trim();
      if (utteranceNum >= 1 && utteranceNum <= utterances.length && newText) {
        await mcEditUtterance(targetScene.id, sceneIdx, utterances[utteranceNum - 1], utteranceNum, newText);
        return;
      }
    }
    
    // Show utterance list
    let listHtml = `<div class="text-sm font-semibold mb-2">📝 シーン${sceneIdx}のセリフ一覧:</div>`;
    utterances.forEach((u, i) => {
      const isUnconfirmed = u.role === 'dialogue' && !u.character_key;
      const role = u.role === 'narration' ? '🎤ナレ' 
        : isUnconfirmed ? '⚠️話者不明' 
        : `🗣️${u.character_name || u.character_key || 'キャラ'}`;
      const truncText = u.text.length > 40 ? u.text.substring(0, 40) + '...' : u.text;
      listHtml += `<div class="text-xs py-0.5 border-b border-gray-100${isUnconfirmed ? ' bg-amber-50' : ''}">`;
      listHtml += `<span class="font-mono text-purple-600 font-bold">${i + 1}.</span> `;
      listHtml += `<span class="${isUnconfirmed ? 'text-amber-600 font-semibold' : 'text-gray-400'}">${role}</span> `;
      listHtml += `<span class="text-gray-700">"${escapeHtml(truncText)}"</span>`;
      listHtml += `</div>`;
    });
    listHtml += `<div class="mt-2 text-[11px] text-purple-600">→ 修正したい番号と新しいテキストを入力してください</div>`;
    listHtml += `<div class="text-[11px] text-gray-400">例:「1 ここに新しいセリフ」「2 別の言い方」</div>`;
    mcAddSystemMessage(listHtml, 'info');
    
    // Enter dialogue edit mode
    MC._dialogueEditMode = {
      sceneId: targetScene.id,
      sceneIdx: sceneIdx,
      utterances: utterances,
    };
    
    // Update input placeholder
    const input = document.getElementById('mcChatInput');
    if (input) input.placeholder = `セリフ編集中（例: 1 新しいセリフテキスト）`;
    
    mcSetEditBanner(`📝 セリフ編集中: シーン${sceneIdx}`, true);
  } catch (err) {
    const errMsg = err.response?.data?.error?.message || err.message || '通信エラー';
    mcAddSystemMessage(`セリフ取得エラー: ${errMsg}`, 'error');
  }
}

// Handle reply in dialogue edit mode ("1 新しいセリフテキスト")
async function mcHandleDialogueEditReply(text) {
  const mode = MC._dialogueEditMode;
  if (!mode) return;
  
  mcAddUserMessage(text);
  
  // Parse: "N 新しいテキスト" or just a number for cancel
  const trimmed = text.trim();
  
  // Check for exit/cancel
  if (/^やめ|キャンセル|戻る|cancel|exit|quit$/i.test(trimmed)) {
    MC._dialogueEditMode = null;
    const input = document.getElementById('mcChatInput');
    if (input) input.placeholder = '完成しました（シーンをタップして画像再生成）';
    mcSetEditBanner('', false);
    mcAddSystemMessage('セリフ編集を終了しました。', 'info');
    return;
  }
  
  // Parse "N text" format
  const match = trimmed.match(/^(\d+)\s+(.+)$/s);
  if (!match) {
    mcAddSystemMessage('番号と新しいテキストを入力してください。\n例:「1 新しいセリフ」「やめ」で終了', 'info');
    return;
  }
  
  const utteranceNum = parseInt(match[1], 10);
  const newText = match[2].trim();
  
  if (utteranceNum < 1 || utteranceNum > mode.utterances.length) {
    mcAddSystemMessage(`番号が範囲外です。1〜${mode.utterances.length}で指定してください。`, 'error');
    return;
  }
  
  const utterance = mode.utterances[utteranceNum - 1];
  await mcEditUtterance(mode.sceneId, mode.sceneIdx, utterance, utteranceNum, newText);
}

// Actually edit an utterance and regenerate audio
async function mcEditUtterance(sceneId, sceneIdx, utterance, utteranceNum, newText) {
  mcAddSystemMessage(`シーン${sceneIdx}の${utteranceNum}番目のセリフを更新中...`, 'info');
  mcSetEditBanner(`📝 シーン${sceneIdx} セリフ${utteranceNum}を修正中...`, true);
  
  try {
    // Step 1: Update text
    const updateRes = await axios.put(`/api/utterances/${utterance.id}`, {
      text: newText
    });
    
    if (!updateRes.data?.success) {
      mcAddSystemMessage('セリフの更新に失敗しました。', 'error');
      return;
    }
    
    mcAddSystemMessage(`✅ テキストを更新しました。音声を再生成中...`, 'info');
    
    // Step 2: Regenerate audio with force=true
    try {
      const audioRes = await axios.post(`/api/utterances/${utterance.id}/generate-audio`, {
        force: true
      }, { timeout: 60000 });
      
      if (audioRes.data?.success || audioRes.data?.audio_generation_id) {
        const shortText = newText.length > 20 ? newText.substring(0, 20) + '...' : newText;
        mcAddSystemMessage(
          `✅ シーン${sceneIdx}のセリフ${utteranceNum}を更新しました！` +
          `\n新: 「${escapeHtml(shortText)}」` +
          `\n音声も再生成しました。再ビルドで動画に反映されます。`,
          'success'
        );
        MC._lastEditInstruction = `セリフ${utteranceNum}:「${shortText}」`;
        mcSetEditBanner(`📝 シーン${sceneIdx} セリフ${utteranceNum} ✅ 更新済み`, true);
        mcTrackChange('dialogue', sceneIdx, `セリフ${utteranceNum}: 「${shortText}」`);
      } else {
        // Text updated but audio generation didn't start cleanly
        mcAddSystemMessage(
          `テキストは更新しましたが、音声再生成の確認ができませんでした。\n再ビルドでテキスト変更は反映されます。`,
          'info'
        );
        mcSetEditBanner(`📝 シーン${sceneIdx} セリフ${utteranceNum} テキスト更新済み`, true);
      }
    } catch (audioErr) {
      // Audio generation may be async or rate-limited
      if (audioErr.response?.status === 409) {
        mcAddSystemMessage(
          `テキストを更新しました。音声生成は現在処理中です。\nしばらく待ってから再ビルドしてください。`,
          'info'
        );
      } else {
        const errMsg = audioErr.response?.data?.error?.message || audioErr.message || '';
        mcAddSystemMessage(
          `テキストは更新済みですが、音声再生成が失敗しました: ${errMsg}\n再ビルドでテキスト変更は反映されます。`,
          'error'
        );
      }
      mcSetEditBanner(`📝 シーン${sceneIdx} セリフ${utteranceNum} テキスト更新済み`, true);
    }
    
    // Update the utterance in the local mode data
    if (MC._dialogueEditMode) {
      MC._dialogueEditMode.utterances[utteranceNum - 1].text = newText;
    }
    
    // Force poll to pick up audio changes
    mcForcePollSoon();
    
  } catch (err) {
    const errMsg = err.response?.data?.error?.message || err.message || '通信エラー';
    mcAddSystemMessage(`セリフ更新エラー: ${errMsg}`, 'error');
  }
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
  const boardIdle = document.getElementById('mcBoardIdle');
  
  switch (state) {
    case 'idle':
      input.disabled = false;
      sendBtn.disabled = false;
      input.placeholder = 'シナリオテキストを貼り付けてください...';
      mcUnlockBoard();
      boardIdle.classList.remove('hidden');
      // P2: Hide assets summary when returning to idle
      const assetsSummaryIdle = document.getElementById('mcAssetsSummary');
      if (assetsSummaryIdle) assetsSummaryIdle.classList.add('hidden');
      document.getElementById('mcSceneCards').classList.add('hidden');
      // P-0: Hide video preview
      const vpIdle = document.getElementById('mcBoardVideoPreview');
      if (vpIdle) vpIdle.classList.add('hidden');
      // T2: Clear edit banner on idle
      mcSetEditBanner('', false);
      // P-4: Clear BGM display on idle
      MC._bgmChecked = false;
      MC._currentBgm = null;
      if (typeof mcUpdateBgmDisplay === 'function') mcUpdateBgmDisplay(null);
      MC.runId = null;
      MC.projectId = null;
      MC.phase = null;
      MC._retryShown = false;
      break;
      
    case 'processing':
      input.disabled = true;
      sendBtn.disabled = true;
      input.placeholder = '処理中...';
      mcLockBoard();
      break;
      
    case 'ready':
      input.disabled = true;
      sendBtn.disabled = true;
      input.placeholder = '完成しました（シーンをタップして画像再生成）';
      mcLockBoard();
      mcShowReadyActions();
      break;
      
    case 'error':
      input.disabled = true;
      sendBtn.disabled = true;
      input.placeholder = 'エラーが発生しました';
      break;
  }
}

// ============================================================
// Left Board Lock/Unlock (B-spec)
// ============================================================

function mcLockBoard() {
  const sections = ['mcBoardCharacters', 'mcBoardStyle', 'mcBoardVoice', 'mcBoardOutputSettings'];
  const locks = ['mcBoardCharLock', 'mcBoardStyleLock', 'mcBoardVoiceLock', 'mcBoardOutputLock'];
  
  sections.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.add('locked');
  });
  locks.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('hidden');
  });
  
  // Show locked-state displays (confirmed selections)
  mcShowConfirmedSelections();
}

function mcUnlockBoard() {
  const sections = ['mcBoardCharacters', 'mcBoardStyle', 'mcBoardVoice', 'mcBoardOutputSettings'];
  const locks = ['mcBoardCharLock', 'mcBoardStyleLock', 'mcBoardVoiceLock', 'mcBoardOutputLock'];
  
  sections.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.remove('locked');
  });
  locks.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  });
  
  // Hide locked-state displays, show edit controls
  ['mcCharacterLocked', 'mcStyleLocked', 'mcVoiceLocked'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  });
  // Show edit controls
  const charList = document.getElementById('mcCharacterList');
  if (charList) charList.classList.remove('hidden');
  const styleList = document.getElementById('mcStyleList');
  if (styleList) styleList.classList.remove('hidden');
  const voiceProvTabs = document.getElementById('mcVoiceProvTabs');
  if (voiceProvTabs) voiceProvTabs.classList.remove('hidden');
  const voiceSearch = document.getElementById('mcVoiceSearch');
  if (voiceSearch) voiceSearch.classList.remove('hidden');
  const voiceList = document.getElementById('mcVoiceList');
  if (voiceList) voiceList.classList.remove('hidden');
}

function mcShowConfirmedSelections() {
  // Characters — P2: include voice_provider from local state
  const charConfirmed = document.getElementById('mcCharacterConfirmed');
  const charLocked = document.getElementById('mcCharacterLocked');
  if (charConfirmed && charLocked) {
    if (MC.selectedCharacterIds.length > 0) {
      charConfirmed.innerHTML = MC.selectedCharacterIds.map(id => {
        const ch = MC._userCharacters.find(c => c.id === id);
        const name = ch ? ch.character_name : 'ID:' + id;
        let voiceLabel = '🔊Google';
        if (ch && ch.voice_preset_id) {
          const vid = ch.voice_preset_id;
          if (vid.startsWith('el-') || vid.startsWith('elevenlabs:')) voiceLabel = '🎤EL';
          else if (vid.startsWith('fish:') || vid.startsWith('fish-')) voiceLabel = '🎤Fish';
        }
        return '<span class="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-50 text-blue-700 rounded text-xs font-medium">'
          + '<i class="fas fa-user text-[10px]"></i>' + escapeHtml(name)
          + '<span class="text-[9px] text-gray-400 ml-0.5">' + voiceLabel + '</span>'
          + '</span>';
      }).join('');
    } else {
      charConfirmed.innerHTML = '<span class="text-xs text-gray-400">キャラクターなし</span>';
    }
    charLocked.classList.remove('hidden');
    const charList = document.getElementById('mcCharacterList');
    if (charList) charList.classList.add('hidden');
  }
  
  // Style
  const styleLocked = document.getElementById('mcStyleLocked');
  const styleConfirmed = document.getElementById('mcStyleConfirmed');
  if (styleLocked && styleConfirmed) {
    const preset = MC._stylePresets.find(p => p.id === MC.selectedStylePresetId);
    styleConfirmed.innerHTML = '<i class="fas fa-brush mr-1 text-pink-500"></i>' + escapeHtml(preset ? preset.name : '未選択');
    styleLocked.classList.remove('hidden');
    const styleList = document.getElementById('mcStyleList');
    if (styleList) styleList.classList.add('hidden');
  }
  
  // Voice
  const voiceLocked = document.getElementById('mcVoiceLocked');
  const voiceConfirmed = document.getElementById('mcVoiceConfirmed');
  if (voiceLocked && voiceConfirmed) {
    const v = MC._allVoices.find(v => v.provider === MC.selectedVoice.provider && v.voice_id === MC.selectedVoice.voice_id);
    voiceConfirmed.innerHTML = '<i class="fas fa-microphone-alt mr-1 text-purple-500"></i>' + escapeHtml(v ? v.name + ' (' + v.provider + ')' : MC.selectedVoice.voice_id);
    voiceLocked.classList.remove('hidden');
    // Hide edit controls
    const voiceProvTabs = document.getElementById('mcVoiceProvTabs');
    if (voiceProvTabs) voiceProvTabs.classList.add('hidden');
    const voiceSearch = document.getElementById('mcVoiceSearch');
    if (voiceSearch) voiceSearch.classList.add('hidden');
    const voiceList = document.getElementById('mcVoiceList');
    if (voiceList) voiceList.classList.add('hidden');
    const voiceSelected = document.getElementById('mcVoiceSelected');
    if (voiceSelected) voiceSelected.classList.add('hidden');
  }
}

function mcShowReadyActions() {
  const container = document.getElementById('mcChatMessages');
  
  const status = MC._lastStatus;
  const p = status?.progress;
  const imgDone = p?.images?.completed || 0;
  const imgTotal = p?.images?.total || 0;
  const audioDone = p?.audio?.completed || 0;
  const audioTotal = p?.audio?.total_utterances || 0;
  const speakerNoConfirm = p?.audio?.speaker_stats?.dialogue_no_speaker || 0;
  
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
  
  // If already shown, update in-place instead of re-creating
  const existing = container.querySelector('[data-ready-actions]');
  if (existing) {
    const titleEl = existing.querySelector('[data-ready-title]');
    const subtitleEl = existing.querySelector('[data-ready-subtitle]');
    const imgCountEl = existing.querySelector('[data-img-count]');
    const audioCountEl = existing.querySelector('[data-audio-count]');
    if (titleEl) titleEl.innerHTML = `<i class="fas fa-check-circle mr-1"></i>${readyTitle}`;
    if (subtitleEl) subtitleEl.textContent = readySubtitle;
    if (imgCountEl) imgCountEl.innerHTML = `<i class="fas fa-image text-blue-500 mr-1"></i>画像: <strong>${imgDone}/${imgTotal}</strong>`;
    if (audioCountEl) audioCountEl.innerHTML = `<i class="fas fa-microphone text-purple-500 mr-1"></i>音声: <strong>${audioDone}/${audioTotal}</strong>`;
    // Update speaker unconfirmed banner
    const speakerBannerEl = existing.querySelector('[data-speaker-banner]');
    if (speakerBannerEl) {
      speakerBannerEl.innerHTML = speakerNoConfirm > 0
        ? `<i class="fas fa-exclamation-triangle mr-1"></i>話者未確定の発話が <strong>${speakerNoConfirm}件</strong> あります<br><span class="text-[10px]">シーンカードをタップ → 音声タブで話者を設定できます</span>`
        : '';
      speakerBannerEl.className = speakerNoConfirm > 0 ? 'text-xs bg-amber-50 text-amber-700 border border-amber-200 rounded px-2 py-1.5 mb-2' : 'hidden';
    }
    mcUpdateVideoPanel(p?.video);
    return;
  }
  
  const div = document.createElement('div');
  div.className = 'flex justify-start';
  div.setAttribute('data-ready-actions', 'true');
  div.innerHTML = `
    <div class="chat-bubble bg-green-50 text-green-800 border border-green-200 w-full">
      <p class="font-bold mb-2" data-ready-title><i class="fas fa-check-circle mr-1"></i>${readyTitle}</p>
      <p class="text-sm mb-2" data-ready-subtitle>${readySubtitle}</p>
      
      <div class="grid grid-cols-2 gap-2 mb-3 text-sm">
        <div class="bg-white rounded px-2 py-1.5 border" data-img-count>
          <i class="fas fa-image text-blue-500 mr-1"></i>画像: <strong>${imgDone}/${imgTotal}</strong>
        </div>
        <div class="bg-white rounded px-2 py-1.5 border" data-audio-count>
          <i class="fas fa-microphone text-purple-500 mr-1"></i>音声: <strong>${audioDone}/${audioTotal}</strong>
        </div>
      </div>
      
      <div data-speaker-banner class="${speakerNoConfirm > 0 ? 'text-xs bg-amber-50 text-amber-700 border border-amber-200 rounded px-2 py-1.5 mb-2' : 'hidden'}">
        ${speakerNoConfirm > 0 ? `<i class="fas fa-exclamation-triangle mr-1"></i>話者未確定の発話が <strong>${speakerNoConfirm}件</strong> あります<br><span class="text-[10px]">シーンカードをタップ → 音声タブで話者を設定できます</span>` : ''}
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
  if (!video) {
    return '<div class="text-sm text-gray-400"><i class="fas fa-film mr-1"></i>動画情報なし</div>';
  }
  
  if (video.state === 'off') {
    // Flag is OFF — video build feature disabled
    if (video.enabled === false) {
      return '<div class="text-sm text-gray-400"><i class="fas fa-video-slash mr-1"></i>動画自動合成は無効です</div>';
    }
    // Flag status unknown or not yet in ready phase
    return '<div class="text-sm text-gray-400"><i class="fas fa-film mr-1"></i>動画ビルド待機中</div>';
  }
  
  switch (video.state) {
    case 'pending':
      return '<div class="text-sm text-yellow-600"><i class="fas fa-clock mr-1 animate-pulse"></i>動画ビルド準備中（自動開始します）...</div>';
    
    case 'running': {
      const pct = video.progress_percent || 0;
      const stage = video.build_status ? `（${video.build_status}）` : '';
      return `
        <div class="text-sm text-blue-600 mb-1"><i class="fas fa-spinner fa-spin mr-1"></i>動画レンダリング中${stage}...</div>
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
    
    case 'failed': {
      const errorMsg = video.error ? `<div class="text-xs text-gray-500 mt-1">原因: ${video.error.substring(0, 100)}</div>` : '';
      return `<div class="text-sm text-red-600"><i class="fas fa-exclamation-triangle mr-1"></i>動画ビルドに失敗しました</div>${errorMsg}`;
    }
    
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

// ── T1: Left Board Video Preview (always present in ready phase) ──
async function mcUpdateBoardVideoPreview(video) {
  const previewEl = document.getElementById('mcBoardVideoPreview');
  if (!previewEl) return;

  const player = document.getElementById('mcBoardVideoPlayer');
  const placeholder = document.getElementById('mcBoardVideoPlaceholder');
  const placeholderText = document.getElementById('mcBoardVideoPlaceholderText');
  const dlBtn = document.getElementById('mcBoardVideoDL');
  const rebuildBtn = document.getElementById('mcBoardVideoRebuild');
  const statusEl = document.getElementById('mcBoardVideoStatus');

  // T1: Show video section whenever phase is ready (or later), hide during idle/processing
  if (MC.phase === 'ready' || MC.phase === 'canceled') {
    previewEl.classList.remove('hidden');
  } else if (!video || !['running','done','failed'].includes(video?.state)) {
    previewEl.classList.add('hidden');
    return;
  } else {
    // Active phases with video state — show
    previewEl.classList.remove('hidden');
  }

  // Reset visibility
  if (player) player.classList.add('hidden');
  if (placeholder) placeholder.classList.add('hidden');
  if (dlBtn) dlBtn.classList.add('hidden');
  if (rebuildBtn) rebuildBtn.classList.add('hidden');
  if (statusEl) statusEl.textContent = '';

  // No video info or waiting states
  if (!video || video.state === 'off' || video.state === 'pending') {
    if (placeholder) { placeholder.classList.remove('hidden'); }
    if (placeholderText) placeholderText.textContent = '動画未生成（待機中）';
    return;
  }

  // Running — show progress in placeholder
  if (video.state === 'running') {
    if (placeholder) { placeholder.classList.remove('hidden'); }
    const pct = video.progress_percent || 0;
    if (placeholderText) placeholderText.innerHTML = `<i class="fas fa-spinner fa-spin mr-1"></i>動画生成中… ${pct}%`;
    if (statusEl) statusEl.textContent = `レンダリング ${pct}%`;
    return;
  }

  // Done — show video player (status API returns fresh presigned URL when near expiry)
  if (video.state === 'done' && (video.download_url || video.build_id)) {
    if (placeholder) placeholder.classList.add('hidden');
    
    let videoUrl = video.download_url;
    
    // Fallback: if no download_url from status but build_id exists, fetch fresh URL
    if (!videoUrl && video.build_id) {
      try {
        const freshRes = await axios.get(`/api/video-builds/${video.build_id}`, { timeout: 10000 });
        const freshUrl = freshRes.data?.build?.download_url;
        if (freshUrl) videoUrl = freshUrl;
      } catch (e) {
        console.warn('[Video] Fresh URL fetch failed:', e.message);
      }
    }
    
    if (player && videoUrl) {
      player.classList.remove('hidden');
      // Only update src when URL changes (avoids playback reset during polling)
      const currentSrc = player.getAttribute('data-src');
      if (currentSrc !== videoUrl) {
        player.setAttribute('data-src', videoUrl);
        player.setAttribute('data-build-id', String(video.build_id || ''));
        player.src = videoUrl;
        player.load();
      }
      // Add one-time error handler for 403/expired URL recovery
      if (!player._errorHandlerSet && video.build_id) {
        player._errorHandlerSet = true;
        player.addEventListener('error', async () => {
          console.warn('[Video] Playback error, fetching fresh URL...');
          try {
            const r = await axios.get(`/api/video-builds/${video.build_id}`, { timeout: 10000 });
            const u = r.data?.build?.download_url;
            if (u && u !== player.getAttribute('data-src')) {
              player.setAttribute('data-src', u);
              player.src = u;
              player.load();
            }
          } catch (e2) { console.warn('[Video] Error recovery failed:', e2.message); }
        });
      }
    }
    if (dlBtn && videoUrl) { dlBtn.classList.remove('hidden'); dlBtn.href = videoUrl; }
    if (statusEl) statusEl.innerHTML = '<i class="fas fa-check-circle mr-1"></i>動画完成 — タップで再生';
    mcUpdateRebuildButton(video);
    return;
  }

  // Failed — show error in placeholder + retry
  if (video.state === 'failed') {
    if (placeholder) { placeholder.classList.remove('hidden'); }
    if (placeholderText) placeholderText.innerHTML = '<i class="fas fa-exclamation-triangle mr-1"></i>動画生成に失敗しました';
    if (statusEl) statusEl.innerHTML = '<span class="text-red-500"><i class="fas fa-exclamation-triangle mr-1"></i>失敗</span>';
    mcUpdateRebuildButton(video);
    return;
  }
}

// ── A-2 Guard: Update rebuild button state (cooldown / state control) ──
function mcUpdateRebuildButton(video) {
  const btn = document.getElementById('mcBoardVideoRebuild');
  const dlBtn = document.getElementById('mcBoardVideoDL');
  if (!btn) return;

  // Guard: While video is running, hide rebuild
  if (video.state === 'running') {
    btn.classList.add('hidden');
    return;
  }

  btn.classList.remove('hidden');

  // Guard: Cooldown — 3min after last attempt
  const COOLDOWN_MS = 3 * 60 * 1000;
  if (video.attempted_at) {
    const elapsed = Date.now() - new Date(video.attempted_at).getTime();
    if (elapsed < COOLDOWN_MS && video.state !== 'failed') {
      const remainSec = Math.ceil((COOLDOWN_MS - elapsed) / 1000);
      const remainMin = Math.floor(remainSec / 60);
      const remainSecPart = remainSec % 60;
      btn.disabled = true;
      btn.className = 'flex-1 text-xs px-3 py-1.5 bg-gray-100 text-gray-400 rounded-lg font-semibold cursor-not-allowed';
      btn.innerHTML = `<i class="fas fa-clock mr-1"></i>${remainMin}:${String(remainSecPart).padStart(2,'0')} 後に再試行可`;
      return;
    }
  }

  // Style by state
  if (video.state === 'done') {
    // "修正反映" rebuild — subtle style (primary action is download)
    btn.disabled = false;
    btn.className = 'flex-1 text-xs px-3 py-1.5 bg-purple-50 text-purple-600 rounded-lg font-semibold hover:bg-purple-100 border border-purple-200';
    btn.innerHTML = '<i class="fas fa-sync-alt mr-1"></i>修正を反映して再ビルド';
  } else if (video.state === 'failed') {
    // Retry — prominent
    btn.disabled = false;
    btn.className = 'flex-1 text-xs px-3 py-1.5 bg-red-100 text-red-700 rounded-lg font-semibold hover:bg-red-200';
    btn.innerHTML = '<i class="fas fa-redo mr-1"></i>リトライ';
  } else {
    btn.disabled = false;
    btn.className = 'flex-1 text-xs px-3 py-1.5 bg-purple-100 text-purple-700 rounded-lg font-semibold hover:bg-purple-200';
    btn.innerHTML = '<i class="fas fa-redo mr-1"></i>再ビルド';
  }
}

// ── A-2: Rebuild Video from left board (with guards) ──
async function mcRebuildVideo() {
  if (!MC.projectId) {
    mcAddSystemMessage('プロジェクトが選択されていません。', 'error');
    return;
  }
  if (MC.phase !== 'ready') {
    mcAddSystemMessage('動画の再ビルドはready状態でのみ可能です。', 'error');
    return;
  }
  
  // Guard 1: Cooldown check — prevent spam
  const lastVideo = MC._lastStatus?.progress?.video;
  if (lastVideo?.attempted_at) {
    const elapsed = Date.now() - new Date(lastVideo.attempted_at).getTime();
    const COOLDOWN_MS = 3 * 60 * 1000;
    if (elapsed < COOLDOWN_MS && lastVideo.state !== 'failed') {
      const remainMin = Math.ceil((COOLDOWN_MS - elapsed) / 60000);
      mcAddSystemMessage(`クールダウン中です。約${remainMin}分後に再試行できます。`, 'error');
      return;
    }
  }
  
  // Guard 3: Prevent rebuild while running
  if (lastVideo?.state === 'running') {
    mcAddSystemMessage('動画ビルド中のため再ビルドはできません。', 'error');
    return;
  }
  
  // Confirm: if dirty changes exist → show confirm modal; retry/no-changes → simple confirm
  const isRetry = lastVideo?.state === 'failed';
  const hasDirty = MC._dirtyChanges && MC._dirtyChanges.length > 0;
  
  if (hasDirty && !isRetry) {
    // Show rich confirm modal with change list
    mcShowRebuildConfirmModal();
    return;
  }
  
  // No dirty changes or retry → simple confirm
  const confirmMsg = isRetry
    ? '前回の動画生成が失敗しました。リトライしますか？\n（素材はそのまま、動画だけ再レンダリングします）'
    : '変更はありませんが、動画を再ビルドしますか？\n（同じ素材で動画だけ再レンダリングします）';
  if (!confirm(confirmMsg)) return;
  
  await mcExecuteRebuild(isRetry);
}

// Rebuild confirm modal — shows list of pending changes before rebuild
function mcShowRebuildConfirmModal() {
  const existing = document.getElementById('mcRebuildConfirmModal');
  if (existing) existing.remove();
  
  const changes = [...MC._dirtyChanges].reverse().slice(0, 10);
  
  const TYPE_ICONS = {
    image: { icon: 'fa-image', color: 'text-green-600', bg: 'bg-green-50' },
    audio: { icon: 'fa-microphone', color: 'text-blue-600', bg: 'bg-blue-50' },
    dialogue: { icon: 'fa-comment-alt', color: 'text-blue-600', bg: 'bg-blue-50' },
    se: { icon: 'fa-volume-up', color: 'text-indigo-600', bg: 'bg-indigo-50' },
    bgm: { icon: 'fa-music', color: 'text-purple-600', bg: 'bg-purple-50' },
    comic: { icon: 'fa-book-open', color: 'text-pink-600', bg: 'bg-pink-50' },
    i2v: { icon: 'fa-film', color: 'text-cyan-600', bg: 'bg-cyan-50' },
    dat: { icon: 'fa-exchange-alt', color: 'text-orange-600', bg: 'bg-orange-50' },
  };
  
  let changeRows = '';
  for (const c of changes) {
    const ti = TYPE_ICONS[c.type] || { icon: 'fa-edit', color: 'text-gray-600', bg: 'bg-gray-50' };
    const sceneLabel = c.sceneIdx > 0 ? `S${c.sceneIdx}` : '全体';
    const ago = mcTimeAgo(c.ts);
    changeRows += `
      <div class="flex items-center gap-2 py-1.5 border-b border-gray-100 last:border-0">
        <span class="flex-shrink-0 w-6 h-6 ${ti.bg} rounded flex items-center justify-center">
          <i class="fas ${ti.icon} text-[10px] ${ti.color}"></i>
        </span>
        <span class="text-[11px] font-semibold text-gray-500 w-8">${sceneLabel}</span>
        <span class="text-[11px] text-gray-700 flex-1 truncate">${escapeHtml(c.label)}</span>
        <span class="text-[10px] text-gray-400 flex-shrink-0">${ago}</span>
      </div>`;
  }
  
  const totalChanges = MC._dirtyChanges.length;
  const moreNote = totalChanges > 10 ? `<p class="text-[10px] text-gray-400 mt-1">他 ${totalChanges - 10} 件の変更あり</p>` : '';
  
  const modal = document.createElement('div');
  modal.id = 'mcRebuildConfirmModal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;';
  
  modal.innerHTML = `
    <div style="background:#fff;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.2);max-width:420px;width:90%;max-height:80vh;overflow:hidden;" onclick="event.stopPropagation()">
      <div style="padding:16px 20px 12px;border-bottom:1px solid #f3f4f6;">
        <h3 style="font-size:15px;font-weight:700;color:#1f2937;margin:0;">
          <i class="fas fa-sync-alt" style="color:#7c3aed;margin-right:6px;"></i>この変更を動画に反映しますか？
        </h3>
      </div>
      <div style="padding:12px 20px;max-height:50vh;overflow-y:auto;">
        <p class="text-[11px] text-gray-500 mb-2 font-semibold">未反映の変更（${totalChanges}件）</p>
        ${changeRows}
        ${moreNote}
      </div>
      <div style="padding:12px 20px;border-top:1px solid #f3f4f6;background:#f9fafb;">
        <p style="font-size:10px;color:#9ca3af;margin:0 0 10px;">反映すると動画が再生成されます（数分かかる場合があります）</p>
        <div style="display:flex;gap:8px;">
          <button onclick="document.getElementById('mcRebuildConfirmModal').remove()"
                  style="flex:1;padding:8px;border-radius:8px;border:1px solid #e5e7eb;background:#fff;color:#6b7280;font-size:12px;font-weight:600;cursor:pointer;">
            キャンセル
          </button>
          <button onclick="document.getElementById('mcRebuildConfirmModal').remove(); mcExecuteRebuild(false)"
                  style="flex:1;padding:8px;border-radius:8px;border:none;background:#7c3aed;color:#fff;font-size:12px;font-weight:600;cursor:pointer;">
            <i class="fas fa-sync-alt" style="margin-right:4px;"></i>反映して再ビルド
          </button>
        </div>
      </div>
    </div>
  `;
  
  // Close on background click
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  document.body.appendChild(modal);
  
  // Close on Escape
  const handler = (e) => {
    if (e.key === 'Escape') { modal.remove(); document.removeEventListener('keydown', handler); }
  };
  document.addEventListener('keydown', handler);
}

// Execute the actual rebuild (called from confirm modal or direct confirm)
async function mcExecuteRebuild(isRetry) {
  const lastVideo = MC._lastStatus?.progress?.video;

  const btn = document.getElementById('mcBoardVideoRebuild');
  if (btn) {
    btn.disabled = true;
    btn.className = 'flex-1 text-xs px-3 py-1.5 bg-gray-100 text-gray-400 rounded-lg font-semibold cursor-not-allowed';
    btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>準備中...';
  }

  try {
    // Guard 2: Send reason for audit trail
    const reason = isRetry ? 'manual_retry_after_failure' : 'manual_rebuild';
    const res = await axios.post(`/api/marunage/${MC.projectId}/rebuild-video`, { reason }, { timeout: 30000 });
    mcAddSystemMessage(
      isRetry ? 'リトライを開始しました。自動で進捗が更新されます。' : '修正を反映して動画を再ビルド中です。自動で進捗が更新されます。',
      'success'
    );
    // Reset video done notification so the new completion will trigger scroll+highlight
    MC._videoDoneNotified = false;
    MC._videoFailedNotified = false;
    
    // T3: Clear dirty changes on rebuild
    mcClearDirtyOnRebuild();
    
    // Instant UI: switch video frame to "generating 0%" immediately (no poll wait)
    const player = document.getElementById('mcBoardVideoPlayer');
    const placeholder = document.getElementById('mcBoardVideoPlaceholder');
    const placeholderText = document.getElementById('mcBoardVideoPlaceholderText');
    const dlBtn = document.getElementById('mcBoardVideoDL');
    const statusEl = document.getElementById('mcBoardVideoStatus');
    if (player) player.classList.add('hidden');
    if (placeholder) placeholder.classList.remove('hidden');
    if (placeholderText) placeholderText.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i>動画生成中… 0%';
    if (dlBtn) dlBtn.classList.add('hidden');
    if (btn) btn.classList.add('hidden');
    if (statusEl) statusEl.textContent = '再ビルド準備中...';
    
    // Instant UI: update edit banner to show rebuild status
    const instrSuffix = MC._lastEditInstruction
      ? `<br><span class="text-[10px] text-purple-500">指示:「${MC._lastEditInstruction}」→ 動画に反映中</span>`
      : '';
    mcSetEditBanner(`🎬 動画再ビルド中…${instrSuffix}`, true);
    
    // Trigger polls to pick up running state quickly
    mcForcePollSoon();
  } catch (err) {
    const errMsg = err.response?.data?.error?.message || err.message || '通信エラー';
    mcAddSystemMessage(`再ビルドエラー: ${errMsg}`, 'error');
    // Restore button on error
    if (btn) {
      btn.classList.remove('hidden');
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-sync-alt mr-1"></i>修正を反映して再ビルド';
    }
  }
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
  MC.selectedStylePresetId = MC._stylePresets.length > 0 ? MC._stylePresets[0].id : null;
  MC.selectedCharacterIds = [];
  
  // P-2: Reset scene selection
  MC._selectedSceneId = null;
  MC._selectedSceneIdx = null;
  MC._regeneratingSceneId = null;
  MC._lastEditInstruction = null;
  MC._bgmChecked = false;
  MC._currentBgm = null;
  MC._seChecked = false;
  MC._currentSeMap = {};
  MC._dialogueEditMode = null;
  MC._dirtyChanges = [];
  MC._lastRebuildTs = null;
  // I2V: Stop polling and clear state
  mcStopI2vPolling();
  MC._i2vGenerating = null;
  MC._i2vChecked = false;
  // Comic: Clear state
  MC._comicGenerating = null;
  MC._comicEditMode = null;
  // SE timing & Batch comic: Clear state
  MC._seTimingEditMode = null;
  MC._batchComicRunning = false;
  if (typeof mcSetEditBanner === 'function') mcSetEditBanner('', false);
  if (typeof mcUpdateBgmDisplay === 'function') mcUpdateBgmDisplay(null);
  if (typeof mcUpdateSeDisplay === 'function') mcUpdateSeDisplay();
  
  // Clear chat
  const container = document.getElementById('mcChatMessages');
  container.innerHTML = `
    <div class="flex justify-start">
      <div class="chat-bubble chat-system">
        <p class="font-semibold mb-1"><i class="fas fa-hand-sparkles mr-1"></i>丸投げチャットへようこそ！</p>
        <p class="text-sm">シナリオテキストを貼り付けてください。<br>シーン画像・ナレーション音声・BGM・SEを自動で生成します。<br>生成後はチャットから編集指示も可能です。</p>
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
  
  // Reset style chips — re-select first
  document.querySelectorAll('#mcStyleList .voice-chip').forEach((c, i) => {
    if (i === 0) c.classList.add('active');
    else c.classList.remove('active');
  });
  // Reset character chips — deselect all
  document.querySelectorAll('#mcCharacterList .char-chip').forEach(c => {
    c.classList.remove('selected', 'disabled');
  });
  // Reset voice to default & re-render list
  MC.selectedVoice = { provider: 'google', voice_id: 'ja-JP-Neural2-B' };
  MC._voiceFilter = 'all';
  MC._voiceSearch = '';
  const searchInput = document.getElementById('mcVoiceSearch');
  if (searchInput) searchInput.value = '';
  // Reset Fish custom ID input
  const fishIdInput = document.getElementById('mcFishIdInput');
  if (fishIdInput) fishIdInput.value = '';
  const fishIdApply = document.getElementById('mcFishIdApply');
  if (fishIdApply) { fishIdApply.disabled = true; fishIdApply.textContent = '適用'; }
  document.querySelectorAll('.voice-prov-tab').forEach((t, i) => {
    if (i === 0) t.classList.add('active');
    else t.classList.remove('active');
  });
  mcRenderVoiceList();
  // Unlock left board for new creation
  mcUnlockBoard();
  
  // P2: Reset assets summary
  const assetsSummary = document.getElementById('mcAssetsSummary');
  if (assetsSummary) assetsSummary.classList.add('hidden');
  const boardIdle = document.getElementById('mcBoardIdle');
  if (boardIdle) boardIdle.classList.remove('hidden');
  
  // P-0: Reset video preview
  const videoPreview = document.getElementById('mcBoardVideoPreview');
  if (videoPreview) videoPreview.classList.add('hidden');
  // T2: Clear edit banner on reset
  if (typeof mcSetEditBanner === 'function') mcSetEditBanner('', false);
  MC._regeneratingSceneId = null;
  
  // P-1: Reset custom scene count
  const customScene = document.getElementById('mcCustomSceneCount');
  if (customScene) customScene.classList.add('hidden');
  
  mcSetUIState('idle');
}

// ============================================================
// B-spec: Update left board from status API confirmed data
// ============================================================

function mcUpdateBoardFromConfirmed(confirmed) {
  if (!confirmed) return;
  
  // Characters (from server SSOT — P2: include appear_scenes + voice label)
  const charConfirmed = document.getElementById('mcCharacterConfirmed');
  const charLocked = document.getElementById('mcCharacterLocked');
  if (charConfirmed && charLocked && confirmed.characters) {
    if (confirmed.characters.length > 0) {
      charConfirmed.innerHTML = confirmed.characters.map(ch => {
        const voiceLabel = ch.voice_provider === 'elevenlabs' ? '🎤EL'
          : ch.voice_provider === 'fish' ? '🎤Fish' : '🔊Google';
        const scenesTotal = MC._lastStatus?.progress?.format?.scene_count || 0;
        const appear = ch.appear_scenes || 0;
        const uttCount = ch.utterance_count || 0;
        const statsText = scenesTotal > 0 ? ' ' + appear + '/' + scenesTotal + 'シーン' : '';
        const uttText = uttCount > 0 ? ' ' + uttCount + '発話' : '';
        return '<span class="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-50 text-blue-700 rounded text-xs font-medium">'
          + '<i class="fas fa-user text-[10px]"></i>' + escapeHtml(ch.character_name)
          + '<span class="text-[9px] text-gray-400 ml-0.5">' + statsText + uttText + ' ' + voiceLabel + '</span>'
          + '</span>';
      }).join('');
    } else {
      charConfirmed.innerHTML = '<span class="text-xs text-gray-400">キャラクターなし</span>';
    }
    if (MC.uiState !== 'idle') {
      charLocked.classList.remove('hidden');
      const charList = document.getElementById('mcCharacterList');
      if (charList) charList.classList.add('hidden');
    }
  }
  
  // Style (from server SSOT)
  const styleConfirmed = document.getElementById('mcStyleConfirmed');
  const styleLocked = document.getElementById('mcStyleLocked');
  if (styleConfirmed && styleLocked && confirmed.style) {
    styleConfirmed.innerHTML = '<i class="fas fa-brush mr-1 text-pink-500"></i>' + escapeHtml(confirmed.style.name || '未選択');
    if (MC.uiState !== 'idle') {
      styleLocked.classList.remove('hidden');
      const styleList = document.getElementById('mcStyleList');
      if (styleList) styleList.classList.add('hidden');
    }
  }
  
  // Voice (from server SSOT)
  const voiceConfirmed = document.getElementById('mcVoiceConfirmed');
  const voiceLocked = document.getElementById('mcVoiceLocked');
  if (voiceConfirmed && voiceLocked && confirmed.voice) {
    const v = MC._allVoices.find(v => v.provider === confirmed.voice.provider && v.voice_id === confirmed.voice.voice_id);
    const voiceName = v ? v.name + ' (' + v.provider + ')' : confirmed.voice.voice_id + ' (' + confirmed.voice.provider + ')';
    voiceConfirmed.innerHTML = '<i class="fas fa-microphone-alt mr-1 text-purple-500"></i>' + escapeHtml(voiceName);
    if (MC.uiState !== 'idle') {
      voiceLocked.classList.remove('hidden');
      const voiceProvTabs = document.getElementById('mcVoiceProvTabs');
      if (voiceProvTabs) voiceProvTabs.classList.add('hidden');
      const voiceSearch = document.getElementById('mcVoiceSearch');
      if (voiceSearch) voiceSearch.classList.add('hidden');
      const voiceList = document.getElementById('mcVoiceList');
      if (voiceList) voiceList.classList.add('hidden');
      const voiceSelected = document.getElementById('mcVoiceSelected');
      if (voiceSelected) voiceSelected.classList.add('hidden');
    }
  }
}

// ============================================================
// P2: Assets Summary — 3-column display (images/audio/video)
// ============================================================

function mcAssetStateColor(state) {
  if (state === 'done') return 'text-green-600';
  if (state === 'running') return 'text-blue-600';
  if (state === 'failed') return 'text-red-600';
  return 'text-gray-600';
}

function mcUpdateAssetsSummary(progress) {
  const el = document.getElementById('mcAssetsSummary');
  if (!el || !progress) return;

  const summary = progress.assets_summary;
  if (!summary) return;

  // Show summary, hide idle placeholder
  el.classList.remove('hidden');
  const idle = document.getElementById('mcBoardIdle');
  if (idle) idle.classList.add('hidden');

  // Images: "3/5"
  const imgEl = document.getElementById('mcAssetsImages');
  if (imgEl) {
    imgEl.textContent = summary.images_done + '/' + summary.scenes_total;
    imgEl.className = 'text-sm font-bold ' + mcAssetStateColor(summary.images_state);
  }

  // Audio: "12/12"
  const audEl = document.getElementById('mcAssetsAudio');
  if (audEl) {
    audEl.textContent = summary.audio_done + '/' + summary.audio_total;
    audEl.className = 'text-sm font-bold ' + mcAssetStateColor(summary.audio_state);
  }

  // Video: state label
  const vidEl = document.getElementById('mcAssetsVideo');
  if (vidEl) {
    if (summary.video_state === 'done') vidEl.textContent = '完了';
    else if (summary.video_state === 'running') vidEl.textContent = (summary.video_percent || 0) + '%';
    else if (summary.video_state === 'failed') vidEl.textContent = '失敗';
    else if (summary.video_state === 'off') vidEl.textContent = 'OFF';
    else vidEl.textContent = '待機中';
    vidEl.className = 'text-sm font-bold ' + mcAssetStateColor(summary.video_state);
  }

  // Hide hint once generation is underway
  const hint = document.getElementById('mcAssetsHint');
  if (hint && (summary.images_state !== 'pending' || summary.audio_state !== 'pending')) {
    hint.classList.add('hidden');
  }
}

// ============================================================
// Voice / Preset Selection — SSOT: /api/tts/voices
// ============================================================

// All loaded voices (flat array: [{id, name, provider, gender, voice_id?, unavailable}])

async function mcLoadVoices() {
  const container = document.getElementById('mcVoiceList');
  try {
    const res = await axios.get('/api/tts/voices');
    const data = res.data;
    const voices = [];
    const providers = data.providers || {};

    // Google
    for (const v of (data.voices.google || [])) {
      voices.push({
        id: v.id,
        voice_id: v.id,
        name: v.name,
        provider: 'google',
        gender: v.gender,
        unavailable: !providers.google,
      });
    }
    // ElevenLabs
    for (const v of (data.voices.elevenlabs || [])) {
      voices.push({
        id: v.id,
        voice_id: v.voice_id || v.id,
        name: v.name,
        provider: 'elevenlabs',
        gender: v.gender,
        unavailable: !providers.elevenlabs,
      });
    }
    // Fish
    for (const v of (data.voices.fish || [])) {
      voices.push({
        id: v.id,
        voice_id: v.id,
        name: v.name,
        provider: 'fish',
        gender: v.gender,
        unavailable: !providers.fish,
      });
    }

    MC._allVoices = voices;

    // Pre-select default (google:ja-JP-Neural2-B) if not yet set
    if (!MC._allVoices.find(v => v.provider === MC.selectedVoice.provider && v.voice_id === MC.selectedVoice.voice_id)) {
      // Keep current default — it might not be in the list if Neural2 voices aren't listed.
      // Add it as a synthetic entry if needed.
      const hasDefault = voices.some(v => v.id === 'ja-JP-Neural2-B');
      if (!hasDefault) {
        voices.push({
          id: 'ja-JP-Neural2-B',
          voice_id: 'ja-JP-Neural2-B',
          name: 'Neural2-B（男性・デフォルト）',
          provider: 'google',
          gender: 'male',
          unavailable: false,
        });
      }
    }

    mcRenderVoiceList();

    // Show selected name
    const sel = voices.find(v => v.provider === MC.selectedVoice.provider && v.voice_id === MC.selectedVoice.voice_id);
    if (sel) {
      document.getElementById('mcVoiceSelectedName').textContent = sel.name + ' (' + sel.provider + ')';
      document.getElementById('mcVoiceSelected').classList.remove('hidden');
    }

  } catch (err) {
    console.warn('[MC] Failed to load voices:', err);
    // Fallback: show default voice so user can still proceed
    MC._allVoices = [{
      id: 'ja-JP-Neural2-B', voice_id: 'ja-JP-Neural2-B',
      name: 'Neural2-B（男性・デフォルト）', provider: 'google', gender: 'male', unavailable: false,
    }];
    mcRenderVoiceList();
    container.insertAdjacentHTML('beforeend',
      '<div class="text-[10px] text-amber-500 mt-1"><i class="fas fa-exclamation-triangle mr-0.5"></i>音声一覧の読み込みに失敗。デフォルトのみ表示中</div>'
    );
  }
}

function mcRenderVoiceList() {
  const container = document.getElementById('mcVoiceList');
  const filter = MC._voiceFilter;
  const search = MC._voiceSearch.toLowerCase();

  const filtered = MC._allVoices.filter(v => {
    if (filter !== 'all' && v.provider !== filter) return false;
    if (search && !v.name.toLowerCase().includes(search) && !v.id.toLowerCase().includes(search) && !v.provider.includes(search) && !(v.gender || '').includes(search)) return false;
    return true;
  });

  if (filtered.length === 0) {
    container.innerHTML = '<span class="text-xs text-gray-400">該当するボイスがありません</span>';
    return;
  }

  container.innerHTML = filtered.map(v => {
    const isActive = v.provider === MC.selectedVoice.provider && v.voice_id === MC.selectedVoice.voice_id;
    const cls = 'voice-item' + (isActive ? ' active' : '') + (v.unavailable ? ' unavailable' : '');
    const icon = v.gender === 'female' ? 'fa-female' : 'fa-male';
    return '<button class="' + cls + '" data-provider="' + v.provider + '" data-voice-id="' + v.voice_id + '" '
      + (v.unavailable ? 'title="プロバイダ未設定" disabled' : 'onclick="mcSelectVoice(this)"')
      + '>'
      + '<span class="prov-dot prov-' + v.provider + '"></span>'
      + '<i class="fas ' + icon + '"></i>'
      + '<span>' + escapeHtml(v.name) + '</span>'
      + (v.unavailable ? '<i class="fas fa-lock text-gray-300 text-[8px] ml-0.5"></i>' : '')
      + '</button>';
  }).join('');
}

function mcSelectVoice(el) {
  const provider = el.dataset.provider;
  const voiceId = el.dataset.voiceId;
  MC.selectedVoice = { provider: provider, voice_id: voiceId };

  // Update active class
  document.querySelectorAll('#mcVoiceList .voice-item').forEach(c => c.classList.remove('active'));
  el.classList.add('active');

  // Update selected display
  const v = MC._allVoices.find(v => v.provider === provider && v.voice_id === voiceId);
  if (v) {
    document.getElementById('mcVoiceSelectedName').textContent = v.name + ' (' + v.provider + ')';
    document.getElementById('mcVoiceSelected').classList.remove('hidden');
  }
}

function mcFilterVoices(prov, tabEl) {
  MC._voiceFilter = prov;
  document.querySelectorAll('.voice-prov-tab').forEach(t => t.classList.remove('active'));
  tabEl.classList.add('active');
  mcRenderVoiceList();
}

function mcFilterVoicesBySearch(val) {
  MC._voiceSearch = val;
  mcRenderVoiceList();
}

// ============================================================
// Fish Audio Custom ID — allow user to enter any Fish model ID
// ============================================================

function mcValidateFishId(val) {
  const btn = document.getElementById('mcFishIdApply');
  // Valid Fish ID: 32-char hex
  btn.disabled = !/^[a-f0-9]{32}$/i.test(val.trim());
}

function mcApplyFishId() {
  const input = document.getElementById('mcFishIdInput');
  const fishId = input.value.trim();
  if (!/^[a-f0-9]{32}$/i.test(fishId)) return;

  // Set voice to fish with custom ID — backend supports 'fish:REFERENCE_ID' format
  MC.selectedVoice = { provider: 'fish', voice_id: 'fish:' + fishId };

  // Deselect all voice chips
  document.querySelectorAll('#mcVoiceList .voice-item').forEach(c => c.classList.remove('active'));

  // Show selected
  const selEl = document.getElementById('mcVoiceSelectedName');
  if (selEl) selEl.textContent = 'Fish Custom (' + fishId.substring(0, 8) + '…)';
  const selWrap = document.getElementById('mcVoiceSelected');
  if (selWrap) selWrap.classList.remove('hidden');

  // Brief visual feedback
  const btn = document.getElementById('mcFishIdApply');
  btn.textContent = '✓ 適用済み';
  btn.classList.add('bg-green-500');
  setTimeout(() => {
    btn.textContent = '適用';
    btn.classList.remove('bg-green-500');
  }, 1500);
}

// Legacy compat — old selectVoice calls from HTML (if any remain)
function selectVoice(el) {
  if (el.dataset.voice) {
    const [provider, voiceId] = el.dataset.voice.split(':');
    MC.selectedVoice = { provider, voice_id: voiceId };
  }
}

function selectPreset(el) {
  document.querySelectorAll('#mcOutputPresetList .voice-chip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  MC.selectedPreset = el.dataset.preset;
}

function selectSceneCount(el) {
  document.querySelectorAll('#mcSceneCountList .voice-chip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  const val = el.dataset.scenes;
  if (val === 'custom') return; // handled by mcShowCustomSceneCount
  MC.selectedSceneCount = parseInt(val) || 5;
  // Hide custom input when preset selected
  const customEl = document.getElementById('mcCustomSceneCount');
  if (customEl) customEl.classList.add('hidden');
}

// P-1: Show custom scene count input
function mcShowCustomSceneCount() {
  const customEl = document.getElementById('mcCustomSceneCount');
  if (customEl) customEl.classList.toggle('hidden');
}

// P-1: Apply custom scene count with warnings
function mcApplyCustomSceneCount() {
  const input = document.getElementById('mcCustomSceneInput');
  const warnEl = document.getElementById('mcSceneCountWarning');
  let val = parseInt(input.value) || 5;
  val = Math.max(1, Math.min(200, val));
  input.value = val;
  
  // Warnings
  if (warnEl) {
    const span = warnEl.querySelector('span');
    if (val >= 100) {
      span.textContent = `${val}シーンは処理に非常に長い時間がかかります。API費用も高額になります。`;
      warnEl.classList.remove('hidden');
      if (!confirm(`${val}シーンの生成を開始しますか？\n\n注意:\n・処理に長時間かかります（推定${Math.ceil(val*0.5)}分以上）\n・API費用が高額になる可能性があります\n\n本当に続行しますか？`)) return;
    } else if (val >= 30) {
      span.textContent = `${val}シーンは標準より多いため、処理時間が長くなります。`;
      warnEl.classList.remove('hidden');
    } else {
      warnEl.classList.add('hidden');
    }
  }
  
  MC.selectedSceneCount = val;
  // Deactivate preset buttons, highlight custom
  document.querySelectorAll('#mcSceneCountList .voice-chip').forEach(c => c.classList.remove('active'));
  const customBtn = document.querySelector('#mcSceneCountList .voice-chip[data-scenes="custom"]');
  if (customBtn) customBtn.classList.add('active');
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
// Style Preset Loading & Selection (Phase 1 UI)
// ============================================================

async function mcLoadStylePresets() {
  const container = document.getElementById('mcStyleList');
  try {
    const res = await axios.get('/api/style-presets');
    const presets = res.data.style_presets || [];
    MC._stylePresets = presets;
    
    if (presets.length === 0) {
      container.innerHTML = '<span class="text-xs text-gray-400">スタイルが未登録です</span>';
      return;
    }
    
    // Render style chips — first one pre-selected by default
    container.innerHTML = presets.map((p, i) => {
      const isDefault = i === 0; // Auto-select first preset
      if (isDefault) MC.selectedStylePresetId = p.id;
      return '<button class="voice-chip' + (isDefault ? ' active' : '') + '" data-style-id="' + p.id + '" onclick="selectStyle(this)" title="' + escapeHtml(p.description || '') + '">'
        + '<i class="fas fa-brush mr-1"></i>' + escapeHtml(p.name)
        + '</button>';
    }).join('');
  } catch (err) {
    console.warn('[MC] Failed to load style presets:', err);
    container.innerHTML = '<span class="text-xs text-gray-400">読み込み失敗</span>';
  }
}

function selectStyle(el) {
  document.querySelectorAll('#mcStyleList .voice-chip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
  MC.selectedStylePresetId = parseInt(el.dataset.styleId) || null;
}

// ============================================================
// Character Loading & Selection (Phase 2 UI)
// ============================================================

async function mcLoadUserCharacters() {
  const container = document.getElementById('mcCharacterList');
  const hint = document.getElementById('mcCharacterHint');
  try {
    const res = await axios.get('/api/user/characters');
    const chars = res.data.characters || [];
    MC._userCharacters = chars;
    
    if (chars.length === 0) {
      container.innerHTML = '<span class="text-xs text-gray-400">キャラクターが未登録です</span>';
      hint.classList.remove('hidden');
      return;
    }
    
    // Render character chips (multi-select, max 3)
    container.innerHTML = chars.map(ch => {
      const initial = (ch.character_name || '?').charAt(0);
      return '<button class="char-chip" data-char-id="' + ch.id + '" onclick="toggleCharacter(this)">'
        + '<span class="w-5 h-5 rounded-full bg-blue-100 text-blue-600 text-[10px] font-bold flex items-center justify-center shrink-0">' + escapeHtml(initial) + '</span>'
        + '<span>' + escapeHtml(ch.character_name) + '</span>'
        + '</button>';
    }).join('');
    hint.classList.remove('hidden');
  } catch (err) {
    console.warn('[MC] Failed to load user characters:', err);
    // Check for auth-related errors: 401, 403, redirect to login, or network errors
    const status = err.response?.status;
    if (status === 401 || status === 403 || !err.response) {
      container.innerHTML = '<span class="text-xs text-gray-400"><i class="fas fa-sign-in-alt mr-1"></i>ログインするとキャラクターが使えます</span>';
    } else {
      container.innerHTML = '<span class="text-xs text-gray-400">読み込み失敗（' + (status || 'error') + '）</span>';
    }
    hint.classList.remove('hidden');
  }
}

function toggleCharacter(el) {
  const charId = parseInt(el.dataset.charId);
  const idx = MC.selectedCharacterIds.indexOf(charId);
  
  if (idx >= 0) {
    // Deselect
    MC.selectedCharacterIds.splice(idx, 1);
    el.classList.remove('selected');
  } else {
    // Check max 3
    if (MC.selectedCharacterIds.length >= 3) {
      mcAddSystemMessage('キャラクターは最大3名まで選択できます', 'error');
      return;
    }
    MC.selectedCharacterIds.push(charId);
    el.classList.add('selected');
  }
  
  // Update disabled state on unselected chips
  document.querySelectorAll('#mcCharacterList .char-chip').forEach(chip => {
    const cid = parseInt(chip.dataset.charId);
    if (MC.selectedCharacterIds.length >= 3 && !MC.selectedCharacterIds.includes(cid)) {
      chip.classList.add('disabled');
    } else {
      chip.classList.remove('disabled');
    }
  });
}

// ============================================================
// Init
// ============================================================

mcCheckAuth();
