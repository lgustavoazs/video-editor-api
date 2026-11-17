# video-editor-api

Site/API que aplica efeitos em fotos (sem IA, com presets JSON fixos) e gera vídeos curtos com áudio para Instagram, Facebook, TikTok e YouTube Shorts.

**Estado atual: Fase 1C (clipes de vídeo).** O motor renderiza fotos e clipes de vídeo com todos os efeitos do catálogo, logos, texto e trecho de áudio, por linha de comando. A API e o site ainda não existem.

## Estrutura

| Pasta | Conteúdo |
|---|---|
| `packages/engine` | Motor: presets, regra de duração, montagem do FFmpeg, ferramentas de linha de comando |
| `presets/` | Um arquivo JSON por estilo; LUTs em `presets/luts/` |
| `assets/fonts` | Fontes usadas nos textos |
| `apps/` | (Fases 2 e 3) API e site |

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

## Medição na Railway (Fase 0)

O `Dockerfile` sobe um servidor temporário que renderiza o vídeo de teste e devolve as medições.

1. Na Railway: **New Project → Deploy from GitHub repo →** este repositório.
2. Em **Variables**, crie `SPIKE_TOKEN` com um valor aleatório (sem ele as rotas de teste ficam desativadas).
3. Em **Settings → Networking**, gere um domínio público.
4. Acesse:
   - `https://SEU-DOMINIO/health`
   - `https://SEU-DOMINIO/spike?token=SEU_TOKEN` (medições em JSON; leva de 10 a 60 s)
   - `https://SEU-DOMINIO/spike?token=SEU_TOKEN&x264=veryfast` (encode mais rápido)
   - `https://SEU-DOMINIO/spike?token=SEU_TOKEN&photos=30&duration=60` (pior caso: leva alguns minutos)
   - `https://SEU-DOMINIO/spike?token=SEU_TOKEN&photos=10&clips=6&duration=45` (com clipes)
   - Acrescente `&async=1` para iniciar e buscar o resultado depois em `/spike/result?token=SEU_TOKEN`
   - `https://SEU-DOMINIO/spike/video?token=SEU_TOKEN` (baixa o vídeo gerado)

O servidor de teste será removido quando a API entrar (Fase 2). Como o token vai na URL, use um valor descartável.

## Documento de projeto

Arquitetura, contrato da API, formato dos presets e fases estão no documento de projeto mantido no Project "Site/API Vídeo Editor" do Claude. O resumo para quem for mexer no código está em `CLAUDE.md`.
