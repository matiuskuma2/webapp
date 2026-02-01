#!/usr/bin/env node
/**
 * S3 サイトアップロードのみ（メモリ軽量版）
 * 
 * 既にバンドル済みの dist/ を S3 にアップロード
 */

import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONFIG = {
  region: process.env.AWS_REGION || 'ap-northeast-1',
  siteBucket: process.env.SITE_BUCKET || 'remotionlambda-apnortheast1-ucgr0eo7k7',
  siteName: 'rilarc-video-build',
};

const CONTENT_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
};

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return CONTENT_TYPES[ext] || 'application/octet-stream';
}

function getAllFiles(dirPath, arrayOfFiles = [], basePath = dirPath) {
  const files = fs.readdirSync(dirPath);
  
  files.forEach((file) => {
    const fullPath = path.join(dirPath, file);
    if (fs.statSync(fullPath).isDirectory()) {
      getAllFiles(fullPath, arrayOfFiles, basePath);
    } else {
      arrayOfFiles.push({
        fullPath,
        relativePath: path.relative(basePath, fullPath),
      });
    }
  });
  
  return arrayOfFiles;
}

async function main() {
  console.log('🚀 S3 サイトアップロード開始');
  console.log('='.repeat(50));
  console.log('リージョン:', CONFIG.region);
  console.log('バケット:', CONFIG.siteBucket);
  console.log('サイト名:', CONFIG.siteName);
  console.log('='.repeat(50));

  const distPath = path.resolve(__dirname, '../dist');
  
  if (!fs.existsSync(distPath)) {
    console.error('❌ dist/ ディレクトリが見つかりません。npm run build を実行してください。');
    process.exit(1);
  }

  const s3Client = new S3Client({ region: CONFIG.region });
  const prefix = `sites/${CONFIG.siteName}/`;

  // Get all files
  const files = getAllFiles(distPath);
  console.log(`\n📁 ${files.length} ファイルを検出`);

  // Upload files
  let uploaded = 0;
  for (const file of files) {
    const key = prefix + file.relativePath.replace(/\\/g, '/');
    const body = fs.readFileSync(file.fullPath);
    const contentType = getContentType(file.fullPath);
    
    try {
      await s3Client.send(new PutObjectCommand({
        Bucket: CONFIG.siteBucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }));
      uploaded++;
      if (uploaded % 10 === 0 || uploaded === files.length) {
        console.log(`  アップロード進捗: ${uploaded}/${files.length}`);
      }
    } catch (err) {
      console.error(`❌ アップロード失敗: ${key}`, err.message);
    }
  }

  const serveUrl = `https://${CONFIG.siteBucket}.s3.${CONFIG.region}.amazonaws.com/${prefix}index.html`;
  
  console.log('\n' + '='.repeat(50));
  console.log('✅ アップロード完了!');
  console.log('='.repeat(50));
  console.log('Serve URL:', serveUrl);

  // Update deployment-info.json
  const deployInfo = {
    deployedAt: new Date().toISOString(),
    region: CONFIG.region,
    serveUrl,
    functionName: 'remotion-render-4-0-404-mem2048mb-disk2048mb-240sec',
    siteBucket: CONFIG.siteBucket,
    rendersBucket: 'rilarc-remotion-renders-prod-202601',
    features: [
      'Phase 1 Telop Style Presets (minimal, outline, band, pop, cinematic)',
      'Position presets (bottom, center, top)',
      'Size presets (sm, md, lg)',
      'A案 baked: BalloonOverlay',
      'text_render_mode: remotion/baked/none',
      'voices[] R1.5 複数話者音声',
      'MotionWrapper R2-C カメラワーク',
    ],
  };
  
  fs.writeFileSync(
    path.resolve(__dirname, '../deployment-info.json'),
    JSON.stringify(deployInfo, null, 2)
  );
  console.log('\n💾 deployment-info.json を更新しました');
}

main().catch(console.error);
