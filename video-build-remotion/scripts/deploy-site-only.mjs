#!/usr/bin/env node
/**
 * Remotion サイトのみ再デプロイ（Lambda関数は変更しない）
 * 
 * バンドル済み dist/ を deploySite API 経由で S3 にアップロード
 * 
 * 環境変数:
 *   AWS_ACCESS_KEY_ID     - AWS アクセスキー
 *   AWS_SECRET_ACCESS_KEY - AWS シークレットキー
 *   AWS_REGION            - リージョン (default: ap-northeast-1)
 */

import { deploySite } from '@remotion/lambda';
import { bundle } from '@remotion/bundler';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONFIG = {
  region: process.env.AWS_REGION || 'ap-northeast-1',
  siteBucket: process.env.SITE_BUCKET || 'remotionlambda-apnortheast1-ucgr0eo7k7',
  siteName: 'rilarc-video-build',
};

async function main() {
  console.log('🚀 Remotion サイトのみ再デプロイ');
  console.log('='.repeat(50));
  console.log('リージョン:', CONFIG.region);
  console.log('バケット:', CONFIG.siteBucket);
  console.log('サイト名:', CONFIG.siteName);
  console.log('='.repeat(50));

  try {
    // Step 1: Bundle
    console.log('\n📦 Step 1: バンドル中...');
    const bundled = await bundle({
      entryPoint: path.resolve(__dirname, '../src/index.ts'),
      webpackOverride: (config) => config,
    });
    console.log('✅ バンドル完了:', bundled);

    // Step 2: Deploy site to S3 via Remotion API
    console.log('\n☁️ Step 2: deploySite API でサイトをデプロイ中...');
    const { serveUrl } = await deploySite({
      siteName: CONFIG.siteName,
      bucketName: CONFIG.siteBucket,
      region: CONFIG.region,
      entryPoint: path.resolve(__dirname, '../src/index.ts'),
      options: {
        webpackOverride: (config) => config,
      },
    });
    console.log('✅ サイトデプロイ完了');
    console.log('   Serve URL:', serveUrl);

    // Update deployment-info.json
    const deployInfoPath = path.resolve(__dirname, '../deployment-info.json');
    let deployInfo = {};
    if (fs.existsSync(deployInfoPath)) {
      deployInfo = JSON.parse(fs.readFileSync(deployInfoPath, 'utf-8'));
    }
    deployInfo.deployedAt = new Date().toISOString();
    deployInfo.serveUrl = serveUrl;
    deployInfo.region = CONFIG.region;
    deployInfo.siteBucket = CONFIG.siteBucket;
    deployInfo.features = [
      ...(deployInfo.features || []).filter(f => !f.includes('Voice duration safety')),
      'Voice duration safety validation (audio cutoff prevention)',
      'Video freeze at last frame when audio > video duration',
    ];
    
    fs.writeFileSync(deployInfoPath, JSON.stringify(deployInfo, null, 2));
    console.log('\n💾 deployment-info.json を更新しました');

    console.log('\n' + '='.repeat(50));
    console.log('🎉 サイト再デプロイ完了!');
    console.log('='.repeat(50));

  } catch (error) {
    console.error('\n❌ デプロイエラー:', error.message);
    console.error(error);
    process.exit(1);
  }
}

main();
