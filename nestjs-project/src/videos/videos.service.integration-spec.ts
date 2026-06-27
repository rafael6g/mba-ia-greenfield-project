import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { PROCESS_VIDEO_JOB, VIDEO_QUEUE } from '../queue/queue.constants';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { ChannelNotFoundException } from './exceptions/video.exceptions';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration)', () => {
  let moduleRef: Awaited<ReturnType<typeof buildModule>>;
  let service: VideosService;
  let dataSource: DataSource;
  let queue: Queue;

  async function buildModule() {
    return Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, videoConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(
          createTestDataSource(ALL_ENTITIES, { synchronize: false }).options,
        ),
        VideosModule,
      ],
    }).compile();
  }

  beforeAll(async () => {
    moduleRef = await buildModule();
    service = moduleRef.get(VideosService);
    dataSource = moduleRef.get(DataSource);
    queue = moduleRef.get<Queue>(getQueueToken(VIDEO_QUEUE));
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
  });

  let counter = 0;
  async function createChannel(): Promise<{ userId: string }> {
    counter++;
    const userRepo = dataSource.getRepository(User);
    const channelRepo = dataSource.getRepository(Channel);
    const user = await userRepo.save(
      userRepo.create({
        email: `vid_svc_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    await channelRepo.save(
      channelRepo.create({
        name: `Chan ${counter}`,
        nickname: `vid_svc_${counter}`,
        user_id: user.id,
      }),
    );
    return { userId: user.id };
  }

  const dto = {
    title: 'Integration Video',
    filename: 'clip.mp4',
    contentType: 'video/mp4',
    sizeBytes: 1024,
  };

  it('persists a draft with upload_id and returns usable presigned part URLs', async () => {
    const { userId } = await createChannel();

    const result = await service.initiateUpload(userId, dto);

    const row = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: result.id });
    expect(row.status).toBe(VideoStatus.DRAFT);
    expect(row.upload_id).toBe(result.uploadId);
    expect(row.storage_key).toBe(result.key);
    expect(result.parts).toHaveLength(1);

    // The presigned part URL works directly against MinIO — no bytes via API.
    const putRes = await fetch(result.parts[0].url, {
      method: 'PUT',
      body: Buffer.from('a small part payload'),
    });
    expect(putRes.ok).toBe(true);
    expect(putRes.headers.get('etag')).toBeTruthy();
  });

  it('throws ChannelNotFoundException for a user without a channel', async () => {
    const userRepo = dataSource.getRepository(User);
    const user = await userRepo.save(
      userRepo.create({ email: 'no_chan@example.com', password: 'hashed' }),
    );

    await expect(service.initiateUpload(user.id, dto)).rejects.toBeInstanceOf(
      ChannelNotFoundException,
    );
  });

  it('completes a real multipart upload: status processing, upload_id cleared, job enqueued', async () => {
    const { userId } = await createChannel();
    const init = await service.initiateUpload(userId, dto);

    // Play the client: PUT the single part directly to MinIO and capture ETag.
    const putRes = await fetch(init.parts[0].url, {
      method: 'PUT',
      body: Buffer.from('the full small video payload'),
    });
    const etag = putRes.headers.get('etag');
    expect(etag).toBeTruthy();

    const result = await service.completeUpload(userId, init.id, {
      parts: [{ partNumber: 1, etag: etag as string }],
    });
    expect(result.status).toBe(VideoStatus.PROCESSING);

    const row = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: init.id });
    expect(row.status).toBe(VideoStatus.PROCESSING);
    expect(row.upload_id).toBeNull();
    expect(Number(row.size_bytes)).toBeGreaterThan(0);

    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe(PROCESS_VIDEO_JOB);
    expect(jobs[0].data).toEqual({ videoId: init.id });
  });
});
