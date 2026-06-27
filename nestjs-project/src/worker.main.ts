import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker/worker.module';

/**
 * Standalone Nest application context for the `video-worker` container.
 * It does not start an HTTP server — it only hosts the BullMQ processor that
 * consumes the `video-processing` queue, so processing runs separately from
 * the API process.
 */
async function bootstrap(): Promise<void> {
  const appContext = await NestFactory.createApplicationContext(WorkerModule);
  appContext.enableShutdownHooks();
  Logger.log('Video worker started — consuming video-processing', 'Worker');
}
void bootstrap();
