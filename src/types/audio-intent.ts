/**
 * Chat Audio Intent Types
 * 
 * チャットによる音声編集指示を解釈するための型定義
 * SSOT: docs/CHAT_AUDIO_INTENT_SCHEMA.md
 */

// ============================================================================
// AudioEvent SSOT (正規化された音声イベント)
// ============================================================================

export interface AudioEvent {
  /** 識別子: scene-{sceneId}-{type}-{n} */
  id: string;
  /** シーンID */
  scene_id: number;
  /** 音源タイプ */
  source_type: 'bgm' | 'sfx' | 'voice';
  /** ライブラリID (system/user) or null (direct) */
  source_id: number | null;
  /** 開始位置（シーン内相対ms） */
  start_ms: number;
  /** 終了位置（null = 自然長） */
  end_ms: number | null;
  /** 音量 (0.0 - 1.0) */
  volume: number;
  /** フェードイン (ms) */
  fade_in_ms: number;
  /** フェードアウト (ms) */
  fade_out_ms: number;
  /** 優先度 (voice=100, sfx=50, bgm=10) */
  priority: number;
}

// ============================================================================
// Audio Intent Actions
// ============================================================================

/** BGM操作アクション */
export type BgmAction =
  | 'bgm.set_volume'      // BGM音量調整
  | 'bgm.adjust_volume'   // BGM音量相対調整
  | 'bgm.mute'            // BGMミュート
  | 'bgm.unmute'          // BGMアンミュート
  | 'bgm.replace'         // BGM差し替え
  | 'bgm.remove'          // BGM削除
  | 'bgm.set_timing'      // BGM区間指定
  | 'bgm.set_fade'        // BGMフェード設定
  | 'bgm.reuse';          // BGM再利用

/** Scene BGM操作アクション */
export type SceneBgmAction =
  | 'scene_bgm.add'       // SceneBGM追加
  | 'scene_bgm.set_volume'// SceneBGM音量調整
  | 'scene_bgm.remove'    // SceneBGM削除
  | 'scene_bgm.set_timing';// SceneBGMタイミング

/** SFX操作アクション */
export type SfxAction =
  | 'sfx.add'             // SFX追加
  | 'sfx.set_volume'      // SFX音量調整
  | 'sfx.remove'          // SFX削除
  | 'sfx.set_timing'      // SFXタイミング変更
  | 'sfx.duplicate'       // SFX複製
  | 'sfx.remove_all';     // SFX全削除

/** Voice操作アクション */
export type VoiceAction =
  | 'voice.set_volume'    // Voice音量調整
  | 'voice.duck_bgm'      // Voice区間でBGM Duck
  | 'voice.regenerate';   // Voice再生成

/** 複合操作アクション */
export type CompositeAction =
  | 'audio.mute_all'      // 全音声ミュート
  | 'audio.adjust_all';   // 音量一括調整

/** 全アクションの型 */
export type AudioIntentAction =
  | BgmAction
  | SceneBgmAction
  | SfxAction
  | VoiceAction
  | CompositeAction;

// ============================================================================
// Intent Parameters
// ============================================================================

export interface AudioIntentParameters {
  // === 対象指定 ===
  /** 1-based シーン番号 */
  scene_idx?: number;
  /** 1-based SFX番号 (start_ms順) */
  sfx_no?: number;
  /** 1-based Voice番号 */
  voice_no?: number;

  // === 音量 ===
  /** 絶対値 (0.0-1.0) */
  volume?: number;
  /** 相対値 (-0.5 ~ +0.5) */
  delta?: number;
  /** Duck時の音量 (default: 0.1) */
  duck_volume?: number;

  // === タイミング ===
  /** 開始位置 (ms) */
  start_ms?: number;
  /** 終了位置 (ms, null=自然長) */
  end_ms?: number | null;

  // === フェード ===
  /** フェードイン (ms) */
  fade_in_ms?: number;
  /** フェードアウト (ms) */
  fade_out_ms?: number;

  // === ライブラリ参照 ===
  /** system/user audio library ID */
  audio_id?: number;
  /** ライブラリタイプ */
  library_type?: 'system' | 'user' | 'direct';

  // === 複製・再利用 ===
  /** 複製先の開始位置 */
  new_start_ms?: number;
  /** 複製先のシーン */
  new_scene_idx?: number;
  /** 再利用元シーン */
  source_scene_idx?: number;
  /** 再利用先シーン */
  target_scene_idx?: number;

  // === Voice固有 ===
  /** Voice ID (TTS設定用) */
  voice_id?: string;
  /** 再生速度 */
  speed?: number;
}

// ============================================================================
// Ambiguous (曖昧さ情報)
// ============================================================================

export type AmbiguousReason =
  | 'target_unclear'       // 対象が不明確
  | 'value_unclear'        // 数値が曖昧
  | 'timing_unclear'       // タイミングが曖昧
  | 'multiple_matches'     // 複数候補がある
  | 'scene_not_specified'; // シーン指定がない

export interface AudioIntentAmbiguous {
  /** 曖昧な理由 */
  reason: AmbiguousReason;
  /** 候補となる解釈 */
  candidates: string[];
  /** ユーザーへの確認質問 */
  question: string;
}

// ============================================================================
// AudioIntent (メイン型)
// ============================================================================

export interface AudioIntent {
  /** アクション名 */
  action: AudioIntentAction;
  /** AIの確信度 (0.0-1.0) */
  confidence: number;
  /** パラメータ */
  parameters: AudioIntentParameters;
  /** 曖昧さ情報（Mode B時） */
  ambiguous?: AudioIntentAmbiguous;
}

// ============================================================================
// API Response Mapping
// ============================================================================

export interface AudioApiMapping {
  /** HTTP Method */
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Endpoint template (e.g., '/api/scenes/:sceneId/audio-assignments/:id') */
  endpoint: string;
  /** Request body builder */
  bodyBuilder?: (params: AudioIntentParameters) => Record<string, unknown>;
}

/** アクション→API マッピング定義 */
export const AUDIO_ACTION_API_MAP: Record<string, AudioApiMapping> = {
  'bgm.set_volume': {
    method: 'PUT',
    endpoint: '/api/scenes/:sceneId/audio-assignments/:id',
    bodyBuilder: (p) => ({ volume_override: p.volume }),
  },
  'bgm.mute': {
    method: 'PUT',
    endpoint: '/api/scenes/:sceneId/audio-assignments/:id',
    bodyBuilder: () => ({ volume_override: 0 }),
  },
  'bgm.unmute': {
    method: 'PUT',
    endpoint: '/api/scenes/:sceneId/audio-assignments/:id',
    bodyBuilder: () => ({ volume_override: null }),
  },
  'bgm.replace': {
    method: 'POST',
    endpoint: '/api/scenes/:sceneId/audio-assignments',
    bodyBuilder: (p) => ({
      audio_library_type: p.library_type,
      [p.library_type === 'system' ? 'system_audio_id' : 'user_audio_id']: p.audio_id,
      audio_type: 'bgm',
    }),
  },
  'bgm.remove': {
    method: 'DELETE',
    endpoint: '/api/scenes/:sceneId/audio-assignments/:id',
  },
  'bgm.set_timing': {
    method: 'PUT',
    endpoint: '/api/scenes/:sceneId/audio-assignments/:id',
    bodyBuilder: (p) => ({ start_ms: p.start_ms, end_ms: p.end_ms }),
  },
  'bgm.set_fade': {
    method: 'PUT',
    endpoint: '/api/scenes/:sceneId/audio-assignments/:id',
    bodyBuilder: (p) => ({
      fade_in_ms_override: p.fade_in_ms,
      fade_out_ms_override: p.fade_out_ms,
    }),
  },
  'sfx.add': {
    method: 'POST',
    endpoint: '/api/scenes/:sceneId/audio-assignments',
    bodyBuilder: (p) => ({
      audio_library_type: p.library_type,
      [p.library_type === 'system' ? 'system_audio_id' : 'user_audio_id']: p.audio_id,
      audio_type: 'sfx',
      start_ms: p.start_ms ?? 0,
      volume_override: p.volume,
    }),
  },
  'sfx.set_volume': {
    method: 'PUT',
    endpoint: '/api/scenes/:sceneId/audio-assignments/:id',
    bodyBuilder: (p) => ({ volume_override: p.volume }),
  },
  'sfx.remove': {
    method: 'DELETE',
    endpoint: '/api/scenes/:sceneId/audio-assignments/:id',
  },
  'sfx.set_timing': {
    method: 'PUT',
    endpoint: '/api/scenes/:sceneId/audio-assignments/:id',
    bodyBuilder: (p) => ({ start_ms: p.start_ms, end_ms: p.end_ms }),
  },
};

// ============================================================================
// Ambiguous Expression Converters (曖昧語→数値変換)
// ============================================================================

/** 音量曖昧語変換テーブル */
export const VOLUME_EXPRESSION_MAP: Record<string, { volume?: number; delta?: number }> = {
  // 相対調整
  '上げて': { delta: 0.1 },
  '大きく': { delta: 0.1 },
  '下げて': { delta: -0.1 },
  '小さく': { delta: -0.1 },
  'もっと上げて': { delta: 0.2 },
  'もっと下げて': { delta: -0.2 },
  'うるさい': { delta: -0.15 },
  '聞こえない': { delta: 0.2 },
  'ちょっと': { delta: 0.05 },
  '少し': { delta: 0.05 },
  // 絶対値
  'ミュート': { volume: 0 },
  '消して': { volume: 0 },
  'オフ': { volume: 0 },
  '最大': { volume: 1.0 },
  'MAX': { volume: 1.0 },
  '半分': { volume: 0.5 },
  '50%': { volume: 0.5 },
};

/** タイミング曖昧語変換テーブル */
export const TIMING_EXPRESSION_MAP: Record<string, { start_ms?: number; end_ms?: number | null }> = {
  '最初から': { start_ms: 0 },
  '冒頭から': { start_ms: 0 },
  '最後まで': { end_ms: null },
  '終わりまで': { end_ms: null },
};

/** フェード曖昧語変換テーブル */
export const FADE_EXPRESSION_MAP: Record<string, { fade_in_ms?: number; fade_out_ms?: number }> = {
  'フェードイン': { fade_in_ms: 500 },
  'フェードアウト': { fade_out_ms: 500 },
  'ゆっくりフェード': { fade_in_ms: 1000, fade_out_ms: 1000 },
  'すぐに': { fade_in_ms: 0, fade_out_ms: 0 },
  '急に': { fade_in_ms: 0, fade_out_ms: 0 },
};

// ============================================================================
// Mode Decision (Mode判定)
// ============================================================================

export type ChatMode = 'A' | 'B' | 'C';

export interface ModeDecisionResult {
  mode: ChatMode;
  reason: string;
  normalizedIntent: AudioIntent | null;
}

/**
 * Mode C (Direct Edit) 条件判定
 * すべて満たされる場合、確認なしで即実行
 */
export function canDirectEdit(intent: AudioIntent, playbackSceneIdx?: number): boolean {
  const params = intent.parameters;
  
  // 1. scene_idx が確定（明示指定 or playbackContext）
  const hasSceneIdx = params.scene_idx != null || playbackSceneIdx != null;
  
  // 2. 対象が確定（BGMなら不要、SFXならsfx_no必須）
  const isBgmAction = intent.action.startsWith('bgm.') || intent.action.startsWith('scene_bgm.');
  const hasTarget = isBgmAction || 
                    params.sfx_no != null ||
                    params.voice_no != null;
  
  // 3. 値が確定
  const hasValue = params.volume != null ||
                   params.delta != null ||
                   params.start_ms != null ||
                   intent.action.includes('remove') ||
                   intent.action.includes('mute');
  
  // 4. 曖昧さがない
  const notAmbiguous = !intent.ambiguous;
  
  return hasSceneIdx && hasTarget && hasValue && notAmbiguous;
}

/**
 * Intent の scene_idx を playbackContext で補完
 */
export function normalizeIntent(intent: AudioIntent, playbackSceneIdx: number): AudioIntent {
  if (intent.parameters.scene_idx != null) {
    return intent;
  }
  
  return {
    ...intent,
    parameters: {
      ...intent.parameters,
      scene_idx: playbackSceneIdx,
    },
  };
}

// ============================================================================
// Confirmation Templates (確認テンプレート)
// ============================================================================

export interface ConfirmationTemplate {
  reason: AmbiguousReason;
  template: (context: Record<string, unknown>) => string;
}

export const CONFIRMATION_TEMPLATES: Record<AmbiguousReason, (context: Record<string, unknown>) => string> = {
  target_unclear: (ctx) => 
    `「${ctx.target}」はこのシーンの${ctx.type}ですか？それともプロジェクト全体の${ctx.type}ですか？`,
  
  value_unclear: (ctx) => 
    `「${ctx.expression}」はどのくらいですか？\n1. 少し${ctx.direction} (${ctx.option1})\n2. かなり${ctx.direction} (${ctx.option2})\n3. ${ctx.option3}`,
  
  timing_unclear: (ctx) => 
    `「${ctx.expression}」は具体的にいつからですか？\n現在のシーンは ${ctx.scene_start_ms}ms〜${ctx.scene_end_ms}ms です。`,
  
  multiple_matches: (ctx) => {
    const items = (ctx.items as Array<{ id: string; label: string }>)
      .map((item, i) => `${i + 1}. ${item.id}: 「${item.label}」`)
      .join('\n');
    return `このシーンには複数の${ctx.type}があります:\n${items}\nどの${ctx.type}ですか？`;
  },
  
  scene_not_specified: (ctx) => 
    `どのシーンの${ctx.type}を調整しますか？現在表示中のシーン${ctx.current_scene_idx}でよいですか？`,
};

// ============================================================================
// Priority Constants
// ============================================================================

export const AUDIO_PRIORITY = {
  voice: 100,
  sfx: 50,
  bgm: 10,
} as const;

// ============================================================================
// Identifier Helpers (P1-B準拠)
// ============================================================================

/**
 * AudioEvent識別子を生成
 */
export function generateAudioEventId(
  sceneId: number,
  sourceType: 'bgm' | 'sfx' | 'voice',
  index?: number
): string {
  if (sourceType === 'bgm') {
    return `scene-${sceneId}-bgm`;
  }
  return `scene-${sceneId}-${sourceType}-${index ?? 1}`;
}

/**
 * 識別子からパース
 */
export function parseAudioEventId(id: string): {
  sceneId: number;
  sourceType: 'bgm' | 'sfx' | 'voice';
  index?: number;
} | null {
  const match = id.match(/^scene-(\d+)-(bgm|sfx|voice)(?:-(\d+))?$/);
  if (!match) return null;
  
  return {
    sceneId: parseInt(match[1], 10),
    sourceType: match[2] as 'bgm' | 'sfx' | 'voice',
    index: match[3] ? parseInt(match[3], 10) : undefined,
  };
}
