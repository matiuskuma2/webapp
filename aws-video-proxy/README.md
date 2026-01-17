# rilarc-video-proxy

AWS Lambda function for Google Veo video generation proxy.

## Purpose

This Lambda function serves as a proxy for Google Veo video generation API.
Cloudflare Workers cannot use the Google GenAI SDK due to CSP/dynamic code restrictions,
so this Lambda function handles the SDK calls and returns the generated video.

## Architecture

```
Cloudflare Workers (webapp)
    │
    │ HTTPS + SigV4 signature
    ▼
┌─────────────────────────────────────────────────────────┐
│  AWS (ap-northeast-1)                                   │
│                                                         │
│  ┌─────────────┐    ┌─────────────────────────────────┐ │
│  │ API Gateway │───▶│     Lambda                      │ │
│  │ (REST API)  │    │     rilarc-video-proxy          │ │
│  │             │    │                                 │ │
│  │ POST /video │    │  - Node.js 20                   │ │
│  │     /generate│   │  - @google/genai SDK            │ │
│  │             │    │  - Memory: 512MB                │ │
│  │ GET /video  │    │  - Timeout: 900s                │ │
│  │     /status │    │                                 │ │
│  └─────────────┘    └─────────────────────────────────┘ │
│                                                         │
└─────────────────────────────────────────────────────────┘
    │
    │ Gemini SDK
    ▼
Google Veo API (generativelanguage.googleapis.com)
```

## API Endpoints

### POST /video/generate

Generate a video from an image using Google Veo.

**Request Body:**
```json
{
  "image_base64": "base64 encoded image",
  "image_mime_type": "image/png",
  "prompt": "A beautiful cinematic scene",
  "duration_sec": 8,
  "api_key": "user's Gemini API key"
}
```

**Response (Success):**
```json
{
  "success": true,
  "status": "completed",
  "video": {
    "base64": "base64 encoded video",
    "mime_type": "video/mp4",
    "size_bytes": 1234567
  }
}
```

**Response (Error):**
```json
{
  "success": false,
  "status": "failed",
  "error": {
    "code": "INVALID_API_KEY",
    "message": "The provided API key is invalid"
  }
}
```

### GET /video/status/{jobId}

Get the status of a video generation job (for async mode - currently not used).

### GET /health

Health check endpoint.

## Development

### Prerequisites

- Node.js 20.x
- AWS CLI configured with appropriate credentials
- AWS Lambda access

### Install Dependencies

```bash
npm install
```

### Build

```bash
npm run build
```

### Package for Deployment

```bash
npm run package
```

This creates `function.zip` containing the compiled code and dependencies.

### Deploy

```bash
npm run deploy
```

Or manually:

```bash
aws lambda update-function-code \
  --function-name rilarc-video-proxy \
  --zip-file fileb://function.zip \
  --region ap-northeast-1
```

## Lambda Configuration

| Setting | Value |
|---------|-------|
| Runtime | Node.js 20.x |
| Handler | dist/index.handler |
| Memory | 512 MB |
| Timeout | 900 seconds (15 minutes) |
| Architecture | x86_64 |

## Environment Variables

| Variable | Description |
|----------|-------------|
| LOG_LEVEL | Log level (debug, info, warn, error) |

## Security

- API keys are passed per-request from Cloudflare (user's Gemini API key)
- API keys are NEVER stored in Lambda or logged
- IAM authentication via SigV4 for API Gateway
- Minimal IAM permissions (CloudWatch Logs only)

## Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| INVALID_API_KEY | 403 | Gemini API key is invalid |
| RATE_LIMITED | 429 | API rate limit exceeded |
| TIMEOUT | 504 | Generation timed out |
| GENERATION_FAILED | 500 | Video generation failed |
| INTERNAL_ERROR | 500 | Unexpected error |

## Cost Considerations

- Lambda: ~$0.20 per 1M requests + $0.00001667 per GB-second
- API Gateway: ~$1 per 1M requests
- Estimated monthly cost: $3-5 for typical usage
- Budget alarm set at $50/month

## Related Documentation

- [AWS Video Proxy Setup Guide](../webapp/docs/GENSPARK_INSTRUCTION_AWS_VIDEO_PROXY_SETUP.md)
- [Cloudflare Integration Guide](../webapp/docs/GENSPARK_INSTRUCTION_CLOUDFLARE_VIDEO_PROXY_INTEGRATION.md)
- [Google Veo API Documentation](https://ai.google.dev/gemini-api/docs/video)
