import { useEffect, useState } from "react";
import { api, ApiError, type Job } from "./api.ts";
import { statusLabel } from "./JobView.tsx";
import { formatTime } from "./lib.ts";

/** Vídeos das últimas 24 h, com atualização automática enquanto algum está sendo gerado. */
export function MyVideos({ refreshKey }: { refreshKey: number }) {
  const [videos, setVideos] = useState<Job[] | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const list = await api.videos();
        if (stop) return;
        setVideos(list);
        setError("");
        if (list.some((v) => v.status === "queued" || v.status === "processing")) timer = setTimeout(load, 3000);
      } catch (err) {
        if (!stop) setError(err instanceof ApiError ? err.message : "Falha ao carregar a lista.");
      }
    };
    void load();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [refreshKey]);

  const remove = async (id: string) => {
    if (!confirm("Apagar este vídeo?")) return;
    try {
      await api.deleteVideo(id);
      setVideos((v) => v?.filter((x) => x.id !== id) ?? null);
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Não foi possível apagar.");
    }
  };

  if (error) return <section className="card"><p className="error">{error}</p></section>;
  if (!videos) return <section className="card"><p className="muted">Carregando…</p></section>;
  if (videos.length === 0)
    return (
      <section className="card">
        <p className="muted">Nenhum vídeo nas últimas 24 horas. Os vídeos ficam disponíveis por 24 horas depois de prontos.</p>
      </section>
    );

  return (
    <section className="card">
      <h2>Meus vídeos</h2>
      <p className="muted small hint">Cada vídeo fica disponível por 24 horas depois de pronto.</p>
      <ul className="videos">
        {videos.map((v) => (
          <li key={v.id} className="video-row">
            <div className="video-info">
              <strong>{statusLabel(v)}</strong>
              <span className="muted small">
                {new Date(v.createdAt).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}
                {v.result ? ` · ${formatTime(v.result.duration, 0)}` : ""}
                {v.sizeBytes ? ` · ${(v.sizeBytes / 1048576).toFixed(1)} MB` : ""}
              </span>
              {v.status === "failed" && v.error && <span className="error small">{v.error.message}</span>}
              {(v.status === "processing" || v.status === "queued") && (
                <div className="progress small">
                  <div style={{ width: `${v.status === "processing" ? Math.max(3, v.progress) : 2}%` }} />
                </div>
              )}
            </div>
            <div className="video-actions">
              {v.status === "done" && (
                <>
                  <button onClick={() => setOpen(open === v.id ? null : v.id)}>{open === v.id ? "Fechar" : "Assistir"}</button>
                  <a className="button" href={api.downloadUrl(v.id)} download>
                    Baixar
                  </a>
                </>
              )}
              {v.status !== "processing" && (
                <button className="icon" aria-label="Apagar" title="Apagar" onClick={() => void remove(v.id)}>
                  ✕
                </button>
              )}
            </div>
            {open === v.id && <video className="final" src={api.downloadUrl(v.id)} controls autoPlay playsInline />}
          </li>
        ))}
      </ul>
    </section>
  );
}
