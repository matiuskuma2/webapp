# video-build-remotion

Remotion-based video rendering system for RILARC.

## Purpose

This module contains the Remotion video composition and rendering logic. It is bundled and deployed to AWS Lambda via Remotion Lambda.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  AWS (ap-northeast-1)                                   │
│                                                         │
│  ┌─────────────────────────────────────────────────────┐│
│  │ S3: remotionlambda-apnortheast1-xxx                 ││
│  │                                                     ││
│  │  /sites/rilarc-video-build/                         ││
│  │    ├── index.html                                   ││
│  │    ├── bundle.js (Remotion composition)             ││
│  │    └── ...                                          ││
│  └─────────────────────────────────────────────────────┘│
│                      │                                  │
│                      ▼                                  │
│  ┌─────────────────────────────────────────────────────┐│
│  │ Lambda: remotion-render-4-0-404-mem2048mb-...       ││
│  │                                                     ││
│  │  - Memory: 2048MB                                   ││
│  │  - Disk: 2048MB                                     ││
│  │  - Timeout: 240s                                    ││
│  │  - Provisioned Concurrency: :live alias             ││
│  └─────────────────────────────────────────────────────┘│
│                      │                                  │
│                      ▼                                  │
│  ┌─────────────────────────────────────────────────────┐│
│  │ S3: rilarc-remotion-renders-prod-202601             ││
│  │  (Output videos with presigned URLs)                ││
│  └─────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────┘
```

## Project Structure

```
video-build-remotion/
├── src/
│   ├── index.ts           # Remotion entry point
│   ├── Root.tsx           # Root composition
│   ├── RilarcVideo.tsx    # Main video component
│   ├── components/
│   │   └── Scene.tsx      # Scene renderer
│   ├── schemas/
│   │   └── project-schema.ts  # Input props schema
│   └── utils/
│       └── timing.ts      # Duration calculations
├── scripts/
│   ├── deploy.mjs         # Remotion Lambda deploy script
│   └── test-render.mjs    # Local test render
├── remotion.config.ts     # Remotion configuration
├── package.json
└── tsconfig.json
```

## Input Schema

The video composition expects a `project_json` with the following structure:

```typescript
{
  project_id: number;
  scenes: Array<{
    idx: number;
    image_url?: string;      // Image asset URL
    comic_url?: string;      // Comic asset URL
    video_url?: string;      // Video asset URL
    audio_url?: string;      // Audio asset URL
    duration_ms: number;     // Scene duration in milliseconds
    display_asset_type: 'image' | 'comic' | 'video';
  }>;
  settings?: {
    fps?: number;            // Default: 30
    width?: number;          // Default: 1920
    height?: number;         // Default: 1080
  };
}
```

## Scripts

```bash
# Install dependencies
npm install

# Preview in Remotion Studio
npm run studio

# Local test render
npm run render

# Deploy to AWS Lambda
npm run deploy

# Test render via deployed Lambda
npm run test-render
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `AWS_ACCESS_KEY_ID` | AWS access key | - |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key | - |
| `AWS_REGION` | AWS Region | ap-northeast-1 |
| `SITE_BUCKET` | S3 bucket for Remotion site | rilarc-remotion-site-prod-202601 |
| `RENDERS_BUCKET` | S3 bucket for output videos | rilarc-remotion-renders-prod-202601 |

## Deployment

```bash
# Full deployment (site + function)
npm run deploy
```

This will:
1. Bundle the Remotion composition
2. Upload to S3 site bucket
3. Deploy/update Lambda function
4. Configure permissions

## Related

- `aws-orchestrator/` - Lambda that invokes this Remotion Lambda
- Main webapp: Provides project data and asset URLs

## License

Proprietary - All rights reserved
