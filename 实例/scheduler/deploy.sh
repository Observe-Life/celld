#!/bin/sh
set -e
cd "$(dirname "$0")"
cp wrangler.template.jsonc wrangler.jsonc
set -a; . ../../.env; set +a
docker run --rm --network backend -v "$(pwd)":/app -w /app \
  -e AWS_ACCESS_KEY_ID=$MINIO_ROOT_USER -e AWS_SECRET_ACCESS_KEY=$MINIO_ROOT_PASSWORD \
  -e S3_ENDPOINT=http://minio:9000 -e AWS_REGION=us-east-1 \
  celld-full:latest deploy . --bucket s3://celld-fleet
