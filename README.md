# video-editor-api

Site/API que aplica efeitos em fotos (sem IA, com presets JSON fixos) e gera vídeos curtos com áudio para Instagram, Facebook, TikTok e YouTube Shorts.

**Estado atual: Fase 3A (site: criar vídeo).** O motor renderiza fotos e clipes com todos os efeitos do catálogo, logos, texto e trecho de áudio. A API recebe os arquivos, enfileira, avisa por webhook e devolve o vídeo, com documentação em `/docs`. O site, em `/app`, cria vídeos pelo navegador (computador ou celular). O editor visual de presets vem na Fase 3B.

## Estrutura

| Pasta | Conteúdo |
|---|---|
| `packages/engine` | Motor: presets, regra de duração, montagem do FFmpeg, ferramentas de linha de comando |
| `presets/` | Um arquivo JSON por estilo; LUTs em `presets/luts/` |
| `assets/fonts` | Fontes usadas nos textos |
| `apps/api` | API HTTP (Fastify), fila e banco SQLite |
| `apps/web` | Site (React + Vite), servido pela API em `/app` |
| `audio/` | Biblioteca de músicas (`library.json` + `tracks/`); começa vazia |
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

Estilos disponíveis:

| Estilo | Visual | Título, legenda e logos |
|---|---|---|
| `limpo` | Neutro: cores quase originais, zoom suave, fade | Não usa |
| `cinema` | LUT azul e laranja, barras de cinema, vinheta, grão; fade e fade pelo preto | Título, legenda; marca d'água e abertura (marca), encerramento "Apoio" (parceiro) |
| `dinamico` | Nitidez, clareza e cores vivas; deslocamento lateral; transições variadas e rápidas | Título, legenda; marca d'água (marca), encerramento "Apoio" (parceiro) |
| `retro-quente` | Tons quentes e desbotados, vinheta, grão; fade lento | Título, legenda; marca d'água (marca), encerramento "Apoio" (parceiro) |
| `preto-e-branco` | P&B com contraste, vinheta e grão fino; fade pelo preto | Título, legenda; marca d'água (marca), encerramento "Apoio" (parceiro) |

Os presets por nicho virão depois, criados com a ficha de nicho.

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

## Site (`/app`)

Servido pela própria API, no mesmo endereço: `https://SEU-DOMINIO/app/` (a raiz `/` leva para lá). Entra-se com a senha `SITE_PASSWORD`; a sessão dura 30 dias, num cookie que o JavaScript da página não lê. O navegador nunca recebe chave de API.

Tela **Novo vídeo**:

- Fotos e clipes: escolher ou arrastar arquivos; **a ordem da lista é a ordem do vídeo** (arrastar para reordenar; no celular, segurar um instante antes; ou usar as setas).
- Para incluir mais itens: o quadro **+** no fim da lista, ou arrastar arquivos do computador **para o ponto da lista onde devem entrar** (uma barra laranja mostra a posição).
- Tocar num item: **área exibida** da foto ou do clipe (tocar para centralizar a moldura e **aproximar** de 100% a 400%); no clipe, também início e fim assistindo e o som original. Legenda por item.
- Música: arquivo próprio ou da biblioteca, com o **trecho escolhido na forma de onda** (arrastar a faixa laranja; ouvir antes) e o **início e o fim** da música: padrão do estilo, corte seco ou suave (0,5 a 3 s).
- Plataformas: Reels do Instagram e do Facebook, TikTok e Shorts em 1080×1920; feed do Instagram e do Facebook em 1080×1350 (4:5).
- Logos de marca e parceiro; a tela avisa se o estilo escolhido não usa a logo, a legenda ou o título.
- Envio com progresso, acompanhamento da geração, player e download.
- Fotos HEIC do iPhone: no próprio iPhone o Safari já entrega JPEG; HEIC arrastado no computador é convertido no navegador (a biblioteca de conversão, LGPL, só é baixada quando aparece um HEIC).

Tela **Meus vídeos**: os vídeos das últimas 24 h, com assistir, baixar e apagar.

Desenvolvimento: `npm run api` (porta 3000) e, em outro terminal, `npm run dev -w @video-editor/web` (o Vite repassa `/v1` para a API).

## API

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
| `GET /v1/audio` | Biblioteca de músicas e climas disponíveis |
| `GET /health`, `/docs`, `/openapi.json` | Públicos: healthcheck e documentação |
| `GET /v1/videos` | Vídeos recentes da chave (últimas 24 h) |
| `GET /v1/audio/:id/file` | Arquivo de uma música da biblioteca |
| `GET/POST/DELETE /v1/session` | Login do site (senha → cookie de sessão) |
| `POST /v1/previews` | (admin) Pré-visualização: até 6 itens, 10 s, metade da resolução, passa na frente da fila |
| `POST /v1/admin/keys` `{"name": "..."}` | Cria uma chave de cliente e o segredo do webhook (mostrados uma única vez) |
| `POST /v1/admin/keys/:id/webhook-secret` | Gera ou troca o segredo do webhook de uma chave |
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
- `zoom` (por item, de 1 a 4): aproxima o enquadramento, centrado em `focus`. Acima de 1 sempre corta a imagem, mesmo em estilos que mostram a foto inteira.
- **Ordem:** o vídeo segue a ordem da lista `items`. O nome dos arquivos e a ordem dos campos no multipart não influem; para mudar a ordem, mude a posição na lista.
- **Logos** vão em `logos`, não em `items`. Uma logo colocada em `items` aparece como uma foto comum.
- Sem `audio`, use `"timing":{"mode":"fixed","total":15}`.
- `overrides` aceita só: `transition` (`type`/`types`, `order`, `seed`, `duration`), `audio` (`volume`, `fadeIn`, `fadeOut`, `clipDucking`) e `photo.fit`. As faixas são as do schema do preset.
- Limites: foto 15 MB, clipe 200 MB, áudio 20 MB, logo 5 MB, pedido 500 MB, até 30 itens (10 clipes). Fila de até 20 pedidos; um render por vez.
- Fotos HEIC (padrão do iPhone) ainda não são aceitas: erro `415` pedindo JPEG ou PNG.
- Erros têm sempre o formato `{"error": {"code", "message", "details"}}`. Regras do motor (fotos demais, trecho fora do áudio...) voltam como `422` **na hora**, antes de entrar na fila.
- O vídeo fica disponível por 24 h; as entradas são apagadas assim que o render termina.
- Música da biblioteca no lugar do arquivo: `"audio": {"libraryId": "piano-01"}` ou `"audio": {"mood": "calmo", "seed": 7}`. Sem `seed`, o servidor sorteia e devolve a semente em `audioTrack`, para repetir a escolha.

### Webhook

Com `"callbackUrl": "https://..."`, o servidor faz um POST quando o vídeo fica pronto (`video.done`) ou falha (`video.failed`). Sem resposta 2xx, tenta de novo após 10 s, 1 min e 5 min. O estado aparece em `webhook` na consulta do vídeo.

Para conferir que o aviso veio do servidor, use o segredo `whsec_...` da chave:

```js
// X-Webhook-Signature: t=<unix>,v1=<hex>
const [, t, v1] = /t=(\d+),v1=([0-9a-f]+)/.exec(req.headers["x-webhook-signature"]);
const esperado = crypto.createHmac("sha256", SEGREDO).update(`${t}.${corpoBruto}`).digest("hex");
const valido = crypto.timingSafeEqual(Buffer.from(v1, "hex"), Buffer.from(esperado, "hex"))
  && Math.abs(Date.now() / 1000 - Number(t)) < 300;
```

O endereço precisa ser `https://` e público (endereços internos são recusados).

### Pré-visualização (editor)

`POST /v1/previews`, com a chave de administrador, aceita o mesmo multipart dos vídeos. O `preset` pode ser um id ou o preset inteiro, como o editor exporta (inclusive com `extends`). O resultado sai em 540×960 (metade da plataforma), encode rápido, e é consultado em `/v1/admin/jobs/:id`.

Do Windows, `scripts/testar-api.ps1` envia uma pasta inteira e baixa o resultado. O script monta `items` com **todas as imagens e vídeos da pasta, em ordem alfabética do nome**. Para controlar a ordem, numere os arquivos com dois dígitos (`01-chegada.jpg`, `02-aquecimento.jpg`...; sem o zero, `10` viria antes de `2`). Deixe a logo fora da pasta e passe com `-Logo`; dentro da pasta ela entraria como foto.

```powershell
.\scripts\testar-api.ps1 -Url https://SEU-DOMINIO -Chave vea_... -Pasta C:\fotos -Audio C:\musica.mp3 -Inicio 30 -Duracao 20 -Logo C:\logo.png
.\scripts\testar-api.ps1 -Url https://SEU-DOMINIO -Chave vea_... -Pasta C:\fotos -Clima calmo -Duracao 20
```

### Variáveis de ambiente

| Variável | Padrão | Uso |
|---|---|---|
| `DATA_DIR` | `/data` no Docker | Banco, fila e vídeos. Na Railway, o volume persistente |
| `ADMIN_KEY` | (nenhuma) | Liga as rotas de administração (mínimo 16 caracteres) |
| `SITE_PASSWORD` | (nenhuma) | Senha do site em `/app` (mínimo 8 caracteres). Sem ela, o site mostra que o acesso está desativado. Trocar a senha encerra as sessões abertas |
| `RAILWAY_RUN_UID` | | `0` na Railway, porque o volume é montado como root |
| `VIDEO_TTL_HOURS` | 24 | Prazo do vídeo pronto |
| `QUEUE_MAX` | 20 | Pedidos aguardando |
| `RATE_LIMIT_PER_MINUTE` / `CREATE_LIMIT_PER_MINUTE` | 300 / 10 | Por chave |
| `LIMIT_PHOTO_MB`, `LIMIT_CLIP_MB`, `LIMIT_AUDIO_MB`, `LIMIT_LOGO_MB`, `LIMIT_TOTAL_MB` | 15, 200, 20, 5, 500 | Tamanhos de upload |
| `MIN_FREE_MB` | 1024 | Abaixo disso, novos pedidos recebem `503` |
| `FFMPEG_THREADS` | núcleos disponíveis (máx. 8) | Limite de threads do FFmpeg |
| `PUBLIC_URL` | (host da requisição) | Base dos links devolvidos |
| `PREVIEW_QUEUE_MAX` | 3 | Pré-visualizações aguardando |
| `WEBHOOK_TIMEOUT_MS` | 10000 | Tempo máximo de cada tentativa do webhook |
| `SELFTEST_WARMUP` | true | Gera os arquivos do autoteste ao iniciar (em segundo plano) |

## Deploy na Railway

1. Volume persistente montado em `/data`.
2. Variáveis: `DATA_DIR=/data`, `RAILWAY_RUN_UID=0`, `ADMIN_KEY` e, para o site, `SITE_PASSWORD`.
3. Conferir: `https://SEU-DOMINIO/v1/admin/info?key=ADMIN_KEY` (`dataDirWritable: true`) e `.../v1/admin/selftest?key=ADMIN_KEY`.
4. Criar a chave de cliente (no Windows, `curl.exe`):

   ```powershell
   curl.exe -X POST https://SEU-DOMINIO/v1/admin/keys -H "X-Admin-Key: ADMIN_KEY" -H "Content-Type: application/json" -d '{\"name\":\"gustavo\"}'
   ```

## Documento de projeto

Arquitetura, contrato da API, formato dos presets e fases estão no documento de projeto mantido no Project "Site/API Vídeo Editor" do Claude. O resumo para quem for mexer no código está em `CLAUDE.md`.
