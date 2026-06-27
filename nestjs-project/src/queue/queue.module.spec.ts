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
    // Handle BullMQ connection 'error' events so a stray "Connection is closed"
    // on teardown is not reported as an unhandled error in a later suite
    // (shared --runInBand process).
    queue.on('error', () => undefined);
    expect(queue).toBeInstanceOf(Queue);
    expect(queue.name).toBe(VIDEO_QUEUE);

    await queue.waitUntilReady();
    await moduleRef.close();
  }, 30000);
});
