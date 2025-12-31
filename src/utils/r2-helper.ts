// src/utils/r2-helper.ts
export function generateR2Key(
  type: 'image' | 'audio' | 'video',
  projectId: number,
  sceneIndex: number,
  generationId: number,
  timestamp: number,
  extension: string
): string {
  // type/audio/video/image のトップディレクトリは将来拡張に強い
  return `${type}/${projectId}/scene_${sceneIndex}/${generationId}_${timestamp}.${extension}`;
}

export function getR2PublicUrl(r2Key: string, r2PublicUrl?: string): string {
  // 例: https://<your-domain> (末尾/は除去)
  if (r2PublicUrl && r2PublicUrl.trim().length > 0) {
    const base = r2PublicUrl.replace(/\/$/, '');
    return `${base}/${r2Key}`;
  }
  // 最低限: 相対パスでも参照できるように
  return `/${r2Key}`;
}

/** Workers/Node どちらでも使える Base64 decode */
export function base64ToUint8Array(b64: string): Uint8Array {
  // Workers
  if (typeof atob === 'function') {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  }
  // Node.js compat
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const buf = Buffer.from(b64, 'base64');
  return new Uint8Array(buf);
}
