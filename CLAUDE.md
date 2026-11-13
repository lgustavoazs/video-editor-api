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

- `packages/engine`: motor. `preset.ts` (tipos e validação), `timing.ts` (trecho de áudio e duração proporcional), `filtergraph.ts` (filter_complex), `render.ts` (normaliza fotos com sharp e executa o FFmpeg), `cli/` (ferramentas).
- `presets/`: um JSON por estilo. `limpo.json` é o preset neutro, base para os demais.
- Planejado: `apps/api` (Fastify + fila, na Railway) e `apps/web` (Next.js com editor visual de presets, na Vercel).

## Regras do motor

- Duração: com N fotos e transição `t`, o tempo visível por foto é `(T - t) / N`. Modo `audio`: `T` = duração do trecho (limitada ao máximo da plataforma). Modo `fixed`: `T` informado.
- Tudo é quantizado em quadros; a duração final é exata e o resto da divisão vai para os primeiros clipes.
- Fotos demais para a duração: erro `too_many_photos` informando o máximo. Nunca descartar fotos em silêncio.
- Trecho do áudio: `start` + (`end` ou `duration`, mutuamente exclusivos); corte com recodificação (`atrim`), fades nas bordas do trecho.
- Erros de regra usam `EngineError` com `code` estável (a API vai mapear para 4xx).

## Fases

0. Spike (esta): 1 preset, render por linha de comando, medição na Railway.
1A. Motor completo: JSON Schema, herança (`extends`), todos os efeitos do catálogo, loop de áudio, perfis de plataforma conferidos.
★ Marco de presets: criação dos presets por nicho (o dono envia referências; aprovação por vídeo de amostra).
1B. Biblioteca de presets, em paralelo com as fases seguintes.
2. API: endpoints, fila, API key, webhook, `/v1/previews`, limpeza por TTL.
3. Site: upload, seletor de trecho com forma de onda, editor visual de presets (exporta JSON).

## Pendências conhecidas

- `platforms.ts`: `maxDuration` é provisório (60 s); conferir nas docs oficiais na Fase 1A.
- Loop do trecho de áudio ainda não implementado (`not_implemented`).
- `cli/spike-server.ts` e o `CMD` do Dockerfile são temporários; saem na Fase 2.

## Comandos

```bash
npm install && npm run assets
npm run sample -- --audio assets/test/tone.wav --start 5 --duration 15
npm test && npm run typecheck
```
