import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import videoConfig from '../config/video.config';
import { PROCESS_VIDEO_JOB, VIDEO_QUEUE } from '../queue/queue.constants';
import type { ProcessVideoJobData } from '../queue/process-video.job';
import { StorageService } from '../storage/storage.service';
import type { SignedPart } from '../storage/storage.service';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { Video, VideoStatus } from './entities/video.entity';
import {
  ChannelNotFoundException,
  ForbiddenChannelException,
  InvalidUploadStateException,
  UnsupportedMediaTypeException,
  UploadTooLargeException,
  VideoNotFoundException,
} from './exceptions/video.exceptions';
import { generatePublicId } from './public-id.util';

const PG_UNIQUE_VIOLATION = '23505';
const PUBLIC_ID_MAX_ATTEMPTS = 2;
const VIDEO_CONTENT_TYPE_PREFIX = 'video/';

export interface InitiateUploadResult {
  id: string;
  publicId: string;
  uploadId: string;
  key: string;
  partSize: number;
  parts: SignedPart[];
}

function isPublicIdUniqueViolation(err: unknown): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const e = err as QueryFailedError & { code?: string; detail?: string };
  return (
    e.code === PG_UNIQUE_VIOLATION &&
    typeof e.detail === 'string' &&
    e.detail.includes('public_id')
  );
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly channelsService: ChannelsService,
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
    @InjectQueue(VIDEO_QUEUE)
    private readonly videoQueue: Queue<ProcessVideoJobData>,
  ) {}

  async initiateUpload(
    userId: string,
    dto: InitiateUploadDto,
  ): Promise<InitiateUploadResult> {
    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new ChannelNotFoundException();
    }

    if (dto.sizeBytes > this.config.maxSizeBytes) {
      throw new UploadTooLargeException();
    }

    if (!dto.contentType.startsWith(VIDEO_CONTENT_TYPE_PREFIX)) {
      throw new UnsupportedMediaTypeException();
    }

    const partSize = this.config.multipartPartSize;
    const partCount = Math.ceil(dto.sizeBytes / partSize);

    const { video, key, uploadId } = await this.createDraftWithMultipart(
      channel.id,
      dto,
    );

    const parts = await this.storageService.signUploadParts(
      key,
      uploadId,
      partCount,
    );

    return {
      id: video.id,
      publicId: video.public_id,
      uploadId,
      key,
      partSize,
      parts,
    };
  }

  async completeUpload(
    userId: string,
    videoId: string,
    dto: CompleteUploadDto,
  ): Promise<{ id: string; status: VideoStatus }> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel || channel.id !== video.channel_id) {
      throw new ForbiddenChannelException();
    }

    if (video.status !== VideoStatus.DRAFT || !video.upload_id) {
      throw new InvalidUploadStateException();
    }

    await this.storageService.completeMultipartUpload(
      video.storage_key,
      video.upload_id,
      dto.parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag })),
    );

    const { contentLength } = await this.storageService.headObject(
      video.storage_key,
    );

    video.status = VideoStatus.PROCESSING;
    video.upload_id = null;
    video.size_bytes = String(contentLength);
    await this.videoRepository.save(video);

    await this.videoQueue.add(PROCESS_VIDEO_JOB, { videoId: video.id });

    return { id: video.id, status: video.status };
  }

  /**
   * Reserves a unique `public_id`, opens the S3 multipart upload and persists
   * the draft row. On the (astronomically unlikely) `public_id` collision, the
   * orphaned multipart is aborted and a fresh id is tried once more.
   */
  private async createDraftWithMultipart(
    channelId: string,
    dto: InitiateUploadDto,
  ): Promise<{ video: Video; key: string; uploadId: string }> {
    for (let attempt = 0; attempt < PUBLIC_ID_MAX_ATTEMPTS; attempt++) {
      const publicId = generatePublicId();
      const key = this.storageService.buildVideoKey(publicId);
      const uploadId = await this.storageService.createMultipartUpload(
        key,
        dto.contentType,
      );

      try {
        const video = await this.videoRepository.save(
          this.videoRepository.create({
            public_id: publicId,
            channel_id: channelId,
            title: dto.title,
            status: VideoStatus.DRAFT,
            storage_key: key,
            upload_id: uploadId,
            original_filename: dto.filename,
            size_bytes: String(dto.sizeBytes),
          }),
        );
        return { video, key, uploadId };
      } catch (err) {
        await this.storageService.abortMultipartUpload(key, uploadId);
        if (
          isPublicIdUniqueViolation(err) &&
          attempt < PUBLIC_ID_MAX_ATTEMPTS - 1
        ) {
          continue;
        }
        throw err;
      }
    }

    // Unreachable: the loop either returns or throws.
    throw new Error('Failed to reserve a unique public_id');
  }
}
