# Biblioteca de áudio

Músicas que os clientes podem usar sem enviar arquivo, por `id` ou por clima (`mood`).

- `library.json`: o catálogo. Cada faixa precisa de licença que permita uso comercial em redes sociais.
- `tracks/`: os arquivos (MP3, M4A, WAV, OGG ou FLAC). Mantenha poucas faixas aqui; se a biblioteca crescer, os arquivos devem sair do repositório.

Formato de cada faixa:

```json
{
  "id": "calmo-piano-01",
  "name": "Piano calmo",
  "file": "tracks/calmo-piano-01.mp3",
  "moods": ["calmo", "inspirador"],
  "license": "CC BY 4.0",
  "source": "https://endereco-de-onde-veio",
  "attribution": "Autor - Título (crédito exigido pela licença, se houver)"
}
```

Regras: `id` e `moods` em minúsculas, com letras, números e hífen. A faixa é conferida (arquivo e formato) quando o servidor inicia; um erro aqui impede o deploy de subir com catálogo quebrado.
