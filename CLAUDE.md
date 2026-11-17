# Contexto do projeto

Site/API que recebe N fotos (+ áudio opcional, com trecho escolhido) e devolve um vídeo curto para redes sociais. Dono: Gustavo (uso próprio na V1; público e cobrança depois).

## Regras que não mudam sem o dono pedir

- **Sem IA em produção.** Todo efeito é determinístico e vem de um **preset JSON** com parâmetros fixos.
- **Sem .NET.** TypeScript em Node.js 22, em tudo.
- **Motor de vídeo: FFmpeg**, sempre chamado com array de argumentos (`spawn`), nunca via shell.
- **Não iniciar implementação de uma fase sem a confirmação do dono.** Primeiro negociar o escopo.
- Fluxo de trabalho: uma branch e um pull request por fase ou correção; `main` é o que vai para produção. O dono dispensou o pedido de autorização para o merge dos pull requests; iniciar uma fase continua exigindo a confirmação dele.
- Textos voltados ao usuário (mensagens de erro, README, comentários) em português.

## Arquitetura

- `packages/engine/src`:
  - `schema.ts`: JSON Schema dos presets (fonte única das faixas válidas; vai alimentar o editor visual).
  - `preset.ts`: tipos, validação (Ajv, mensagens em português) e herança (`extends`, um nível).
  - `transitions.ts`: as 58 transições do xfade, rodízio e sorteio com semente; confere o que o FFmpeg instalado suporta.
  - `timing.ts`: trecho de áudio e duração proporcional, com cartões de logo.
  - `prepare.ts`: normalização de fotos (EXIF, enquadramento, foco), cartões e marca d'água, com sharp.
  - `clip.ts`: trecho, rotação, HDR para SDR e ramo de vídeo dos clipes (enquadramento feito no FFmpeg).
  - `filters.ts`, `text.ts`, `filtergraph.ts`: tradução do preset para o filter_complex.
  - `render.ts`: `planRender` (valida, sonda e calcula a linha do tempo, sem renderizar) e `renderVideo` (executa o FFmpeg, com progresso via `-progress pipe:1`). `cli/`: ferramenta de amostras e arquivos de teste.
- `apps/api/src` (Fase 2A):
  - `app.ts`: rotas Fastify (`/v1/videos`, `/v1/presets`, `/v1/platforms`, `/v1/admin/*`) e o `submit` (valida, planeja, enfileira).
  - `upload.ts` + `sniff.ts`: multipart gravado direto no disco; tipo pelo conteúdo (assinatura), limites por tipo; HEIC recusado com 415.
  - `options.ts`: JSON Schema do campo `options` (mensagens em português). `presets.ts`: biblioteca em memória e `overrides` (lista branca, revalidada pelo schema do preset).
  - `jobs.ts`: fila em processo (um render por vez), recuperação após reinício, limpeza por TTL. `db.ts`: SQLite (`node:sqlite`) em `DATA_DIR`.
  - `keys.ts`: chaves `vea_...` guardadas como sha256, limite por minuto. `errors.ts`: formato único de erro e mapeamento dos códigos do motor (regra = 422, servidor = 500).
- `presets/`: um JSON por estilo; `limpo.json` é o neutro, base para os demais. LUTs em `presets/luts/`.
- `assets/fonts`: fontes DejaVu (licença livre) para o texto renderizar igual em qualquer máquina.
- Planejado: `apps/web` (Next.js com editor visual de presets, na Vercel).

## Regras do motor

- Entrada: lista de **itens** (`photo` ou `clip`), logos por papel (`brand`, `partner`), título e áudio.
- Clipes: duração própria (o trecho pedido, nunca esticado); as fotos dividem o resto. Sem fotos, o vídeo dura a soma dos clipes. Som original mudo por padrão; com `keepAudio` entra na mixagem e a música abaixa (`audio.clipDucking`). HDR (PQ/HLG) é convertido com zscale + tonemap mobius. Limites: 10 clipes, trecho mínimo de 1 s, até 4K.
- O preset define **como** a logo aparece; a requisição envia **qual**. Papel pedido e não enviado: o espaço é ignorado, com aviso.
- Linha do tempo: cartão de abertura, itens (com cartões intercalados) e cartão de encerramento. Cartões e clipes têm duração fixa; as fotos dividem o resto. Passagens que tocam um cartão são sempre `fade`.
- Tudo é quantizado em quadros; a duração final é exata.
- Fotos demais para a duração: erro `too_many_photos` informando o máximo. Nunca descartar fotos em silêncio.
- Enquadramento `auto`: usa `contain` (fundo desfocado) quando o corte removeria mais que `autoThreshold` da foto; um `focus` informado força o corte.
- Texto e marca d'água respeitam a zona segura da plataforma (`platforms.ts`). A marca d'água não aparece sobre os cartões.
- Trecho do áudio: `start` + (`end` ou `duration`, mutuamente exclusivos); corte com recodificação; `loop` repete o trecho.
- Erros de regra usam `EngineError` com `code` estável (a API devolve 422 para regras e 500 para falhas do servidor).
- Texto do usuário nunca entra no filtergraph: vai por arquivo (`textfile`).

## Fases

0. Spike: concluída.
1A. Motor base: concluída.
1C. Clipes de vídeo: concluída.
2A. API (esta): upload, fila, chaves, consulta e download, administração, limpeza por TTL.
2B. API: webhook (HMAC), `/v1/previews`, biblioteca de áudio (id ou mood), OpenAPI em `/docs`.
3. Site: upload, seletor de trecho com forma de onda, editor visual de presets (exporta JSON).
★ Presets por nicho (ficou para o final, por decisão do dono): ficha, amostras e aprovação, já com o editor visual.
V1.2 (ideia registrada): modelos de composição em camadas; olho de peixe, dupla exposição, restauração.

## Pendências conhecidas

- O FFmpeg roda sempre com limite explícito de threads (`defaultThreads()` ou `FFMPEG_THREADS`): em container ele enxerga os núcleos do host, e sem limite o codificador falha ao abrir com muitas fotos.
- Otimização de memória adiada por decisão do dono (reduzir o supersample).
- Durações máximas e zonas seguras das plataformas mudam com frequência; revisar `platforms.ts` periodicamente.
- Texto com várias linhas fica alinhado à esquerda dentro do bloco centralizado.
- HDR testado só com clipes sintéticos (PQ e HLG); falta um clipe real de iPhone (HLG com Dolby Vision).
- Fotos HEIC (padrão do iPhone) são recusadas com 415: o sharp pré-compilado não lê HEIC. Avaliar conversão no futuro.
- Fila e limite por minuto ficam em memória: valem para uma instância só (suficiente na V1).
- As chaves de teste que passaram pelo chat (token do spike e a `ADMIN_KEY` inicial) devem ser trocadas antes do uso público.

## Comandos

```bash
npm install && npm run assets
npm run sample -- --audio assets/test/tone.wav --start 5 --duration 15
npm test && npm run typecheck
DATA_DIR=./data ADMIN_KEY=uma-chave-longa-qualquer npm run api
```
