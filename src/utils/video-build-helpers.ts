/**
 * Video Build Helpers
 * 
 * Remotion Video Build 用のヘルパー関数
 * - validateProjectAssets: プロジェクトの素材検証（Preflight）
 * - buildProjectJson: Remotion 入力データ（project.json）生成
 */

import type { ProjectJson, ProjectJsonScene, VideoBuildSettings } from './aws-video-build-client';

// ====================================================================
// Types
// ====================================================================

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

// ====================================================================
// validateProjectAssets
// ====================================================================
// 
// display_asset_type に応じた素材の必須検証
// - image: active_image.r2_url が必須
// - comic: active_comic.r2_url が必須
// - video: active_video.status='completed' かつ r2_url が必須
//
// 音声は警告レベル（必須ではない）
//

export function validateProjectAssets(scenes: SceneData[]): AssetValidationResult {
  const missing: AssetValidationResult['missing'] = [];
  const warnings: AssetValidationResult['warnings'] = [];
  let readyCount = 0;

  for (const scene of scenes) {
    const displayType = scene.display_asset_type || 'image';
    let isReady = false;

    switch (displayType) {
      case 'image':
        if (scene.active_image?.r2_url) {
          isReady = true;
        } else {
          missing.push({
            scene_idx: scene.idx,
            scene_id: scene.id,
            reason: 'アクティブ画像がありません',
            required_asset: 'active_image.r2_url',
          });
        }
        break;

      case 'comic':
        if (scene.active_comic?.r2_url) {
          isReady = true;
        } else {
          missing.push({
            scene_idx: scene.idx,
            scene_id: scene.id,
            reason: '漫画画像がありません（漫画モードに設定されています）',
            required_asset: 'active_comic.r2_url',
          });
        }
        break;

      case 'video':
        if (scene.active_video?.status === 'completed' && scene.active_video?.r2_url) {
          isReady = true;
        } else if (scene.active_video?.status === 'generating') {
          missing.push({
            scene_idx: scene.idx,
            scene_id: scene.id,
            reason: '動画が生成中です。完了までお待ちください。',
            required_asset: 'active_video (completed)',
          });
        } else {
          missing.push({
            scene_idx: scene.idx,
            scene_id: scene.id,
            reason: '動画がありません（動画モードに設定されています）',
            required_asset: 'active_video.r2_url',
          });
        }
        break;
    }

    // 音声チェック（警告レベル）
    if (displayType === 'comic') {
      // 漫画モード: utterance の音声をチェック
      const utterances = scene.comic_data?.utterances || [];
      const hasAllAudio = utterances.every(u => u.audio_url);
      if (!hasAllAudio && utterances.length > 0) {
        warnings.push({
          scene_idx: scene.idx,
          scene_id: scene.id,
          message: `発話音声が未生成です（${utterances.filter(u => !u.audio_url).length}/${utterances.length}件）`,
        });
      }
    } else {
      // 画像/動画モード: シーン音声をチェック
      if (!scene.active_audio?.audio_url) {
        warnings.push({
          scene_idx: scene.idx,
          scene_id: scene.id,
          message: '音声が生成されていません',
        });
      }
    }

    if (isReady) {
      readyCount++;
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
// buildProjectJson
// ====================================================================
// 
// Remotion 用の project.json を生成
// 
// SSOT:
// - asset.src = display_asset_type に基づく r2_url
// - duration_ms = 音声尺 + padding（音声がなければデフォルト3秒）
// - ken_burns = asset.type が 'image' の場合のみ（漫画/動画は false）
//

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

  const projectScenes: ProjectJsonScene[] = scenes.map((scene) => {
    const displayType = scene.display_asset_type || 'image';
    
    // Asset選択（SSOT）
    let assetType: 'image' | 'comic' | 'video' = 'image';
    let assetSrc = '';

    switch (displayType) {
      case 'comic':
        assetType = 'comic';
        assetSrc = scene.active_comic?.r2_url || '';
        break;
      case 'video':
        assetType = 'video';
        assetSrc = scene.active_video?.r2_url || '';
        break;
      default:
        assetType = 'image';
        assetSrc = scene.active_image?.r2_url || '';
        break;
    }

    // Duration計算（SSOT）
    // 動画モード: 動画の尺を使用
    // 漫画モード: utterance の合計尺を使用
    // 画像モード: シーン音声の尺を使用
    let durationMs = DEFAULT_SCENE_DURATION_MS;

    if (displayType === 'video' && scene.active_video?.duration_sec) {
      durationMs = scene.active_video.duration_sec * 1000;
    } else if (displayType === 'comic') {
      const utterances = scene.comic_data?.utterances || [];
      const totalUtteranceDuration = utterances.reduce((sum, u) => sum + (u.duration_ms || 0), 0);
      if (totalUtteranceDuration > 0) {
        durationMs = totalUtteranceDuration + AUDIO_PADDING_MS;
      }
    } else if (scene.active_audio?.duration_ms) {
      durationMs = scene.active_audio.duration_ms + AUDIO_PADDING_MS;
    }

    // Ken Burns: 画像モードの場合のみ有効（漫画・動画は無効）
    const kenBurnsEnabled = 
      settings.motion?.preset !== 'none' && 
      assetType === 'image';

    // Utterances（漫画モード用）
    const utterances = displayType === 'comic' && scene.comic_data?.utterances
      ? scene.comic_data.utterances.map(u => ({
          id: u.id,
          text: u.text,
          audio_url: u.audio_url,
          duration_ms: u.duration_ms,
        }))
      : undefined;

    return {
      scene_id: scene.id,
      idx: scene.idx,
      role: scene.role,
      title: scene.title,
      dialogue: scene.dialogue,
      asset: {
        type: assetType,
        src: assetSrc,
      },
      audio: scene.active_audio ? {
        src: scene.active_audio.audio_url,
        duration_ms: scene.active_audio.duration_ms,
      } : undefined,
      utterances,
      duration_ms: durationMs,
      effects: {
        ken_burns: kenBurnsEnabled,
      },
    };
  });

  // Total duration
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

export async function hashProjectJson(projectJson: ProjectJson): Promise<string> {
  const jsonString = JSON.stringify(projectJson);
  const encoder = new TextEncoder();
  const data = encoder.encode(jsonString);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
