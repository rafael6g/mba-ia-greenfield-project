import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.STORAGE_ENDPOINT || 'http://minio:9000',
  region: process.env.STORAGE_REGION || 'us-east-1',
  accessKey: process.env.STORAGE_ACCESS_KEY!,
  secretKey: process.env.STORAGE_SECRET_KEY!,
  bucket: process.env.STORAGE_BUCKET || 'streamtube-videos',
  forcePathStyle: (process.env.STORAGE_FORCE_PATH_STYLE || 'true') === 'true',
  presignExpires: parseInt(process.env.STORAGE_PRESIGN_EXPIRES || '3600', 10),
}));
