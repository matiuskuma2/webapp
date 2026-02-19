/**
 * Dialogue Parser & Utterances Generator
 * 
 * Purpose: Parse dialogue text to extract individual utterances with speaker identification
 * 
 * Supported Formats:
 * - キャラ名：「セリフ」
 * - キャラ名： 「セリフ」
 * - キャラ名：　「セリフ」
 * - キャラ名: 「セリフ」
 * - キャラ名：セリフ（括弧なし）
 * - ナレーション：テキスト
 * - ナレーション： テキスト
 * 
 * Output: Array of parsed utterances with role and character_key
 */

import type { D1Database } from '@cloudflare/workers-types';

// =============================================================================
// Types
// =============================================================================

export interface ParsedUtterance {
  order_no: number;
  role: 'narration' | 'dialogue';
  character_key: string | null;
  character_name: string | null;  // 検出されたキャラ名（マッチング用）
  text: string;  // セリフ本文（キャラ名を除いた部分）
  original_line: string;  // 元の行（デバッグ用）
}

export interface CharacterMapping {
  character_key: string;
  character_name: string;
  aliases: string[];
}

// =============================================================================
// Constants
// =============================================================================

// ナレーション判定用キーワード
const NARRATION_KEYWORDS = [
  'ナレーション',
  'ナレーター',
  'Narration',
  'Narrator',
  'NA',
  'N',
  '地の文',
  '説明',
];

// セリフ検出用正規表現
// 形式: キャラ名：「セリフ」 または キャラ名：セリフ
// コロンは全角(:)・半角(:)両対応、後ろに空白があってもOK
const DIALOGUE_PATTERN = /^([^：:]+)[：:]\s*(.+)$/;

// 括弧付きセリフの抽出（「」『』""）
const QUOTE_PATTERNS = [
  /「([^」]+)」/g,  // 「」
  /『([^』]+)』/g,  // 『』
  /"([^"]+)"/g,      // ""
  /"([^"]+)"/g,      // ""
];

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * テキストを正規化（マッチング用）
 */
function normalizeForMatching(text: string): string {
  if (!text) return '';
  
  // 全角→半角（英数字）
  let normalized = text.replace(/[Ａ-Ｚａ-ｚ０-９]/g, (s) => {
    return String.fromCharCode(s.charCodeAt(0) - 0xFEE0);
  });
  
  // 空白除去、小文字化
  return normalized.trim().toLowerCase();
}

/**
 * キャラ名がナレーションかどうか判定
 */
function isNarrationSpeaker(speakerName: string): boolean {
  const normalized = normalizeForMatching(speakerName);
  return NARRATION_KEYWORDS.some(kw => 
    normalizeForMatching(kw) === normalized
  );
}

/**
 * セリフ本文を抽出（括弧があれば括弧内、なければコロン以降全体）
 */
function extractDialogueText(rawText: string): string {
  // 括弧付きセリフを検出
  for (const pattern of QUOTE_PATTERNS) {
    const matches = [...rawText.matchAll(pattern)];
    if (matches.length > 0) {
      // 複数の括弧がある場合は全て結合
      return matches.map(m => m[1]).join('');
    }
  }
  
  // 括弧がない場合はそのままテキストを返す
  return rawText.trim();
}

/**
 * キャラ名からキャラクターキーを検索
 * 
 * マッチング優先順位:
 * 1. character_name / aliases の完全一致
 * 2. character_name / aliases の部分一致（「恵さん」→「とわの恵」）
 * 3. character_key の完全一致（大文字小文字無視）
 * 4. あいまいマッチ（ひらがな/カタカナ統一、敬称除去）
 */
function findCharacterKey(
  speakerName: string,
  characterMappings: CharacterMapping[]
): { character_key: string; character_name: string } | null {
  const normalizedSpeaker = normalizeForMatching(speakerName);
  
  // Pass 1: 完全一致（character_name, aliases, character_key）
  for (const char of characterMappings) {
    if (normalizeForMatching(char.character_name) === normalizedSpeaker) {
      return { character_key: char.character_key, character_name: char.character_name };
    }
    for (const alias of char.aliases) {
      if (normalizeForMatching(alias) === normalizedSpeaker) {
        return { character_key: char.character_key, character_name: char.character_name };
      }
    }
    // character_key 一致（例: "pinkboo_sub" → "pinkboo_sub"）
    if (normalizeForMatching(char.character_key) === normalizedSpeaker) {
      return { character_key: char.character_key, character_name: char.character_name };
    }
  }
  
  // Pass 2: 部分一致（どちらかが含まれる）
  // 例: シナリオ「恵さん」↔ DB「とわの恵」→「恵」が共通
  // 例: シナリオ「ぴんくぶ〜」↔ DB alias「でびるぶー」→ 一致しない
  const speakerClean = removeSuffix(normalizedSpeaker);
  
  for (const char of characterMappings) {
    const nameClean = removeSuffix(normalizeForMatching(char.character_name));
    const nameKana = toHiragana(nameClean);
    const speakerKana = toHiragana(speakerClean);
    
    // 名前の一部が含まれるか（2文字以上の部分一致）
    if (speakerKana.length >= 2 && nameKana.length >= 2) {
      if (nameKana.includes(speakerKana) || speakerKana.includes(nameKana)) {
        return { character_key: char.character_key, character_name: char.character_name };
      }
    }
    
    // aliasesの部分一致
    for (const alias of char.aliases) {
      const aliasClean = removeSuffix(normalizeForMatching(alias));
      const aliasKana = toHiragana(aliasClean);
      if (speakerKana.length >= 2 && aliasKana.length >= 2) {
        if (aliasKana.includes(speakerKana) || speakerKana.includes(aliasKana)) {
          return { character_key: char.character_key, character_name: char.character_name };
        }
      }
    }
  }
  
  return null;
}

/**
 * 敬称・呼称サフィックスを除去
 * 例: "恵さん" → "恵", "太郎くん" → "太郎"
 */
function removeSuffix(name: string): string {
  return name.replace(/(さん|くん|ちゃん|様|さま|先生|先輩|後輩|殿|氏)$/g, '');
}

/**
 * カタカナをひらがなに変換（マッチング用）
 * 「〜」「～」も正規化
 */
function toHiragana(str: string): string {
  return str
    .replace(/[\u30A1-\u30F6]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60))
    .replace(/[〜～ー]/g, '')  // 長音・波ダッシュを除去
    .replace(/[\s\u3000]/g, '');  // スペース除去
}

// =============================================================================
// Main Parser Function
// =============================================================================

/**
 * dialogueテキストをパースしてutterances配列を生成
 * 
 * @param dialogue シーンのdialogueテキスト
 * @param characterMappings プロジェクトのキャラクターマッピング
 * @returns パースされたutterances配列
 */
export function parseDialogueToUtterances(
  dialogue: string,
  characterMappings: CharacterMapping[]
): ParsedUtterance[] {
  if (!dialogue || dialogue.trim().length === 0) {
    return [];
  }
  
  const utterances: ParsedUtterance[] = [];
  const lines = dialogue.split('\n').filter(line => line.trim().length > 0);
  
  let orderNo = 1;
  
  for (const line of lines) {
    const trimmedLine = line.trim();
    
    // キャラ名：セリフ 形式を検出
    const match = trimmedLine.match(DIALOGUE_PATTERN);
    
    if (match) {
      const speakerName = match[1].trim();
      const rawText = match[2].trim();
      
      // ナレーション判定
      if (isNarrationSpeaker(speakerName)) {
        utterances.push({
          order_no: orderNo++,
          role: 'narration',
          character_key: null,
          character_name: null,
          text: rawText,  // ナレーションは括弧を含めてそのまま
          original_line: trimmedLine
        });
        continue;
      }
      
      // キャラクター検索
      const charMatch = findCharacterKey(speakerName, characterMappings);
      
      if (charMatch) {
        // キャラクターが見つかった場合 → dialogue
        const dialogueText = extractDialogueText(rawText);
        utterances.push({
          order_no: orderNo++,
          role: 'dialogue',
          character_key: charMatch.character_key,
          character_name: charMatch.character_name,
          text: dialogueText,
          original_line: trimmedLine
        });
      } else {
        // ================================================================
        // FAILSAFE: 未マッチ話者 → narration に矯正
        // ================================================================
        // 「名前：セリフ」形式だがプロジェクトのキャラに一致しない場合、
        // dialogue + character_key=null にすると voice-resolution が
        // narration 声に落ちるだけでなく、UI上も「誰のセリフか不明」になる。
        //
        // 解決策: narration に確定させ、テキストにキャラ名を含めて保持する。
        // ユーザーは後から PUT /utterances/:id で role=dialogue + character_key を
        // セットして「話者確定」させることができる。
        // ================================================================
        const dialogueText = extractDialogueText(rawText);
        console.warn(`[DialogueParser] Unknown speaker: "${speakerName}" → narration (failsafe). Text preserved with speaker prefix.`);
        utterances.push({
          order_no: orderNo++,
          role: 'narration',
          character_key: null,
          character_name: speakerName,  // シナリオ上の名前は保持（UIで表示用）
          text: `${speakerName}：${dialogueText}`,  // キャラ名付きで保持（情報損失なし）
          original_line: trimmedLine
        });
      }
    } else {
      // キャラ名：形式でない場合 → ナレーション
      utterances.push({
        order_no: orderNo++,
        role: 'narration',
        character_key: null,
        character_name: null,
        text: trimmedLine,
        original_line: trimmedLine
      });
    }
  }
  
  // =========================================================================
  // A-spec: 3キャラクター上限ガード（最後の砦）
  // 1シーン内で distinct character_key > 3 の場合、
  // 4人目以降の dialogue を narration に矯正する（絶対に落とさない）
  // =========================================================================
  const MAX_CHARACTERS_PER_SCENE = 3;
  const distinctKeys = new Set<string>();
  
  // Pass 1: 登場順にキャラクターキーを収集
  for (const utt of utterances) {
    if (utt.role === 'dialogue' && utt.character_key) {
      distinctKeys.add(utt.character_key);
    }
  }
  
  if (distinctKeys.size > MAX_CHARACTERS_PER_SCENE) {
    // 上位3キャラ（登場順）を確定
    const allowedKeys = new Set<string>();
    for (const utt of utterances) {
      if (utt.role === 'dialogue' && utt.character_key) {
        allowedKeys.add(utt.character_key);
        if (allowedKeys.size >= MAX_CHARACTERS_PER_SCENE) break;
      }
    }
    
    // 4人目以降 → ナレーションに矯正（テキストにキャラ名を含めて保持）
    let correctedCount = 0;
    for (const utt of utterances) {
      if (utt.role === 'dialogue' && utt.character_key && !allowedKeys.has(utt.character_key)) {
        const originalName = utt.character_name || utt.character_key;
        utt.text = `${originalName} ${utt.text}`;  // キャラ名をナレーション文に含める
        utt.role = 'narration';
        utt.character_key = null;
        utt.character_name = null;
        correctedCount++;
      }
    }
    
    console.warn(
      `[DialogueParser:A-spec] Exceeded ${MAX_CHARACTERS_PER_SCENE} characters ` +
      `(found ${distinctKeys.size}). Corrected ${correctedCount} utterance(s) to narration. ` +
      `Allowed: [${[...allowedKeys].join(', ')}]`
    );
  }
  
  // Summary logging
  const narrationCount = utterances.filter(u => u.role === 'narration').length;
  const dialogueCount = utterances.filter(u => u.role === 'dialogue').length;
  const unmatchedCount = utterances.filter(u => u.role === 'narration' && u.character_name !== null).length;
  
  if (unmatchedCount > 0) {
    const unmatchedNames = utterances
      .filter(u => u.role === 'narration' && u.character_name !== null)
      .map(u => u.character_name);
    const uniqueNames = [...new Set(unmatchedNames)];
    console.warn(
      `[DialogueParser] ${unmatchedCount} utterance(s) had unmatched speakers → narration fallback. ` +
      `Unmatched: [${uniqueNames.join(', ')}]. ` +
      `Available characters: [${characterMappings.map(c => c.character_name).join(', ')}]`
    );
  }
  
  if (utterances.length > 0) {
    console.log(
      `[DialogueParser] Parsed ${utterances.length} utterances: ` +
      `${dialogueCount} dialogue, ${narrationCount} narration` +
      (unmatchedCount > 0 ? `, ${unmatchedCount} unmatched→narration` : '')
    );
  }
  
  return utterances;
}

// =============================================================================
// Database Functions
// =============================================================================

/**
 * プロジェクトのキャラクターマッピングを取得
 */
export async function getCharacterMappings(
  db: D1Database,
  projectId: number
): Promise<CharacterMapping[]> {
  const { results } = await db.prepare(`
    SELECT character_key, character_name, aliases_json
    FROM project_character_models
    WHERE project_id = ?
    ORDER BY id ASC
  `).bind(projectId).all();
  
  return (results || []).map(row => {
    let aliases: string[] = [];
    try {
      if (row.aliases_json) {
        const parsed = JSON.parse(row.aliases_json as string);
        if (Array.isArray(parsed)) {
          aliases = parsed.filter(a => typeof a === 'string');
        }
      }
    } catch (e) {
      console.warn('[DialogueParser] Failed to parse aliases_json:', e);
    }
    
    return {
      character_key: row.character_key as string,
      character_name: row.character_name as string,
      aliases
    };
  });
}

/**
 * シーンのutterancesを自動生成（既存を削除して再生成）
 * 
 * @param db D1 Database
 * @param sceneId シーンID
 * @param dialogue シーンのdialogueテキスト
 * @param projectId プロジェクトID
 * @returns 生成されたutterances数
 */
export async function generateUtterancesForScene(
  db: D1Database,
  sceneId: number,
  dialogue: string,
  projectId: number
): Promise<{ created: number; parsed: ParsedUtterance[]; unmatched_speakers: number }> {
  // 1. キャラクターマッピング取得
  const characterMappings = await getCharacterMappings(db, projectId);
  
  // 2. dialogueをパース
  const parsed = parseDialogueToUtterances(dialogue, characterMappings);
  
  if (parsed.length === 0) {
    // パース結果が空の場合、dialogue全体を1つのnarrationとして保存
    await db.prepare(`
      DELETE FROM scene_utterances WHERE scene_id = ?
    `).bind(sceneId).run();
    
    await db.prepare(`
      INSERT INTO scene_utterances (scene_id, order_no, role, character_key, text)
      VALUES (?, 1, 'narration', NULL, ?)
    `).bind(sceneId, dialogue || '').run();
    
    return { created: 1, parsed: [], unmatched_speakers: 0 };
  }
  
  // 3. 既存のutterancesを削除
  await db.prepare(`
    DELETE FROM scene_utterances WHERE scene_id = ?
  `).bind(sceneId).run();
  
  // 4. 新しいutterancesを挿入
  for (const utt of parsed) {
    await db.prepare(`
      INSERT INTO scene_utterances (scene_id, order_no, role, character_key, text)
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      sceneId,
      utt.order_no,
      utt.role,
      utt.character_key,
      utt.text
    ).run();
  }
  
  const unmatchedSpeakers = parsed.filter(u => u.role === 'narration' && u.character_name !== null).length;
  
  console.log(`[DialogueParser] Scene ${sceneId}: Generated ${parsed.length} utterances` +
    (unmatchedSpeakers > 0 ? ` (${unmatchedSpeakers} unmatched speakers → narration)` : ''));
  
  return { created: parsed.length, parsed, unmatched_speakers: unmatchedSpeakers };
}

/**
 * プロジェクト全体のutterancesを自動生成
 * 
 * @param db D1 Database
 * @param projectId プロジェクトID
 * @returns 生成統計
 */
export async function generateUtterancesForProject(
  db: D1Database,
  projectId: number
): Promise<{
  total_scenes: number;
  total_utterances: number;
  scenes_with_dialogues: number;
  scenes_with_narration_only: number;
  total_unmatched_speakers: number;
}> {
  // 1. プロジェクトの全シーンを取得
  const { results: scenes } = await db.prepare(`
    SELECT id, dialogue FROM scenes WHERE project_id = ? ORDER BY idx ASC
  `).bind(projectId).all();
  
  if (!scenes || scenes.length === 0) {
    return {
      total_scenes: 0,
      total_utterances: 0,
      scenes_with_dialogues: 0,
      scenes_with_narration_only: 0,
      total_unmatched_speakers: 0
    };
  }
  
  // 2. キャラクターマッピング取得（一度だけ）
  const characterMappings = await getCharacterMappings(db, projectId);
  
  let totalUtterances = 0;
  let scenesWithDialogues = 0;
  let scenesWithNarrationOnly = 0;
  let totalUnmatchedSpeakers = 0;
  
  // 3. 各シーンを処理
  for (const scene of scenes) {
    const sceneId = scene.id as number;
    const dialogue = scene.dialogue as string || '';
    
    const result = await generateUtterancesForScene(
      db,
      sceneId,
      dialogue,
      projectId
    );
    
    totalUtterances += result.created;
    totalUnmatchedSpeakers += result.unmatched_speakers;
    
    // カウント
    const hasDialogueRole = result.parsed.some(u => u.role === 'dialogue');
    if (hasDialogueRole) {
      scenesWithDialogues++;
    } else {
      scenesWithNarrationOnly++;
    }
  }
  
  console.log(
    `[DialogueParser] Project ${projectId}: Generated ${totalUtterances} utterances for ${scenes.length} scenes` +
    (totalUnmatchedSpeakers > 0 ? ` (⚠ ${totalUnmatchedSpeakers} unmatched speakers → narration fallback)` : '')
  );
  
  return {
    total_scenes: scenes.length,
    total_utterances: totalUtterances,
    scenes_with_dialogues: scenesWithDialogues,
    scenes_with_narration_only: scenesWithNarrationOnly,
    total_unmatched_speakers: totalUnmatchedSpeakers
  };
}
