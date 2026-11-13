# video-editor-api

Site/API que aplica efeitos em fotos (sem IA, com presets JSON fixos) e gera vídeos curtos com áudio para Instagram, Facebook, TikTok e YouTube Shorts.

**Estado atual: Fase 0 (spike).** Existe o motor de render e uma ferramenta de linha de comando. A API e o site ainda não existem.

## Estrutura

| Pasta | Conteúdo |
|---|---|
| `packages/engine` | Motor: presets, regra de duração, montagem do FFmpeg, ferramentas de linha de comando |
| `presets/` | Um arquivo JSON por estilo |
| `apps/` | (Fases 2 e 3) API e site |

## Requisitos

- Node.js 22 ou superior
- FFmpeg e ffprobe no `PATH` (ou as variáveis `FFMPEG_PATH` / `FFPROBE_PATH`)

## Uso

```bash
npm install
npm run assets            # gera imagens e áudios sintéticos de teste em assets/test
npm run sample -- --audio assets/test/tone.wav --start 5 --duration 15
# resultado em out/amostra.mp4, com as medições impressas em JSON
```

Com as suas fotos e a sua música:

```bash
npm run sample -- --photos ./minhas-fotos --preset limpo --audio ./musica.mp3 --start 0:42.5 --end 1:12.5
```

`npm run sample -- --help` lista todas as opções. `npm test` roda os testes.

## Medição na Railway (Fase 0)

O `Dockerfile` sobe um servidor temporário que renderiza o vídeo de teste e devolve as medições.

1. Na Railway: **New Project → Deploy from GitHub repo →** este repositório.
2. Em **Variables**, crie `SPIKE_TOKEN` com um valor aleatório (sem ele as rotas de teste ficam desativadas).
3. Em **Settings → Networking**, gere um domínio público.
4. Acesse:
   - `https://SEU-DOMINIO/health`
   - `https://SEU-DOMINIO/spike?token=SEU_TOKEN` (medições em JSON; leva de 10 a 60 s)
   - `https://SEU-DOMINIO/spike?token=SEU_TOKEN&x264=veryfast` (encode mais rápido)
   - `https://SEU-DOMINIO/spike/video?token=SEU_TOKEN` (baixa o vídeo gerado)

O servidor de teste será removido quando a API entrar (Fase 2). Como o token vai na URL, use um valor descartável.

## Documento de projeto

Arquitetura, contrato da API, formato dos presets e fases estão no documento de projeto mantido no Project "Site/API Vídeo Editor" do Claude. O resumo para quem for mexer no código está em `CLAUDE.md`.
