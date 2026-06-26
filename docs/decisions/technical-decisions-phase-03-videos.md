---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-06-26
scope_description: "Upload de vídeos de até 10GB, object storage, fila de processamento, worker FFmpeg, streaming, download e URL única"
---

# Technical Decisions — Fase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — Backend. Recebe o módulo de vídeos, a integração com object storage, a fila de processamento, o worker de mídia (FFmpeg) e os novos serviços no `compose.yaml`. Todas as TDs abaixo cobrem este subprojeto.
- `next-frontend/` — Frontend. **Sem decisão técnica nesta fase.** O enunciado é explícito: a interface de vídeo não faz parte do escopo da Fase 03 (entrega é API + worker + infra). Os contratos de API definidos aqui (handshake de upload, streaming, download) serão consumidos por um cliente em fase futura, mas nenhuma decisão de frontend é tomada agora.

> Nota de infraestrutura: os serviços novos no `compose.yaml` (object storage, broker de fila quando aplicável, worker) são **consequência** das TDs de Backend abaixo (TD-01, TD-04, TD-06), não uma decisão `Repo-wide` independente — a estrutura do compose permanece unificada, sem split/profiles. Por isso não há TD `Repo-wide` separada.

---

## TD-01: Tecnologia da fila de processamento em segundo plano

**Scope:** Backend

**Capability:** "Serviço de processamento em segundo plano (filas)"

**Context:** A Fase 03 precisa processar vídeos (extração de metadados e geração de thumbnail) de forma assíncrona, fora do ciclo de request, sem bloquear a API. O `project-plan.md` deixa a tecnologia de fila explicitamente em aberto ("Message Queue — TBD"). Esta é a principal decisão de stack da fase. Restrição herdada relevante: o projeto evitou deliberadamente adicionar Redis até aqui (a Fase 02 registrou "No need for Redis — PostgreSQL suffices" para refresh tokens), então introduzir Redis é uma escolha de infraestrutura nova, não uma extensão do stack atual.

**Options:**

### Option A: BullMQ + Redis (`@nestjs/bullmq`)
- Fila baseada em Redis. `Queue` para enfileirar e `Worker` para consumir (pode rodar em processo/container separado). Integração oficial NestJS via `@nestjs/bullmq` (`@Processor`/`@Process`). Suporta `attempts` + `backoff` exponencial e eventos `failed`.
- **Pros:** Padrão de facto no ecossistema NestJS; alto throughput; rico em scheduling/rate-limiting; adiciona um **container de fila dedicado** (Redis) — leitura literal do critério "fila real subindo no Compose" e do diagrama C4 (Message Queue como container). UI opcional (Bull Board).
- **Cons:** Introduz **Redis** como nova dependência de infra (contraria a postura "sem Redis" do projeto); dead-letter é manual (via handler de `failed`); mais um serviço para operar.

### Option B: pg-boss (fila no PostgreSQL existente)
- Fila persistida no PostgreSQL já no stack. `boss.work(name, opts, handler)` com `localConcurrency`/`pollingInterval`/`batchSize`. `retryLimit` (default 2), `retryDelay`, `retryBackoff` exponencial e **dead-letter queue nativa**. Permite criar o job **na mesma transação** que cria o vídeo rascunho (atomicidade) e expõe `AbortSignal` para cancelamento.
- **Pros:** Zero infra nova — reaproveita o Postgres (coerente com a decisão da Fase 02 de evitar Redis); enfileiramento transacional (o rascunho e o job nascem atômicos); dead-letter e retry/backoff nativos; troca de worker independente da API.
- **Cons:** Menor throughput que Redis (irrelevante para a carga de processamento de vídeo, que é I/O/CPU-bound no FFmpeg, não na fila); **não há um container de fila dedicado** no Compose (a "fila" é o Postgres) — pode divergir de uma leitura literal de "fila subindo no Compose" e do diagrama C4.

### Option C: RabbitMQ (`amqplib` / `@nestjs/microservices`)
- Broker de mensageria AMQP dedicado, como container próprio. Worker consome via canal/queue, com ack/nack e dead-letter exchanges.
- **Pros:** Broker robusto e agnóstico; dead-letter exchanges nativas; container de fila dedicado (atende o critério literal).
- **Cons:** Mais pesado operacionalmente que Redis/Postgres para este escopo; sem integração de jobs tão ergonômica quanto BullMQ/pg-boss (é mensageria, não job-queue com retries/backoff prontos); maior curva para um único tipo de job (processar vídeo).

**Recommendation:** **Option A (BullMQ + Redis)** — pela aderência direta ao critério de aceite do desafio ("fila real subindo no Compose") e ao diagrama C4 (Message Queue como container dedicado), além de ser o padrão NestJS com worker em processo separado e retry/backoff prontos. **Trade-off honesto:** se minimizar infraestrutura fosse a prioridade, **pg-boss (B)** seria tecnicamente superior para este projeto (sem Redis, enfileiramento transacional atômico com o rascunho, dead-letter nativo) — é uma alternativa plenamente válida e recomendada como segunda opção. RabbitMQ (C) é overkill para um único tipo de job.

**Decision:** **Option A — BullMQ + Redis.** Escolhido pela aderência inequívoca ao critério de aceite ("fila real subindo no Compose") e ao diagrama C4 (Message Queue como container dedicado), além de ser o padrão NestJS (worker em processo separado, retry/backoff, `@nestjs/bullmq`). O custo de adicionar Redis é justificado pelo requisito do desafio; pg-boss fica registrado como alternativa técnica forte caso minimizar infraestrutura passe a ser prioridade.
**Libraries:** bullmq, @nestjs/bullmq

---

## TD-02: Estratégia de upload de vídeos de até 10GB

**Scope:** Backend

**Capability:** "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance"

**Context:** O arquivo de até 10GB não pode trafegar pela API (passar 10GB por um handler Node trava o event loop, consome memória e derruba a performance — o enunciado proíbe isso explicitamente). É preciso um mecanismo que envie o arquivo diretamente ao object storage sem onerar a API, e que cubra 10GB. A API entra apenas no início (pré-cadastro do rascunho + emissão das credenciais de upload) e no fim (confirmação — ver TD-03). Define um contrato de handshake que qualquer cliente (incl. o frontend futuro) consumirá.

**Options:**

### Option A: Presigned **multipart** upload direto ao storage
- A API cria o rascunho e inicia um multipart upload (`CreateMultipartUpload`), devolvendo presigned URLs por parte (`UploadPart`). O cliente envia as partes **direto ao MinIO/S3** (em paralelo, com retomada por parte) e a API finaliza (`CompleteMultipartUpload`) na confirmação.
- **Pros:** O arquivo nunca passa pela API (não trava nada); cobre 10GB (multipart vai até 5TB; paralelismo e retry por parte); padrão S3 nativo, idêntico em MinIO e produção.
- **Cons:** Handshake mais elaborado (iniciar → assinar partes → completar); a API precisa orquestrar o ciclo multipart e lidar com uploads abandonados (abort/expiração).

### Option B: Presigned **PUT simples** (URL única)
- A API gera uma única presigned URL (`PutObject`); o cliente faz um único PUT do arquivo inteiro direto ao storage.
- **Pros:** Handshake mínimo (uma URL); arquivo também não passa pela API.
- **Cons:** **Não cobre 10GB** — o `PutObject` único do S3 limita a 5GB por objeto; sem paralelismo nem retomada (uma falha de rede reinicia os 10GB). Inadequado ao requisito.

### Option C: Protocolo tus (resumable upload)
- Servidor tus (ex.: `@tus/server`) recebe uploads resumíveis em chunks, com retomada robusta; depois move o objeto ao storage.
- **Pros:** Resumability de primeira classe; ótima UX de upload em redes instáveis.
- **Cons:** Adiciona um **servidor tus** (mais infra/complexidade) e, se o tus receber o upload, o tráfego volta a passar por um serviço próprio (a menos que se use o backend S3 do tus); redundante com o multipart nativo do S3/MinIO para este escopo.

### Option D: Proxy/stream pela API (`multer`/streaming)
- O cliente envia o arquivo para a API, que faz streaming para o storage.
- **Pros:** Handshake trivial; controle total no servidor.
- **Cons:** **É exatamente o anti-padrão proibido** — 10GB passam pela API, ocupando o serviço durante todo o envio; reprova automática segundo o enunciado.

**Recommendation:** **Option A (presigned multipart direto ao storage)** — é a única que cobre 10GB sem trafegar pela API, com paralelismo e retomada por parte, usando o multipart nativo do S3/MinIO (mesmo SDK em dev e prod). PUT simples (B) não atinge 10GB; tus (C) agrega infra desnecessária dado o multipart nativo; proxy (D) é o caminho proibido.

**Decision:** **Option A** — conforme recomendação.

---

## TD-03: Sinalização de conclusão do upload e disparo do processamento

**Scope:** Backend

**Capability:** "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** Com upload direto ao storage (TD-02), a API não vê o byte final do arquivo. É preciso decidir como a API descobre que o upload terminou para **finalizar o multipart**, validar o objeto e **enfileirar o processamento** (TD-01), transicionando o status do vídeo (TD-09).

**Options:**

### Option A: Endpoint de confirmação do cliente + validação no storage
- Após enviar todas as partes, o cliente chama `POST /videos/:id/complete` (com os ETags das partes). A API executa `CompleteMultipartUpload`, valida o objeto (`HeadObject` — existência/tamanho) e enfileira o job de processamento.
- **Pros:** Simples e explícito; sem acoplar à configuração de eventos do storage; a API mantém controle (valida antes de enfileirar); funciona idêntico em MinIO e S3.
- **Cons:** Depende de o cliente chamar o endpoint (uploads não confirmados ficam como rascunho "pendente" — mitigável com expiração/limpeza de multipart abandonado).

### Option B: Bucket notifications do storage (evento → webhook)
- MinIO/S3 emite evento `s3:ObjectCreated:*` ao concluir o upload, chamando um webhook na API, que então enfileira.
- **Pros:** Não depende do cliente confirmar; desacoplado do fluxo de request.
- **Cons:** Adiciona configuração de eventos no MinIO (e diferença operacional MinIO↔S3/SNS); exige endpoint webhook público/seguro; o multipart ainda precisa ser concluído (evento dispara após complete) — não elimina a confirmação, só desloca o trigger.

### Option C: Polling da API
- A API verifica periodicamente o storage por objetos novos/concluídos.
- **Pros:** Independe de cliente e de eventos.
- **Cons:** Ineficiente (varredura periódica), latência variável, escala mal; anti-idiomático.

**Recommendation:** **Option A (endpoint de confirmação + `HeadObject`)** — o caminho mais simples e portável (MinIO↔S3 sem config extra), mantendo a API no controle do `CompleteMultipartUpload` e da validação antes de enfileirar. Bucket notifications (B) é uma evolução válida se quisermos eliminar a dependência do cliente, mas adiciona acoplamento à infra de eventos; polling (C) está descartado por ineficiência.

**Decision:** **Option A** — conforme recomendação.

---

## TD-04: Cliente/SDK do object storage

**Scope:** Backend

**Capability:** "Serviço de armazenamento de arquivos (vídeos e thumbnails)"

**Context:** O storage já é dado (S3-compatível; MinIO local em Docker, S3 em produção). A decisão é qual biblioteca cliente usar para falar com ele — gerar presigned URLs (TD-02/03/07), orquestrar multipart e ler objetos.

**Options:**

### Option A: `@aws-sdk/client-s3` v3 (+ `@aws-sdk/s3-request-presigner`, `@aws-sdk/lib-storage`)
- SDK oficial AWS v3, modular e tipado. `S3Client` com `endpoint` + `forcePathStyle: true` fala com MinIO; `s3-request-presigner` gera presigned GET/PUT; comandos de multipart nativos; `lib-storage` para uploads server-side quando necessário.
- **Pros:** Padrão da indústria; **mesma API para MinIO e S3** (troca por env, sem mudar código); presigner e multipart oficiais e bem documentados; TypeScript first-class.
- **Cons:** Pacote mais "AWS-cêntrico"; superfície de API maior.

### Option B: `minio-js` (cliente oficial MinIO)
- Cliente JS oficial do MinIO; API enxuta com `presignedPutObject`/`presignedGetObject` e multipart.
- **Pros:** Simples e direto para MinIO; menos verboso.
- **Cons:** Amarra mais ao MinIO; migração para S3 puro em produção é menos transparente que o SDK AWS (que é o alvo declarado "S3 em produção").

### Option C: `s3-lite-client`
- Cliente S3 leve e sem dependências, compatível com MinIO/S3.
- **Pros:** Mínimo footprint; cobre o essencial (presigned, multipart).
- **Cons:** Menos difundido/suportado que o SDK AWS; menor garantia de paridade com features S3 avançadas a longo prazo.

**Recommendation:** **Option A (`@aws-sdk/client-s3` v3)** — é o caminho com paridade total MinIO↔S3 (o projeto declara "trocaria por S3 em produção"), com presigner e multipart oficiais e tipagem forte, sem amarrar a implementação ao MinIO. `minio-js` e `s3-lite-client` funcionam, mas comprometem a transparência da troca para S3.

**Decision:** **Option A** — conforme recomendação.
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner, @aws-sdk/lib-storage

---

## TD-05: Organização de buckets/chaves e visibilidade dos objetos

**Scope:** Backend

**Capability:** "Serviço de armazenamento de arquivos (vídeos e thumbnails)"

**Context:** É preciso definir como os objetos (vídeo original e thumbnail) são organizados no storage e qual sua visibilidade — o que condiciona streaming/download (TD-07) e a privacidade dos vídeos. Decisão cross-component (código + política do bucket + estratégia de presigned).

**Options:**

### Option A: Bucket único privado + layout de chaves por vídeo
- Um bucket privado; chaves estruturadas por vídeo, ex.: `videos/{publicId}/source.<ext>` e `videos/{publicId}/thumbnail.jpg`. Todo acesso de leitura (vídeo e thumbnail) via presigned GET.
- **Pros:** Simples (um bucket); namespacing claro por vídeo; tudo privado por padrão (controle de acesso uniforme via presigned); fácil limpeza por prefixo.
- **Cons:** Thumbnails (que são públicos para usuários anônimos nas listagens) também exigem presigned — overhead em telas com muitas miniaturas (mitigável com presigned de cache mais longo ou evolução para B).

### Option B: Buckets separados por visibilidade
- Bucket privado para originais (`videos-private`) + bucket público para thumbnails (`thumbnails-public`), thumbnails servidos por URL pública direta.
- **Pros:** Thumbnails públicos servidos sem presigned (eficiente em listagens/anônimos); separação clara de política de acesso.
- **Cons:** Dois buckets e duas políticas para gerenciar; expõe diretamente o thumbnail (aceitável, pois é público por natureza).

### Option C: Bucket por canal
- Um bucket por canal de usuário.
- **Pros:** Isolamento por tenant.
- **Cons:** Explosão de buckets (limites e operação ruins); desnecessário — o isolamento lógico por chave já basta.

**Recommendation:** **Option A (bucket único privado + chaves por `publicId`)** para o MVP da fase — minimiza superfície (um bucket, tudo privado via presigned) e mantém controle de acesso uniforme, coerente com o foco backend da fase. **Option B** é a evolução natural quando o custo de presigned em listagens de thumbnails pesar (telas públicas das Fases 05/07). Bucket por canal (C) está descartado por operação.

**Decision:** **Option A** — conforme recomendação.

---

## TD-06: Execução do worker e toolchain de processamento de mídia (FFmpeg)

**Scope:** Backend

**Capability:** "Geração automática de thumbnail a partir de um frame do vídeo"
(Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo")

**Context:** O processamento (extrair duração/metadados e gerar thumbnail de um frame) é pesado de CPU/I/O e deve rodar fora do ciclo de request, consumindo a fila (TD-01). É preciso decidir **onde** o worker roda e **como** ele invoca o FFmpeg/ffprobe. O diagrama C4 já prevê um "Video Worker (FFmpeg)" como container.

**Options:**

### Option A: Container worker dedicado + `ffprobe`/`ffmpeg`
- Um serviço separado no Compose (mesmo codebase NestJS, processo distinto) consome a fila e processa: `ffprobe` para duração/metadados, `ffmpeg` para extrair um frame como thumbnail. Imagem com binários FFmpeg instalados. Baixa o original do storage (ou usa presigned), processa, sobe o thumbnail e atualiza o banco.
- **Pros:** Isola a carga de CPU do FFmpeg da API (a API permanece responsiva); escala/reinicia independente; alinhado ao diagrama C4 ("Video Worker") e ao critério "worker subindo no Compose"; reuso do código/entidades do projeto.
- **Cons:** Mais um serviço no Compose e uma imagem com FFmpeg (build maior); precisa de acesso ao storage e ao banco.

### Option B: Worker in-process na API (mesmo container)
- O processamento roda dentro do processo da API (handler da fila no mesmo container).
- **Pros:** Zero serviço novo; deploy mais simples.
- **Cons:** FFmpeg compete por CPU com o atendimento HTTP (degrada a API sob carga); não atende o "worker subindo no Compose" como serviço separado; escala acoplada.

### Option C: Worker dedicado chamando FFmpeg via `child_process` direto (sem wrapper)
- Igual ao A na topologia, mas invocando `ffmpeg`/`ffprobe` por `spawn` direto, parseando saída manualmente, sem `fluent-ffmpeg`.
- **Pros:** Sem dependência de wrapper; controle total da linha de comando.
- **Cons:** Mais código boilerplate para montar comandos e parsear `ffprobe` (vs. a ergonomia de `fluent-ffmpeg`); maior chance de erro no parsing.

**Recommendation:** **Option A (container worker dedicado + `ffprobe`/`ffmpeg`)** — isola a carga pesada da API, escala de forma independente e atende diretamente o critério "worker real subindo no Compose" e o diagrama C4. Quanto ao **wrapper**, `fluent-ffmpeg` tende a ser preferível pela ergonomia de montar comandos e extrair metadados, mas `child_process` direto (C) é aceitável — esse detalhe de implementação fica para o `implement`, guiado pelas best-practices. Worker in-process (B) está descartado por acoplar CPU pesada à API.

**Decision:** **Option A** — conforme recomendação.
**Libraries:** fluent-ffmpeg, @types/fluent-ffmpeg

---

## TD-07: Estratégia de streaming e download do vídeo

**Scope:** Backend

**Capability:** "Reprodução via streaming (sem necessidade de download completo)"
(Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário")

**Context:** O vídeo precisa ser reproduzível por streaming (o player busca apenas os bytes necessários, via HTTP Range / `206 Partial Content`) sem baixar o arquivo inteiro, e também disponível para download. É preciso decidir se a API serve os bytes ou se delega ao storage.

**Options:**

### Option A: Redirect para presigned GET do storage (storage serve Range/206)
- A API valida o acesso e responde com um redirect (ou devolve) uma presigned GET URL de expiração curta; o player/cliente faz as requisições **direto ao MinIO/S3**, que suporta HTTP Range e `206` nativamente. Download = presigned GET com `response-content-disposition: attachment`.
- **Pros:** O tráfego de vídeo **não passa pela API** (coerente com "sem travar o sistema"); Range/206 nativos do storage (streaming real, sem download completo); escala com o storage, não com a API; mesma mecânica em MinIO e S3.
- **Cons:** Controle de acesso é "por emissão de URL" (presigned com TTL curto) e não por cada byte-range; a URL assinada fica visível ao cliente durante sua validade.

### Option B: Proxy de Range pela API (`206` repassado)
- A API recebe a requisição com header `Range`, lê o intervalo do storage e repassa como `206 Partial Content`.
- **Pros:** Controle total por requisição (auth, contagem de views, regras de visibilidade aplicadas a cada range); a URL do storage nunca é exposta.
- **Cons:** Todo o tráfego de vídeo passa pela API (gargalo de banda/CPU/conegões persistentes); contraria o princípio de não onerar a API com bytes de vídeo; mais caro para 10GB.

### Option C: Híbrido (proxy para vídeos restritos, presigned para públicos)
- Públicos via presigned (A); restritos/unlisted via proxy (B).
- **Pros:** Equilíbrio entre eficiência e controle.
- **Cons:** Duas trajetórias para manter e testar; complexidade extra que só se justifica com requisitos de visibilidade que pertencem a fases posteriores (04/05).

**Recommendation:** **Option A (presigned GET com Range nativo do storage)** para streaming e download — entrega streaming real (206) sem onerar a API, escalando com o storage, com presigned de TTL curto para controle de acesso. Proxy (B) só se justifica quando for indispensável interceptar cada requisição (não é requisito desta fase); o híbrido (C) é a evolução natural quando a visibilidade restrita (Fases 04/05) entrar em jogo.

**Decision:** **Option A** — conforme recomendação.

---

## TD-08: Geração da URL única do vídeo

**Scope:** Backend

**Capability:** "URL única por vídeo, sem conflito com outros vídeos"

**Context:** Cada vídeo precisa de um identificador público curto e único para compor sua URL (estilo `watch?v=...`), sem conflitar com outros e sem expor a chave primária. Esse identificador é persistido (coluna única indexada) e usado nas rotas de streaming/download/visualização.

**Options:**

### Option A: `nanoid`
- Gera um ID curto, URL-safe e colisão-resistente (ex.: 11 caracteres do alfabeto padrão). Armazenado em coluna única indexada (`public_id`).
- **Pros:** Curto e amigável na URL; alta resistência a colisão; não expõe a PK nem ordem de criação; biblioteca minúscula e padrão moderno.
- **Cons:** Dependência nova (pequena); colisão teórica exige índice único + retry (probabilidade desprezível no volume do projeto).

### Option B: UUID v4
- Reusa o padrão de PK do projeto (UUID nas entidades atuais).
- **Pros:** Já no stack (sem dependência nova); unicidade garantida.
- **Cons:** Longo e "feio" na URL (36 chars); pior UX de URL pública; mais do que o necessário para um identificador de vídeo.

### Option C: `hashids`
- Codifica um ID sequencial interno em um hash curto reversível (com salt).
- **Pros:** Curto; deriva de um inteiro sequencial.
- **Cons:** Exige um ID sequencial (o projeto usa UUID, não serial) e gestão de salt; reversível (não é ID opaco real); mais fricção que `nanoid` para o mesmo benefício.

**Recommendation:** **Option A (`nanoid`)** — entrega o identificador público curto e opaco que a URL única pede, com índice único na coluna `public_id` (+ retry em colisão improvável), sem expor a PK. UUID (B) serve mas degrada a URL; `hashids` (C) pressupõe IDs sequenciais que o projeto não usa.

**Decision:** **Option A** — conforme recomendação.
**Libraries:** nanoid

---

## TD-09: Ciclo de status do vídeo e tratamento de falha no processamento

**Scope:** Backend

**Capability:** "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"
(Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)")

**Context:** O vídeo nasce como rascunho ao iniciar o upload e precisa refletir no banco a evolução até ficar pronto — ou falhar. É preciso definir a máquina de estados e o que acontece quando o processamento (TD-06) falha, considerando os retries da fila (TD-01).

**Options:**

### Option A: Enum de status com estado terminal de erro + retry/backoff da fila
- Coluna `status` com enum explícito (ex.: `draft` → `processing` → `ready` | `failed`). Ao confirmar o upload (TD-03), enfileira e marca `processing`; sucesso → `ready`; ao esgotar os retries/backoff da fila (TD-01) → `failed`. Falhas terminais vão para a dead-letter da fila para auditoria.
- **Pros:** Estados explícitos e legíveis; distingue "processando" de "erro"; integra-se ao retry/backoff e dead-letter da fila; permite à UI/consumidor reagir a cada estado; auditável.
- **Cons:** Exige definir transições válidas e refletir no banco (enum + migração).

### Option B: Flag booleana (`is_ready`)
- Apenas um booleano "pronto ou não".
- **Pros:** Trivial de implementar.
- **Cons:** Não distingue rascunho/processando/erro; impossível comunicar falha ao usuário; insuficiente para o ciclo que o enunciado descreve (rascunho → processando → pronto/erro).

### Option C: Enum de status + tabela/colunas de erro detalhado
- Como A, porém persistindo também detalhes do erro (mensagem, tentativa, timestamp) em colunas/tabela dedicadas.
- **Pros:** Observabilidade fina das falhas; facilita reprocessamento manual.
- **Cons:** Mais esquema e escrita; parte do detalhe se sobrepõe à dead-letter da fila; pode ser overkill para o MVP da fase.

**Recommendation:** **Option A (enum de status `draft`/`processing`/`ready`/`failed` + retry/backoff e dead-letter da fila)** — reflete fielmente o ciclo "rascunho → processando → pronto/erro" exigido, distinguindo erro de processamento, e reaproveita o retry/backoff e a dead-letter já decididos em TD-01. Booleano (B) é insuficiente; o detalhamento de erro (C) é uma evolução opcional (a dead-letter da fila já cobre a auditoria mínima no MVP).

**Decision:** **Option A** — conforme recomendação.

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Tecnologia da fila de processamento | BullMQ + Redis (alternativa forte: pg-boss) | ✅ Option A |
| TD-02 | Backend | Estratégia de upload de até 10GB | Presigned multipart direto ao storage | ✅ Option A |
| TD-03 | Backend | Sinalização de conclusão do upload e disparo do processamento | Endpoint de confirmação + `HeadObject` | ✅ Option A |
| TD-04 | Backend | Cliente/SDK do object storage | `@aws-sdk/client-s3` v3 (+ presigner/lib-storage) | ✅ Option A |
| TD-05 | Backend | Organização de buckets/chaves e visibilidade | Bucket único privado + chaves por `publicId` | ✅ Option A |
| TD-06 | Backend | Worker dedicado + toolchain FFmpeg | Container worker + `ffprobe`/`ffmpeg` | ✅ Option A |
| TD-07 | Backend | Streaming e download | Presigned GET com Range nativo do storage | ✅ Option A |
| TD-08 | Backend | Geração da URL única do vídeo | `nanoid` (coluna `public_id` única) | ✅ Option A |
| TD-09 | Backend | Ciclo de status e tratamento de falha | Enum `draft`/`processing`/`ready`/`failed` + retry/dead-letter | ✅ Option A |
