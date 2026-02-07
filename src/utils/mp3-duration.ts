/**
 * MP3 Duration Calculator
 * 
 * MP3ファイルのヘッダーを解析して正確なdurationを計算
 * CBR（固定ビットレート）とVBR（可変ビットレート）の両方に対応
 */

// MP3 Frame Header Constants
const BITRATE_INDEX = {
  // MPEG Version 1, Layer 3
  'v1l3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
  // MPEG Version 2/2.5, Layer 3
  'v2l3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
};

const SAMPLE_RATE_INDEX = {
  // MPEG Version 1
  'v1': [44100, 48000, 32000, 0],
  // MPEG Version 2
  'v2': [22050, 24000, 16000, 0],
  // MPEG Version 2.5
  'v2.5': [11025, 12000, 8000, 0],
};

interface MP3FrameHeader {
  version: 1 | 2 | 2.5;
  layer: 1 | 2 | 3;
  bitrate: number;      // kbps
  sampleRate: number;   // Hz
  frameSize: number;    // bytes
  samplesPerFrame: number;
}

/**
 * Parse MP3 frame header at given offset
 */
function parseFrameHeader(data: Uint8Array, offset: number): MP3FrameHeader | null {
  if (offset + 4 > data.length) return null;
  
  // Check frame sync (11 bits of 1s)
  if (data[offset] !== 0xFF || (data[offset + 1] & 0xE0) !== 0xE0) {
    return null;
  }
  
  const byte1 = data[offset + 1];
  const byte2 = data[offset + 2];
  
  // Version (bits 4-3 of byte1)
  const versionBits = (byte1 >> 3) & 0x03;
  let version: 1 | 2 | 2.5;
  switch (versionBits) {
    case 3: version = 1; break;      // MPEG Version 1
    case 2: version = 2; break;      // MPEG Version 2
    case 0: version = 2.5; break;    // MPEG Version 2.5
    default: return null;            // Reserved
  }
  
  // Layer (bits 2-1 of byte1)
  const layerBits = (byte1 >> 1) & 0x03;
  let layer: 1 | 2 | 3;
  switch (layerBits) {
    case 3: layer = 1; break;
    case 2: layer = 2; break;
    case 1: layer = 3; break;
    default: return null;            // Reserved
  }
  
  // We only handle Layer 3 (MP3)
  if (layer !== 3) return null;
  
  // Bitrate index (bits 7-4 of byte2)
  const bitrateIndex = (byte2 >> 4) & 0x0F;
  const bitrateTable = version === 1 ? BITRATE_INDEX['v1l3'] : BITRATE_INDEX['v2l3'];
  const bitrate = bitrateTable[bitrateIndex];
  if (bitrate === 0) return null;
  
  // Sample rate index (bits 3-2 of byte2)
  const sampleRateIndex = (byte2 >> 2) & 0x03;
  const sampleRateTable = version === 1 ? SAMPLE_RATE_INDEX['v1'] : 
                          version === 2 ? SAMPLE_RATE_INDEX['v2'] : 
                          SAMPLE_RATE_INDEX['v2.5'];
  const sampleRate = sampleRateTable[sampleRateIndex];
  if (sampleRate === 0) return null;
  
  // Padding (bit 1 of byte2)
  const padding = (byte2 >> 1) & 0x01;
  
  // Samples per frame (Layer 3)
  const samplesPerFrame = version === 1 ? 1152 : 576;
  
  // Frame size calculation (Layer 3)
  const frameSize = Math.floor((samplesPerFrame / 8 * bitrate * 1000) / sampleRate) + padding;
  
  return {
    version,
    layer,
    bitrate,
    sampleRate,
    frameSize,
    samplesPerFrame,
  };
}

/**
 * Skip ID3v2 tag if present
 */
function skipId3v2(data: Uint8Array): number {
  if (data.length < 10) return 0;
  
  // Check ID3 header
  if (data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33) { // "ID3"
    // Size is stored as syncsafe integer (4 bytes, 7 bits each)
    const size = ((data[6] & 0x7F) << 21) |
                 ((data[7] & 0x7F) << 14) |
                 ((data[8] & 0x7F) << 7) |
                 (data[9] & 0x7F);
    return 10 + size; // 10 bytes header + tag size
  }
  
  return 0;
}

/**
 * Check for Xing/Info VBR header
 */
function getXingHeader(data: Uint8Array, offset: number): { frames: number } | null {
  // Xing header is located after the frame header (4 bytes) + side info
  // Side info size depends on MPEG version and channel mode
  // For simplicity, search for "Xing" or "Info" within first 200 bytes of frame
  
  const searchEnd = Math.min(offset + 200, data.length);
  for (let i = offset + 4; i < searchEnd - 4; i++) {
    // Check for "Xing" or "Info"
    if ((data[i] === 0x58 && data[i+1] === 0x69 && data[i+2] === 0x6E && data[i+3] === 0x67) ||  // Xing
        (data[i] === 0x49 && data[i+1] === 0x6E && data[i+2] === 0x66 && data[i+3] === 0x6F)) { // Info
      const flags = (data[i+4] << 24) | (data[i+5] << 16) | (data[i+6] << 8) | data[i+7];
      
      if (flags & 0x01) { // Frames flag
        const frames = (data[i+8] << 24) | (data[i+9] << 16) | (data[i+10] << 8) | data[i+11];
        return { frames };
      }
    }
  }
  
  return null;
}

/**
 * Calculate MP3 duration from ArrayBuffer
 * 
 * @param buffer - MP3 file as ArrayBuffer
 * @returns duration in milliseconds, or null if unable to determine
 */
export function getMp3Duration(buffer: ArrayBuffer): number | null {
  const data = new Uint8Array(buffer);
  
  if (data.length < 100) {
    console.warn('[MP3Duration] File too small');
    return null;
  }
  
  // Skip ID3v2 tag
  let offset = skipId3v2(data);
  
  // Find first valid frame
  let firstFrame: MP3FrameHeader | null = null;
  const maxSearchOffset = Math.min(offset + 10000, data.length - 4);
  
  for (let i = offset; i < maxSearchOffset; i++) {
    if (data[i] === 0xFF && (data[i + 1] & 0xE0) === 0xE0) {
      const header = parseFrameHeader(data, i);
      if (header) {
        firstFrame = header;
        offset = i;
        break;
      }
    }
  }
  
  if (!firstFrame) {
    console.warn('[MP3Duration] No valid MP3 frame found');
    return null;
  }
  
  // Check for VBR header (Xing/Info)
  const xing = getXingHeader(data, offset);
  if (xing && xing.frames > 0) {
    // VBR: Calculate duration from frame count
    const durationSec = (xing.frames * firstFrame.samplesPerFrame) / firstFrame.sampleRate;
    console.log(`[MP3Duration] VBR detected: ${xing.frames} frames, ${durationSec.toFixed(3)}s`);
    return Math.round(durationSec * 1000);
  }
  
  // CBR: Calculate from file size and bitrate
  // Subtract ID3 tag size from total
  const audioDataSize = data.length - offset;
  const durationSec = (audioDataSize * 8) / (firstFrame.bitrate * 1000);
  
  console.log(`[MP3Duration] CBR detected: ${firstFrame.bitrate}kbps, ${durationSec.toFixed(3)}s`);
  return Math.round(durationSec * 1000);
}

/**
 * Calculate duration from file size and known bitrate
 * Fallback method when header parsing fails
 */
export function estimateMp3Duration(bytes: number, bitrateKbps: number = 128): number {
  return Math.round((bytes * 8) / (bitrateKbps * 1000) * 1000);
}
