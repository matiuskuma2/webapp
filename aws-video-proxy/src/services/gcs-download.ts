/**
 * GCS Download Service
 * 
 * Downloads files from Google Cloud Storage using Service Account authentication.
 * Used when Vertex AI Veo3 outputs video to GCS instead of returning bytes directly.
 */

import { getVertexAccessToken } from './vertex-auth';
import { logger } from '../utils/logger';

// =============================================================================
// Types
// =============================================================================

interface GcsUri {
  bucket: string;
  object: string;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Parse GCS URI into bucket and object path
 * @param gsUri - GCS URI in format gs://bucket/path/to/object
 */
function parseGcsUri(gsUri: string): GcsUri {
  const match = gsUri.match(/^gs:\/\/([^/]+)\/(.+)$/);
  if (!match) {
    throw new Error(`Invalid GCS URI format: ${gsUri}`);
  }
  return {
    bucket: match[1],
    object: match[2],
  };
}

// =============================================================================
// Main Functions
// =============================================================================

/**
 * Download object from GCS as bytes
 * 
 * @param serviceAccountJson - SA JSON for authentication
 * @param gsUri - GCS URI (gs://bucket/path/to/object)
 * @returns Object bytes as Uint8Array
 */
export async function downloadGcsObject(
  serviceAccountJson: string,
  gsUri: string
): Promise<{
  bytes: Uint8Array;
  contentType: string;
  size: number;
}> {
  const { accessToken } = await getVertexAccessToken(serviceAccountJson);
  const { bucket, object } = parseGcsUri(gsUri);

  // GCS JSON API - download object
  // https://cloud.google.com/storage/docs/json_api/v1/objects/get
  const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}?alt=media`;

  logger.info('Downloading object from GCS', {
    bucket,
    object: object.substring(0, 100),
    uri: gsUri.substring(0, 100),
  });

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    logger.error('GCS download failed', {
      status: res.status,
      bucket,
      object: object.substring(0, 100),
      errorPreview: text.substring(0, 200),
    });
    throw new Error(`GCS download failed: HTTP ${res.status}`);
  }

  const contentType = res.headers.get('content-type') || 'video/mp4';
  const buffer = await res.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  logger.info('GCS download completed', {
    bucket,
    object: object.substring(0, 100),
    size: bytes.length,
    contentType,
  });

  return {
    bytes,
    contentType,
    size: bytes.length,
  };
}

/**
 * Get GCS object metadata without downloading
 * 
 * @param serviceAccountJson - SA JSON for authentication
 * @param gsUri - GCS URI
 */
export async function getGcsObjectMetadata(
  serviceAccountJson: string,
  gsUri: string
): Promise<{
  name: string;
  bucket: string;
  size: string;
  contentType: string;
  updated: string;
}> {
  const { accessToken } = await getVertexAccessToken(serviceAccountJson);
  const { bucket, object } = parseGcsUri(gsUri);

  // GCS JSON API - get object metadata
  const url = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}`;

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GCS metadata fetch failed: HTTP ${res.status} - ${text.substring(0, 200)}`);
  }

  return await res.json() as {
    name: string;
    bucket: string;
    size: string;
    contentType: string;
    updated: string;
  };
}

/**
 * Check if a GCS URI is valid format
 */
export function isValidGcsUri(uri: string): boolean {
  return /^gs:\/\/[^/]+\/.+$/.test(uri);
}
