import React from 'react';
import { AbsoluteFill, Sequence, Audio, useVideoConfig, getInputProps } from 'remotion';
import type { ProjectJson } from './schemas/project-schema';
import { Scene } from './components/Scene';
import { msToFrames } from './utils/timing';

interface RilarcVideoProps {
  projectJson: ProjectJson;
}

export const RilarcVideo: React.FC<RilarcVideoProps> = (props) => {
  const { fps } = useVideoConfig();
  
  // CRITICAL: getInputProps() を使用して確実に inputProps を取得
  // Lambda 環境では props が正しく渡されない場合があるため
  const inputProps = getInputProps() as { projectJson?: ProjectJson };
  const projectJson = inputProps?.projectJson || props.projectJson;
  
  // Debug: props を確認
  console.log('[RilarcVideo] props.projectJson type:', typeof props.projectJson);
  console.log('[RilarcVideo] inputProps.projectJson type:', typeof inputProps?.projectJson);
  console.log('[RilarcVideo] final projectJson scenes:', projectJson?.scenes?.length);
  console.log('[RilarcVideo] first scene image:', projectJson?.scenes?.[0]?.assets?.image?.url);
  
  // 各シーンの開始フレームを計算
  const scenesWithFrames = (projectJson?.scenes || []).map((scene) => {
    const startFrame = msToFrames(scene.timing.start_ms, fps);
    const durationFrames = msToFrames(scene.timing.duration_ms, fps);
    return { scene, startFrame, durationFrames };
  });
  
  return (
    <AbsoluteFill style={{ backgroundColor: 'black' }}>
      {/* BGM（あれば） */}
      {projectJson.assets?.bgm && (
        <Audio
          src={projectJson.assets.bgm.url}
          volume={projectJson.build_settings.audio?.bgm_volume ?? 0.3}
          loop
        />
      )}
      
      {/* シーン群 */}
      {scenesWithFrames.map(({ scene, startFrame, durationFrames }) => (
        <Sequence
          key={scene.idx}
          from={startFrame}
          durationInFrames={durationFrames}
        >
          <Scene scene={scene} startFrame={startFrame} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
