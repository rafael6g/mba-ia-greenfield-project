import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { generatePublicId } from '../videos/public-id.util';
import { VideoProcessingService } from './video-processing.service';

const execFileAsync = promisify(execFile);
const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideoProcessing (integration)', () => {
  let moduleRef: Awaited<ReturnType<typeof buildModule>>;
  let service: VideoProcessingService;
  let storage: StorageService;
  let dataSource: DataSource;
  let fixtureDir: string;
  let fixturePath: string;

  async function buildModule() {
    return Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, videoConfig],
        }),
        TypeOrmModule.forRoot(
          createTestDataSource(ALL_ENTITIES, { synchronize: false }).options,
        ),
        TypeOrmModule.forFeature([Video]),
        StorageModule,
      ],
      providers: [VideoProcessingService],
    }).compile();
  }

  beforeAll(async () => {
    moduleRef = await buildModule();
    service = moduleRef.get(VideoProcessingService);
    storage = moduleRef.get(StorageService);
    dataSource = moduleRef.get(DataSource);

    // Generate a tiny real video fixture with ffmpeg (available in the image).
    fixtureDir = await mkdtemp(join(tmpdir(), 'streamtube-fixture-'));
    fixturePath = join(fixtureDir, 'fixture.mp4');
    await execFileAsync('ffmpeg', [
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=1:size=320x240:rate=10',
      '-pix_fmt',
      'yuv420p',
      fixturePath,
    ]);
  }, 60000);

  afterAll(async () => {
    await rm(fixtureDir, { recursive: true, force: true });
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannelId(): Promise<string> {
    counter++;
    const userRepo = dataSource.getRepository(User);
    const channelRepo = dataSource.getRepository(Channel);
    const user = await userRepo.save(
      userRepo.create({
        email: `worker_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    const channel = await channelRepo.save(
      channelRepo.create({
        name: `Chan ${counter}`,
        nickname: `worker_${counter}`,
        user_id: user.id,
      }),
    );
    return channel.id;
  }

  async function seedVideo(body: Buffer): Promise<Video> {
    const channelId = await createChannelId();
    const publicId = generatePublicId();
    const storageKey = storage.buildVideoKey(publicId);
    await storage.putObject(storageKey, body, 'video/mp4');

    const repo = dataSource.getRepository(Video);
    return repo.save(
      repo.create({
        public_id: publicId,
        channel_id: channelId,
        title: 'Worker Fixture',
        status: VideoStatus.PROCESSING,
        storage_key: storageKey,
      }),
    );
  }

  it('processes a real video: sets ready, persists duration/metadata, uploads thumbnail', async () => {
    const fixture = await readFile(fixturePath);
    const video = await seedVideo(fixture);

    await service.process(video.id);

    const row = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: video.id });
    expect(row.status).toBe(VideoStatus.READY);
    expect(row.duration).toBeGreaterThanOrEqual(1);
    expect(row.metadata).toMatchObject({ width: 320, height: 240 });
    expect(row.thumbnail_key).toBe(storage.buildThumbnailKey(row.public_id));

    // Thumbnail object exists in MinIO.
    const head = await storage.headObject(row.thumbnail_key as string);
    expect(head.contentLength).toBeGreaterThan(0);
  }, 60000);

  it('fails to process a corrupt/non-video input and markFailed records it', async () => {
    const video = await seedVideo(Buffer.from('this is not a video file'));

    await expect(service.process(video.id)).rejects.toThrow();

    await service.markFailed(video.id, 'ffprobe failed on corrupt input');

    const row = await dataSource
      .getRepository(Video)
      .findOneByOrFail({ id: video.id });
    expect(row.status).toBe(VideoStatus.FAILED);
    expect(row.error_reason).toBeTruthy();
  }, 60000);
});
