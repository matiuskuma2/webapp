#!/bin/bash
# Deploy script for rilarc-video-proxy Lambda function
# Usage: ./deploy.sh [create|update]

set -e

FUNCTION_NAME="rilarc-video-proxy"
REGION="ap-northeast-1"
RUNTIME="nodejs20.x"
HANDLER="dist/index.handler"
MEMORY_SIZE=512
TIMEOUT=900
ROLE_ARN="arn:aws:iam::YOUR_ACCOUNT_ID:role/rilarc-video-proxy-role"

echo "=== Building Lambda package ==="
npm run build

echo "=== Creating deployment package ==="
rm -f function.zip
cd dist && zip -r ../function.zip . && cd ..
zip -r function.zip node_modules

PACKAGE_SIZE=$(du -h function.zip | cut -f1)
echo "Package size: $PACKAGE_SIZE"

MODE=${1:-update}

if [ "$MODE" == "create" ]; then
    echo "=== Creating Lambda function ==="
    aws lambda create-function \
        --function-name $FUNCTION_NAME \
        --runtime $RUNTIME \
        --role $ROLE_ARN \
        --handler $HANDLER \
        --memory-size $MEMORY_SIZE \
        --timeout $TIMEOUT \
        --zip-file fileb://function.zip \
        --region $REGION \
        --environment Variables="{LOG_LEVEL=info}"
else
    echo "=== Updating Lambda function code ==="
    aws lambda update-function-code \
        --function-name $FUNCTION_NAME \
        --zip-file fileb://function.zip \
        --region $REGION
fi

echo "=== Deployment complete ==="
echo "Function: $FUNCTION_NAME"
echo "Region: $REGION"
