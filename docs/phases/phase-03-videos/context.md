---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-06-26T13:43:01-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-06-26T19:13:29-03:00"
  docs/decisions/technical-decisions-phase-02-auth.md: "2026-06-26T13:43:01-03:00"
  docs/decisions/technical-decisions-phase-01-configuracao-base.md: "2026-06-26T13:43:01-03:00"
  docs/phases/phase-02-auth/context.md: "2026-06-26T13:43:01-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-06-26T13:43:01-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-06-26T19:16:31-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** Edição de informações do vídeo, fluxo de publicação/visibilidade, painel de gerenciamento e página pública do canal (Fase 04); página de visualização com player e sugestões (Fase 05); interações sociais — likes, comentários, inscrições (Fase 06). A interface de vídeo (frontend) não faz parte desta fase.

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/`

**Deferred subprojects:** `next-frontend/` — a interface de vídeo é explicitamente diferida; esta fase entrega API + worker + infraestrutura.

**Sequencing notes:** Depende de Fase 01 (Configuração Base) e Fase 02 (Auth/Usuários/Canais). Os vídeos pertencem a um canal (relação criada no cadastro da Fase 02).

**Neighbors (for boundary detection only):**

- **Fase 02 — Cadastro, Login e Gerenciamento de Conta** (prior): entrega usuários, canais (1:1 com usuário), guard JWT global, filtro de exceções, ValidationPipe, rate limiting.
- **Fase 04 — Gerenciamento de Vídeos e Canal** (next): edição de vídeo, visibilidade público/unlisted, fluxo rascunho→publicação, painel e página pública do canal.

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | technical-decisions-phase-03-videos.md | Backend | Tecnologia da fila de processamento | decided | A (BullMQ + Redis) | bullmq, @nestjs/bullmq |
| phase-03-videos/TD-02 | technical-decisions-phase-03-videos.md | Backend | Estratégia de upload de até 10GB | decided | A (Presigned multipart direto ao storage) | — |
| phase-03-videos/TD-03 | technical-decisions-phase-03-videos.md | Backend | Sinalização de conclusão do upload e disparo do processamento | decided | A (Endpoint de confirmação + HeadObject) | — |
| phase-03-videos/TD-04 | technical-decisions-phase-03-videos.md | Backend | Cliente/SDK do object storage | decided | A (@aws-sdk/client-s3 v3) | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner, @aws-sdk/lib-storage |
| phase-03-videos/TD-05 | technical-decisions-phase-03-videos.md | Backend | Organização de buckets/chaves e visibilidade | decided | A (Bucket único privado + chaves por publicId) | — |
| phase-03-videos/TD-06 | technical-decisions-phase-03-videos.md | Backend | Worker dedicado + toolchain FFmpeg | decided | A (Container worker + ffprobe/ffmpeg) | fluent-ffmpeg, @types/fluent-ffmpeg |
| phase-03-videos/TD-07 | technical-decisions-phase-03-videos.md | Backend | Streaming e download | decided | A (Presigned GET com Range nativo do storage) | — |
| phase-03-videos/TD-08 | technical-decisions-phase-03-videos.md | Backend | Geração da URL única do vídeo | decided | A (nanoid → public_id) | nanoid |
| phase-03-videos/TD-09 | technical-decisions-phase-03-videos.md | Backend | Ciclo de status e tratamento de falha | decided | A (Enum draft/processing/ready/failed + retry/dead-letter) | — |

_Source files:_

- `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase)

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-04, phase-03-videos/TD-05 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-09, phase-03-videos/TD-02 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-03, phase-03-videos/TD-06 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-06 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-08 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-07 |
| Download do vídeo pelo usuário | phase-03-videos/TD-07 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** BullMQ + Redis pela aderência inequívoca ao critério de aceite ("fila real subindo no Compose") e ao diagrama C4 (Message Queue como container dedicado), além de ser o padrão NestJS com worker em processo separado, retry/backoff e integração oficial `@nestjs/bullmq`. O custo de adicionar Redis é justificado pelo requisito do desafio; pg-boss fica registrado como alternativa técnica forte (sem Redis, enfileiramento transacional, dead-letter nativo).

**Libraries:** bullmq, @nestjs/bullmq

### phase-03-videos/TD-02

**Recommendation:** Presigned multipart direto ao storage — é a única estratégia que cobre 10GB sem trafegar o arquivo pela API, com paralelismo e retomada por parte, usando o multipart nativo do S3/MinIO (mesmo SDK em dev e prod). A API entra só no início (rascunho + iniciar multipart + assinar partes) e no fim (completar). PUT simples não atinge 10GB (limite de 5GB), tus agrega infra desnecessária e proxy pela API é o anti-padrão proibido.

**Libraries:** —

### phase-03-videos/TD-03

**Recommendation:** Endpoint de confirmação (`POST /videos/:id/complete`) que executa `CompleteMultipartUpload`, valida o objeto via `HeadObject` e enfileira o processamento — o caminho mais simples e portável (idêntico em MinIO e S3, sem configurar eventos do storage), mantendo a API no controle da validação antes de enfileirar. Bucket notifications é evolução válida se eliminar a dependência do cliente; polling está descartado por ineficiência.

**Libraries:** —

### phase-03-videos/TD-04

**Recommendation:** `@aws-sdk/client-s3` v3 (+ `s3-request-presigner` + `lib-storage`) — paridade total MinIO↔S3 via `endpoint` + `forcePathStyle: true`, presigner e multipart oficiais, tipagem forte, e troca transparente para S3 em produção (alvo declarado). `minio-js` e `s3-lite-client` funcionam mas comprometem a transparência da migração para S3.

**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner, @aws-sdk/lib-storage

### phase-03-videos/TD-05

**Recommendation:** Bucket único privado com layout de chaves por vídeo (`videos/{publicId}/source.<ext>`, `videos/{publicId}/thumbnail.jpg`), todo acesso de leitura via presigned GET — minimiza superfície (um bucket) e mantém controle de acesso uniforme, coerente com o foco backend da fase. Buckets separados por visibilidade (originais privados + thumbnails públicos) é a evolução natural quando o custo de presigned em listagens pesar (Fases 05/07).

**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** Container worker dedicado (mesmo codebase NestJS, processo separado) que consome a fila e processa com `ffprobe` (duração/metadados) e `ffmpeg` (frame → thumbnail), com binários FFmpeg na imagem — isola a carga de CPU da API, escala/reinicia independente e atende o critério "worker real subindo no Compose" + diagrama C4. O wrapper (`fluent-ffmpeg` vs `child_process`) é detalhe de implementação resolvido no `implement` pelas best-practices.

**Libraries:** fluent-ffmpeg, @types/fluent-ffmpeg

### phase-03-videos/TD-07

**Recommendation:** Presigned GET com Range nativo do storage para streaming e download — o tráfego de vídeo não passa pela API (coerente com "sem travar o sistema"), com Range/206 servidos pelo MinIO/S3 (streaming real) e presigned de TTL curto para controle de acesso; download via presigned GET com `response-content-disposition: attachment`. Proxy de Range pela API só se justifica quando for indispensável interceptar cada requisição (não é requisito desta fase); o híbrido é a evolução quando a visibilidade restrita (Fases 04/05) entrar em jogo.

**Libraries:** —

### phase-03-videos/TD-08

**Recommendation:** `nanoid` gerando um identificador público curto, URL-safe e opaco, persistido em coluna única indexada (`public_id`), com retry em colisão improvável — entrega a URL única estilo `watch?v=...` sem expor a PK. UUID degrada a URL (longo) e `hashids` pressupõe IDs sequenciais que o projeto não usa (PKs são UUID).

**Libraries:** nanoid

### phase-03-videos/TD-09

**Recommendation:** Enum de status explícito (`draft` → `processing` → `ready` | `failed`) refletido no banco — o vídeo nasce `draft` ao iniciar o upload, vai a `processing` ao confirmar, `ready` no sucesso e `failed` ao esgotar os retries/backoff da fila (TD-01), com falhas terminais na dead-letter para auditoria. Reflete fielmente o ciclo "rascunho → processando → pronto/erro"; flag booleana é insuficiente e o detalhamento de erro em tabela própria é evolução opcional (a dead-letter cobre a auditoria mínima do MVP).

**Libraries:** —

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, zero custom wiring, native string-to-number coercion.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — Clear file boundaries per domain, typed injection via `ConfigType<typeof xxxConfig>`, natural scalability. The `registerAs()` factory is dual-purpose: DI token + plain importable function.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — `data-source.ts` imports the factory, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — OWASP-recommended for greenfield 2026; native build is a one-time Docker cost; no legacy constraint favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.

**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Custom guards with `@nestjs/jwt` only (decision diverged from the @nestjs/passport recommendation during implementation, to keep the dependency surface smaller — social login is not on the near-term roadmap).

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Refresh Token Rotation — strongest model with automatic theft detection; DB write overhead acceptable (auth refresh is infrequent vs. video ops); PostgreSQL already in stack; short grace period mitigates races.

**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Random Opaque Tokens in DB — revocability matters (new reset invalidates previous tokens); trivial table that can serve future needs; keeps email tokens decoupled from JWT auth.

**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** `@nestjs-modules/mailer` — best NestJS integration, SMTP matching the architecture diagram, works with Mailpit locally, Handlebars templates, no vendor lock-in.

**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** class-validator + class-transformer — backend-only project (no shared FE schemas), documented NestJS approach, project already uses decorators (TypeORM/DI), fewer integration surprises with NestJS 11.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Custom Domain Exception Filter — machine-readable error codes for the first-party consumer without RFC 9457 overhead; simple `{ statusCode, error, message }` format with domain codes; low cost (two small files). Services throw domain exceptions; the global filter maps them to HTTP.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** `@nestjs/throttler` — native NestJS integration (guard system, `@SkipThrottle()`), single-instance in-memory storage sufficient; avoids bypassing DI/guard lifecycle.

**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Refresh token kept as JWT (decision diverged from the opaque recommendation) to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`) — single token format across the codebase.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Strict `[a-z0-9_]` allowlist with `user_<random>` fallback for nickname generation from the email prefix — simplest and most portable, no extra dependency, valid handle even for extreme prefixes.

**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. New env keys (storage, Redis, FFmpeg) follow this. _(from phase 01)_
- Config is injected via `ConfigType<typeof xxxConfig>` + `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts (e.g., TypeORM CLI, worker bootstrap). _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'`, then calls `databaseConfig` as a plain function; DB connection params come from that single factory — never duplicated. _(from phase 01)_
- `TypeOrmModule.forRootAsync` (not `forRoot`) with `inject: [databaseConfig.KEY]`, `autoLoadEntities: true`, `synchronize: false`. Migrations are versioned (`<timestamp>-Name.ts`), entities use UUID PK (`uuid_generate_v4()`) and snake_case columns. _(from phase 01)_
- A global JWT guard (`APP_GUARD`) protects every endpoint by default; anonymous routes opt out with `@Public()`. New video endpoints inherit this — anonymous watch/download must be explicitly `@Public()`. _(from phase 02)_
- A global `ValidationPipe` (whitelist) is active; request bodies/params use DTOs with `class-validator`/`class-transformer`. _(from phase 02)_
- Services throw **domain exceptions** (never NestJS HTTP exceptions); a global exception filter maps them to the standard `{ statusCode, error, message }` shape. _(from phase 02)_
- Rate limiting is enforced via the global `ThrottlerGuard` (`@nestjs/throttler`); endpoints opt out with `@SkipThrottle()`. _(from phase 02)_
- Layering: each domain feature is its own module (controller → service → repository), registered in `AppModule`; controllers are thin, services hold business logic. _(from phase 02)_
- REST conventions enforced on controllers (plural resource nouns, correct HTTP methods/status codes). _(from phase 02)_
- HTTP endpoints are documented with `@nestjs/swagger` (OpenAPI) — new video endpoints follow the same documentation convention. _(from technical-decisions-openapi-docs-nestjs)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` not initialized; UI surfaces start in a later phase. Not in scope for this backend phase. |

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

Layer requirements per artifact type (from `testing-guide-nestjs-project`, §3 Feature Implementation Checklist). The video module introduces entities, services (with branching + DB + side-effect deps on storage/queue), controllers, DTOs, a module with configured imports (`BullModule.registerQueue`, `TypeOrmModule.forFeature`), and the worker.

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) — Video | Integration: constraints (unique `public_id`), defaults, status enum, channel FK |
| Service with branching + DB | Unit (branch logic, mock repo) + Integration (DB contract) |
| Service with side-effect dep (storage/queue) | Integration: real capture via Compose infra (MinIO/Redis) — do not mock what Compose can run |
| Module with configured imports | Unit: compilation test (DI wiring of `BullModule`/`TypeOrmModule.forFeature`) |
| Controller (`*.controller.ts`) | E2E only — status codes, auth enforcement (`@Public` on anonymous routes), response shape |
| DTO (`*.dto.ts`) | E2E: one validation-wiring test per endpoint (`ValidationPipe` active) |
| Worker / queue processor | Integration: enqueue → process → DB/storage side effects, exercising the real queue (Compose) |

Test suffixes: `*.spec.ts` (unit), `*.integration-spec.ts` (integration with real DB/services), `*.e2e-spec.ts` (HTTP via supertest). Per-SI layer coverage is recorded in `progress.md`. **Policy:** do not mock storage/queue when the Compose infra can exercise them for real.
