/**
 * RILARCScenarioV1 JSON Schema Validator
 * docs/03_DOMAIN_MODEL.md に厳密準拠
 */

export interface RILARCScenarioV1 {
  version: string
  metadata: {
    title: string
    total_scenes: number
    estimated_duration_seconds: number
  }
  scenes: RILARCScene[]
}

export interface RILARCScene {
  idx: number
  role: 'hook' | 'context' | 'main_point' | 'evidence' | 'timeline' | 'analysis' | 'summary' | 'cta'
  title: string
  dialogue: string
  bullets: string[]
  image_prompt: string
}

export interface ValidationResult {
  valid: boolean
  errors: string[]
}

const VALID_ROLES = ['hook', 'context', 'main_point', 'evidence', 'timeline', 'analysis', 'summary', 'cta']

/**
 * RILARCScenarioV1 JSON の完全バリデーション
 */
export function validateRILARCScenario(data: any): ValidationResult {
  const errors: string[] = []

  // 1. 構造検証: version, metadata, scenes の存在確認
  if (!data || typeof data !== 'object') {
    errors.push('Invalid JSON: root must be an object')
    return { valid: false, errors }
  }

  if (!data.version) {
    errors.push('Missing required field: version')
  }

  if (!data.metadata) {
    errors.push('Missing required field: metadata')
  }

  if (!data.scenes) {
    errors.push('Missing required field: scenes')
  }

  // 早期リターン（基本構造が不正）
  if (errors.length > 0) {
    return { valid: false, errors }
  }

  // 2. version検証
  if (data.version !== '1.0') {
    errors.push(`Invalid version: expected "1.0", got "${data.version}"`)
  }

  // 3. metadata検証
  const metadata = data.metadata
  
  if (typeof metadata !== 'object') {
    errors.push('Invalid metadata: must be an object')
  } else {
    if (!metadata.title || typeof metadata.title !== 'string') {
      errors.push('Missing or invalid metadata.title')
    } else if (metadata.title.length < 1 || metadata.title.length > 100) {
      errors.push(`Invalid metadata.title length: must be 1-100 characters, got ${metadata.title.length}`)
    }

    if (typeof metadata.total_scenes !== 'number' || !Number.isInteger(metadata.total_scenes)) {
      errors.push('Missing or invalid metadata.total_scenes: must be an integer')
    } else if (metadata.total_scenes < 3 || metadata.total_scenes > 50) {
      errors.push(`Invalid metadata.total_scenes: must be 3-50, got ${metadata.total_scenes}`)
    }

    if (typeof metadata.estimated_duration_seconds !== 'number' || !Number.isInteger(metadata.estimated_duration_seconds)) {
      errors.push('Missing or invalid metadata.estimated_duration_seconds: must be an integer')
    } else if (metadata.estimated_duration_seconds < 30) {
      errors.push(`Invalid metadata.estimated_duration_seconds: must be >= 30, got ${metadata.estimated_duration_seconds}`)
    }
  }

  // 4. scenes配列検証
  if (!Array.isArray(data.scenes)) {
    errors.push('Invalid scenes: must be an array')
    return { valid: false, errors }
  }

  const scenes = data.scenes

  // 4-1. シーン数検証
  if (scenes.length < 3 || scenes.length > 50) {
    errors.push(`Invalid scenes count: must be 3-50, got ${scenes.length}`)
  }

  // 4-2. metadata.total_scenes との一致検証
  if (metadata && typeof metadata.total_scenes === 'number') {
    if (scenes.length !== metadata.total_scenes) {
      errors.push(`Mismatch: metadata.total_scenes (${metadata.total_scenes}) !== scenes.length (${scenes.length})`)
    }
  }

  // 4-3. 各シーンの検証
  scenes.forEach((scene: any, index: number) => {
    const sceneNum = index + 1

    if (!scene || typeof scene !== 'object') {
      errors.push(`Scene ${sceneNum}: must be an object`)
      return
    }

    // idx検証（連番）
    if (typeof scene.idx !== 'number' || !Number.isInteger(scene.idx)) {
      errors.push(`Scene ${sceneNum}: idx must be an integer`)
    } else if (scene.idx !== sceneNum) {
      errors.push(`Scene ${sceneNum}: idx must be ${sceneNum}, got ${scene.idx}`)
    }

    // role検証（enum）
    if (!scene.role || typeof scene.role !== 'string') {
      errors.push(`Scene ${sceneNum}: missing or invalid role`)
    } else if (!VALID_ROLES.includes(scene.role)) {
      errors.push(`Scene ${sceneNum}: invalid role "${scene.role}", must be one of: ${VALID_ROLES.join(', ')}`)
    }

    // title検証
    if (!scene.title || typeof scene.title !== 'string') {
      errors.push(`Scene ${sceneNum}: missing or invalid title`)
    } else if (scene.title.length < 1 || scene.title.length > 50) {
      errors.push(`Scene ${sceneNum}: title length must be 1-50, got ${scene.title.length}`)
    }

    // dialogue検証
    if (!scene.dialogue || typeof scene.dialogue !== 'string') {
      errors.push(`Scene ${sceneNum}: missing or invalid dialogue`)
    } else if (scene.dialogue.length < 40 || scene.dialogue.length > 220) {
      errors.push(`Scene ${sceneNum}: dialogue length must be 40-220, got ${scene.dialogue.length}`)
    }

    // bullets検証
    if (!Array.isArray(scene.bullets)) {
      errors.push(`Scene ${sceneNum}: bullets must be an array`)
    } else {
      if (scene.bullets.length < 2 || scene.bullets.length > 4) {
        errors.push(`Scene ${sceneNum}: bullets count must be 2-4, got ${scene.bullets.length}`)
      }

      scene.bullets.forEach((bullet: any, bulletIndex: number) => {
        if (typeof bullet !== 'string') {
          errors.push(`Scene ${sceneNum}, bullet ${bulletIndex + 1}: must be a string`)
        } else if (bullet.length < 6 || bullet.length > 26) {
          errors.push(`Scene ${sceneNum}, bullet ${bulletIndex + 1}: length must be 6-26, got ${bullet.length}`)
        }
      })
    }

    // image_prompt検証
    if (!scene.image_prompt || typeof scene.image_prompt !== 'string') {
      errors.push(`Scene ${sceneNum}: missing or invalid image_prompt`)
    } else if (scene.image_prompt.length < 20 || scene.image_prompt.length > 500) {
      errors.push(`Scene ${sceneNum}: image_prompt length must be 20-500, got ${scene.image_prompt.length}`)
    }
  })

  return {
    valid: errors.length === 0,
    errors
  }
}
