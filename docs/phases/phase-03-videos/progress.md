# phase-03-videos — Progress

**Status:** in progress (SI-03.1 → SI-03.9 implementados e verdes; fechando Definition of Done)
**SIs:** 9/9 implementados e testados

## Notas de retomada (handoff)

**Branch:** `feature/phase-03-videos` (a partir de `dev`). Remote `origin` = fork `rafael6g` (push via `gh`, já autenticado); `upstream` = base do curso.

**Ambiente Docker (nestjs-project/compose.yaml):** `db`, `mailpit`, `redis`, `minio`, `createbuckets` (one-shot, cria o bucket `streamtube-videos`), `nestjs-api`, `video-worker`.
- `redis` **sem** mapeamento de porta no host — acesso só interno (`redis:6379`).
- `minio` em 9000 (API) / 9001 (console); credenciais `streamtube`/`streamtube`.
- `video-worker` roda `npm run start:worker:dev` (entrypoint `worker.main`). ⚠️ O `nest start --watch` faz a 1ª compilação completa lentamente sobre o bind mount do Windows (~5 min) e o file-watching do tsc é instável nesse mount — após editar arquivos do worker, **reinicie o container** (`docker compose restart video-worker`) para garantir recompilação. Em produção usa-se `start:worker:prod` (`node dist/worker.main`).
- `kryzon-db` foi **parado** (conflito na porta 5432) — religar quando a fase terminar.

**Regras operacionais:** rodar todo `npm`/test **dentro do container**; integração/e2e com `--runInBand`; zerar+migrar o banco antes da suíte (`DROP SCHEMA public CASCADE; CREATE SCHEMA public;` + `npm run migration:run`); `testTimeout=30000` no jest config. NÃO instalar/alterar deps sem autorização.

---

### SI-03.1 — Dependencies, Config Namespaces, and Docker Compose Infra (MinIO + Redis + Worker)
- **Status:** completed
- **Tests:** sem testes próprios (infra/config). Não-regressão: suíte verde (env.validation test ajustado para as novas vars STORAGE_*).
- **Observations:** Deps de produção instaladas (aws-sdk client-s3/presigner/lib-storage, bullmq, @nestjs/bullmq, fluent-ffmpeg, nanoid@^3) + `@types/fluent-ffmpeg` (dev). Configs `storage`/`queue`/`video` (registerAs) + Joi + `.env`/`.env.example`. Dockerfile.dev + `ffmpeg`. Compose + minio/redis/createbuckets/video-worker.

### SI-03.2 — Object Storage Service (S3/MinIO client, presigned, multipart)
- **Status:** completed
- **Tests:** `storage.service.integration-spec.ts` (multipart round-trip, Range/206, putObject, abort, headObject) + `storage.module.spec.ts` — verdes contra o MinIO do Compose.

### SI-03.3 — Video Entity, Status Enum, Public ID, and Migration
- **Status:** completed
- **Tests:** `video.entity.integration-spec.ts`, `public-id.util.spec.ts`, `videos.module.spec.ts` — verdes. Migration `CreateVideos` aplicada; `migrations.integration-spec.ts` atualizado para a cadeia de 3 migrations.

### SI-03.4 — Queue Setup (BullMQ + Redis)
- **Status:** completed
- **Tests:** `queue.module.spec.ts` — verde (Redis live). `QueueModule` com `forRootAsync` + `registerQueueAsync('video-processing')`, constantes e payload do job.

### SI-03.5 — Upload Initiation (draft pre-registration + presigned multipart)
- **Status:** completed
- **Tests:** `videos.service.spec.ts` (unit), `videos.service.integration-spec.ts` (DB+MinIO), `videos.e2e-spec.ts` (POST /videos: 201/401/400/415) — verdes.

### SI-03.6 — Upload Completion + Enqueue Processing
- **Status:** completed
- **Tests:** unit + integration (round-trip multipart real → status processing, upload_id limpo, job enfileirado) + e2e (200/403/404/409) — verdes.

### SI-03.7 — Video Processing Worker (ffprobe metadata + ffmpeg thumbnail)
- **Status:** completed
- **Tests:** `video-processing.service.spec.ts` (unit, ffmpeg/fs/fetch mockados) + `video-processing.integration-spec.ts` (ffmpeg+MinIO+DB reais: fixture gerado por ffmpeg → ready + duração/metadata + thumbnail; input corrompido → falha + markFailed) — verdes. `video-worker` confirmado subindo e consumindo a fila (`Video worker started — consuming video-processing`).

### SI-03.8 — Streaming and Download (presigned GET with Range)
- **Status:** completed
- **Tests:** unit (getStreamRedirect/getDownloadRedirect) + e2e (302 + Range/206 anônimo, 404, 409, download com attachment) — verdes.

### SI-03.9 — Video Metadata / Status Endpoint
- **Status:** completed
- **Tests:** unit (getPublicVideo: thumbnailUrl null→presigned, 404) + e2e (200 com transição draft→processing anônimo, 404) — verdes.
