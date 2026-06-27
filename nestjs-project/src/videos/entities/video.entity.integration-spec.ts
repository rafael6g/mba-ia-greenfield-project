import { randomUUID } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES, { synchronize: false });
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    counter++;
    const user = await userRepository.save(
      userRepository.create({
        email: `video_user_${counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: `Channel ${counter}`,
        nickname: `vid_chan_${counter}`,
        user_id: user.id,
      }),
    );
  }

  function buildVideo(channelId: string, publicId: string): Video {
    return videoRepository.create({
      public_id: publicId,
      channel_id: channelId,
      title: 'My Video',
      storage_key: `videos/${publicId}/source`,
    });
  }

  it('defaults status to draft and auto-populates timestamps', async () => {
    const channel = await createChannel();
    const video = await videoRepository.save(buildVideo(channel.id, 'pub_one'));

    expect(video.status).toBe(VideoStatus.DRAFT);
    expect(video.created_at).toBeInstanceOf(Date);
    expect(video.updated_at).toBeInstanceOf(Date);
    expect(video.thumbnail_key).toBeNull();
    expect(video.duration).toBeNull();
  });

  it('enforces the unique public_id constraint', async () => {
    const channel = await createChannel();
    await videoRepository.save(buildVideo(channel.id, 'dup_pub'));

    await expect(
      videoRepository.save(buildVideo(channel.id, 'dup_pub')),
    ).rejects.toThrow();
  });

  it('accepts all four status enum values', async () => {
    const channel = await createChannel();
    const statuses = [
      VideoStatus.DRAFT,
      VideoStatus.PROCESSING,
      VideoStatus.READY,
      VideoStatus.FAILED,
    ];

    for (const [i, status] of statuses.entries()) {
      const video = await videoRepository.save({
        ...buildVideo(channel.id, `status_${i}`),
        status,
      });
      expect(video.status).toBe(status);
    }
  });

  it('rejects an invalid status enum value', async () => {
    const channel = await createChannel();

    await expect(
      dataSource.query(
        `INSERT INTO "videos" ("public_id", "channel_id", "title", "status", "storage_key")
         VALUES ($1, $2, $3, $4, $5)`,
        ['bad_status', channel.id, 'X', 'archived', 'videos/x/source'],
      ),
    ).rejects.toThrow();
  });

  it('enforces the FK to channels', async () => {
    await expect(
      videoRepository.save(buildVideo(randomUUID(), 'orphan_pub')),
    ).rejects.toThrow();
  });

  it('stores and returns jsonb metadata', async () => {
    const channel = await createChannel();
    const metadata = {
      width: 1920,
      height: 1080,
      codec: 'h264',
      bitrate: 4500,
    };

    const saved = await videoRepository.save({
      ...buildVideo(channel.id, 'meta_pub'),
      metadata,
      duration: 120,
    });

    const found = await videoRepository.findOneByOrFail({ id: saved.id });
    expect(found.metadata).toEqual(metadata);
    expect(found.duration).toBe(120);
  });

  it('loads the related channel via the ManyToOne relation', async () => {
    const channel = await createChannel();
    await videoRepository.save(buildVideo(channel.id, 'rel_pub'));

    const found = await videoRepository.findOne({
      where: { public_id: 'rel_pub' },
      relations: ['channel'],
    });

    expect(found?.channel.id).toBe(channel.id);
  });
});
