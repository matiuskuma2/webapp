#!/usr/bin/env node
/**
 * RILARC Remotion Lambda デプロイスクリプト
 * 
 * 使用方法:
 *   node scripts/deploy.mjs
 * 
 * 環境変数:
 *   AWS_ACCESS_KEY_ID     - AWS アクセスキー
 *   AWS_SECRET_ACCESS_KEY - AWS シークレットキー
 *   AWS_REGION            - リージョン (default: ap-northeast-1)
 */

import { deploySite, deployFunction, getRegions } from '@remotion/lambda';
import { bundle } from '@remotion/bundler';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ======== 設定 ========
const CONFIG = {
  region: process.env.AWS_REGION || 'ap-northeast-1',
  siteBucket: process.env.SITE_BUCKET || 'rilarc-remotion-site-prod-202601',
  rendersBucket: process.env.RENDERS_BUCKET || 'rilarc-remotion-renders-prod-202601',
  functionName: 'rilarc-video-build-prod',
  memorySizeInMb: 2048,
  diskSizeInMb: 2048,
  timeoutInSeconds: 240,
  enableCloudwatchLogging: true,
};

async function main() {
  console.log('🚀 RILARC Remotion Lambda デプロイ開始');
  console.log('='.repeat(50));
  console.log('リージョン:', CONFIG.region);
  console.log('Site バケット:', CONFIG.siteBucket);
  console.log('Renders バケット:', CONFIG.rendersBucket);
  console.log('Lambda 関数名:', CONFIG.functionName);
  console.log('='.repeat(50));

  try {
    // Step 1: Bundle the project
    console.log('\n📦 Step 1: プロジェクトをバンドル中...');
    const bundled = await bundle({
      entryPoint: path.resolve(__dirname, '../src/index.ts'),
      webpackOverride: (config) => config,
    });
    console.log('✅ バンドル完了:', bundled);

    // Step 2: Deploy site to S3
    console.log('\n☁️ Step 2: サイトを S3 にデプロイ中...');
    const { serveUrl } = await deploySite({
      siteName: 'rilarc-video-build',
      bucketName: CONFIG.siteBucket,
      region: CONFIG.region,
      entryPoint: path.resolve(__dirname, '../src/index.ts'),
      options: {
        webpackOverride: (config) => config,
      },
    });
    console.log('✅ サイトデプロイ完了');
    console.log('   Serve URL:', serveUrl);

    // Step 3: Deploy Lambda function
    console.log('\n⚡ Step 3: Lambda 関数をデプロイ中...');
    const { functionName, alreadyExisted } = await deployFunction({
      region: CONFIG.region,
      memorySizeInMb: CONFIG.memorySizeInMb,
      diskSizeInMb: CONFIG.diskSizeInMb,
      timeoutInSeconds: CONFIG.timeoutInSeconds,
      enableCloudwatchLogging: CONFIG.enableCloudwatchLogging,
      architecture: 'arm64',
      customRoleArn: undefined, // 自動生成されるロールを使用
    });
    
    console.log('✅ Lambda 関数デプロイ完了');
    console.log('   関数名:', functionName);
    console.log('   既存関数を更新:', alreadyExisted ? 'はい' : 'いいえ（新規作成）');

    // Summary
    console.log('\n' + '='.repeat(50));
    console.log('🎉 デプロイ完了!');
    console.log('='.repeat(50));
    console.log('\n📋 デプロイ情報:');
    console.log(JSON.stringify({
      region: CONFIG.region,
      serveUrl,
      functionName,
      siteBucket: CONFIG.siteBucket,
      rendersBucket: CONFIG.rendersBucket,
      memorySizeInMb: CONFIG.memorySizeInMb,
      timeoutInSeconds: CONFIG.timeoutInSeconds,
    }, null, 2));

    // Save deployment info
    const deployInfo = {
      deployedAt: new Date().toISOString(),
      region: CONFIG.region,
      serveUrl,
      functionName,
      siteBucket: CONFIG.siteBucket,
      rendersBucket: CONFIG.rendersBucket,
    };
    
    const fs = await import('fs');
    fs.writeFileSync(
      path.resolve(__dirname, '../deployment-info.json'),
      JSON.stringify(deployInfo, null, 2)
    );
    console.log('\n💾 deployment-info.json に保存しました');

  } catch (error) {
    console.error('\n❌ デプロイエラー:', error.message);
    console.error(error);
    process.exit(1);
  }
}

main();
