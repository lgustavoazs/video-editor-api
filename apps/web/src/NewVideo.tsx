import { useEffect, useState } from "react";
import { api, ApiError, type Platform, type PresetSummary, type Track } from "./api.ts";
import { ItemEditor } from "./ItemEditor.tsx";
import { ItemsPanel } from "./ItemsPanel.tsx";
import { JobView } from "./JobView.tsx";
import { buildRequest, PLATFORM_LABELS, validateDraft, type Draft } from "./lib.ts";
import { LogosPanel } from "./LogosPanel.tsx";
import { MusicPanel } from "./MusicPanel.tsx";

const EMPTY: Draft = {
  preset: "limpo",
  platform: "instagram_reels",
  title: "",
  items: [],
  music: { kind: "none", duration: 15 },
  logos: {},
};

export function NewVideo({ onCreated, onShowList }: { onCreated: () => void; onShowList: () => void }) {
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [presets, setPresets] = useState<PresetSummary[]>([]);
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [presetDetail, setPresetDetail] = useState<Record<string, unknown> | null>(null);
  const [loadError, setLoadError] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [upload, setUpload] = useState<{ fraction: number; abort: () => void } | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [jobId, setJobId] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.presets(), api.platforms(), api.audio()])
      .then(([p, pl, a]) => {
        setPresets(p);
        setPlatforms(pl);
        setTracks(a.tracks);
        if (p.length && !p.some((x) => x.id === EMPTY.preset)) setDraft((d) => ({ ...d, preset: p[0]!.id }));
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : "Falha ao carregar as opções."));
  }, []);

  useEffect(() => {
    setPresetDetail(null);
    api.preset(draft.preset).then(setPresetDetail).catch(() => setPresetDetail(null));
  }, [draft.preset]);

  const platform = platforms.find((p) => p.id === draft.platform);
  const aspect = platform ? platform.width / platform.height : 9 / 16;
  const maxDuration = platform?.maxDuration ?? 180;
  const editingIndex = draft.items.findIndex((i) => i.id === editing);
  const editingItem = editingIndex >= 0 ? draft.items[editingIndex] : undefined;
  const text = presetDetail?.text as { title?: unknown; caption?: unknown } | null | undefined;
  const hasTitle = Boolean(text?.title);
  const hasCaptions = Boolean(text?.caption);

  async function submit() {
    const problems = validateDraft(draft);
    setErrors(problems);
    if (problems.length) return;
    const { options, files } = buildRequest(draft);
    const form = new FormData();
    form.append("options", JSON.stringify(options));
    for (const [field, file] of files) form.append(field, file, file.name);
    const req = api.createVideo(form, (fraction) => setUpload((u) => (u ? { ...u, fraction } : u)));
    setUpload({ fraction: 0, abort: req.abort });
    try {
      const created = await req.promise;
      setJobId(created.id);
      onCreated();
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      if (err instanceof ApiError && err.code === "aborted") setErrors([]);
      else setErrors([err instanceof ApiError ? err.message : "Falha ao enviar."]);
    } finally {
      setUpload(null);
    }
  }

  if (loadError) return <section className="card"><p className="error">{loadError}</p></section>;

  if (jobId)
    return (
      <div className="stack">
        <JobView id={jobId} onNew={() => setJobId(null)} />
        <div className="actions">
          <button className="link" onClick={onShowList}>
            Ver todos os meus vídeos
          </button>
          <button
            className="link"
            onClick={() => {
              draft.items.forEach((i) => URL.revokeObjectURL(i.url));
              setDraft({ ...EMPTY, preset: draft.preset, platform: draft.platform });
              setJobId(null);
            }}
          >
            Começar um vídeo do zero
          </button>
        </div>
      </div>
    );

  const sending = upload !== null;
  return (
    <div className="stack">
      <section className="card">
        <h2>Estilo</h2>
        <div className="row wrap">
          <label className="grow">
            Estilo
            <select value={draft.preset} onChange={(e) => setDraft({ ...draft, preset: e.target.value })}>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="grow">
            Plataforma
            <select value={draft.platform} onChange={(e) => setDraft({ ...draft, platform: e.target.value })}>
              {platforms.map((p) => (
                <option key={p.id} value={p.id}>
                  {PLATFORM_LABELS[p.id] ?? p.id} ({p.width}×{p.height})
                </option>
              ))}
            </select>
          </label>
        </div>
        {presets.find((p) => p.id === draft.preset)?.description && (
          <p className="muted small">{presets.find((p) => p.id === draft.preset)?.description}</p>
        )}
        <label>
          Título (opcional)
          <input
            value={draft.title}
            maxLength={120}
            placeholder="Texto de abertura do vídeo"
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
          />
          {presetDetail && !hasTitle && (
            <span className={draft.title ? "error small" : "muted small"}>Este estilo não mostra título.</span>
          )}
        </label>
      </section>

      <ItemsPanel items={draft.items} onChange={(items) => setDraft((d) => ({ ...d, items }))} onEdit={setEditing} />

      <MusicPanel music={draft.music} onChange={(music) => setDraft((d) => ({ ...d, music }))} maxDuration={maxDuration} tracks={tracks} />

      <LogosPanel logos={draft.logos} onChange={(logos) => setDraft((d) => ({ ...d, logos }))} branding={presetDetail?.branding} />

      <section className="card submit">
        {errors.length > 0 && (
          <ul className="errors">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
        {sending ? (
          <>
            <p>Enviando arquivos… {Math.round(upload.fraction * 100)}%</p>
            <div className="progress">
              <div style={{ width: `${Math.max(2, upload.fraction * 100)}%` }} />
            </div>
            <div className="actions">
              <button onClick={upload.abort}>Cancelar envio</button>
            </div>
          </>
        ) : (
          <button className="primary big" onClick={() => void submit()} disabled={draft.items.length === 0}>
            Gerar vídeo
          </button>
        )}
      </section>

      {editingItem && (
        <ItemEditor
          item={editingItem}
          index={editingIndex}
          aspect={aspect}
          photoConf={(presetDetail?.photo as { fit?: string; autoThreshold?: number } | undefined) ?? undefined}
          captions={presetDetail ? hasCaptions : true}
          onChange={(it) => setDraft((d) => ({ ...d, items: d.items.map((x) => (x.id === it.id ? it : x)) }))}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
