import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { QueueModule } from './queue.module';
import { VIDEO_QUEUE } from './queue.constants';

describe('QueueModule', () => {
  it('compiles and registers the video-processing queue (live Redis)', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    }).compile();

    const queue = moduleRef.get<Queue>(getQueueToken(VIDEO_QUEUE));
    expect(queue).toBeInstanceOf(Queue);
    expect(queue.name).toBe(VIDEO_QUEUE);

    // Let the Redis connection finish initializing before tearing down, so its
    // init() does not reject with "Connection is closed" and leak a stray
    // unhandled error into a later suite (shared --runInBand process).
    await queue.waitUntilReady();
    await moduleRef.close();
  }, 30000);
});
