---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-06-26T13:43:01-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-06-26T19:13:29-03:00"
  docs/phases/phase-03-videos/context.md: "2026-06-26T19:16:47-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-06-26T19:16:31-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver large-file video upload (up to 10GB) that never streams bytes through the API, automatic asynchronous processing (duration/metadata extraction + thumbnail generation) via a dedicated worker consuming a queue, a unique public URL per video, and HTTP-range streaming + download — establishing the storage, queue, and worker infrastructure that later phases build on. Videos belong to a channel (1:1 user↔channel from Phase 02).

All decisions trace to `technical-decisions-phase-03-videos.md` (TD-01…TD-09). Inherited conventions (config via `registerAs` + Joi; global JWT guard + `@Public()`; domain exceptions + global filter; `class-validator` DTOs; `@nestjs/swagger`; TypeORM Data Mapper + versioned migrations) come from Phases 01–02 and are reused, not rebuilt.

---

## Step Implementations

### SI-03.1 — Dependencies, Config Namespaces, and Docker Compose Infra (MinIO + Redis + Worker)

**Description:** Install all Phase 03 production dependencies, create `storage` and `queue` config namespaces (`registerAs` pattern from Phase 01), extend the Joi env schema, and add the object storage (MinIO), queue broker (Redis), and video worker services to Docker Compose. This SI stands up the new infrastructure the rest of the phase depends on. Implements the infra side of TD-01 (Redis), TD-04 (S3 SDK), TD-06 (worker container with FFmpeg).

**Technical actions:**

- Install production dependencies in `nestjs-project`: `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`, `@aws-sdk/lib-storage@^3.x`, `bullmq@^5.x`, `@nestjs/bullmq@^11.x`, `fluent-ffmpeg@^2.1.x`, `nanoid@^3.x` (3.x for CommonJS compatibility — see `library-refs.md`); devDependency `@types/fluent-ffmpeg@^2.1.x`. **Installation requires user authorization per project rules — do not bump existing versions.**
- Create `src/config/storage.config.ts` — `registerAs('storage', ...)` reading `STORAGE_ENDPOINT` (string, default `'http://minio:9000'` — Compose service name, never localhost), `STORAGE_REGION` (string, default `'us-east-1'`), `STORAGE_ACCESS_KEY` (string, required), `STORAGE_SECRET_KEY` (string, required), `STORAGE_BUCKET` (string, default `'streamtube-videos'`), `STORAGE_FORCE_PATH_STYLE` (boolean, default `true`), `STORAGE_PRESIGN_EXPIRES` (number, default `3600`).
- Create `src/config/queue.config.ts` — `registerAs('queue', ...)` reading `REDIS_HOST` (string, default `'redis'`), `REDIS_PORT` (number, default `6379`), `VIDEO_QUEUE_ATTEMPTS` (number, default `3`), `VIDEO_QUEUE_BACKOFF_MS` (number, default `5000`).
- Create `src/config/video.config.ts` — `registerAs('video', ...)` reading `VIDEO_MAX_SIZE_BYTES` (number, default `10737418240` = 10GB), `VIDEO_MULTIPART_PART_SIZE` (number, default `52428800` = 50MB), `FFMPEG_PATH` (string, optional), `FFPROBE_PATH` (string, optional), `THUMBNAIL_TIMESTAMP` (string, default `'50%'`).
- Update `src/config/env.validation.ts` — add the new variables to the Joi schema (`STORAGE_ACCESS_KEY`/`STORAGE_SECRET_KEY` required, the rest with defaults). Update `.env.example` with Compose-compatible defaults.
- Update `nestjs-project/Dockerfile.dev` — install `ffmpeg` (provides `ffmpeg` + `ffprobe`) alongside the existing `procps`/`curl`, so the shared image can run the worker. (Keep `CMD ["tail","-f","/dev/null"]`.)
- Update `nestjs-project/compose.yaml`:
  - `minio` — image `minio/minio`, command `server /data --console-address ":9001"`, env `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD`, ports `9000:9000` (API) + `9001:9001` (console), healthcheck on `/minio/health/ready`, named volume for `/data`.
  - `createbuckets` — short-lived `minio/mc` job that waits for MinIO and creates the `streamtube-videos` bucket (idempotent), `depends_on: minio (healthy)`.
  - `redis` — image `redis:7`, port `6379:6379`, healthcheck `redis-cli ping`.
  - `video-worker` — same build context/image as `nestjs-api`, `command` running the worker entrypoint (`npm run start:worker:dev`), `depends_on` db (healthy) + redis (healthy) + minio (healthy), same volume mount and env as `nestjs-api`.
  - `nestjs-api` — add `redis` and `minio` to `depends_on`.

**Dependencies:** None

**Acceptance criteria:**

- Application starts without errors when all new env vars are provided; existing E2E (`GET /` → 200) still passes.
- Starting without `STORAGE_ACCESS_KEY` causes a Joi validation error at bootstrap — the app does not start.
- `docker compose up -d` brings up `db`, `mailpit`, `minio`, `redis`, `nestjs-api`, and `video-worker`, all healthy; the `streamtube-videos` bucket exists in MinIO (console at `localhost:9001`).
- `docker compose exec video-worker ffprobe -version` and `ffmpeg -version` succeed (binaries present in the worker image).

---

### SI-03.2 — Object Storage Service (S3/MinIO client, presigned, multipart)

**Description:** Create a `StorageModule` + `StorageService` wrapping `@aws-sdk/client-s3` against MinIO (TD-04), exposing the multipart-upload handshake (TD-02), presigned GET for streaming/download (TD-07), `HeadObject` validation (TD-03), and server-side put for the thumbnail. Key layout follows TD-05 (single private bucket, keys `videos/{publicId}/...`).

**Technical actions:**

- Create `src/storage/storage.module.ts` — provides `StorageService`, injects `storageConfig`; exports `StorageService`.
- Create `src/storage/storage.service.ts` — `StorageService` injecting `ConfigType<typeof storageConfig>`. Build one `S3Client({ endpoint, region, forcePathStyle, credentials })`. Implement:
  - `buildVideoKey(publicId): string` → `videos/${publicId}/source` and `buildThumbnailKey(publicId): string` → `videos/${publicId}/thumbnail.jpg`.
  - `createMultipartUpload(key, contentType): Promise<string>` → returns `UploadId` (`CreateMultipartUploadCommand`).
  - `signUploadParts(key, uploadId, partCount): Promise<{ partNumber, url }[]>` → presigned `UploadPartCommand` per part via `getSignedUrl`.
  - `completeMultipartUpload(key, uploadId, parts): Promise<void>` (`CompleteMultipartUploadCommand`).
  - `abortMultipartUpload(key, uploadId): Promise<void>` (`AbortMultipartUploadCommand`).
  - `headObject(key): Promise<{ contentLength: number }>` (`HeadObjectCommand`) — throws if absent.
  - `getPresignedDownloadUrl(key, { attachmentFilename? }): Promise<string>` → presigned `GetObjectCommand` (optionally `ResponseContentDisposition`).
  - `putObject(key, body, contentType): Promise<void>` — used by the worker to upload the thumbnail (`@aws-sdk/lib-storage` `Upload` or `PutObjectCommand`).
- Use the Compose service name (`minio`) as host (never localhost), per project Docker rule.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/storage/storage.service.integration-spec.ts` | Integration | Against the real MinIO from Compose: multipart create→sign→PUT parts→complete round-trips an object; `headObject` returns its size; presigned GET serves the object (incl. `Range` → `206`); `putObject` stores a thumbnail; `abortMultipartUpload` cancels an in-progress upload |
| `src/storage/storage.module.spec.ts` | Unit | Module compiles and provides `StorageService` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- An object uploaded via the multipart handshake (create → signed part PUTs → complete) is retrievable from MinIO.
- A presigned GET URL serves the object and honors an HTTP `Range` header with `206 Partial Content`.
- `headObject` on a missing key throws; on an existing key returns the correct `contentLength`.
- No video bytes pass through the Nest process during upload — the API only signs URLs and finalizes the multipart.

---

### SI-03.3 — Video Entity, Status Enum, Public ID, and Migration

**Description:** Create the `Video` entity tied to `Channel` (many-to-one), with the status lifecycle enum (TD-09), the unique `public_id` (TD-08), storage keys (TD-05), and processing metadata. Generate the migration. Wire `VideosModule` with `TypeOrmModule.forFeature`.

**Technical actions:**

- Create `src/videos/entities/video.entity.ts` — `@Entity('videos')` with columns: `id` (uuid PK generated), `public_id` (varchar, unique, not null), `channel_id` (uuid FK → channels, not null), `title` (varchar(255), not null), `status` (enum `video_status`: `'draft'|'processing'|'ready'|'failed'`, default `'draft'`), `storage_key` (varchar, not null), `thumbnail_key` (varchar, nullable), `upload_id` (varchar, nullable — S3 multipart id while uploading), `duration` (int, nullable — seconds), `metadata` (jsonb, nullable — ffprobe streams/format subset), `original_filename` (varchar, nullable), `size_bytes` (bigint, nullable), `error_reason` (varchar, nullable), `created_at` (CreateDateColumn), `updated_at` (UpdateDateColumn). `@ManyToOne(() => Channel)` with `@JoinColumn({ name: 'channel_id' })`.
- Create `src/videos/videos.module.ts` — `TypeOrmModule.forFeature([Video])` + import `ChannelsModule` (ownership checks) + `StorageModule`; provides services added in later SIs; exports `TypeOrmModule`.
- Generate migration: `npm run migration:generate -- src/database/migrations/CreateVideos`; review SQL (enum type, unique `public_id`, FK to `channels`, indexes).
- Add a `nanoid`-based `public_id` generator helper `src/videos/public-id.util.ts` — `generatePublicId(): string` (11 chars, URL-safe) for use by the service.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/entities/video.entity.integration-spec.ts` | Integration | Unique `public_id` constraint; `status` enum accepts the four values and rejects others; FK to `channels`; `metadata` stores/returns JSON; defaults (`status='draft'`); timestamps auto-populate |
| `src/videos/public-id.util.spec.ts` | Unit | `generatePublicId` returns an 11-char URL-safe string; high-volume sample has no collisions |
| `src/videos/videos.module.spec.ts` | Unit | Module compiles with `TypeOrmModule.forFeature([Video])`, `ChannelsModule`, `StorageModule` wiring |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `npm run migration:run` creates the `videos` table with the `video_status` enum, unique `public_id`, FK to `channels`, and indexes on `(public_id)`, `(channel_id)`, `(status)`.
- Inserting two videos with the same `public_id` fails with a unique constraint violation.
- A video row defaults to `status = 'draft'`.
- The migration runner integration test (Phase 02 `migrations.integration-spec.ts`) still applies the full chain including `CreateVideos`.

---

### SI-03.4 — Queue Setup (BullMQ + Redis)

**Description:** Register BullMQ against Redis (TD-01) and declare the `video-processing` queue with default job options (retry/backoff from TD-09). The producer (API) and consumer (worker) both attach to this queue.

**Technical actions:**

- Create `src/queue/queue.module.ts` — `BullModule.forRootAsync` (inject `queueConfig.KEY`, `connection: { host: queue.redisHost, port: queue.redisPort }`) + `BullModule.registerQueue({ name: 'video-processing', defaultJobOptions: { attempts: queue.attempts, backoff: { type: 'exponential', delay: queue.backoffMs }, removeOnComplete: true, removeOnFail: false } })`. Export `BullModule` so the queue token is injectable elsewhere.
- Define `src/queue/queue.constants.ts` — `VIDEO_QUEUE = 'video-processing'`, `PROCESS_VIDEO_JOB = 'process-video'` (`as const`).
- Define the job payload type `src/queue/process-video.job.ts` — `interface ProcessVideoJobData { videoId: string }`.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/queue/queue.module.spec.ts` | Unit | Module compiles with `BullModule.forRootAsync` + `registerQueue('video-processing')` wiring |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- The app boots with the `video-processing` queue registered and a live Redis connection (Compose `redis`).
- The queue token (`getQueueToken('video-processing')`) is injectable in a service.

---

### SI-03.5 — Upload Initiation (draft pre-registration + presigned multipart)

**Description:** Implement `POST /videos`: authenticated, the owner's channel pre-registers the video as `draft` (TD-09), the service starts a multipart upload (TD-02) and returns the `uploadId`, storage key, part size, and one presigned URL per part. The 10GB ceiling and content-type are validated up front; bytes never touch the API.

**Technical actions:**

- Create `src/videos/dto/initiate-upload.dto.ts` — `InitiateUploadDto`: `@IsString() @MaxLength(255)` title; `@IsString()` filename; `@IsString()` contentType (validate `video/*`); `@IsInt() @Min(1) @Max(VIDEO_MAX_SIZE_BYTES)` sizeBytes. (Max bound read from config via a custom validator or checked in the service to keep the limit single-sourced.)
- Create `src/videos/videos.service.ts` — `VideosService` injecting `Repository<Video>`, `StorageService`, `ChannelsService` (resolve the caller's channel), `ConfigType<typeof videoConfig>`. Implement `initiateUpload(userId, dto): Promise<InitiateUploadResult>`: (1) resolve the caller's channel via `ChannelsService` (throw `ChannelNotFoundException` if none); (2) reject `sizeBytes > VIDEO_MAX_SIZE_BYTES` (`UploadTooLargeException`) and non-`video/*` content types (`UnsupportedMediaTypeException`); (3) `publicId = generatePublicId()`, `key = storage.buildVideoKey(publicId)`; (4) `uploadId = storage.createMultipartUpload(key, contentType)`; (5) persist `Video` `{ public_id, channel_id, title, status: 'draft', storage_key: key, upload_id: uploadId, original_filename, size_bytes }` (retry once on `public_id` unique collision); (6) compute `partCount = ceil(sizeBytes / partSize)`, `urls = storage.signUploadParts(key, uploadId, partCount)`; (7) return `{ id, publicId, uploadId, key, partSize, parts: urls }`.
- Create `src/videos/videos.controller.ts` — `@Controller('videos')`. `@Post()` (authenticated — no `@Public()`), `@CurrentUser()` → `initiateUpload`, returns 201. Document with `@nestjs/swagger`.
- Register `VideosModule` in `AppModule`.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | `initiateUpload`: resolves channel, rejects oversize/invalid content-type, generates publicId, calls storage multipart + signs parts, persists draft (mock repo/storage/channels) |
| `src/videos/videos.service.integration-spec.ts` | Integration | Against real DB + MinIO: draft row persisted with `status='draft'` and `upload_id`; part URLs are usable; channel ownership resolved |
| `test/videos.e2e-spec.ts` | E2E | `POST /videos` 201 with `{ id, publicId, uploadId, parts[] }` for an authenticated user; 401 without token; 400 on oversize/invalid body |

**Dependencies:** SI-03.2, SI-03.3

**Acceptance criteria:**

- `POST /videos` (authenticated) returns 201 with the draft video id, `publicId`, `uploadId`, and a presigned URL per part — a video row exists with `status='draft'`.
- `POST /videos` without a token returns 401 (global JWT guard).
- `POST /videos` with `sizeBytes` over 10GB returns 400 `UPLOAD_TOO_LARGE`; a non-`video/*` content type returns 400/415.
- The client can PUT each part directly to MinIO using the returned URLs — the API is not involved in byte transfer.

---

### SI-03.6 — Upload Completion + Enqueue Processing

**Description:** Implement `POST /videos/:id/complete`: the owner submits the part ETags; the service finalizes the multipart upload (TD-02), validates the object exists via `HeadObject` (TD-03), flips status to `processing` (TD-09), and enqueues the `process-video` job (TD-01).

**Technical actions:**

- Create `src/videos/dto/complete-upload.dto.ts` — `CompleteUploadDto`: `parts: { partNumber: number; etag: string }[]` validated with `@ValidateNested({ each: true })` + `@Type`.
- Add to `VideosService` `completeUpload(userId, videoId, dto): Promise<{ id, status }>`: (1) load the video; 404 `VideoNotFoundException` if missing; verify the caller owns the video's channel else `ForbiddenChannelException`; (2) require `status='draft'` and a non-null `upload_id` else `InvalidUploadStateException`; (3) `storage.completeMultipartUpload(key, upload_id, parts)`; (4) `storage.headObject(key)` to confirm + capture `size_bytes`; (5) update `status='processing'`, clear `upload_id`; (6) enqueue `videoQueue.add(PROCESS_VIDEO_JOB, { videoId })`. Inject the queue via `@InjectQueue('video-processing')`.
- Add to `VideosController` `@Post(':id/complete')` (authenticated), returns 200 `{ id, status }`.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | `completeUpload`: ownership check, state guard, calls storage complete + head, sets `processing`, enqueues job (mock queue/storage/repo) |
| `src/videos/videos.service.integration-spec.ts` | Integration | Real DB + MinIO + Redis: after completing a real multipart upload, status becomes `processing`, `upload_id` cleared, and a `process-video` job is present in the queue |
| `test/videos.e2e-spec.ts` | E2E | `POST /videos/:id/complete` 200 `{ status: 'processing' }` for owner; 403 for non-owner; 404 unknown id; 409 when not in `draft` |

**Dependencies:** SI-03.4, SI-03.5

**Acceptance criteria:**

- After PUTting all parts, `POST /videos/:id/complete` with the ETags returns 200 with `status='processing'`; the object is complete in MinIO and a `process-video` job is enqueued.
- A non-owner calling complete returns 403; an unknown id returns 404; completing a non-`draft` video returns 409.
- The enqueued job carries `{ videoId }` and is visible to the worker.

---

### SI-03.7 — Video Processing Worker (ffprobe metadata + ffmpeg thumbnail)

**Description:** Implement the dedicated worker (TD-06) that consumes `process-video`: extracts duration/metadata with `ffprobe`, generates a thumbnail from a frame with `ffmpeg`, uploads the thumbnail (TD-05), and sets `status='ready'`. On terminal failure (after retries/backoff — TD-01), sets `status='failed'` with `error_reason` (TD-09).

**Technical actions:**

- Create the worker bootstrap `src/worker.main.ts` — a standalone Nest application context (`NestFactory.createApplicationContext(WorkerModule)`) so the processor runs in the `video-worker` container, not in the API process. Add npm scripts `start:worker:dev` (`nest start --watch --entryFile worker.main`) and `start:worker:prod` (`node dist/worker.main`).
- Create `src/worker/worker.module.ts` — imports `ConfigModule`, `TypeOrmModule.forRootAsync` (same `databaseConfig`), `QueueModule`, `StorageModule`, `TypeOrmModule.forFeature([Video])`; provides `VideoProcessingProcessor` and `VideoProcessingService`.
- Create `src/worker/video-processing.service.ts` — injecting `Repository<Video>`, `StorageService`, `ConfigType<typeof videoConfig>`. Implement `process(videoId)`: (1) load video; (2) obtain a readable source — generate a short-lived presigned GET and pass the URL to `ffprobe`/`ffmpeg`, or stream to a temp file; (3) `ffmpeg.ffprobe(input)` → `duration = format.duration`, `metadata = { width, height, codec, bitrate }` from `streams`; (4) `ffmpeg(input).screenshots({ timestamps: [video.thumbnailTimestamp], filename, folder, size })` → thumbnail file; (5) `storage.putObject(buildThumbnailKey(publicId), thumbnailBuffer, 'image/jpeg')`; (6) update `duration`, `metadata`, `thumbnail_key`, `status='ready'`. Set `FFMPEG_PATH`/`FFPROBE_PATH` via `setFfmpegPath`/`setFfprobePath` when configured.
- Create `src/worker/video-processing.processor.ts` — `@Processor('video-processing')` extends `WorkerHost`; `process(job)` → `videoProcessingService.process(job.data.videoId)`. `@OnWorkerEvent('failed')` — when `job.attemptsMade >= job.opts.attempts` (terminal), set the video `status='failed'` and `error_reason`; non-terminal failures are left for BullMQ retry/backoff. Failed jobs are retained (`removeOnFail: false`) as the dead-letter record.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/worker/video-processing.service.spec.ts` | Unit | `process`: calls ffprobe + thumbnail + storage put + status update; maps ffprobe output to `duration`/`metadata` (mock ffmpeg wrapper + storage + repo) |
| `src/worker/video-processing.integration-spec.ts` | Integration | Real DB + MinIO + Redis + ffmpeg: enqueue a job for a real uploaded small fixture video → worker sets `status='ready'`, persists `duration`/`metadata`, and a thumbnail object exists in storage; a corrupt/non-video input drives `status='failed'` after retries with `error_reason` set |

**Dependencies:** SI-03.6, SI-03.2

**Acceptance criteria:**

- Completing an upload of a real (small) test video results — within the worker — in `status='ready'`, a non-null `duration`, populated `metadata`, and a `thumbnail.jpg` object in MinIO under the video's key prefix.
- A processing failure that exhausts the configured retries leaves `status='failed'` with `error_reason`, and the failed job is retained in the queue (dead-letter) for inspection.
- The processor runs in the `video-worker` container (separate from the API) and shares the codebase/entities.

---

### SI-03.8 — Streaming and Download (presigned GET with Range)

**Description:** Implement `GET /videos/:publicId/stream` and `GET /videos/:publicId/download` (TD-07): anonymous-accessible, they validate the video is `ready` and redirect to a short-lived presigned GET URL served directly by MinIO/S3 — which honors HTTP `Range`/`206` for streaming and `Content-Disposition: attachment` for download. No video bytes pass through the API.

**Technical actions:**

- Add to `VideosService`: `getStreamRedirect(publicId): Promise<string>` — load by `public_id`; 404 if missing; require `status='ready'` else `VideoNotReadyException`; return `storage.getPresignedDownloadUrl(storage_key, {})`. `getDownloadRedirect(publicId): Promise<string>` — same, but `attachmentFilename = original_filename ?? `${publicId}.mp4`` so the presigned URL carries `ResponseContentDisposition`.
- Add to `VideosController`: `@Public() @Get(':publicId/stream')` → `@Res()` `res.redirect(302, url)`. `@Public() @Get(':publicId/download')` → `res.redirect(302, url)`. (302 to the presigned URL keeps the API out of the byte path; the player/browser does Range requests directly against storage.)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | `getStreamRedirect`/`getDownloadRedirect`: 404 unknown, 409 not-ready, returns presigned URL; download sets attachment filename (mock storage/repo) |
| `test/videos.e2e-spec.ts` | E2E | `GET /videos/:publicId/stream` 302 to a presigned URL for a `ready` video (no token needed); 404 unknown; 409 when not `ready`; `GET /videos/:publicId/download` 302 with attachment disposition |

**Dependencies:** SI-03.3, SI-03.2 (functional streaming exercised end-to-end after SI-03.7)

**Acceptance criteria:**

- `GET /videos/:publicId/stream` on a `ready` video returns a 302 to a presigned URL; fetching that URL with a `Range` header returns `206 Partial Content` (streaming without full download), served by storage — not the API.
- `GET /videos/:publicId/download` returns a 302 to a presigned URL that downloads the file with a sensible filename.
- Both endpoints are reachable anonymously (`@Public()`); a non-`ready` video returns 409 `VIDEO_NOT_READY`; an unknown `publicId` returns 404.

---

### SI-03.9 — Video Metadata / Status Endpoint

**Description:** Implement `GET /videos/:publicId` returning the public video resource (status, title, duration, thumbnail URL, timestamps) so a client can poll processing status and render the video card. Anonymous-accessible (TD-05 — thumbnail served via presigned GET).

**Technical actions:**

- Add to `VideosService` `getPublicVideo(publicId): Promise<PublicVideoView>` — load by `public_id`; 404 if missing; build `{ publicId, title, status, duration, thumbnailUrl: thumbnail_key ? presigned GET : null, createdAt }`.
- Add to `VideosController` `@Public() @Get(':publicId')` → `getPublicVideo`, 200. Document the response shape with `@nestjs/swagger`.

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | `getPublicVideo`: 404 unknown; returns view with `thumbnailUrl` null until processed, presigned once `thumbnail_key` set |
| `test/videos.e2e-spec.ts` | E2E | `GET /videos/:publicId` 200 with status/title/duration; `status` transitions `draft`→`processing`→`ready` are observable; 404 unknown |

**Dependencies:** SI-03.3

**Acceptance criteria:**

- `GET /videos/:publicId` returns 200 with the video's `status`, `title`, `duration` (once processed), and a `thumbnailUrl` (presigned, or null before processing).
- The status reflects the DB lifecycle (`draft` → `processing` → `ready`/`failed`).
- Reachable anonymously; unknown `publicId` returns 404.

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | |
| public_id | varchar | unique, not null | nanoid (11 chars), URL slug — TD-08 |
| channel_id | uuid | FK → channels.id, not null | Owning channel — TD video↔channel |
| title | varchar(255) | not null | |
| status | enum `video_status` | not null, default `'draft'` | `draft`/`processing`/`ready`/`failed` — TD-09 |
| storage_key | varchar | not null | `videos/{public_id}/source` — TD-05 |
| thumbnail_key | varchar | nullable | `videos/{public_id}/thumbnail.jpg` (after processing) |
| upload_id | varchar | nullable | S3 multipart UploadId while uploading — TD-02 |
| duration | int | nullable | seconds, from ffprobe — TD-06 |
| metadata | jsonb | nullable | ffprobe subset (width, height, codec, bitrate) |
| original_filename | varchar | nullable | for download filename |
| size_bytes | bigint | nullable | confirmed via HeadObject |
| error_reason | varchar | nullable | set when status=`failed` — TD-09 |
| created_at | timestamp | not null, auto | `@CreateDateColumn` |
| updated_at | timestamp | not null, auto | `@UpdateDateColumn` |

**Relations:** Video → Channel (many-to-one via `channel_id`)
**Indexes:** `(public_id)` — unique, `(channel_id)` — FK, `(status)`

---

### API Contracts

#### POST /videos (SI-03.5)

**Request headers:** Authorization: Bearer <access_token>; Content-Type: application/json
**Request body:** `title` (string, ≤255, required), `filename` (string, required), `contentType` (string, `video/*`, required), `sizeBytes` (int, 1…`VIDEO_MAX_SIZE_BYTES`, required)
**Response 201:** `id` (uuid), `publicId` (string), `uploadId` (string), `key` (string), `partSize` (int), `parts` (array of `{ partNumber: int, url: string }`)
**Error responses:** 401 (no/invalid token); 400 VALIDATION_ERROR; 400 UPLOAD_TOO_LARGE (> 10GB); 415 UNSUPPORTED_MEDIA_TYPE (non-video); 404 CHANNEL_NOT_FOUND

---

#### POST /videos/:id/complete (SI-03.6)

**Request headers:** Authorization: Bearer <access_token>; Content-Type: application/json
**Request body:** `parts` (array of `{ partNumber: int, etag: string }`, required)
**Response 200:** `id` (uuid), `status` (`'processing'`)
**Error responses:** 401; 403 FORBIDDEN_CHANNEL (non-owner); 404 VIDEO_NOT_FOUND; 409 INVALID_UPLOAD_STATE (not `draft`); 400 VALIDATION_ERROR

---

#### GET /videos/:publicId (SI-03.9)

**Auth:** Public
**Response 200:** `publicId`, `title`, `status`, `duration` (int|null), `thumbnailUrl` (string|null), `createdAt`
**Error responses:** 404 VIDEO_NOT_FOUND

---

#### GET /videos/:publicId/stream (SI-03.8)

**Auth:** Public
**Response 302:** `Location` = presigned GET URL (storage serves `Range`/`206`)
**Error responses:** 404 VIDEO_NOT_FOUND; 409 VIDEO_NOT_READY

---

#### GET /videos/:publicId/download (SI-03.8)

**Auth:** Public
**Response 302:** `Location` = presigned GET URL with `Content-Disposition: attachment`
**Error responses:** 404 VIDEO_NOT_FOUND; 409 VIDEO_NOT_READY

---

### Authorization Matrix

| Endpoint | Public | Authenticated | Notes |
|----------|--------|---------------|-------|
| POST /videos | | ✓ | Owner channel resolved from token |
| POST /videos/:id/complete | | ✓ | Must own the video's channel |
| GET /videos/:publicId | ✓ | | Anonymous watch (metadata) |
| GET /videos/:publicId/stream | ✓ | | Anonymous streaming via presigned redirect |
| GET /videos/:publicId/download | ✓ | | Anonymous download via presigned redirect |

Authenticated endpoints are protected by the inherited global `JwtAuthGuard`; public ones opt out with `@Public()`. Ownership (caller's channel owns the video) is enforced in the service, throwing `ForbiddenChannelException` (403).

---

### Error Catalog

**Error response format** (inherited from Phase 02, TD-07): `{ statusCode, error, message }`.

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| CHANNEL_NOT_FOUND | 404 | Channel not found for user | POST /videos when the caller has no channel |
| UPLOAD_TOO_LARGE | 400 | File exceeds the maximum allowed size | POST /videos with `sizeBytes` > 10GB |
| UNSUPPORTED_MEDIA_TYPE | 415 | Unsupported media type | POST /videos with a non-`video/*` content type |
| VIDEO_NOT_FOUND | 404 | Video not found | complete/stream/download/get with unknown id/publicId |
| FORBIDDEN_CHANNEL | 403 | You do not own this video | complete by a non-owner |
| INVALID_UPLOAD_STATE | 409 | Upload is not in a completable state | complete when the video is not `draft`/has no `upload_id` |
| VIDEO_NOT_READY | 409 | Video is not ready yet | stream/download before `status='ready'` |

New `DomainException` subclasses (extending the inherited base from Phase 02): `ChannelNotFoundException`, `UploadTooLargeException`, `UnsupportedMediaTypeException`, `VideoNotFoundException`, `ForbiddenChannelException`, `InvalidUploadStateException`, `VideoNotReadyException`.

---

### Events / Messages

**Queue:** `video-processing` (BullMQ over Redis — TD-01). Registered via `BullModule.registerQueue` with `defaultJobOptions`.

| Field | Value |
|-------|-------|
| Job name | `process-video` (`PROCESS_VIDEO_JOB`) |
| Payload | `{ videoId: string }` (`ProcessVideoJobData`) |
| Producer | `VideosService.completeUpload` (API) — enqueues after `CompleteMultipartUpload` + `HeadObject` |
| Consumer | `VideoProcessingProcessor` (`@Processor('video-processing')` extends `WorkerHost`) in the `video-worker` container |
| Retry | `attempts = VIDEO_QUEUE_ATTEMPTS` (default 3), `backoff = { type: 'exponential', delay: VIDEO_QUEUE_BACKOFF_MS }` (default 5000ms) |
| Success | worker sets `status='ready'`, persists `duration`/`metadata`/`thumbnail_key`; `removeOnComplete: true` |
| Terminal failure | after attempts exhausted, `@OnWorkerEvent('failed')` sets `status='failed'` + `error_reason`; `removeOnFail: false` retains the job as the dead-letter record |

**Status transitions:** `draft` (POST /videos) → `processing` (POST /complete + enqueue) → `ready` (worker success) | `failed` (worker terminal failure). Reflected in the `videos.status` column (TD-09).

---

### Infrastructure (Docker Compose additions)

| Service | Image | Role | Ports | Notes |
|---------|-------|------|-------|-------|
| `minio` | `minio/minio` | Object storage (S3-compatible) | 9000 (API), 9001 (console) | Healthcheck `/minio/health/ready`; named volume |
| `createbuckets` | `minio/mc` | One-shot bucket bootstrap | — | Creates `streamtube-videos` (idempotent) |
| `redis` | `redis:7` | Queue broker (BullMQ) | 6379 | Healthcheck `redis-cli ping` |
| `video-worker` | same as `nestjs-api` (+ ffmpeg) | Consumes `video-processing` | — | `command: npm run start:worker:dev`; FFmpeg/ffprobe in image |

All inter-service hosts use Compose service names (`minio`, `redis`, `db`), never `localhost`.

---

## Dependency Map

```
SI-03.1 (deps + config + compose: minio/redis/worker) — no deps
├── SI-03.2 (storage service)
├── SI-03.3 (video entity + migration)
└── SI-03.4 (queue setup)

SI-03.2 + SI-03.3
└── SI-03.5 (upload initiation)
    └── SI-03.6 (upload completion + enqueue)   [also needs SI-03.4]
        └── SI-03.7 (worker: ffprobe + thumbnail)   [also needs SI-03.2]

SI-03.3 + SI-03.2
└── SI-03.8 (streaming + download)

SI-03.3
└── SI-03.9 (metadata/status endpoint)
```

Linearized order: SI-03.1 → SI-03.2, SI-03.3, SI-03.4 (parallel) → SI-03.5 → SI-03.6 → SI-03.7 → SI-03.8, SI-03.9 (parallel).

---

## Deliverables

- [ ] Object storage (MinIO), queue broker (Redis), and a dedicated video worker (with FFmpeg) all up via `docker compose`, alongside the existing API/DB/Mailpit
- [ ] `videos` table (migration) with `video_status` enum, unique `public_id`, FK to `channels`, indexes
- [ ] `POST /videos` — draft pre-registration + presigned **multipart** upload of up to 10GB without routing bytes through the API
- [ ] `POST /videos/:id/complete` — finalizes multipart, validates via HeadObject, sets `processing`, enqueues `process-video`
- [ ] Worker processes the queue: ffprobe duration/metadata + ffmpeg thumbnail, sets `ready`; terminal failure sets `failed` + dead-letter retention
- [ ] Unique public URL per video (`nanoid` `public_id`)
- [ ] `GET /videos/:publicId/stream` — streaming via presigned GET with HTTP `Range`/`206` (no full download, bytes not through API)
- [ ] `GET /videos/:publicId/download` — download via presigned GET with attachment disposition
- [ ] `GET /videos/:publicId` — public status/metadata resource (`draft`→`processing`→`ready`/`failed`)
- [ ] Standardized domain exceptions for the new error catalog (reuses Phase 02 filter/format)
- [ ] Tests at the right layers, green (`npm test -- --runInBand` and `npm run test:e2e`) — storage/queue/worker exercised against real Compose infra (not mocked)
- [ ] Definition of Done: full suite green + `npx tsc --noEmit` (exit 0) + `npm run lint`
- [ ] `CLAUDE.md` updated with the videos section (module, endpoints, queue/worker, storage)
- [ ] Git Flow respected (work on `feature/phase-03-videos` from `dev`, no direct commits to `main`)
