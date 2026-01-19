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
}

export interface ProjectData {
  id: number;
  title: string;
  user_id: number;
}

// ====================================================================
// Constants
// ====================================================================

const DEFAULT_SCENE_DURATION_MS = 3000;  // 音声がない場合のデフォルト尺
const AUDIO_PADDING_MS = 500;            // 音声尺への追加padding
const TEXT_DURATION_MS_PER_CHAR = 300;   // 日本語テキストの推定: 300ms/文字
const MIN_DURATION_MS = 2000;            // 最小尺

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
 * シーンの尺を計算
 * SSOT: この関数が尺計算の唯一のロジック
 * 
 * 優先順位:
 * 1. video モード → video.duration_sec × 1000
 * 2. comic モード → utterances の合計 duration_ms + padding
 * 3. audio がある → audio.duration_ms + padding
 * 4. dialogue から推定 → text.length × 300ms
 * 5. デフォルト → 3000ms
 */
export function computeSceneDurationMs(scene: SceneData): number {
  const displayType = scene.display_asset_type || 'image';
  
  // 1. video モード: 動画の尺を使用
  if (displayType === 'video' && scene.active_video?.duration_sec) {
    return scene.active_video.duration_sec * 1000;
  }
  
  // 2. comic モード: utterances の合計尺
  if (displayType === 'comic') {
    const utterances = scene.comic_data?.utterances || [];
    const totalUtteranceDuration = utterances.reduce((sum, u) => sum + (u.duration_ms || 0), 0);
    if (totalUtteranceDuration > 0) {
      return totalUtteranceDuration + AUDIO_PADDING_MS;
    }
    // utterances の duration_ms がない場合はテキストから推定
    const totalText = utterances.map(u => u.text || '').join('');
    if (totalText.length > 0) {
      return Math.max(MIN_DURATION_MS, totalText.length * TEXT_DURATION_MS_PER_CHAR) + AUDIO_PADDING_MS;
    }
  }
  
  // 3. audio がある場合
  if (scene.active_audio?.duration_ms) {
    return scene.active_audio.duration_ms + AUDIO_PADDING_MS;
  }
  
  // 4. dialogue から推定
  if (scene.dialogue && scene.dialogue.length > 0) {
    return Math.max(MIN_DURATION_MS, scene.dialogue.length * TEXT_DURATION_MS_PER_CHAR) + AUDIO_PADDING_MS;
  }
  
  // 5. デフォルト
  return DEFAULT_SCENE_DURATION_MS;
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

    // 音声チェック（警告レベル）
    const displayType = scene.display_asset_type || 'image';
    if (displayType === 'comic') {
      const utterances = scene.comic_data?.utterances || [];
      const missingAudioCount = utterances.filter(u => !u.audio_url).length;
      if (missingAudioCount > 0) {
        warnings.push({
          scene_idx: scene.idx,
          scene_id: scene.id,
          message: `発話音声が未生成です（${missingAudioCount}/${utterances.length}件）`,
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
// Legacy: buildProjectJson (後方互換性のため維持)
// ====================================================================

/**
 * @deprecated Use buildBuildRequestV1 instead
 * 
 * 後方互換性のため維持。内部で buildBuildRequestV1 を呼び出し、
 * 旧形式の ProjectJson に変換して返す。
 */
export function buildProjectJson(
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

export async function hashProjectJson(projectJson: ProjectJson | BuildRequestV1): Promise<string> {
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
