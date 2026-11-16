# Contexto do projeto

Site/API que recebe N fotos (+ áudio opcional, com trecho escolhido) e devolve um vídeo curto para redes sociais. Dono: Gustavo (uso próprio na V1; público e cobrança depois).

## Regras que não mudam sem o dono pedir

- **Sem IA em produção.** Todo efeito é determinístico e vem de um **preset JSON** com parâmetros fixos.
- **Sem .NET.** TypeScript em Node.js 22, em tudo.
- **Motor de vídeo: FFmpeg**, sempre chamado com array de argumentos (`spawn`), nunca via shell.
- **Não iniciar implementação de uma fase sem a confirmação do dono.** Primeiro negociar o escopo.
- Fluxo de trabalho: uma branch e um pull request por fase; `main` é o que vai para produção.
- Textos voltados ao usuário (mensagens de erro, README, comentários) em português.

## Arquitetura

- `packages/engine/src`:
  - `schema.ts`: JSON Schema dos presets (fonte única das faixas válidas; vai alimentar o editor visual).
  - `preset.ts`: tipos, validação (Ajv, mensagens em português) e herança (`extends`, um nível).
  - `transitions.ts`: as 58 transições do xfade, rodízio e sorteio com semente; confere o que o FFmpeg instalado suporta.
  - `timing.ts`: trecho de áudio e duração proporcional, com cartões de logo.
  - `prepare.ts`: normalização de fotos (EXIF, enquadramento, foco), cartões e marca d'água, com sharp.
  - `filters.ts`, `text.ts`, `filtergraph.ts`: tradução do preset para o filter_complex.
  - `render.ts`: orquestra tudo e executa o FFmpeg. `cli/`: ferramenta de amostras e servidor de medição.
- `presets/`: um JSON por estilo; `limpo.json` é o neutro, base para os demais. LUTs em `presets/luts/`.
- `assets/fonts`: fontes DejaVu (licença livre) para o texto renderizar igual em qualquer máquina.
- Planejado: `apps/api` (Fastify + fila, na Railway) e `apps/web` (Next.js com editor visual de presets, na Vercel).

## Regras do motor

- Entrada: lista de **itens** (`photo`; `clip` entra na Fase 1C), logos por papel (`brand`, `partner`), título e áudio.
- O preset define **como** a logo aparece; a requisição envia **qual**. Papel pedido e não enviado: o espaço é ignorado, com aviso.
- Linha do tempo: cartão de abertura, itens (com cartões intercalados) e cartão de encerramento. Cartões têm duração fixa; as fotos dividem o resto. Passagens que tocam um cartão são sempre `fade`.
- Tudo é quantizado em quadros; a duração final é exata.
- Fotos demais para a duração: erro `too_many_photos` informando o máximo. Nunca descartar fotos em silêncio.
- Enquadramento `auto`: usa `contain` (fundo desfocado) quando o corte removeria mais que `autoThreshold` da foto; um `focus` informado força o corte.
- Texto e marca d'água respeitam a zona segura da plataforma (`platforms.ts`). A marca d'água não aparece sobre os cartões.
- Trecho do áudio: `start` + (`end` ou `duration`, mutuamente exclusivos); corte com recodificação; `loop` repete o trecho.
- Erros de regra usam `EngineError` com `code` estável (a API vai mapear para 4xx).
- Texto do usuário nunca entra no filtergraph: vai por arquivo (`textfile`).

## Fases

0. Spike: concluída.
1A. Motor base (esta): schema, herança, efeitos do catálogo, logos, texto, enquadramento, zonas seguras, loop de áudio.
★ Marco de presets: criação dos presets por nicho (o dono envia referências; aprovação por vídeo de amostra).
1B. Biblioteca de presets, em paralelo com as fases seguintes.
1C. Clipes de vídeo na montagem (som original opcional, HDR, limites).
2. API: endpoints, fila, API key, webhook, `/v1/previews`, limpeza por TTL.
3. Site: upload, seletor de trecho com forma de onda, editor visual de presets (exporta JSON).
V1.2 (ideia registrada): modelos de composição em camadas; olho de peixe, dupla exposição, restauração.

## Pendências conhecidas

- Otimização de CPU e memória adiada por decisão do dono (limitar threads do FFmpeg, reduzir o supersample).
- Durações máximas e zonas seguras das plataformas mudam com frequência; revisar `platforms.ts` periodicamente.
- Texto com várias linhas fica alinhado à esquerda dentro do bloco centralizado.
- `cli/spike-server.ts` e o `CMD` do Dockerfile são temporários; saem na Fase 2.

## Comandos

```bash
npm install && npm run assets
npm run sample -- --audio assets/test/tone.wav --start 5 --duration 15
npm test && npm run typecheck
```
