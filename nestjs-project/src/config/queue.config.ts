import { registerAs } from '@nestjs/config';

export default registerAs('queue', () => ({
  redisHost: process.env.REDIS_HOST || 'redis',
  redisPort: parseInt(process.env.REDIS_PORT || '6379', 10),
  videoAttempts: parseInt(process.env.VIDEO_QUEUE_ATTEMPTS || '3', 10),
  videoBackoffMs: parseInt(process.env.VIDEO_QUEUE_BACKOFF_MS || '5000', 10),
}));
