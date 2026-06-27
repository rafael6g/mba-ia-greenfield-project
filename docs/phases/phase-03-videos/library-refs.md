---
libs:
  "bullmq":
    version: "^5.x"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-06-26T19:00:00-03:00"
  "@nestjs/bullmq":
    version: "^11.x"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-06-26T19:00:00-03:00"
  "@aws-sdk/client-s3":
    version: "^3.x"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-06-26T19:00:00-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.x"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-06-26T19:00:00-03:00"
  "@aws-sdk/lib-storage":
    version: "^3.x"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-06-26T19:00:00-03:00"
  "fluent-ffmpeg":
    version: "^2.1.x"
    context7_id: "/fluent-ffmpeg/node-fluent-ffmpeg"
    fetched_at: "2026-06-26T19:00:00-03:00"
  "@types/fluent-ffmpeg":
    version: "^2.1.x"
    context7_id: "/fluent-ffmpeg/node-fluent-ffmpeg"
    fetched_at: "2026-06-26T19:00:00-03:00"
  "nanoid":
    version: "^3.x"
    context7_id: "/ai/nanoid"
    fetched_at: "2026-06-26T19:00:00-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-06-26T19:13:29-03:00"
---

# phase-03-videos — Library References

Cache de docs/versões (via Context7) das bibliotecas novas fixadas para a Fase 03. **Nada é instalado aqui** — a instalação real (com autorização) acontece na implementação. Versões expressas como ranges compatíveis com o stack instalado (NestJS 11, TypeScript 5.9, Node 25, CommonJS).

> Infra não-npm: **Redis** (broker do BullMQ) e **MinIO** (S3-compatível) sobem como serviços no `compose.yaml`; os binários **ffmpeg/ffprobe** vão na imagem do worker (pacote do SO, não npm). Estes não entram no `package.json`.

## bullmq

- **ID:** `/taskforcesh/bullmq` — **Version:** `^5.x` — fila baseada em Redis (core; usado por `@nestjs/bullmq`).
- `Queue` (enfileirar) e `Worker` (consumir, em processo separado). Conexão Redis via `connection: { host, port }`.
- Retry/backoff por job: `queue.add(name, data, { attempts: N, backoff: { type: 'exponential', delay: ms } })`.
- Evento `failed` no Worker; após esgotar `attempts`, o job vai para estado `failed` (base para o status `failed` do vídeo — TD-09). Dead-letter manual via handler de `failed`.
- `ioredis` entra como dependência transitiva — não precisa instalar explicitamente.

## @nestjs/bullmq

- **ID:** `/nestjs/bull` (pacote `@nestjs/bullmq`) — **Version:** `^11.x` (alinha com NestJS 11).
- `BullModule.forRoot({ connection: { host, port } })` (config global) + `BullModule.registerQueue({ name })` por fila.
- Processor: classe `@Processor('queue-name')` que `extends WorkerHost` com `async process(job: Job): Promise<...>`; eventos via `@OnWorkerEvent('completed'|'failed')`.
- Worker em **processo separado**: processor pode ser registrado num app Nest dedicado (container worker — TD-06) consumindo a mesma fila/Redis.
- Injeção da fila no service: `@InjectQueue('queue-name') private queue: Queue` para enfileirar ao confirmar upload (TD-03).

## @aws-sdk/client-s3

- **ID:** `/aws/aws-sdk-js-v3` — **Version:** `^3.x` — cliente S3 (compatível com MinIO).
- `new S3Client({ endpoint, forcePathStyle: true, region, credentials })` → fala com MinIO local; trocar `endpoint`/credenciais por env migra para S3 em produção sem mudar código (TD-04).
- Multipart: `CreateMultipartUploadCommand`, `UploadPartCommand`, `CompleteMultipartUploadCommand`, `AbortMultipartUploadCommand`. `HeadObjectCommand` valida o objeto na confirmação (TD-03).
- `GetObjectCommand` com header `Range` é servido como `206 Partial Content` (streaming — TD-07), mas o caminho recomendado é presigned GET (abaixo).

## @aws-sdk/s3-request-presigner

- **ID:** `/aws/aws-sdk-js-v3` — **Version:** `^3.x` — geração de presigned URLs.
- `getSignedUrl(client, command, { expiresIn })` — assina `PutObject`/`UploadPart` (upload — TD-02) e `GetObject` (streaming/download — TD-07).
- Download com nome amigável: `GetObjectCommand` + `ResponseContentDisposition: 'attachment; filename=...'` na presigned.
- TTL curto (`expiresIn`) como mecanismo de controle de acesso (TD-05/TD-07).

## @aws-sdk/lib-storage

- **ID:** `/aws/aws-sdk-js-v3` — **Version:** `^3.x` — helper de multipart server-side (`Upload`).
- `new Upload({ client, params, queueSize, partSize (>=5MB), leavePartsOnError })` + `.done()` — útil para uploads server-side (ex.: o worker subindo o thumbnail). O upload de 10GB do cliente usa presigned multipart (TD-02), não este helper.

## fluent-ffmpeg

- **ID:** `/fluent-ffmpeg/node-fluent-ffmpeg` — **Version:** `^2.1.x` — wrapper do FFmpeg (TD-06).
- **Metadados/duração:** `ffmpeg.ffprobe(path, (err, data) => { data.format.duration; data.streams })`.
- **Thumbnail de um frame:** `ffmpeg(path).screenshots({ timestamps: ['50%'], filename: 'thumbnail.jpg', folder, size: '320x240' })` (eventos `filenames`/`end`/`error`).
- **Binários:** `ffmpeg.setFfmpegPath(...)` / `ffmpeg.setFfprobePath(...)` quando os executáveis não estão no PATH (na imagem do worker ficam no PATH).
- Sem tipos próprios → requer `@types/fluent-ffmpeg` (dev).

## @types/fluent-ffmpeg

- **ID:** `/fluent-ffmpeg/node-fluent-ffmpeg` — **Version:** `^2.1.x` — definições TypeScript para `fluent-ffmpeg` (devDependency).

## nanoid

- **ID:** `/ai/nanoid` — **Version:** `^3.x` — gerador de ID curto, URL-safe, opaco (TD-08, coluna `public_id`).
- ⚠️ **Compatibilidade CommonJS — fixar em `^3.x`.** O nanoid **5.x é ESM-only** e quebra com `require()` no build CommonJS do projeto (NestJS sem `"type": "module"` → `ERR_REQUIRE_ESM`). A linha 3.x mantém `require`/CommonJS e é a escolha segura aqui.
- API: `import { nanoid } from 'nanoid'` → `nanoid()` (21 chars default) ou `nanoid(11)`; `customAlphabet(alphabet, size)` para tamanho/alfabeto fixos. Persistir em coluna única indexada + retry em colisão (improvável).
