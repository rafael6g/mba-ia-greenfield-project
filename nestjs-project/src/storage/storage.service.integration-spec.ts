import storageConfig from '../config/storage.config';
import { StorageService } from './storage.service';

/**
 * Exercises the real MinIO service from docker compose (host `minio:9000`).
 * No bytes go through the API — the test plays the client role, PUTting the
 * part directly to the presigned URL and GETting via a presigned URL.
 */
describe('StorageService (integration)', () => {
  let service: StorageService;

  beforeAll(() => {
    const config = storageConfig();
    service = new StorageService(config);
  });

  function uniqueKey(suffix: string): string {
    return `videos/it-${Date.now()}-${Math.floor(Math.random() * 1e6)}/${suffix}`;
  }

  it('round-trips a multipart upload and serves it via presigned GET (incl. Range/206)', async () => {
    const key = uniqueKey('source');
    const payload = Buffer.from('hello streamtube multipart upload payload');

    const uploadId = await service.createMultipartUpload(
      key,
      'application/octet-stream',
    );
    expect(uploadId).toBeTruthy();

    const [signed] = await service.signUploadParts(key, uploadId, 1);
    expect(signed.partNumber).toBe(1);

    const putRes = await fetch(signed.url, { method: 'PUT', body: payload });
    expect(putRes.ok).toBe(true);
    const etag = putRes.headers.get('etag');
    expect(etag).toBeTruthy();

    await service.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag: etag as string },
    ]);

    const head = await service.headObject(key);
    expect(head.contentLength).toBe(payload.length);

    // Full presigned GET
    const getUrl = await service.getPresignedDownloadUrl(key);
    const getRes = await fetch(getUrl);
    expect(getRes.status).toBe(200);
    const body = Buffer.from(await getRes.arrayBuffer());
    expect(body.equals(payload)).toBe(true);

    // Range request → 206 Partial Content (streaming without full download)
    const rangeRes = await fetch(getUrl, { headers: { Range: 'bytes=0-4' } });
    expect(rangeRes.status).toBe(206);
    const rangeBody = Buffer.from(await rangeRes.arrayBuffer());
    expect(rangeBody.length).toBe(5);
    expect(rangeBody.equals(payload.subarray(0, 5))).toBe(true);
  });

  it('stores an object via putObject (thumbnail path)', async () => {
    const key = uniqueKey('thumbnail.jpg');
    const thumb = Buffer.from('fake-jpeg-bytes');

    await service.putObject(key, thumb, 'image/jpeg');

    const head = await service.headObject(key);
    expect(head.contentLength).toBe(thumb.length);
  });

  it('aborts an in-progress multipart upload', async () => {
    const key = uniqueKey('source');
    const uploadId = await service.createMultipartUpload(
      key,
      'application/octet-stream',
    );

    await expect(
      service.abortMultipartUpload(key, uploadId),
    ).resolves.toBeUndefined();

    // After abort, the object was never finalized → headObject must fail.
    await expect(service.headObject(key)).rejects.toThrow();
  });

  it('headObject throws for a missing key', async () => {
    await expect(service.headObject(uniqueKey('missing'))).rejects.toThrow();
  });
});
