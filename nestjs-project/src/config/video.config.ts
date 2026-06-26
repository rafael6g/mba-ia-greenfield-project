import { registerAs } from '@nestjs/config';

export default registerAs('video', () => ({
  maxSizeBytes: parseInt(process.env.VIDEO_MAX_SIZE_BYTES || '10737418240', 10),
  multipartPartSize: parseInt(
    process.env.VIDEO_MULTIPART_PART_SIZE || '52428800',
    10,
  ),
  ffmpegPath: process.env.FFMPEG_PATH || undefined,
  ffprobePath: process.env.FFPROBE_PATH || undefined,
  thumbnailTimestamp: process.env.THUMBNAIL_TIMESTAMP || '50%',
}));
