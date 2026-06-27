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

    await moduleRef.close();
  }, 30000);
});
