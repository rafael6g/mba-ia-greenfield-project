import type { ConfigType } from '@nestjs/config';
import { Queue } from 'bullmq';
import { QueryFailedError, Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import videoConfig from '../config/video.config';
import { PROCESS_VIDEO_JOB } from '../queue/queue.constants';
import { StorageService } from '../storage/storage.service';
import { Channel } from '../channels/entities/channel.entity';
import { Video, VideoStatus } from './entities/video.entity';
import {
  ChannelNotFoundException,
  ForbiddenChannelException,
  InvalidUploadStateException,
  UnsupportedMediaTypeException,
  UploadTooLargeException,
  VideoNotFoundException,
} from './exceptions/video.exceptions';
import { VideosService } from './videos.service';

type VideoConfig = ConfigType<typeof videoConfig>;

const TEN_GB = 10737418240;
const FIFTY_MB = 52428800;

function makeConfig(overrides: Partial<VideoConfig> = {}): VideoConfig {
  return {
    maxSizeBytes: TEN_GB,
    multipartPartSize: FIFTY_MB,
    ffmpegPath: undefined,
    ffprobePath: undefined,
    thumbnailTimestamp: '50%',
    ...overrides,
  };
}

function makeChannel(): Channel {
  const c = new Channel();
  c.id = 'channel-uuid';
  c.user_id = 'user-id';
  return c;
}

function makeUniqueError(): QueryFailedError {
  const err = new QueryFailedError('INSERT', [], new Error());
  const mutable = err as QueryFailedError & { code?: string; detail?: string };
  mutable.code = '23505';
  mutable.detail = 'Key (public_id)=(abc) already exists.';
  return err;
}

interface Mocks {
  repo: { create: jest.Mock; save: jest.Mock; findOne: jest.Mock };
  storage: {
    buildVideoKey: jest.Mock;
    createMultipartUpload: jest.Mock;
    signUploadParts: jest.Mock;
    abortMultipartUpload: jest.Mock;
    completeMultipartUpload: jest.Mock;
    headObject: jest.Mock;
  };
  channels: { findByUserId: jest.Mock };
  queue: { add: jest.Mock };
}

function build(
  config: VideoConfig = makeConfig(),
  overrides: Partial<Mocks> = {},
): { service: VideosService; mocks: Mocks } {
  const mocks: Mocks = {
    repo: {
      create: jest.fn((v: Partial<Video>) => v as Video),
      save: jest.fn((v: Video) =>
        Promise.resolve(v.id ? v : { ...v, id: 'video-uuid' }),
      ),
      findOne: jest.fn(),
    },
    storage: {
      buildVideoKey: jest.fn((id: string) => `videos/${id}/source`),
      createMultipartUpload: jest.fn().mockResolvedValue('upload-id'),
      signUploadParts: jest
        .fn()
        .mockResolvedValue([{ partNumber: 1, url: 'https://minio/part1' }]),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      headObject: jest.fn().mockResolvedValue({ contentLength: 2048 }),
    },
    channels: { findByUserId: jest.fn().mockResolvedValue(makeChannel()) },
    queue: { add: jest.fn().mockResolvedValue(undefined) },
    ...overrides,
  };

  const service = new VideosService(
    mocks.repo as unknown as Repository<Video>,
    mocks.storage as unknown as StorageService,
    mocks.channels as unknown as ChannelsService,
    config,
    mocks.queue as unknown as Queue,
  );
  return { service, mocks };
}

function makeDraftVideo(): Video {
  const v = new Video();
  v.id = 'video-uuid';
  v.public_id = 'pub_id_1234';
  v.channel_id = 'channel-uuid';
  v.status = VideoStatus.DRAFT;
  v.storage_key = 'videos/pub_id_1234/source';
  v.upload_id = 'upload-id';
  return v;
}

const validDto = {
  title: 'My Video',
  filename: 'clip.mp4',
  contentType: 'video/mp4',
  sizeBytes: FIFTY_MB * 2 + 10,
};

describe('VideosService', () => {
  describe('initiateUpload', () => {
    it('resolves channel, opens multipart, signs parts and persists a draft', async () => {
      const { service, mocks } = build();

      const result = await service.initiateUpload('user-id', validDto);

      expect(mocks.channels.findByUserId).toHaveBeenCalledWith('user-id');
      expect(mocks.storage.createMultipartUpload).toHaveBeenCalledWith(
        expect.stringMatching(/^videos\/.+\/source$/),
        'video/mp4',
      );
      // 2 parts of 50MB + a remainder → ceil(sizeBytes / partSize) = 3
      expect(mocks.storage.signUploadParts).toHaveBeenCalledWith(
        expect.any(String),
        'upload-id',
        3,
      );
      const saveCalls = mocks.repo.save.mock.calls as unknown as Video[][];
      const saved = saveCalls[0][0];
      expect(saved.status).toBe(VideoStatus.DRAFT);
      expect(saved.upload_id).toBe('upload-id');
      expect(saved.channel_id).toBe('channel-uuid');
      expect(saved.size_bytes).toBe(String(validDto.sizeBytes));
      expect(result).toMatchObject({
        id: 'video-uuid',
        uploadId: 'upload-id',
        partSize: FIFTY_MB,
      });
      expect(result.publicId).toHaveLength(11);
    });

    it('throws ChannelNotFoundException when the caller has no channel', async () => {
      const { service, mocks } = build(makeConfig(), {
        channels: { findByUserId: jest.fn().mockResolvedValue(null) },
      });

      await expect(
        service.initiateUpload('user-id', validDto),
      ).rejects.toBeInstanceOf(ChannelNotFoundException);
      expect(mocks.storage.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('rejects an upload larger than the configured maximum', async () => {
      const { service } = build();

      await expect(
        service.initiateUpload('user-id', {
          ...validDto,
          sizeBytes: TEN_GB + 1,
        }),
      ).rejects.toBeInstanceOf(UploadTooLargeException);
    });

    it('rejects a non-video content type', async () => {
      const { service } = build();

      await expect(
        service.initiateUpload('user-id', {
          ...validDto,
          contentType: 'image/png',
        }),
      ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
    });

    it('retries once and aborts the orphan multipart on a public_id collision', async () => {
      const { service, mocks } = build();
      mocks.repo.save
        .mockRejectedValueOnce(makeUniqueError())
        .mockImplementationOnce((v: Video) =>
          Promise.resolve({ ...v, id: 'video-uuid' }),
        );

      const result = await service.initiateUpload('user-id', validDto);

      expect(mocks.storage.abortMultipartUpload).toHaveBeenCalledTimes(1);
      expect(mocks.repo.save).toHaveBeenCalledTimes(2);
      expect(result.id).toBe('video-uuid');
    });
  });

  describe('completeUpload', () => {
    const parts = [{ partNumber: 1, etag: 'etag-1' }];

    it('finalizes the multipart, sets processing, clears upload_id and enqueues the job', async () => {
      const video = makeDraftVideo();
      const { service, mocks } = build();
      mocks.repo.findOne.mockResolvedValue(video);

      const result = await service.completeUpload('user-id', video.id, {
        parts,
      });

      expect(mocks.storage.completeMultipartUpload).toHaveBeenCalledWith(
        video.storage_key,
        'upload-id',
        parts,
      );
      expect(mocks.storage.headObject).toHaveBeenCalledWith(video.storage_key);
      const saved = (mocks.repo.save.mock.calls[0] as Video[])[0];
      expect(saved.status).toBe(VideoStatus.PROCESSING);
      expect(saved.upload_id).toBeNull();
      expect(saved.size_bytes).toBe('2048');
      expect(mocks.queue.add).toHaveBeenCalledWith(PROCESS_VIDEO_JOB, {
        videoId: video.id,
      });
      expect(result).toEqual({
        id: video.id,
        status: VideoStatus.PROCESSING,
      });
    });

    it('throws VideoNotFoundException for an unknown id', async () => {
      const { service, mocks } = build();
      mocks.repo.findOne.mockResolvedValue(null);

      await expect(
        service.completeUpload('user-id', 'missing', { parts }),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('throws ForbiddenChannelException when the caller is not the owner', async () => {
      const video = makeDraftVideo();
      const otherChannel = new Channel();
      otherChannel.id = 'other-channel';
      const { service, mocks } = build();
      mocks.repo.findOne.mockResolvedValue(video);
      mocks.channels.findByUserId.mockResolvedValue(otherChannel);

      await expect(
        service.completeUpload('user-id', video.id, { parts }),
      ).rejects.toBeInstanceOf(ForbiddenChannelException);
      expect(mocks.storage.completeMultipartUpload).not.toHaveBeenCalled();
    });

    it('throws InvalidUploadStateException when the video is not a draft', async () => {
      const video = makeDraftVideo();
      video.status = VideoStatus.PROCESSING;
      const { service, mocks } = build();
      mocks.repo.findOne.mockResolvedValue(video);

      await expect(
        service.completeUpload('user-id', video.id, { parts }),
      ).rejects.toBeInstanceOf(InvalidUploadStateException);
    });
  });
});
