# aws-orchestrator-b2

AWS Lambda orchestrator using Remotion Lambda SDK (alternative implementation).

## Note

This is an alternative implementation of `aws-orchestrator/` that uses the Remotion Lambda SDK directly instead of direct Lambda invocation.

Currently **not in production use**. The main orchestrator is `aws-orchestrator/`.

## Purpose

Provides an alternative approach for invoking Remotion Lambda using the official SDK:
- `renderMediaOnLambda()` for starting renders
- `getRenderProgress()` for checking status

## When to use

Consider using this if:
- Remotion Lambda SDK API changes
- Need SDK-specific features not available in direct invocation
- Testing/debugging Remotion integration

## Deployment

Same as `aws-orchestrator/`:

```bash
npm ci
zip -r function.zip index.mjs node_modules
aws lambda update-function-code \
  --function-name rilarc-video-build-orch-b2 \
  --zip-file fileb://function.zip \
  --region ap-northeast-1
```

## License

Proprietary - All rights reserved
