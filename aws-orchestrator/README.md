# aws-orchestrator

AWS Lambda function for orchestrating Remotion video builds.

## Purpose

This Lambda function receives video build requests from Cloudflare Workers (webapp) and invokes Remotion Lambda for actual video rendering.

## Architecture

```
Cloudflare Workers (webapp)
    │
    │ POST /video/build/start
    │ (HTTPS + SigV4 signature)
    ▼
┌─────────────────────────────────────────────────────────┐
│  AWS (ap-northeast-1)                                   │
│                                                         │
│  ┌─────────────┐    ┌─────────────────────────────────┐ │
│  │ API Gateway │───▶│     Lambda                      │ │
│  │ (REST API)  │    │     rilarc-video-build-orch     │ │
│  │             │    │                                 │ │
│  │ POST /start │    │  - Invokes Remotion Lambda      │ │
│  │ GET /status │    │  - Returns render progress      │ │
│  │             │    │  - Generates presigned URLs     │ │
│  └─────────────┘    └─────────────────────────────────┘ │
│                               │                         │
│                               ▼                         │
│                     ┌─────────────────────────────────┐ │
│                     │ Remotion Lambda                 │ │
│                     │ remotion-render-4-0-404-...     │ │
│                     │ (Provisioned Concurrency :live) │ │
│                     └─────────────────────────────────┘ │
│                               │                         │
│                               ▼                         │
│                     ┌─────────────────────────────────┐ │
│                     │ S3: rilarc-remotion-renders-... │ │
│                     │ (Output videos)                 │ │
│                     └─────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

## Endpoints

- `POST /video/build/start` - Start Remotion render
- `GET /video/build/status/{buildId}` - Get render progress and presigned URL

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `AWS_REGION` | AWS Region | ap-northeast-1 |
| `REMOTION_FUNCTION_NAME` | Remotion Lambda function name with :live alias | remotion-render-4-0-404-mem2048mb-disk2048mb-240sec:live |
| `REMOTION_SERVE_URL` | S3 site URL for Remotion | - |
| `OUTPUT_BUCKET` | S3 bucket for rendered videos | rilarc-remotion-renders-prod-202601 |

## Deployment

```bash
# 1. Install dependencies
npm install

# 2. Create deployment package
zip -r function.zip index.mjs node_modules

# 3. Deploy to AWS Lambda
aws lambda update-function-code \
  --function-name rilarc-video-build-orch \
  --zip-file fileb://function.zip \
  --region ap-northeast-1
```

## Related

- `video-build-remotion/` - Remotion video rendering logic
- `aws-video-proxy/` - Google Veo API proxy
- Main webapp: Cloudflare Workers that calls this Lambda

## License

Proprietary - All rights reserved
