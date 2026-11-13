/** Erro de validação/regra do motor, com código estável para a API mapear em 4xx. */
export class EngineError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "EngineError";
  }
}
