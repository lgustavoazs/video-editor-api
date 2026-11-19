import { useEffect, useState } from "react";
import { api, ApiError, type Job } from "./api.ts";
import { formatTime } from "./lib.ts";

const STATUS: Record<Job["status"], string> = {
  queued: "Na fila",
  processing: "Gerando",
  done: "Pronto",
  failed: "Falhou",
  expired: "Expirado",
  canceled: "Cancelado",
  deleted: "Apagado",
};

export function statusLabel(job: Job): string {
  if (job.status === "queued" && job.queuePosition) return `Na fila (${job.queuePosition}º)`;
  if (job.status === "processing") return `Gerando… ${Math.round(job.progress)}%`;
  return STATUS[job.status];
}

/** Acompanha um vídeo até ficar pronto (consulta a cada 2 s) e mostra o resultado. */
export function JobView({ id, onNew }: { id: string; onNew: () => void }) {
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const j = await api.video(id);
        if (stop) return;
        setJob(j);
        setError("");
        if (j.status === "queued" || j.status === "processing") timer = setTimeout(tick, 2000);
      } catch (err) {
        if (stop) return;
        setError(err instanceof ApiError ? err.message : "Falha ao consultar o vídeo.");
        timer = setTimeout(tick, 4000);
      }
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [id]);

  if (!job) return <section className="card">{error ? <p className="error">{error}</p> : <p className="muted">Consultando…</p>}</section>;

  const pending = job.status === "queued" || job.status === "processing";
  return (
    <section className="card result">
      <div className="section-head">
        <h2>{statusLabel(job)}</h2>
        {job.result && <span className="muted small">{formatTime(job.result.duration, 1)}</span>}
      </div>
      {pending && (
        <>
          <div className="progress">
            <div style={{ width: `${job.status === "processing" ? Math.max(3, job.progress) : 2}%` }} />
          </div>
          <p className="muted small">Pode sair desta tela: o vídeo continua sendo gerado e aparece em "Meus vídeos".</p>
        </>
      )}
      {error && <p className="error small">{error}</p>}
      {job.status === "done" && (
        <>
          <video className="final" src={api.downloadUrl(job.id)} controls playsInline preload="metadata" />
          <div className="actions">
            <a className="button primary" href={api.downloadUrl(job.id)} download>
              Baixar vídeo
            </a>
            <button onClick={onNew}>Fazer outro vídeo</button>
          </div>
          {job.expiresAt && <p className="muted small">Disponível até {new Date(job.expiresAt).toLocaleString("pt-BR")}.</p>}
        </>
      )}
      {job.status === "failed" && (
        <>
          <p className="error">{job.error?.message ?? "O vídeo não pôde ser gerado."}</p>
          <div className="actions">
            <button onClick={onNew}>Voltar e ajustar</button>
          </div>
        </>
      )}
      {job.warnings.length > 0 && (
        <ul className="warnings">
          {job.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
