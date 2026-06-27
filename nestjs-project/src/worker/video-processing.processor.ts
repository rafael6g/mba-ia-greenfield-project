import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import type { ProcessVideoJobData } from '../queue/process-video.job';
import { VIDEO_QUEUE } from '../queue/queue.constants';
import { VideoProcessingService } from './video-processing.service';

@Processor(VIDEO_QUEUE)
export class VideoProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  constructor(private readonly processingService: VideoProcessingService) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    await this.processingService.process(job.data.videoId);
  }

  /**
   * Only the *terminal* failure (retries exhausted) flips the video to
   * `failed`; transient failures are left for BullMQ's retry/backoff. The
   * failed job is retained (`removeOnFail: false`) as the dead-letter record.
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job<ProcessVideoJobData>): Promise<void> {
    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) {
      this.logger.warn(
        `Job ${job.id} failed (attempt ${job.attemptsMade}/${maxAttempts}), will retry`,
      );
      return;
    }

    const reason = job.failedReason ?? 'Unknown processing error';
    this.logger.error(
      `Job ${job.id} permanently failed for video ${job.data.videoId}: ${reason}`,
    );
    await this.processingService.markFailed(job.data.videoId, reason);
  }
}
