# video-editor-api

Site/API que aplica efeitos em fotos (sem IA, com presets JSON fixos) e gera vídeos curtos com áudio para Instagram, Facebook, TikTok e YouTube Shorts.

**Estado atual: Fase 2A (API).** O motor renderiza fotos e clipes de vídeo com todos os efeitos do catálogo, logos, texto e trecho de áudio. A API recebe os arquivos por upload, enfileira e devolve o vídeo. O site ainda não existe.

## Estrutura

| Pasta | Conteúdo |
|---|---|
| `packages/engine` | Motor: presets, regra de duração, montagem do FFmpeg, ferramentas de linha de comando |
| `presets/` | Um arquivo JSON por estilo; LUTs em `presets/luts/` |
| `assets/fonts` | Fontes usadas nos textos |
| `apps/api` | API HTTP (Fastify), fila e banco SQLite |
| `scripts/` | `testar-api.ps1`: envia uma pasta de fotos para a API a partir do Windows |

## Requisitos

- Node.js 22 ou superior
- **FFmpeg 6.1 ou superior** e ffprobe no `PATH` (ou as variáveis `FFMPEG_PATH` / `FFPROBE_PATH`). Versões anteriores não têm todas as 58 transições; o motor avisa quais faltam.

## Uso

```bash
npm install
npm run assets            # gera imagens e áudios sintéticos de teste em assets/test
npm run sample -- --audio assets/test/tone.wav --start 5 --duration 15
# resultado em out/amostra.mp4, com as medições impressas em JSON
```

Com as suas fotos, música e logo:

```bash
npm run sample -- --photos ./fotos --preset limpo --audio ./musica.mp3 --start 0:32 --end 0:56 --logo-brand ./logo.png
```

Para legendas, ponto de interesse por foto, título e duas logos, use um arquivo de pedido:

```json
{
  "preset": "limpo",
  "platform": "instagram_reels",
  "title": "Título do vídeo",
  "items": [
    { "file": "fotos/01.jpg", "caption": "Legenda da primeira foto" },
    { "file": "fotos/02.jpg", "focus": { "x": 0.3, "y": 0.5 } },
    { "type": "clip", "file": "videos/luta.mp4", "start": 2, "end": 6.5, "keepAudio": true, "volume": 0.8 }
  ],
  "audio": { "file": "musica.mp3", "start": 32, "end": 56 },
  "logos": [
    { "role": "brand", "file": "logo.png" },
    { "role": "partner", "file": "parceiro.png" }
  ]
}
```

```bash
npm run sample -- --request pedido.json
```

### Clipes de vídeo

- Entram com `"type": "clip"` (ou pela extensão `.mp4`, `.mov`, `.m4v`, `.webm`, `.mkv`).
- Trecho opcional: `start` e `end`, ou `start` e `duration` (segundos ou `"mm:ss"`). Sem trecho, o clipe inteiro.
- O clipe mantém a própria duração; as fotos dividem o tempo que sobra. Sem fotos, o vídeo dura a soma dos clipes.
- Som original: mudo por padrão. Com `keepAudio: true` ele é misturado à música, e a música abaixa enquanto ele toca (`audio.clipDucking` do preset).
- Enquadramento, ponto de interesse, filtros de cor e legendas valem como nas fotos. O zoom lento é só das fotos.
- Rotação gravada pelo celular é respeitada; vídeos HDR (PQ ou HLG) são convertidos para cores normais.
- Limites: até 10 clipes por vídeo, trecho mínimo de 1 s, resolução até 4K.

`npm run sample -- --help` lista todas as opções. `npm test` roda os testes.

## Presets

Cada estilo é um JSON em `presets/`, validado pelo schema em `packages/engine/src/schema.ts` (o mesmo que vai alimentar o editor visual). Um preset pode herdar de outro com `"extends": "limpo"` e sobrescrever só o que muda; `null` desliga um bloco herdado.

| Bloco | O que define |
|---|---|
| `photo` | Enquadramento (`cover`, `contain`, `auto`), fundo do `contain` e a lista de filtros: `color`, `curves`, `grayscale`, `sepia`, `lut`, `vignette`, `grain`, `blur`, `sharpen`, `clarity`. Vale também para os clipes |
| `motion` | Zoom lento (Ken Burns) e deslocamento |
| `transition` | `type` (uma) ou `types` (lista) entre as 58 do FFmpeg, com `order` `cycle` (rodízio) ou `random` (sorteio com `seed` fixa) |
| `timing` | Tempo mínimo e máximo de cada foto |
| `audio` | Fades, volume e volume da música durante clipes com som (`clipDucking`) |
| `letterbox` | Barras de cinema |
| `text` | Estilo do título e das legendas |
| `branding` | Onde cada logo aparece: `watermark`, `intro`, `outro`, `between` |

Exemplos completos em `packages/engine/test/fixtures/`.

## API (Fase 2A)

```bash
npm run build
DATA_DIR=./data ADMIN_KEY=uma-chave-longa-qualquer npm run api   # porta 3000
```

### Autenticação

- Clientes: `Authorization: Bearer vea_...` (ou `X-API-Key`). O servidor guarda só o hash da chave.
- Administração: `X-Admin-Key: <ADMIN_KEY>`. Nas rotas GET de administração também vale `?key=` (para conferir pelo navegador; dá para desligar com `ADMIN_QUERY_KEY=false`). A chave nunca aparece nos logs.

### Rotas

| Rota | O que faz |
|---|---|
| `POST /v1/videos` | Cria um vídeo (multipart: campo `options` em JSON + arquivos). Responde `202` com o `id` |
| `GET /v1/videos/:id` | Estado (`queued`, `processing`, `done`, `failed`, `expired`), progresso em %, posição na fila, avisos, erro |
| `GET /v1/videos/:id/download` | Baixa o MP4 (aceita `Range`). Depois do prazo: `410` |
| `DELETE /v1/videos/:id` | Cancela (na fila) ou apaga (pronto). Durante o render: `409` |
| `GET /v1/presets`, `/v1/presets/:id`, `/v1/presets/schema` | Presets disponíveis e o JSON Schema |
| `GET /v1/platforms` | Perfis de plataforma (tamanho, duração máxima, zona segura) |
| `GET /health` | Público, para o healthcheck |
| `POST /v1/admin/keys` `{"name": "..."}` | Cria uma chave de cliente (mostrada uma única vez) |
| `GET /v1/admin/keys`, `DELETE /v1/admin/keys/:id` | Lista e revoga chaves |
| `GET /v1/admin/info` | FFmpeg, filtros, CPUs, memória, disco, fila |
| `GET /v1/admin/selftest?photos=8&clips=2&duration=20` | Gera um vídeo com os arquivos de teste, sem upload |
| `GET /v1/admin/jobs/:id`, `/v1/admin/jobs/:id/download` | Qualquer pedido, com as medições do render |

### Exemplo

```bash
curl -X POST https://SEU-DOMINIO/v1/videos -H "Authorization: Bearer vea_..." \
  -F 'options={"preset":"limpo","platform":"instagram_reels",
       "items":[{"file":"f1","caption":"Largada"},{"file":"c1","duration":4,"keepAudio":true},{"file":"f2"}],
       "audio":{"file":"musica","start":"0:32","duration":20},
       "logos":[{"role":"brand","file":"logo"}],
       "overrides":{"transition":{"types":["fade","wipeleft"],"order":"random","seed":7}}}' \
  -F f1=@foto1.jpg -F f2=@foto2.jpg -F c1=@clipe.mp4 -F musica=@musica.mp3 -F logo=@logo.png
```

- Os arquivos são citados em `options` pelo **nome do campo**. O tipo é identificado pelo conteúdo: imagem vira foto, vídeo vira clipe (`type` é opcional).
- Sem `audio`, use `"timing":{"mode":"fixed","total":15}`.
- `overrides` aceita só: `transition` (`type`/`types`, `order`, `seed`, `duration`), `audio` (`volume`, `fadeIn`, `fadeOut`, `clipDucking`) e `photo.fit`. As faixas são as do schema do preset.
- Limites: foto 15 MB, clipe 200 MB, áudio 20 MB, logo 5 MB, pedido 500 MB, até 30 itens (10 clipes). Fila de até 20 pedidos; um render por vez.
- Fotos HEIC (padrão do iPhone) ainda não são aceitas: erro `415` pedindo JPEG ou PNG.
- Erros têm sempre o formato `{"error": {"code", "message", "details"}}`. Regras do motor (fotos demais, trecho fora do áudio...) voltam como `422` **na hora**, antes de entrar na fila.
- O vídeo fica disponível por 24 h; as entradas são apagadas assim que o render termina.
- Ainda não disponíveis (Fase 2B): aviso por webhook (`callbackUrl` é guardado), biblioteca de áudio (`libraryId`/`mood`), `/v1/previews` e a documentação OpenAPI.

Do Windows, `scripts/testar-api.ps1` envia uma pasta inteira e baixa o resultado:

```powershell
.\scripts\testar-api.ps1 -Url https://SEU-DOMINIO -Chave vea_... -Pasta C:\fotos -Audio C:\musica.mp3 -Inicio 30 -Duracao 20 -Logo C:\logo.png
```

### Variáveis de ambiente

| Variável | Padrão | Uso |
|---|---|---|
| `DATA_DIR` | `/data` no Docker | Banco, fila e vídeos. Na Railway, o volume persistente |
| `ADMIN_KEY` | (nenhuma) | Liga as rotas de administração (mínimo 16 caracteres) |
| `RAILWAY_RUN_UID` | | `0` na Railway, porque o volume é montado como root |
| `VIDEO_TTL_HOURS` | 24 | Prazo do vídeo pronto |
| `QUEUE_MAX` | 20 | Pedidos aguardando |
| `RATE_LIMIT_PER_MINUTE` / `CREATE_LIMIT_PER_MINUTE` | 300 / 10 | Por chave |
| `LIMIT_PHOTO_MB`, `LIMIT_CLIP_MB`, `LIMIT_AUDIO_MB`, `LIMIT_LOGO_MB`, `LIMIT_TOTAL_MB` | 15, 200, 20, 5, 500 | Tamanhos de upload |
| `MIN_FREE_MB` | 1024 | Abaixo disso, novos pedidos recebem `503` |
| `FFMPEG_THREADS` | núcleos disponíveis (máx. 8) | Limite de threads do FFmpeg |
| `PUBLIC_URL` | (host da requisição) | Base dos links devolvidos |

## Deploy na Railway

1. Volume persistente montado em `/data`.
2. Variáveis: `DATA_DIR=/data`, `RAILWAY_RUN_UID=0`, `ADMIN_KEY`.
3. Conferir: `https://SEU-DOMINIO/v1/admin/info?key=ADMIN_KEY` (`dataDirWritable: true`) e `.../v1/admin/selftest?key=ADMIN_KEY`.
4. Criar a chave de cliente (no Windows, `curl.exe`):

   ```powershell
   curl.exe -X POST https://SEU-DOMINIO/v1/admin/keys -H "X-Admin-Key: ADMIN_KEY" -H "Content-Type: application/json" -d '{\"name\":\"gustavo\"}'
   ```

## Documento de projeto

Arquitetura, contrato da API, formato dos presets e fases estão no documento de projeto mantido no Project "Site/API Vídeo Editor" do Claude. O resumo para quem for mexer no código está em `CLAUDE.md`.
