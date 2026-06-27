import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import ffmpeg from 'fluent-ffmpeg';
import type { FfprobeData } from 'fluent-ffmpeg';
import { Repository } from 'typeorm';
import videoConfig from '../config/video.config';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';

const THUMBNAIL_FILENAME = 'thumbnail.jpg';
const THUMBNAIL_SIZE = '640x?';

export interface VideoMetadata {
  width: number | null;
  height: number | null;
  codec: string | null;
  bitrate: number | null;
}

@Injectable()
export class VideoProcessingService {
  private readonly logger = new Logger(VideoProcessingService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
  ) {
    if (this.config.ffmpegPath) {
      ffmpeg.setFfmpegPath(this.config.ffmpegPath);
    }
    if (this.config.ffprobePath) {
      ffmpeg.setFfprobePath(this.config.ffprobePath);
    }
  }

  async process(videoId: string): Promise<void> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });
    if (!video) {
      throw new Error(`Video ${videoId} not found for processing`);
    }

    const workDir = await mkdtemp(join(tmpdir(), 'streamtube-'));
    const sourcePath = join(workDir, 'source');

    try {
      await this.downloadSource(video.storage_key, sourcePath);

      const probe = await this.probe(sourcePath);
      const duration = Math.round(probe.format.duration ?? 0);
      const metadata = this.extractMetadata(probe);

      const thumbnailPath = await this.generateThumbnail(sourcePath, workDir);
      const thumbnailBuffer = await readFile(thumbnailPath);
      const thumbnailKey = this.storageService.buildThumbnailKey(
        video.public_id,
      );
      await this.storageService.putObject(
        thumbnailKey,
        thumbnailBuffer,
        'image/jpeg',
      );

      video.duration = duration;
      video.metadata = metadata as unknown as Record<string, unknown>;
      video.thumbnail_key = thumbnailKey;
      video.status = VideoStatus.READY;
      video.error_reason = null;
      await this.videoRepository.save(video);
      this.logger.log(`Video ${videoId} processed (duration=${duration}s)`);
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  /**
   * Terminal-failure handler: invoked by the processor once BullMQ has
   * exhausted the configured retries. Persists the failed status so clients
   * polling the status endpoint see the outcome.
   */
  async markFailed(videoId: string, reason: string): Promise<void> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });
    if (!video) {
      return;
    }
    video.status = VideoStatus.FAILED;
    video.error_reason = reason.slice(0, 255);
    await this.videoRepository.save(video);
  }

  private async downloadSource(key: string, destPath: string): Promise<void> {
    const url = await this.storageService.getPresignedDownloadUrl(key);
    const res = await fetch(url);
    if (!res.ok || !res.body) {
      throw new Error(`Failed to download source object (status ${res.status})`);
    }
    await pipeline(
      Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(destPath),
    );
  }

  private async probe(path: string): Promise<FfprobeData> {
    return new Promise<FfprobeData>((resolve, reject) => {
      ffmpeg.ffprobe(path, (err, data) => {
        if (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        resolve(data);
      });
    });
  }

  private extractMetadata(probe: FfprobeData): VideoMetadata {
    const stream = probe.streams.find((s) => s.codec_type === 'video');
    const bitrate = probe.format.bit_rate;
    return {
      width: stream?.width ?? null,
      height: stream?.height ?? null,
      codec: stream?.codec_name ?? null,
      bitrate: bitrate ? Number(bitrate) : null,
    };
  }

  private async generateThumbnail(
    sourcePath: string,
    workDir: string,
  ): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      ffmpeg(sourcePath)
        .on('end', () => resolve())
        .on('error', (err: Error) => reject(err))
        .screenshots({
          timestamps: [this.config.thumbnailTimestamp],
          filename: THUMBNAIL_FILENAME,
          folder: workDir,
          size: THUMBNAIL_SIZE,
        });
    });
    return join(workDir, THUMBNAIL_FILENAME);
  }
}
