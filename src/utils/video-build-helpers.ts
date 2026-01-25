/**
 * Video Build Helpers
 * 
 * Remotion Video Build 用のヘルパー関数
 * 
 * ## SSOT (Single Source of Truth)
 * - Scene表示素材: scenes.display_asset_type ('image' | 'comic' | 'video')
 * - 素材選択:
 *   - image → image_generations (is_active=1)
 *   - comic → image_generations (is_active=1, asset_type='comic')
 *   - video → video_generations (is_active=1, status='completed')
 * - 音声: audio_generations (is_active=1, status='completed')
 * - Build SSOT: BuildRequest (version=1.0)
 * 
 * ## Remotion契約
 * Remotion は BuildRequest JSON のみを参照し、DB を直接読まない。
 */

// ====================================================================
// BuildRequest v1 Types (Remotion契約)
// ====================================================================

export interface BuildRequestV1 {
  version: '1.0';
  project: {
    id: number;
    title: string;
  };
  output: {
    resolution: {
      width: number;
      height: number;
    };
    fps: number;
    format: 'mp4';
  };
  timeline: {
    scenes: BuildSceneV1[];
  };
  // 将来拡張用
  bgm?: {
    audio_url: string;
    volume: number;
    ducking: boolean;
  };
}

export interface BuildSceneV1 {
  scene_id: number;
  order: number;
  duration_ms: number;
  
  visual: {
    type: 'image' | 'comic' | 'video';
    source: {
      image_url?: string;  // image/comic の場合
      video_url?: string;  // video の場合
    };
    effect?: {
      type: 'kenburns' | 'none';
      zoom?: number;
      pan?: 'center' | 'left' | 'right';
    };
  };
  
  audio?: {
    voice?: {
      audio_url: string;
      speed: number;
    };
  };
  
  bubbles: BuildBubbleV1[];
  
  telop: {
    enabled: boolean;
    text?: string;
  };
}

export interface BuildBubbleV1 {
  id: string;
  text: string;
  type: 'speech' | 'thought' | 'telop' | 'caption' | 'whisper';
  position: {
    x: number;  // 0-1 正規化座標
    y: number;  // 0-1 正規化座標
  };
  timing: {
    start_ms: number;
    end_ms: number;
  };
}

// ====================================================================
// Legacy Types (後方互換性のため維持)
// ====================================================================

import type { ProjectJson, ProjectJsonScene, VideoBuildSettings } from './aws-video-build-client';

export interface AssetValidationResult {
  ready_count: number;
  total_count: number;
  is_ready: boolean;
  missing: Array<{
    scene_idx: number;
    scene_id: number;
    reason: string;
    required_asset: string;
  }>;
  warnings: Array<{
    scene_idx: number;
    scene_id: number;
    message: string;
  }>;
}

export interface SceneData {
  id: number;
  idx: number;
  role: string;
  title: string;
  dialogue: string;
  display_asset_type: 'image' | 'comic' | 'video';
  // R3: 無音シーンの手動尺設定（ミリ秒）
  duration_override_ms?: number | null;
  active_image?: {
    r2_key: string;
    r2_url: string;
  } | null;
  active_comic?: {
    id: number;
    r2_key: string;
    r2_url: string;
  } | null;
  active_video?: {
    id: number;
    status: string;
    r2_url: string;
    model: string;
    duration_sec: number;
  } | null;
  active_audio?: {
    id: number;
    audio_url: string;
    duration_ms: number;
  } | null;
  comic_data?: {
    utterances?: Array<{
      id: string;
      text: string;
      audio_url?: string;
      duration_ms?: number;
      type?: string;
      position?: { x: number; y: number };
    }>;
    base_image_generation_id?: number;
  } | null;
  // R1.5: scene_utterances から読み込んだ音声パーツリスト
  utterances?: Array<{
    id: number;
    order_no: number;
    role: 'narration' | 'dialogue';
    character_key: string | null;
    character_name?: string | null;
    text: string;
    audio_generation_id: number | null;
    duration_ms: number | null;
    audio_url?: string | null;
  }> | null;
  // R2: text_render_mode（Remotion描画モード）
  text_render_mode?: 'remotion' | 'baked' | 'none';
  // R2-A: scene_balloons から読み込んだ吹き出しリスト
  balloons?: Array<{
    id: number;
    utterance_id: number | null;
    position: { x: number; y: number };
    size: { w: number; h: number };
    shape: 'round' | 'square' | 'thought' | 'shout' | 'caption';
    display_mode: 'voice_window' | 'manual_window';
    timing?: { start_ms: number | null; end_ms: number | null } | null;
    tail: { enabled: boolean; tip_x: number; tip_y: number };
    style: {
      writing_mode: string;
      text_align: string;
      font_family: string;
      font_weight: number;
      font_size: number;
      line_height: number;
      padding: number;
      bg_color: string;
      text_color: string;
      border_color: string;
      border_width: number;
    };
    z_index: number;
    // A案 baked: 文字入りバブル画像
    bubble_r2_key?: string | null;
    bubble_r2_url?: string | null;
    bubble_width_px?: number | null;
    bubble_height_px?: number | null;
  }> | null;
  // R2-C: モーションプリセット（scene_motion から読み込み）
  motion?: {
    preset_id: string;
    motion_type: 'none' | 'zoom' | 'pan' | 'combined';
    params: Record<string, number>;
  } | null;
}

export interface ProjectData {
  id: number;
  title: string;
  user_id: number;
}

// ====================================================================
// Constants
// ====================================================================

const DEFAULT_SCENE_DURATION_MS = 5000;  // 無音シーンのデフォルト尺（R3: 5秒に統一）
const AUDIO_PADDING_MS = 500;            // 音声尺への追加padding
const TEXT_DURATION_MS_PER_CHAR = 300;   // 日本語テキストの推定: 300ms/文字
const MIN_DURATION_MS = 2000;            // 最小尺
const MAX_DURATION_MS = 600000;          // 最大尺（10分）

// 解像度マッピング
const RESOLUTION_MAP = {
  '1080p': { '9:16': { width: 1080, height: 1920 }, '16:9': { width: 1920, height: 1080 }, '1:1': { width: 1080, height: 1080 } },
  '720p': { '9:16': { width: 720, height: 1280 }, '16:9': { width: 1280, height: 720 }, '1:1': { width: 720, height: 720 } },
} as const;

// ====================================================================
// selectSceneVisual - display_asset_type → visual 変換 (SSOT)
// ====================================================================

export interface SceneVisual {
  type: 'image' | 'comic' | 'video';
  source: {
    image_url?: string;
    video_url?: string;
  };
  effect: {
    type: 'kenburns' | 'none';
    zoom: number;
    pan: 'center';
  };
}

/**
 * display_asset_type に基づいて visual を選択
 * SSOT: この関数が素材選択の唯一の判定ロジック
 * 
 * @throws Error 必須素材が存在しない場合
 */
export function selectSceneVisual(
  scene: SceneData,
  enableKenBurns: boolean = true
): SceneVisual {
  const displayType = scene.display_asset_type || 'image';
  
  switch (displayType) {
    case 'comic':
      if (!scene.active_comic?.r2_url) {
        throw new Error(`Scene ${scene.id}: 漫画画像がありません (display_asset_type=comic)`);
      }
      return {
        type: 'comic',
        source: { image_url: scene.active_comic.r2_url },
        effect: { type: 'none', zoom: 1.0, pan: 'center' },  // comic は Ken Burns 無効
      };
      
    case 'video':
      if (!scene.active_video?.r2_url || scene.active_video?.status !== 'completed') {
        throw new Error(`Scene ${scene.id}: 完了済み動画がありません (display_asset_type=video)`);
      }
      return {
        type: 'video',
        source: { video_url: scene.active_video.r2_url },
        effect: { type: 'none', zoom: 1.0, pan: 'center' },  // video は Ken Burns 無効
      };
      
    default: // 'image'
      if (!scene.active_image?.r2_url) {
        throw new Error(`Scene ${scene.id}: 画像がありません (display_asset_type=image)`);
      }
      return {
        type: 'image',
        source: { image_url: scene.active_image.r2_url },
        effect: {
          type: enableKenBurns ? 'kenburns' : 'none',
          zoom: enableKenBurns ? 1.05 : 1.0,
          pan: 'center',
        },
      };
  }
}

// ====================================================================
// computeSceneDurationMs - 尺計算 (SSOT)
// ====================================================================

/**
 * 尺の決定理由
 */
export type DurationReason = 'voice' | 'video' | 'manual' | 'estimate' | 'default';

/**
 * 尺計算結果
 */
export interface DurationResult {
  duration_ms: number;
  reason: DurationReason;
}

/**
 * シーンの尺を計算
 * SSOT: この関数が尺計算の唯一のロジック
 * 
 * ================================
 * 優先順位（R3 確定版）
 * ================================
 * 1. video モード → video.duration_sec × 1000
 * 2. scene_utterances の音声合計（R1.5+）
 * 3. duration_override_ms（無音尺の手動設定）
 * 4. comic_data.utterances の合計（後方互換）
 * 5. active_audio.duration_ms（旧式音声）
 * 6. dialogue から推定（300ms/文字）
 * 7. デフォルト（5000ms）
 * 
 * 「セリフなし」でも必ず尺が返る＝生成可能
 */
export function computeSceneDurationMs(scene: SceneData): number {
  return computeSceneDurationMsWithReason(scene).duration_ms;
}

/**
 * 尺計算（理由付き）- UIで「なぜこの尺か」を表示するため
 */
export function computeSceneDurationMsWithReason(scene: SceneData): DurationResult {
  const displayType = scene.display_asset_type || 'image';
  
  // 1. video モード: 動画の尺を使用
  if (displayType === 'video' && scene.active_video?.duration_sec) {
    return {
      duration_ms: scene.active_video.duration_sec * 1000,
      reason: 'video',
    };
  }
  
  // 2. scene_utterances（R1.5+）の音声合計
  //    utterances があり、かつ duration_ms が設定されているものを合計
  const utterances = scene.utterances || [];
  const totalUtteranceDuration = utterances.reduce((sum, u) => {
    // duration_ms があるもの（音声生成済み）のみ加算
    return sum + (u.duration_ms || 0);
  }, 0);
  if (totalUtteranceDuration > 0) {
    return {
      duration_ms: totalUtteranceDuration + AUDIO_PADDING_MS,
      reason: 'voice',
    };
  }
  
  // 3. duration_override_ms（無音尺の手動設定）
  if (scene.duration_override_ms != null && scene.duration_override_ms > 0) {
    const clampedDuration = Math.min(Math.max(scene.duration_override_ms, MIN_DURATION_MS), MAX_DURATION_MS);
    return {
      duration_ms: clampedDuration,
      reason: 'manual',
    };
  }
  
  // 4. comic モード: comic_data.utterances の合計尺（後方互換）
  if (displayType === 'comic') {
    const comicUtterances = scene.comic_data?.utterances || [];
    const totalComicDuration = comicUtterances.reduce((sum, u) => sum + (u.duration_ms || 0), 0);
    if (totalComicDuration > 0) {
      return {
        duration_ms: totalComicDuration + AUDIO_PADDING_MS,
        reason: 'voice',
      };
    }
    // comic_data.utterances の duration_ms がない場合はテキストから推定
    const totalText = comicUtterances.map(u => u.text || '').join('');
    if (totalText.length > 0) {
      return {
        duration_ms: Math.max(MIN_DURATION_MS, totalText.length * TEXT_DURATION_MS_PER_CHAR) + AUDIO_PADDING_MS,
        reason: 'estimate',
      };
    }
  }
  
  // 5. active_audio（旧式音声）
  if (scene.active_audio?.duration_ms) {
    return {
      duration_ms: scene.active_audio.duration_ms + AUDIO_PADDING_MS,
      reason: 'voice',
    };
  }
  
  // 6. dialogue から推定
  if (scene.dialogue && scene.dialogue.length > 0) {
    return {
      duration_ms: Math.max(MIN_DURATION_MS, scene.dialogue.length * TEXT_DURATION_MS_PER_CHAR) + AUDIO_PADDING_MS,
      reason: 'estimate',
    };
  }
  
  // 7. デフォルト（無音シーン）
  return {
    duration_ms: DEFAULT_SCENE_DURATION_MS,
    reason: 'default',
  };
}

// ====================================================================
// buildSceneBubbles - 吹き出しデータ生成 (v1: 空配列)
// ====================================================================

/**
 * シーンの吹き出しデータを生成
 * v1: comic モードの utterances を bubbles に変換（タイミングは推定）
 * 
 * 将来: Comic Editor のデータをそのまま流用
 */
export function buildSceneBubbles(scene: SceneData): BuildBubbleV1[] {
  // v1: comic モードのみ bubbles を生成
  if (scene.display_asset_type !== 'comic') {
    return [];
  }
  
  const utterances = scene.comic_data?.utterances || [];
  if (utterances.length === 0) {
    return [];
  }
  
  // utterances を bubbles に変換
  // タイミングは累積で計算
  let currentMs = 0;
  
  return utterances.map((u) => {
    const durationMs = u.duration_ms || Math.max(MIN_DURATION_MS, (u.text?.length || 0) * TEXT_DURATION_MS_PER_CHAR);
    const startMs = currentMs;
    const endMs = currentMs + durationMs;
    currentMs = endMs;
    
    return {
      id: u.id,
      text: u.text || '',
      type: (u.type as BuildBubbleV1['type']) || 'speech',
      position: {
        x: u.position?.x ?? 0.5,  // デフォルト中央
        y: u.position?.y ?? 0.5,
      },
      timing: {
        start_ms: startMs,
        end_ms: endMs,
      },
    };
  });
}

// ====================================================================
// buildBuildRequestV1 - BuildRequest v1 生成 (唯一の出口)
// ====================================================================

export interface BuildRequestV1Options {
  aspectRatio?: '9:16' | '16:9' | '1:1';
  resolution?: '720p' | '1080p';
  fps?: number;
  enableKenBurns?: boolean;
  enableTelop?: boolean;
}

/**
 * BuildRequest v1 を生成
 * SSOT: この関数が BuildRequest 生成の唯一の出口
 * Remotion は この JSON のみを参照
 * 
 * @param project プロジェクト基本情報
 * @param scenes シーンデータ配列（fetchBuildInputs で取得）
 * @param options オプション設定
 * @returns BuildRequest v1 JSON
 */
export function buildBuildRequestV1(
  project: ProjectData,
  scenes: SceneData[],
  options?: BuildRequestV1Options
): BuildRequestV1 {
  const aspectRatio = options?.aspectRatio || '9:16';
  const resolution = options?.resolution || '1080p';
  const fps = options?.fps || 30;
  const enableKenBurns = options?.enableKenBurns ?? true;
  const enableTelop = options?.enableTelop ?? false;
  
  const resolutionSize = RESOLUTION_MAP[resolution][aspectRatio];
  
  const buildScenes: BuildSceneV1[] = scenes.map((scene, index) => {
    // visual 選択 (SSOT)
    const visual = selectSceneVisual(scene, enableKenBurns);
    
    // duration 計算 (SSOT)
    const durationMs = computeSceneDurationMs(scene);
    
    // audio
    const audio = scene.active_audio?.audio_url
      ? { voice: { audio_url: scene.active_audio.audio_url, speed: 1.0 } }
      : undefined;
    
    // bubbles (v1: comic モードのみ)
    const bubbles = buildSceneBubbles(scene);
    
    // telop (v1: disabled)
    const telop = {
      enabled: enableTelop,
      text: enableTelop ? scene.dialogue : undefined,
    };
    
    return {
      scene_id: scene.id,
      order: index + 1,
      duration_ms: durationMs,
      visual,
      audio,
      bubbles,
      telop,
    };
  });
  
  return {
    version: '1.0',
    project: {
      id: project.id,
      title: project.title,
    },
    output: {
      resolution: resolutionSize,
      fps,
      format: 'mp4',
    },
    timeline: {
      scenes: buildScenes,
    },
  };
}

// ====================================================================
// validateProjectAssets - Preflight 検証 (selectSceneVisual と同じ SSOT)
// ====================================================================

/**
 * プロジェクトの素材を検証（Preflight）
 * SSOT: selectSceneVisual と同じ判定ロジックを使用
 * 
 * 注意: preflight が OK なら buildBuildRequestV1 は必ず成功する
 */
export function validateProjectAssets(scenes: SceneData[]): AssetValidationResult {
  const missing: AssetValidationResult['missing'] = [];
  const warnings: AssetValidationResult['warnings'] = [];
  let readyCount = 0;

  for (const scene of scenes) {
    // selectSceneVisual と同じロジックで判定
    try {
      selectSceneVisual(scene, true);
      readyCount++;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const displayType = scene.display_asset_type || 'image';
      
      missing.push({
        scene_idx: scene.idx,
        scene_id: scene.id,
        reason: message,
        required_asset: displayType === 'comic' ? 'active_comic.r2_url'
          : displayType === 'video' ? 'active_video.r2_url'
          : 'active_image.r2_url',
      });
    }

    // ========================================
    // A案 baked チェック（事故ゼロ化）
    // ========================================
    const displayType = scene.display_asset_type || 'image';
    const textRenderMode = scene.text_render_mode || 
      (displayType === 'comic' ? 'baked' : 'remotion');
    
    // Check 1: comic で remotion モード → 二重表示の警告
    if (displayType === 'comic' && textRenderMode === 'remotion') {
      warnings.push({
        scene_idx: scene.idx,
        scene_id: scene.id,
        message: '⚠️ 漫画シーンで text_render_mode=remotion が設定されています。文字が二重に表示される可能性があります。',
      });
    }
    
    // Check 2: baked モードなのに bubble_r2_url がないバルーンがある
    if (textRenderMode === 'baked' && scene.balloons && scene.balloons.length > 0) {
      const balloonsWithoutImage = scene.balloons.filter(b => !b.bubble_r2_url);
      if (balloonsWithoutImage.length > 0) {
        warnings.push({
          scene_idx: scene.idx,
          scene_id: scene.id,
          message: `⚠️ bakedモードですが、バブル画像が未設定です（${balloonsWithoutImage.length}/${scene.balloons.length}件）。これらのバルーンは表示されません。`,
        });
      }
    }

    // 音声チェック（警告レベル）
    if (displayType === 'comic') {
      const utterances = scene.comic_data?.utterances || [];
      const missingAudioCount = utterances.filter(u => !u.audio_url).length;
      if (missingAudioCount > 0) {
        warnings.push({
          scene_idx: scene.idx,
          scene_id: scene.id,
          message: `音声パーツが未生成です（${missingAudioCount}/${utterances.length}件）※ボイスなしでも動画生成可`,
        });
      }
    } else {
      if (!scene.active_audio?.audio_url) {
        warnings.push({
          scene_idx: scene.idx,
          scene_id: scene.id,
          message: '音声が生成されていません',
        });
      }
    }
  }

  return {
    ready_count: readyCount,
    total_count: scenes.length,
    is_ready: missing.length === 0 && scenes.length > 0,
    missing,
    warnings,
  };
}

// ====================================================================
// validateProjectJson - project.json 生成後の最終検証（src完全性）
// ====================================================================

/**
 * ProjectJsonValidationResult - project.json検証結果
 */
export interface ProjectJsonValidationResult {
  is_valid: boolean;
  critical_errors: Array<{
    scene_idx: number;
    field: string;
    reason: string;
  }>;
  warnings: Array<{
    scene_idx: number;
    field: string;
    message: string;
  }>;
}

/**
 * validateProjectJson - buildProjectJson後の最終検証
 * 
 * SSOT原則: この関数が「レンダーに飛ばして良いか」の最終ゲート
 * 
 * ================================
 * 必須エラー（critical_errors）→ レンダー不可
 * ================================
 * - 画像src が空（image/comic モードで assets.image.url が undefined/空文字）
 * - 動画src が空（video モードで assets.video.url が undefined/空文字）
 * - voices[].audio_url が空文字（存在するなら非空必須）
 * 
 * ================================
 * 警告（warnings）→ レンダー可だが注意
 * ================================
 * - voices が空（音声なし、無音になる）
 * - balloons が設定されているが baked画像がない
 * 
 * @param projectJson buildProjectJson() の返り値
 * @returns 検証結果
 */
export function validateProjectJson(projectJson: RemotionProjectJson_R1): ProjectJsonValidationResult {
  const critical_errors: ProjectJsonValidationResult['critical_errors'] = [];
  const warnings: ProjectJsonValidationResult['warnings'] = [];
  
  for (const scene of projectJson.scenes) {
    // ========================================
    // 必須チェック 1: 画像ソース
    // ========================================
    const imageUrl = scene.assets?.image?.url;
    if (!imageUrl || imageUrl.trim() === '') {
      critical_errors.push({
        scene_idx: scene.idx,
        field: 'assets.image.url',
        reason: `画像URLが未設定です。シーン${scene.idx}の画像を生成してください。`,
      });
    } else if (!imageUrl.startsWith('http://') && !imageUrl.startsWith('https://')) {
      // 相対URLは Remotion Lambda で解決できない
      critical_errors.push({
        scene_idx: scene.idx,
        field: 'assets.image.url',
        reason: `画像URLが相対パスです（${imageUrl.substring(0, 50)}...）。絶対URLが必要です。`,
      });
    }
    
    // ========================================
    // 必須チェック 2: 音声ソース（voicesがあるなら全て非空必須）
    // ========================================
    const voices = scene.assets?.voices || [];
    for (let i = 0; i < voices.length; i++) {
      const voice = voices[i];
      if (voice.audio_url === '' || voice.audio_url === null || voice.audio_url === undefined) {
        // 空文字の audio_url は Remotion で "No src passed" を引き起こす
        critical_errors.push({
          scene_idx: scene.idx,
          field: `assets.voices[${i}].audio_url`,
          reason: `音声URL が空です（voice_id: ${voice.id}）。音声を生成するか、このvoiceを削除してください。`,
        });
      } else if (!voice.audio_url.startsWith('http://') && !voice.audio_url.startsWith('https://')) {
        critical_errors.push({
          scene_idx: scene.idx,
          field: `assets.voices[${i}].audio_url`,
          reason: `音声URLが相対パスです。絶対URLが必要です。`,
        });
      }
    }
    
    // ========================================
    // 警告チェック 1: 音声なし（無音シーン）
    // ========================================
    if (voices.length === 0 && !scene.assets?.audio?.url) {
      warnings.push({
        scene_idx: scene.idx,
        field: 'assets.voices',
        message: '音声がありません。このシーンは無音で再生されます。',
      });
    }
    
    // ========================================
    // 警告チェック 2: balloons の baked 画像
    // ========================================
    if (scene.text_render_mode === 'baked' && scene.balloons && scene.balloons.length > 0) {
      const balloonsWithoutImage = scene.balloons.filter((b: any) => !b.bubble_image_url);
      if (balloonsWithoutImage.length > 0) {
        warnings.push({
          scene_idx: scene.idx,
          field: 'balloons[].bubble_image_url',
          message: `bakedモードで ${balloonsWithoutImage.length}件のバルーン画像が未設定です。これらは表示されません。`,
        });
      }
    }
  }
  
  return {
    is_valid: critical_errors.length === 0,
    critical_errors,
    warnings,
  };
}

// ====================================================================
// Phase R1.6: Utterances Preflight 検証
// ====================================================================

/**
 * UtteranceError - 音声パーツ単位のエラー詳細
 */
export interface UtteranceError {
  scene_id: number;
  scene_idx: number;
  utterance_id?: number;
  type: 'NO_UTTERANCES' | 'TEXT_EMPTY' | 'AUDIO_MISSING';
  message: string;
}

/**
 * UtterancePreflightResult - utterances 検証結果
 */
export interface UtterancePreflightResult {
  can_generate: boolean;
  errors: UtteranceError[];
  summary: {
    total_scenes: number;
    invalid_scenes: number;
    invalid_utterances: number;
  };
}

/**
 * validateUtterancesPreflight - R1.6+ 2レイヤー検証
 * 
 * ================================
 * 新しい設計（2レイヤー）
 * ================================
 * 
 * レイヤー1: 必須条件（can_generate を決定）
 *   - 素材（画像/漫画/動画）がある → validateProjectAssets で判定済み
 *   - シーンの尺（duration）が決まる
 *     - 音声があれば → 音声長
 *     - なければ → 無音尺（scene.duration_override_ms または DEFAULT_SCENE_DURATION_MS）
 *   → セリフなし・風景・戦闘シーンでもOK
 * 
 * レイヤー2: 推奨条件（warnings に出力）
 *   - セリフがあるのに音声パーツ（utterances）がない → 警告
 *   - 音声パーツがあるのに音声が未生成 → 警告
 *   - baked モードなのにバブル画像がない → 警告
 *   → 生成は止めない（事故警告のみ）
 * 
 * ================================
 * 
 * @returns UtterancePreflightResult
 */
export function validateUtterancesPreflight(
  scenes: Array<{
    id: number;
    idx: number;
    dialogue?: string;  // セリフ（旧フィールド）
    active_audio?: { id: number; audio_url: string; duration_ms: number } | null;
    duration_override_ms?: number | null;  // 無音尺の手動設定
    utterances?: Array<{
      id: number;
      text: string;
      audio_generation_id: number | null;
      audio_status?: string;  // 'completed' | 'pending' | 'generating' | 'failed'
    }> | null;
  }>
): UtterancePreflightResult {
  const errors: UtteranceError[] = [];  // レイヤー1: 本当にNGな場合のみ
  const warnings: UtteranceError[] = []; // レイヤー2: 推奨条件の警告
  const invalidSceneIds = new Set<number>();
  let invalidUtteranceCount = 0;

  for (const scene of scenes) {
    const utterances = scene.utterances || [];
    const dialogue = scene.dialogue?.trim() || '';
    const hasDialogue = dialogue.length > 0;
    const hasActiveAudio = scene.active_audio != null;
    const hasDurationOverride = scene.duration_override_ms != null && scene.duration_override_ms > 0;

    // ================================
    // レイヤー1: 必須条件 - シーンの尺が決まるか
    // ================================
    // 音声がある OR 無音尺が設定されている OR デフォルト無音尺を使う
    // → 基本的には常に成立（デフォルト尺があるため）
    // 将来：無音尺を必須にしたい場合はここでチェック
    
    // 現状はデフォルト尺（DEFAULT_SCENE_DURATION_MS）を自動適用するので、
    // レイヤー1のエラーは素材チェック以外では出さない

    // ================================
    // レイヤー2: 推奨条件 - 警告のみ
    // ================================
    
    // A. セリフがあるのに utterances がない → 警告
    if (hasDialogue && utterances.length === 0) {
      // セリフがあるなら音声パーツを登録すべき
      warnings.push({
        scene_id: scene.id,
        scene_idx: scene.idx,
        type: 'NO_UTTERANCES',
        message: `シーン${scene.idx}：セリフがありますが音声パーツが未登録です（ボイスなしでも生成可）`,
      });
      // 生成は止めない（無音尺で進む）
    }
    
    // B. utterances がない かつ セリフもない → 無音シーン（正常）
    if (!hasDialogue && utterances.length === 0) {
      // 無音シーンとして正常扱い
      // 何も出さない（can_generate に影響しない）
      continue;
    }

    // C. utterances があるが、音声が未生成のものがある → 警告
    for (const utterance of utterances) {
      // テキストが空 → 警告（削除忘れ？）
      if (!utterance.text || utterance.text.trim().length === 0) {
        warnings.push({
          scene_id: scene.id,
          scene_idx: scene.idx,
          utterance_id: utterance.id,
          type: 'TEXT_EMPTY',
          message: `シーン${scene.idx}：空の音声パーツがあります（削除推奨、無視して生成可）`,
        });
        continue;
      }

      // 音声が未生成 → 警告
      const hasCompletedAudio = utterance.audio_generation_id != null && utterance.audio_status === 'completed';
      if (!hasCompletedAudio) {
        const textPreview = utterance.text.length > 20 
          ? utterance.text.substring(0, 20) + '…' 
          : utterance.text;
        
        warnings.push({
          scene_id: scene.id,
          scene_idx: scene.idx,
          utterance_id: utterance.id,
          type: 'AUDIO_MISSING',
          message: `シーン${scene.idx}：「${textPreview}」の音声が未生成です（無音で生成されます）`,
        });
        invalidUtteranceCount++;
      }
    }
  }

  // ================================
  // 判定: can_generate の決定
  // ================================
  // レイヤー1のエラー（errors）が0件なら生成OK
  // レイヤー2の警告（warnings）は生成を止めない
  const canGenerate = errors.length === 0 && scenes.length > 0;

  return {
    can_generate: canGenerate,
    errors: [...errors, ...warnings],  // 後方互換: 全部 errors に入れる（UI側で type で分類）
    summary: {
      total_scenes: scenes.length,
      invalid_scenes: invalidSceneIds.size,
      invalid_utterances: invalidUtteranceCount,
    },
  };
}

// ====================================================================
// Phase R1: Remotionスキーマ準拠 ProjectJson 生成
// ====================================================================

/**
 * VoiceAsset - R1.5 の核心
 * ナレーション/キャラ別音声の両方に対応
 */
export interface VoiceAsset {
  id: string;
  utterance_id?: number;  // R2: scene_utterances.id への参照
  role: 'narration' | 'dialogue';
  character_key?: string | null;
  character_name?: string | null;
  audio_url: string;
  duration_ms: number;
  text: string;
  start_ms?: number;
  end_ms?: number;  // R2: start_ms + duration_ms
  format?: 'mp3' | 'wav';
}

/**
 * BalloonAsset - R2-A 吹き出し
 * utterance と連動して表示/非表示
 * 
 * A案 baked 対応:
 *   - bubble_image_url が存在する場合: 画像をそのまま表示（文字描画なし）
 *   - bubble_image_url がない場合: text + style を使って Remotion で描画
 */
export interface BalloonAsset {
  id: string;
  utterance_id: number;  // 必須: scene_utterances.id への参照
  text: string;          // utterance.text と同じ
  // タイミング（SSOT: utterance の区間）
  start_ms: number;
  end_ms: number;
  // 位置・サイズ（0-1 正規化座標）
  position: { x: number; y: number };
  size: { w: number; h: number };
  // 形状
  shape: 'round' | 'square' | 'thought' | 'shout' | 'caption';
  // しっぽ
  tail: {
    enabled: boolean;
    tip_x: number;
    tip_y: number;
  };
  // スタイル（text_render_mode='remotion' の場合に使用）
  style: {
    writing_mode: 'horizontal' | 'vertical';
    text_align: 'left' | 'center' | 'right';
    font_family: string;
    font_weight: number;
    font_size: number;
    line_height: number;
    padding: number;
    bg_color: string;
    text_color: string;
    border_color: string;
    border_width: number;
  };
  z_index: number;
  
  // ========================================
  // A案 baked 専用フィールド
  // ========================================
  /** 文字入りバブル画像URL（baked モード時に使用） */
  bubble_image_url?: string;
  /** バブル画像の実サイズ（ピクセル） */
  bubble_image_size?: {
    width: number;
    height: number;
  };
}

/**
 * R3-B: SfxAsset - 効果音アセット
 * シーン内の特定タイミングで再生される効果音
 */
export interface SfxAsset {
  id: string;           // sfx-{cue_id}
  name: string;         // 効果音名（例: 剣の音）
  url: string;          // 音声ファイルURL
  start_ms: number;     // シーン内の開始時間
  end_ms?: number;      // 終了時間（省略時はduration_msで計算）
  duration_ms?: number; // 音声ファイルの長さ
  volume: number;       // 0.0〜1.0
  loop: boolean;        // ループ再生
  fade_in_ms: number;
  fade_out_ms: number;
}

/**
 * RemotionScene_R1 - Phase R1/R2 用シーン型
 * Remotion の ProjectSceneSchema に完全準拠
 */
export interface RemotionScene_R1 {
  idx: number;
  role: string;
  title: string;
  dialogue: string;
  timing: {
    start_ms: number;       // ★ 必須: 累積計算
    duration_ms: number;    // ★ 必須: SSOT
    head_pad_ms: number;
    tail_pad_ms: number;
  };
  /** R2: 文字描画モード（remotion=Remotion描画, baked=焼込済, none=なし） */
  text_render_mode?: 'remotion' | 'baked' | 'none';
  assets: {
    image?: {
      url: string;
      width: number;
      height: number;
    };
    /** @deprecated R1.5では voices を使用 */
    audio?: {
      url: string;
      duration_ms: number;
      format: 'mp3' | 'wav';
    };
    /** R1.5: 複数話者音声配列 */
    voices?: VoiceAsset[];
    video_clip?: {
      url: string;
      duration_ms: number;
    };
  };
  /** R2-A: 吹き出し（utterance と同期） */
  balloons?: BalloonAsset[];
  /** R3-B: SFX（効果音） */
  sfx?: SfxAsset[];
  /** R2-C: モーションプリセット */
  motion?: {
    id: string;
    motion_type: 'none' | 'zoom' | 'pan' | 'combined';
    params: {
      start_scale?: number;
      end_scale?: number;
      start_x?: number;
      end_x?: number;
      start_y?: number;
      end_y?: number;
    };
  };
  characters?: {
    image?: string[];
    voice?: string;
  };
}

/**
 * RemotionProjectJson_R1 - Phase R1/R1.5 用プロジェクトJSON型
 * Remotion の ProjectJsonSchema に完全準拠
 */
export interface RemotionProjectJson_R1 {
  schema_version: '1.1' | '1.5';
  project_id: number;
  project_title: string;
  created_at: string;
  build_settings: {
    preset: string;
    /** R1.5: アスペクト比選択 */
    aspect_ratio?: '9:16' | '16:9' | '1:1';
    resolution: {
      width: number;
      height: number;
    };
    fps: number;
    codec: 'h264' | 'h265';
    audio?: {
      bgm_enabled: boolean;
      bgm_volume: number;
      narration_volume: number;
      duck_bgm_on_voice: boolean;
    };
    transition?: {
      type: 'none' | 'fade' | 'slide' | 'wipe';
      duration_ms: number;
    };
  };
  global: {
    default_scene_duration_ms: number;
    transition_duration_ms: number;
  };
  assets?: {
    bgm?: {
      url: string;
      duration_ms?: number;
      volume: number;
    };
  };
  scenes: RemotionScene_R1[];
  summary: {
    total_scenes: number;
    total_duration_ms: number;
    has_audio: boolean;
    has_video_clips: boolean;
    /** R1.5: 音声付きシーン数 */
    scenes_with_voices?: number;
  };
}

/**
 * buildProjectJson - Remotionスキーマ完全準拠版
 * 
 * Phase R1.5: 複数話者音声 + 画角選択対応
 * 
 * ## SSOT ルール
 * - duration_ms: voices[] があれば Σ(voices[].duration_ms) + padding
 * - start_ms: 累積計算（0, n, n+m, ...）
 * - 字幕: voices[].text から表示
 * 
 * ## R1.5 対応
 * - ✅ voices[] (複数話者音声)
 * - ✅ aspect_ratio (画角選択)
 * - ✅ BGM (入れる/入れない)
 * - ❌ ducking (R2)
 * - ❌ subtitles[] 分割 (R2)
 * 
 * @param project プロジェクト基本情報
 * @param scenes シーンデータ配列（idx昇順）
 * @param settings ビルド設定
 * @param options オプション
 * @returns Remotionスキーマ準拠のProjectJson
 */
const DEFAULT_SITE_URL = 'https://webapp-c7n.pages.dev';

/**
 * Convert relative R2 URL to absolute URL
 * CRITICAL: Remotion Lambda cannot resolve relative URLs
 */
function toAbsoluteUrl(relativeUrl: string | null | undefined, siteUrl: string | undefined): string | null {
  if (!relativeUrl) return null;
  if (relativeUrl.startsWith('http://') || relativeUrl.startsWith('https://')) {
    return relativeUrl;
  }
  const baseUrl = (siteUrl || DEFAULT_SITE_URL).replace(/\/$/, '');
  const path = relativeUrl.startsWith('/') ? relativeUrl : `/${relativeUrl}`;
  return `${baseUrl}${path}`;
}

export function buildProjectJson(
  project: ProjectData,
  scenes: SceneData[],
  settings: VideoBuildSettings,
  options?: {
    aspectRatio?: '9:16' | '16:9' | '1:1';
    resolution?: '720p' | '1080p';
    fps?: number;
    schemaVersion?: '1.1' | '1.5';
    siteUrl?: string;  // For absolute URL conversion
  }
): RemotionProjectJson_R1 {
  const now = new Date().toISOString();
  const aspectRatio = options?.aspectRatio || '9:16';
  const resolution = options?.resolution || '1080p';
  const fps = options?.fps || 30;
  const schemaVersion = options?.schemaVersion || '1.5';
  const siteUrl = options?.siteUrl || DEFAULT_SITE_URL;
  
  const resolutionSize = RESOLUTION_MAP[resolution][aspectRatio];
  
  // ========================================
  // R1.5 核心: voices[] + start_ms 累積計算
  // ========================================
  let currentMs = 0;
  let hasAudio = false;
  let hasVideoClips = false;
  let scenesWithVoices = 0;
  
  const remotionScenes: RemotionScene_R1[] = scenes.map((scene) => {
    // 1. voices[] 構築 - R1.5の核心
    const voices: VoiceAsset[] = [];
    
    // R1.5/R2: scene_utterances があればそこから voices を構築（SSOT優先）
    // R2: utterance_id と end_ms を追加（balloon 同期用）
    if (scene.utterances && scene.utterances.length > 0) {
      let voiceStartMs = 0;
      for (const utt of scene.utterances) {
        // 音声URLがあるutteranceのみ voices に追加
        if (utt.audio_url && utt.duration_ms) {
          hasAudio = true;
          
          voices.push({
            id: `voice-utt-${utt.id}`,
            utterance_id: utt.id,  // R2: balloon 連動用
            role: utt.role,
            character_key: utt.character_key || null,
            character_name: utt.character_name || null,
            audio_url: toAbsoluteUrl(utt.audio_url, siteUrl) || utt.audio_url,  // Absolute URL
            duration_ms: utt.duration_ms,
            text: utt.text || '',
            start_ms: voiceStartMs,
            end_ms: voiceStartMs + utt.duration_ms,  // R2
            format: 'mp3',
          });
          
          voiceStartMs += utt.duration_ms;
        } else {
          // R2-A: 音声なしの utterance は duration 計算に使うが、voices には追加しない
          // (Remotion Lambda は空の audio_url で "No src passed" エラーになるため)
          // balloon 同期は別途 utterances データから行う
          const durationMsValue = utt.duration_ms || Math.max(
            MIN_DURATION_MS,
            (utt.text?.length || 0) * TEXT_DURATION_MS_PER_CHAR
          );
          
          // 注意: voiceStartMs は進めるが voices には追加しない
          // これにより後続の音声付き utterance のタイミングが正しく計算される
          voiceStartMs += durationMsValue;
        }
      }
      
      if (voices.length > 0) {
        scenesWithVoices++;
      }
    }
    // R1.5 fallback: utterances がない場合、既存の active_audio を voice に変換（後方互換）
    else if (scene.active_audio?.audio_url) {
      hasAudio = true;
      scenesWithVoices++;
      
      voices.push({
        id: `voice-scene${scene.idx}-0`,
        role: 'narration',
        character_key: null,
        character_name: null,
        audio_url: scene.active_audio.audio_url,
        duration_ms: scene.active_audio.duration_ms,
        text: scene.dialogue || '',
        start_ms: 0,
        format: 'mp3',
      });
    }
    
    // 2. duration_ms 確定 (SSOT)
    // voices があれば Σ(voices[].duration_ms) + padding
    let durationMs: number;
    if (voices.length > 0) {
      const voicesDuration = voices.reduce((sum, v) => sum + v.duration_ms, 0);
      durationMs = voicesDuration + AUDIO_PADDING_MS;
    } else {
      durationMs = computeSceneDurationMs(scene);
    }
    
    // 3. start_ms 累積計算
    const startMs = currentMs;
    currentMs += durationMs;
    
    // 4. visual URL 取得 (Convert to absolute URL for Remotion Lambda)
    let imageUrl: string | undefined;
    const displayType = scene.display_asset_type || 'image';
    
    if (displayType === 'comic' && scene.active_comic?.r2_url) {
      imageUrl = toAbsoluteUrl(scene.active_comic.r2_url, siteUrl) || undefined;
    } else if (scene.active_image?.r2_url) {
      imageUrl = toAbsoluteUrl(scene.active_image.r2_url, siteUrl) || undefined;
    }
    
    // 5. legacy audio 構築（後方互換）- Convert URL to absolute
    let audioAsset: RemotionScene_R1['assets']['audio'] | undefined;
    if (scene.active_audio?.audio_url) {
      audioAsset = {
        url: toAbsoluteUrl(scene.active_audio.audio_url, siteUrl) || scene.active_audio.audio_url,
        duration_ms: scene.active_audio.duration_ms,
        format: 'mp3',
      };
    }
    
    // 6. R2-A/A案 baked: balloons 構築（utterance と同期）
    // ========================================
    // A案 baked の処理ルール:
    //   - text_render_mode='remotion': style を使って Remotion で文字描画
    //   - text_render_mode='baked': bubble_image_url を使って画像表示（文字描画なし）
    //   - text_render_mode='none': balloons 出力しない
    // ========================================
    const textRenderMode = scene.text_render_mode || 
      (scene.display_asset_type === 'comic' ? 'baked' : 'remotion');
    
    const balloons: BalloonAsset[] = [];
    
    // text_render_mode='none' の場合は balloons を出力しない
    if (scene.balloons && scene.balloons.length > 0 && textRenderMode !== 'none') {
      // voices から utterance_id -> timing のマップを作成
      const utteranceTimingMap = new Map<number, { start_ms: number; end_ms: number; text: string }>();
      for (const v of voices) {
        if (v.utterance_id) {
          utteranceTimingMap.set(v.utterance_id, {
            start_ms: v.start_ms || 0,
            end_ms: v.end_ms || (v.start_ms || 0) + v.duration_ms,
            text: v.text,
          });
        }
      }
      
      for (const b of scene.balloons) {
        // display_policy を優先（SSOT）、無ければ display_mode から互換判定
        const policy: 'always_on' | 'voice_window' | 'manual_window' =
          (b.display_policy as 'always_on' | 'voice_window' | 'manual_window') ??
          (b.display_mode === 'manual_window' ? 'manual_window' : 'voice_window');
        
        let balloonStartMs = 0;
        let balloonEndMs = 0;
        let balloonText = '';
        
        if (policy === 'always_on') {
          // ★ 常時表示: シーン全体（0 〜 sceneDurationMs）
          balloonStartMs = 0;
          balloonEndMs = durationMs;
          // テキストは utterance から取得（あれば）
          if (b.utterance_id) {
            const timing = utteranceTimingMap.get(b.utterance_id);
            if (timing) balloonText = timing.text;
          }
        } else if (policy === 'manual_window') {
          // ★ 手動指定: start_ms/end_ms を使用
          balloonStartMs = b.timing?.start_ms ?? 0;
          balloonEndMs = b.timing?.end_ms ?? durationMs;
          // テキストは utterance から取得（あれば）
          if (b.utterance_id) {
            const timing = utteranceTimingMap.get(b.utterance_id);
            if (timing) balloonText = timing.text;
          }
        } else {
          // voice_window: utterance のタイミングを使用
          if (b.utterance_id) {
            const timing = utteranceTimingMap.get(b.utterance_id);
            if (timing) {
              balloonStartMs = timing.start_ms;
              balloonEndMs = timing.end_ms;
              balloonText = timing.text;
            } else {
              // utterance が見つからない場合、always_on にフォールバック
              console.warn(`[buildProjectJson] Balloon ${b.id}: utterance ${b.utterance_id} not found, falling back to always_on`);
              balloonStartMs = 0;
              balloonEndMs = durationMs;
            }
          } else {
            // utterance_id がない voice_window は always_on にフォールバック
            console.warn(`[buildProjectJson] Balloon ${b.id}: voice_window without utterance_id, falling back to always_on`);
            balloonStartMs = 0;
            balloonEndMs = durationMs;
          }
        }
        
        // end <= start は無効なのでスキップ（事故防止）
        if (balloonEndMs <= balloonStartMs) {
          console.warn(`[buildProjectJson] Balloon ${b.id}: invalid timing (start=${balloonStartMs}, end=${balloonEndMs}), skipping`);
          continue;
        }
        
        // A案 baked: bubble_r2_url がある場合のみ balloons に追加
        // （baked モードでは画像がないと表示できない）
        if (textRenderMode === 'baked' && !b.bubble_r2_url) {
          console.warn(`[buildProjectJson] Balloon ${b.id} has no bubble_r2_url in baked mode, skipping`);
          continue;
        }
        
        balloons.push({
          id: `balloon-${b.id}`,
          utterance_id: b.utterance_id,
          text: balloonText,
          start_ms: balloonStartMs,
          end_ms: balloonEndMs,
          // ★ display_policy を明示（SSOT、Remotion/UI で参照可能）
          display_policy: policy,
          position: b.position,
          size: b.size,
          shape: b.shape,
          tail: b.tail,
          style: {
            writing_mode: b.style.writing_mode as 'horizontal' | 'vertical',
            text_align: b.style.text_align as 'left' | 'center' | 'right',
            font_family: b.style.font_family,
            font_weight: b.style.font_weight,
            font_size: b.style.font_size,
            line_height: b.style.line_height,
            padding: b.style.padding,
            bg_color: b.style.bg_color,
            text_color: b.style.text_color,
            border_color: b.style.border_color,
            border_width: b.style.border_width,
          },
          z_index: b.z_index,
          // A案 baked: バブル画像URL（baked モード時に使用）- Absolute URL
          bubble_image_url: b.bubble_r2_url ? (toAbsoluteUrl(b.bubble_r2_url, siteUrl) || undefined) : undefined,
          bubble_image_size: (b.bubble_width_px && b.bubble_height_px) ? {
            width: b.bubble_width_px,
            height: b.bubble_height_px,
          } : undefined,
        });
      }
    }
    
    // 7. RemotionScene_R1 構築
    return {
      idx: scene.idx,
      role: scene.role || 'main_point',
      title: scene.title || '',
      dialogue: scene.dialogue || '',
      timing: {
        start_ms: startMs,
        duration_ms: durationMs,
        head_pad_ms: 0,
        tail_pad_ms: 0,
      },
      // R2: text_render_mode
      // SSOT: comic の場合は baked をデフォルト（二重事故防止）
      text_render_mode: scene.text_render_mode || 
        (scene.display_asset_type === 'comic' ? 'baked' : 'remotion'),
      assets: {
        image: imageUrl ? {
          url: imageUrl,
          width: resolutionSize.width,
          height: resolutionSize.height,
        } : undefined,
        audio: audioAsset,  // 後方互換
        voices: voices.length > 0 ? voices : undefined,  // R1.5
      },
      // R2-A: balloons
      balloons: balloons.length > 0 ? balloons : undefined,
      // R3-B: sfx - Convert URL to absolute
      sfx: scene.sfx && scene.sfx.length > 0 ? scene.sfx.map((cue: any) => ({
        id: `sfx-${cue.id}`,
        name: cue.name || 'SFX',
        url: toAbsoluteUrl(cue.r2_url, siteUrl) || cue.r2_url,
        start_ms: cue.start_ms || 0,
        end_ms: cue.end_ms ?? undefined,
        duration_ms: cue.duration_ms ?? undefined,
        volume: cue.volume ?? 0.8,
        loop: cue.loop === 1 || cue.loop === true,
        fade_in_ms: cue.fade_in_ms || 0,
        fade_out_ms: cue.fade_out_ms || 0,
      })) : undefined,
      // R2-C: motion
      // comic は none（静止画）、image/video はプリセット or デフォルト
      motion: scene.motion ? {
        id: scene.motion.preset_id,
        motion_type: scene.motion.motion_type,
        params: scene.motion.params,
      } : (scene.display_asset_type === 'comic' 
        ? { id: 'none', motion_type: 'none', params: {} }
        : { id: 'kenburns_soft', motion_type: 'zoom', params: { start_scale: 1.0, end_scale: 1.05 } }
      ),
    };
  });
  
  // ========================================
  // RemotionProjectJson_R1 構築
  // ========================================
  return {
    schema_version: schemaVersion,
    project_id: project.id,
    project_title: project.title,
    created_at: now,
    build_settings: {
      preset: settings.motion?.preset || 'none',
      aspect_ratio: aspectRatio,  // R1.5
      resolution: resolutionSize,
      fps,
      codec: 'h264',
      audio: {
        bgm_enabled: settings.bgm?.enabled || false,
        bgm_volume: settings.bgm?.volume || 0.3,
        narration_volume: 1.0,
        duck_bgm_on_voice: true,
      },
      transition: {
        type: 'fade',
        duration_ms: 300,
      },
    },
    global: {
      default_scene_duration_ms: DEFAULT_SCENE_DURATION_MS,
      transition_duration_ms: 300,
    },
    // R3-A: BGM対応（通しBGM with ducking）
    assets: settings.bgm?.enabled && settings.bgm?.url ? {
      bgm: {
        url: settings.bgm.url,
        volume: settings.bgm.volume || 0.25,
        loop: settings.bgm.loop ?? true,
        fade_in_ms: settings.bgm.fade_in_ms ?? 800,
        fade_out_ms: settings.bgm.fade_out_ms ?? 800,
        // R3-B: ducking設定（音声再生時にBGM音量を下げる）
        ducking: settings.bgm.ducking?.enabled ? {
          enabled: true,
          volume: settings.bgm.ducking.volume ?? 0.12,
          attack_ms: settings.bgm.ducking.attack_ms ?? 120,
          release_ms: settings.bgm.ducking.release_ms ?? 220,
        } : undefined,
      },
    } : undefined,
    scenes: remotionScenes,
    summary: {
      total_scenes: scenes.length,
      total_duration_ms: currentMs,
      has_audio: hasAudio,
      has_video_clips: hasVideoClips,
      scenes_with_voices: scenesWithVoices,  // R1.5
    },
  };
}

// ====================================================================
// Legacy: buildProjectJsonLegacy (後方互換性のため維持)
// ====================================================================

/**
 * @deprecated Use buildProjectJson instead
 * 
 * 旧形式のProjectJsonを出力する関数。
 * Phase R1 以降は使用しない。
 */
export function buildProjectJsonLegacy(
  project: ProjectData,
  scenes: SceneData[],
  settings: VideoBuildSettings,
  options?: {
    aspectRatio?: '9:16' | '16:9' | '1:1';
    resolution?: '720p' | '1080p';
    fps?: number;
  }
): ProjectJson {
  const now = new Date().toISOString();
  const aspectRatio = options?.aspectRatio || '9:16';
  const resolution = options?.resolution || '1080p';
  const fps = options?.fps || 30;
  
  // buildBuildRequestV1 を内部で使用
  const buildRequest = buildBuildRequestV1(project, scenes, {
    aspectRatio,
    resolution,
    fps,
    enableKenBurns: settings.motion?.preset !== 'none',
    enableTelop: settings.captions?.enabled ?? true,
  });

  // 旧形式に変換
  const projectScenes: ProjectJsonScene[] = buildRequest.timeline.scenes.map((bs) => {
    const scene = scenes.find(s => s.id === bs.scene_id)!;
    const displayType = scene.display_asset_type || 'image';
    
    return {
      scene_id: bs.scene_id,
      idx: scene.idx,
      role: scene.role,
      title: scene.title,
      dialogue: scene.dialogue,
      asset: {
        type: bs.visual.type,
        src: bs.visual.source.image_url || bs.visual.source.video_url || '',
      },
      audio: bs.audio?.voice ? {
        src: bs.audio.voice.audio_url,
        duration_ms: scene.active_audio?.duration_ms || computeSceneDurationMs(scene),
      } : undefined,
      utterances: displayType === 'comic' && scene.comic_data?.utterances
        ? scene.comic_data.utterances.map(u => ({
            id: u.id,
            text: u.text,
            audio_url: u.audio_url,
            duration_ms: u.duration_ms,
          }))
        : undefined,
      duration_ms: bs.duration_ms,
      effects: {
        ken_burns: bs.visual.effect?.type === 'kenburns',
      },
    };
  });

  const totalDurationMs = projectScenes.reduce((sum, s) => sum + s.duration_ms, 0);

  return {
    version: '1.1',
    project_id: project.id,
    project_title: project.title,
    output: {
      aspect_ratio: aspectRatio,
      fps,
      resolution,
    },
    global: {
      captions: settings.captions || { enabled: true },
      bgm: settings.bgm || { enabled: false },
      motion: settings.motion || { preset: 'gentle-zoom', transition: 'crossfade' },
    },
    scenes: projectScenes,
    total_duration_ms: totalDurationMs,
    created_at: now,
  };
}

// ====================================================================
// Hash Helper
// ====================================================================

export async function hashProjectJson(projectJson: ProjectJson | BuildRequestV1 | RemotionProjectJson_R1): Promise<string> {
  const jsonString = JSON.stringify(projectJson);
  const encoder = new TextEncoder();
  const data = encoder.encode(jsonString);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// ====================================================================
// 総尺計算ヘルパー
// ====================================================================

export function computeTotalDurationMs(scenes: SceneData[]): number {
  return scenes.reduce((sum, scene) => sum + computeSceneDurationMs(scene), 0);
}
