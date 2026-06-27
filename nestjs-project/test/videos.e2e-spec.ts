import { getQueueToken } from '@nestjs/bullmq';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { MailService } from '../src/mail/mail.service';
import { VIDEO_QUEUE } from '../src/queue/queue.constants';
import { cleanAllTables } from '../src/test/create-test-data-source';

interface InitiateResponse {
  id: string;
  publicId: string;
  uploadId: string;
  key: string;
  partSize: number;
  parts: { partNumber: number; url: string }[];
}

interface AuthServiceWithMail {
  mailService: MailService;
}

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let queue: Queue;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
    queue = moduleFixture.get<Queue>(getQueueToken(VIDEO_QUEUE));
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    await queue.obliterate({ force: true });
  });

  let userCounter = 0;
  async function registerConfirmAndLogin(): Promise<string> {
    userCounter++;
    const email = `vid_e2e_${userCounter}@example.com`;
    const password = 'password123';

    const authService = app.get(AuthService);
    const mailService = (authService as unknown as AuthServiceWithMail)
      .mailService;
    let token = '';
    jest
      .spyOn(mailService, 'sendConfirmationEmail')
      .mockImplementationOnce((_e: string, _n: string, t: string) => {
        token = t;
        return Promise.resolve();
      });

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
    return (res.body as { access_token: string }).access_token;
  }

  const validBody = {
    title: 'My E2E Video',
    filename: 'clip.mp4',
    contentType: 'video/mp4',
    sizeBytes: 1024,
  };

  async function initiateAndUpload(
    accessToken: string,
  ): Promise<{ id: string; parts: { partNumber: number; etag: string }[] }> {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${accessToken}`)
      .send(validBody);
    const body = res.body as InitiateResponse;

    const parts: { partNumber: number; etag: string }[] = [];
    for (const part of body.parts) {
      const putRes = await fetch(part.url, {
        method: 'PUT',
        body: Buffer.from('full e2e video payload'),
      });
      parts.push({
        partNumber: part.partNumber,
        etag: putRes.headers.get('etag') as string,
      });
    }
    return { id: body.id, parts };
  }

  describe('POST /videos', () => {
    it('returns 201 with the draft id, publicId, uploadId and presigned parts', async () => {
      const accessToken = await registerConfirmAndLogin();

      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(validBody)
        .expect(201);

      const body = res.body as InitiateResponse;
      expect(body.id).toBeDefined();
      expect(body.publicId).toHaveLength(11);
      expect(body.uploadId).toBeTruthy();
      expect(body.parts.length).toBeGreaterThanOrEqual(1);
      expect(body.parts[0].url).toContain('http');
    });

    it('returns 401 without a token', async () => {
      await request(app.getHttpServer())
        .post('/videos')
        .send(validBody)
        .expect(401);
    });

    it('returns 400 on an oversize upload', async () => {
      const accessToken = await registerConfirmAndLogin();

      await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ ...validBody, sizeBytes: 10737418240 + 1 })
        .expect(400);
    });

    it('returns 415 on a non-video content type', async () => {
      const accessToken = await registerConfirmAndLogin();

      await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ ...validBody, contentType: 'image/png' })
        .expect(415);
    });

    it('returns 400 on an invalid body (missing fields)', async () => {
      const accessToken = await registerConfirmAndLogin();

      await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ title: 'only title' })
        .expect(400);
    });
  });

  describe('POST /videos/:id/complete', () => {
    it('finalizes the upload and returns 200 with status processing', async () => {
      const accessToken = await registerConfirmAndLogin();
      const { id, parts } = await initiateAndUpload(accessToken);

      const res = await request(app.getHttpServer())
        .post(`/videos/${id}/complete`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts })
        .expect(200);

      expect(res.body as { status: string }).toMatchObject({
        id,
        status: 'processing',
      });
    });

    it('returns 403 for a non-owner', async () => {
      const ownerToken = await registerConfirmAndLogin();
      const { id, parts } = await initiateAndUpload(ownerToken);
      const otherToken = await registerConfirmAndLogin();

      await request(app.getHttpServer())
        .post(`/videos/${id}/complete`)
        .set('Authorization', `Bearer ${otherToken}`)
        .send({ parts })
        .expect(403);
    });

    it('returns 404 for an unknown id', async () => {
      const accessToken = await registerConfirmAndLogin();

      await request(app.getHttpServer())
        .post('/videos/00000000-0000-0000-0000-000000000000/complete')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts: [{ partNumber: 1, etag: 'x' }] })
        .expect(404);
    });

    it('returns 409 when completing a non-draft video', async () => {
      const accessToken = await registerConfirmAndLogin();
      const { id, parts } = await initiateAndUpload(accessToken);

      await request(app.getHttpServer())
        .post(`/videos/${id}/complete`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts })
        .expect(200);

      // Second completion: the video is now processing, not draft → 409.
      await request(app.getHttpServer())
        .post(`/videos/${id}/complete`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts })
        .expect(409);
    });
  });
});
