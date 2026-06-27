import type { ConfigType } from '@nestjs/config';
import { Repository } from 'typeorm';
import videoConfig from '../config/video.config';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/entities/video.entity';

// ---- Module mocks (declared before importing the service under test) ----

const ffmpegState: {
  handlers: Record<string, (...args: unknown[]) => void>;
  probeData: unknown;
} = { handlers: {}, probeData: undefined };

jest.mock('fluent-ffmpeg', () => {
  const command: { on: jest.Mock; screenshots: jest.Mock } = {
    on: jest.fn((event: string, cb: (...args: unknown[]) => void) => {
      ffmpegState.handlers[event] = cb;
      return command;
    }),
    screenshots: jest.fn((): void => {
      // Simulate ffmpeg finishing the screenshot job.
      ffmpegState.handlers['end']?.();
    }),
  };
  const ffmpeg = jest.fn((): typeof command => command) as unknown as {
    (path: string): typeof command;
    ffprobe: jest.Mock;
    setFfmpegPath: jest.Mock;
    setFfprobePath: jest.Mock;
  };
  ffmpeg.ffprobe = jest.fn(
    (_path: string, cb: (err: Error | null, data: unknown) => void): void => {
      cb(null, ffmpegState.probeData);
    },
  );
  ffmpeg.setFfmpegPath = jest.fn();
  ffmpeg.setFfprobePath = jest.fn();
  return { __esModule: true, default: ffmpeg };
});

jest.mock('node:fs', () => ({
  ...jest.requireActual<typeof import('node:fs')>('node:fs'),
  createWriteStream: jest.fn((): object => ({})),
}));
jest.mock('node:fs/promises', () => ({
  ...jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises'),
  mkdtemp: jest.fn().mockResolvedValue('/tmp/streamtube-test'),
  readFile: jest.fn().mockResolvedValue(Buffer.from('jpeg-bytes')),
  rm: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('node:stream/promises', () => ({
  ...jest.requireActual<typeof import('node:stream/promises')>(
    'node:stream/promises',
  ),
  pipeline: jest.fn().mockResolvedValue(undefined),
}));

import { VideoProcessingService } from './video-processing.service';

type VideoConfig = ConfigType<typeof videoConfig>;

function makeConfig(): VideoConfig {
  return {
    maxSizeBytes: 10737418240,
    multipartPartSize: 52428800,
    ffmpegPath: undefined,
    ffprobePath: undefined,
    thumbnailTimestamp: '50%',
  };
}

interface Mocks {
  repo: { findOne: jest.Mock; save: jest.Mock };
  storage: {
    buildThumbnailKey: jest.Mock;
    getPresignedDownloadUrl: jest.Mock;
    putObject: jest.Mock;
  };
}

function build(): { service: VideoProcessingService; mocks: Mocks } {
  const mocks: Mocks = {
    repo: {
      findOne: jest.fn(),
      save: jest.fn((v: Video) => Promise.resolve(v)),
    },
    storage: {
      buildThumbnailKey: jest.fn((id: string) => `videos/${id}/thumbnail.jpg`),
      getPresignedDownloadUrl: jest
        .fn()
        .mockResolvedValue('http://minio:9000/presigned'),
      putObject: jest.fn().mockResolvedValue(undefined),
    },
  };
  const service = new VideoProcessingService(
    mocks.repo as unknown as Repository<Video>,
    mocks.storage as unknown as StorageService,
    makeConfig(),
  );
  return { service, mocks };
}

function makeVideo(): Video {
  const v = new Video();
  v.id = 'video-uuid';
  v.public_id = 'pub_id_1234';
  v.storage_key = 'videos/pub_id_1234/source';
  v.status = VideoStatus.PROCESSING;
  return v;
}

describe('VideoProcessingService', () => {
  beforeEach(() => {
    ffmpegState.handlers = {};
    ffmpegState.probeData = {
      format: { duration: 42.7, bit_rate: '800000' },
      streams: [
        { codec_type: 'audio', codec_name: 'aac' },
        {
          codec_type: 'video',
          codec_name: 'h264',
          width: 1280,
          height: 720,
        },
      ],
    };
    (global.fetch as unknown) = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array([0, 1, 2]));
          controller.close();
        },
      }),
    });
  });

  describe('process', () => {
    it('probes duration/metadata, uploads the thumbnail and sets ready', async () => {
      const video = makeVideo();
      const { service, mocks } = build();
      mocks.repo.findOne.mockResolvedValue(video);

      await service.process(video.id);

      expect(mocks.storage.putObject).toHaveBeenCalledWith(
        'videos/pub_id_1234/thumbnail.jpg',
        expect.any(Buffer),
        'image/jpeg',
      );
      const saved = (mocks.repo.save.mock.calls[0] as Video[])[0];
      expect(saved.status).toBe(VideoStatus.READY);
      expect(saved.duration).toBe(43); // round(42.7)
      expect(saved.thumbnail_key).toBe('videos/pub_id_1234/thumbnail.jpg');
      expect(saved.metadata).toEqual({
        width: 1280,
        height: 720,
        codec: 'h264',
        bitrate: 800000,
      });
      expect(saved.error_reason).toBeNull();
    });

    it('throws when the video does not exist', async () => {
      const { service, mocks } = build();
      mocks.repo.findOne.mockResolvedValue(null);

      await expect(service.process('missing')).rejects.toThrow(
        /not found for processing/,
      );
    });
  });

  describe('markFailed', () => {
    it('sets status failed with a truncated reason', async () => {
      const video = makeVideo();
      const { service, mocks } = build();
      mocks.repo.findOne.mockResolvedValue(video);

      await service.markFailed(video.id, 'x'.repeat(300));

      const saved = (mocks.repo.save.mock.calls[0] as Video[])[0];
      expect(saved.status).toBe(VideoStatus.FAILED);
      expect(saved.error_reason).toHaveLength(255);
    });

    it('no-ops when the video does not exist', async () => {
      const { service, mocks } = build();
      mocks.repo.findOne.mockResolvedValue(null);

      await service.markFailed('missing', 'boom');

      expect(mocks.repo.save).not.toHaveBeenCalled();
    });
  });
});
