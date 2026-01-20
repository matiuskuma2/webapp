#!/usr/bin/env node
/**
 * RILARC Remotion Lambda テストレンダリングスクリプト
 * 
 * 使用方法:
 *   node scripts/test-render.mjs
 * 
 * 環境変数:
 *   AWS_ACCESS_KEY_ID     - AWS アクセスキー
 *   AWS_SECRET_ACCESS_KEY - AWS シークレットキー
 *   AWS_REGION            - リージョン (default: ap-northeast-1)
 */

import { renderMediaOnLambda, getRenderProgress } from '@remotion/lambda';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ======== 設定 ========
const CONFIG = {
  region: process.env.AWS_REGION || 'ap-northeast-1',
  rendersBucket: process.env.RENDERS_BUCKET || 'rilarc-remotion-renders-prod-202601',
};

// deployment-info.json から読み込み
function loadDeploymentInfo() {
  const infoPath = path.resolve(__dirname, '../deployment-info.json');
  if (!fs.existsSync(infoPath)) {
    console.error('❌ deployment-info.json が見つかりません。');
    console.error('   先に npm run deploy を実行してください。');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(infoPath, 'utf-8'));
}

// テスト用の inputProps（3シーン）
const TEST_INPUT_PROPS = {
  meta: {
    projectId: 'test-project-001',
    title: 'テストレンダリング',
    totalDuration: 24, // 8秒 × 3シーン = 24秒
    fps: 30,
    resolution: { width: 1920, height: 1080 },
    version: '1.0',
    exportedAt: new Date().toISOString(),
  },
  scenes: [
    {
      index: 0,
      startFrame: 0,
      durationFrames: 240, // 8秒 × 30fps
      imageUrl: 'https://placehold.co/1920x1080/3498db/ffffff?text=Scene+1',
      audioUrl: null,
      dialogue: 'これはテストシーン1です。',
      character: 'ナレーター',
    },
    {
      index: 1,
      startFrame: 240,
      durationFrames: 240,
      imageUrl: 'https://placehold.co/1920x1080/e74c3c/ffffff?text=Scene+2',
      audioUrl: null,
      dialogue: 'これはテストシーン2です。',
      character: '太郎',
    },
    {
      index: 2,
      startFrame: 480,
      durationFrames: 240,
      imageUrl: 'https://placehold.co/1920x1080/2ecc71/ffffff?text=Scene+3',
      audioUrl: null,
      dialogue: 'これはテストシーン3です。',
      character: '花子',
    },
  ],
};

async function main() {
  console.log('🧪 RILARC Remotion Lambda テストレンダリング');
  console.log('='.repeat(50));

  const deployInfo = loadDeploymentInfo();
  console.log('デプロイ情報:', JSON.stringify(deployInfo, null, 2));
  console.log('='.repeat(50));

  try {
    // Step 1: Start render
    console.log('\n🎬 Step 1: レンダリング開始...');
    const renderStart = Date.now();
    
    const { renderId, bucketName } = await renderMediaOnLambda({
      region: CONFIG.region,
      functionName: deployInfo.functionName,
      serveUrl: deployInfo.serveUrl,
      composition: 'RilarcVideo',
      inputProps: TEST_INPUT_PROPS,
      codec: 'h264',
      imageFormat: 'jpeg',
      maxRetries: 1,
      privacy: 'private',
      outName: `test-render-${Date.now()}.mp4`,
      // framesPerLambda: 300, // オプション：並列処理の粒度
    });

    console.log('✅ レンダリング開始');
    console.log('   Render ID:', renderId);
    console.log('   出力バケット:', bucketName);

    // Step 2: Poll for progress
    console.log('\n⏳ Step 2: 進捗を監視中...');
    
    let progress;
    let lastPercent = 0;
    
    while (true) {
      progress = await getRenderProgress({
        renderId,
        bucketName,
        region: CONFIG.region,
        functionName: deployInfo.functionName,
      });

      const percent = Math.round((progress.overallProgress || 0) * 100);
      if (percent !== lastPercent) {
        console.log(`   進捗: ${percent}%`);
        lastPercent = percent;
      }

      if (progress.done) {
        break;
      }

      if (progress.fatalErrorEncountered) {
        throw new Error(`レンダリングエラー: ${progress.errors?.join(', ')}`);
      }

      // 3秒待機
      await new Promise(resolve => setTimeout(resolve, 3000));
    }

    const renderTime = ((Date.now() - renderStart) / 1000).toFixed(1);

    // Step 3: Output result
    console.log('\n' + '='.repeat(50));
    console.log('🎉 テストレンダリング完了!');
    console.log('='.repeat(50));
    console.log('   レンダリング時間:', renderTime, '秒');
    console.log('   出力ファイル:', progress.outputFile);
    console.log('   出力サイズ:', progress.outputSizeInBytes, 'bytes');
    
    // Generate presigned URL (24時間有効)
    if (progress.outputFile) {
      console.log('\n📎 出力ファイル情報:');
      console.log('   S3 URI:', `s3://${bucketName}/${progress.outputFile}`);
      console.log('   ※ 署名URLは RILARC API 経由で取得してください');
    }

    // Save test result
    const testResult = {
      testedAt: new Date().toISOString(),
      renderId,
      bucketName,
      outputFile: progress.outputFile,
      outputSizeInBytes: progress.outputSizeInBytes,
      renderTimeSeconds: parseFloat(renderTime),
      inputProps: TEST_INPUT_PROPS,
    };
    
    fs.writeFileSync(
      path.resolve(__dirname, '../test-result.json'),
      JSON.stringify(testResult, null, 2)
    );
    console.log('\n💾 test-result.json に保存しました');

  } catch (error) {
    console.error('\n❌ テストエラー:', error.message);
    console.error(error);
    process.exit(1);
  }
}

main();
