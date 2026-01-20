import React from 'react';
import { AbsoluteFill, Sequence, Audio, useVideoConfig } from 'remotion';
import type { ProjectJson } from './schemas/project-schema';
import { Scene } from './components/Scene';
import { msToFrames } from './utils/timing';

interface RilarcVideoProps {
  projectJson: ProjectJson;
}

export const RilarcVideo: React.FC<RilarcVideoProps> = ({ projectJson }) => {
  const { fps } = useVideoConfig();
  
  // 各シーンの開始フレームを計算
  const scenesWithFrames = projectJson.scenes.map((scene) => {
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
