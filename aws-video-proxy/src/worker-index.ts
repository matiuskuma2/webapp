/**
 * rilarc-video-worker Lambda Entry Point
 * 
 * This is a separate Lambda function triggered by SQS.
 * It handles the actual video generation work.
 * 
 * Trigger: SQS queue (rilarc-video-queue)
 * Timeout: 15 minutes
 * Memory: 512MB or higher recommended
 */

export { handler, processJobDirect } from './handlers/worker';
