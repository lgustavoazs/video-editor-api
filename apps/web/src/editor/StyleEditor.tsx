import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type Job, type Platform, type PresetSummary } from "../api.ts";
import { PLATFORM_LABELS } from "../lib.ts";
import { imageSize } from "../media.ts";
import { InstantPreview, type SamplePhoto } from "./InstantPreview.tsx";
import { FiltersEditor, TransitionsEditor } from "./ListEditors.tsx";
import { SchemaField } from "./SchemaField.tsx";
import { BLOCK_TITLES, BLOCKS, exportPreset, slugify, type Json, type Preset } from "./schemaUtil.ts";

const BASE_ID = "limpo";
const SAMPLE_SECONDS = 10;
const MAX_SAMPLE_PHOTOS = 6;

interface LocalPhoto extends SamplePhoto {
  file: File;
}

/** Editor visual de estilos (Fase 3B). Não grava no servidor: exporta o JSON. */
export function StyleEditor() {
  const [schema, setSchema] = useState<Json>(null);
  const [luts, setLuts] = useState<string[]>([]);
  const [presets, setPresets] = useState<PresetSummary[]>([]);
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [base, setBase] = useState<Preset | null>(null);
  const [current, setCurrent] = useState<Preset | null>(null);
  const [idEdited, setIdEdited] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [validation, setValidation] = useState<{ state: "checking" | "ok" | "error"; message?: string }>({ state: "ok" });
  const [platformId, setPlatformId] = useState("instagram_reels");
  const [photos, setPhotos] = useState<LocalPhoto[]>([]);
  const [logos, setLogos] = useState<{ brand?: File; partner?: File }>({});
  const [music, setMusic] = useState<{ file: File; start: number } | null>(null);
  const [sample, setSample] = useState<{ id?: string; job?: Job; error?: string; sending?: boolean }>({});
  const importInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    Promise.all([api.schema(), api.luts(), api.presets(), api.platforms(), api.preset(BASE_ID)])
      .then(([s, l, p, pl, b]) => {
        setSchema(s);
        setLuts(l);
        setPresets(p);
        setPlatforms(pl);
        setBase(b);
        setCurrent(newFrom(b, "Novo estilo"));
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : "Falha ao carregar o editor."));
  }, []);

  const exported = useMemo(() => (current && base ? exportPreset(current, base, BASE_ID) : null), [current, base]);

  // Confere no servidor (mesmas regras dos arquivos), um pouco depois de cada mudança.
  useEffect(() => {
    if (!exported) return;
    setValidation({ state: "checking" });
    const timer = setTimeout(() => {
      api
        .validatePreset(exported)
        .then(() => setValidation({ state: "ok" }))
        .catch((err) => setValidation({ state: "error", message: err instanceof ApiError ? err.message : "Falha ao conferir." }));
    }, 500);
    return () => clearTimeout(timer);
  }, [exported]);

  const logoUrls = useMemo(
    () => ({ brand: logos.brand && URL.createObjectURL(logos.brand), partner: logos.partner && URL.createObjectURL(logos.partner) }),
    [logos],
  );
  useEffect(
    () => () => {
      if (logoUrls.brand) URL.revokeObjectURL(logoUrls.brand);
      if (logoUrls.partner) URL.revokeObjectURL(logoUrls.partner);
    },
    [logoUrls],
  );

  if (loadError) return <section className="card"><p className="error">{loadError}</p></section>;
  if (!schema || !current || !base || !exported) return <section className="card"><p className="muted">Carregando o editor…</p></section>;

  const platform = platforms.find((p) => p.id === platformId) ?? platforms[0]!;
  const set = (key: string, value: Json) => setCurrent((c) => ({ ...c!, [key]: value }));

  function newFrom(p: Preset, name: string): Preset {
    setIdEdited(false);
    setSample({});
    return { ...structuredClone(p), id: slugify(name), name, version: 1, description: undefined };
  }

  async function open(id: string) {
    try {
      const p = await api.preset(id);
      setCurrent(p);
      setIdEdited(true);
      setSample({});
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Não foi possível abrir o estilo.");
    }
  }

  async function importFile(file: File) {
    try {
      const json = JSON.parse(await file.text());
      const { preset } = await api.validatePreset(json);
      setCurrent(preset);
      setIdEdited(true);
      setSample({});
    } catch (err) {
      alert(err instanceof ApiError ? `Arquivo recusado: ${err.message}` : "O arquivo não é um JSON válido.");
    }
  }

  function download() {
    const blob = new Blob([JSON.stringify(exported, null, 2) + "\n"], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${exported!.id}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function addPhotos(list: FileList) {
    const added: LocalPhoto[] = [];
    for (const file of Array.from(list).slice(0, MAX_SAMPLE_PHOTOS - photos.length)) {
      if (!/^image\/(jpeg|png|webp)$/.test(file.type)) continue;
      const url = URL.createObjectURL(file);
      try {
        const { width, height } = await imageSize(url);
        added.push({ file, url, width, height });
      } catch {
        URL.revokeObjectURL(url);
      }
    }
    setPhotos((p) => [...p, ...added]);
  }

  /** Quantas fotos cabem nos 10 s da amostra, descontando os cartões. */
  function photosForSample(): number {
    const b = current!.branding ?? {};
    const cards = (b.intro?.duration ?? 0) + (b.outro?.duration ?? 0);
    const per = Math.max(current!.timing?.perPhotoMin ?? 1.5, 0.5);
    return Math.max(1, Math.min(photos.length, Math.floor((SAMPLE_SECONDS - cards) / per)));
  }

  async function renderSample() {
    const n = photosForSample();
    const used = photos.slice(0, n);
    const items = used.map((_, i) => ({
      file: `foto${i + 1}`,
      type: "photo",
      ...(current!.text?.caption && i % 2 === 1 ? { caption: "Legenda de exemplo" } : {}),
    }));
    const options: Record<string, Json> = { preset: exported, platform: platformId, items };
    if (current!.text?.title) options.title = "Título de exemplo";
    const form = new FormData();
    used.forEach((p, i) => form.append(`foto${i + 1}`, p.file, p.file.name));
    const roleLogos: { role: string; file: string }[] = [];
    if (logos.brand) {
      form.append("logo_marca", logos.brand, logos.brand.name);
      roleLogos.push({ role: "brand", file: "logo_marca" });
    }
    if (logos.partner) {
      form.append("logo_parceiro", logos.partner, logos.partner.name);
      roleLogos.push({ role: "partner", file: "logo_parceiro" });
    }
    if (roleLogos.length) options.logos = roleLogos;
    if (music) {
      form.append("musica", music.file, music.file.name);
      options.audio = { file: "musica", start: music.start, duration: SAMPLE_SECONDS };
    } else {
      options.timing = { mode: "fixed", total: SAMPLE_SECONDS };
    }
    form.append("options", JSON.stringify(options));
    setSample({ sending: true });
    try {
      const created = await api.createVideo(form, () => {}, "/v1/previews").promise;
      setSample({ id: created.id });
      poll(created.id);
    } catch (err) {
      setSample({ error: err instanceof ApiError ? err.message : "Falha ao pedir a amostra." });
    }
  }

  function poll(id: string) {
    const tick = async () => {
      try {
        const job = await api.preview(id);
        setSample((s) => (s.id === id ? { id, job } : s));
        if (job.status === "queued" || job.status === "processing") setTimeout(tick, 1200);
      } catch (err) {
        setSample((s) => (s.id === id ? { id, error: err instanceof ApiError ? err.message : "Falha ao consultar a amostra." } : s));
      }
    };
    void tick();
  }

  const photoConf = current.photo ?? {};
  const photoSkip = ["filters", ...(photoConf.fit === "cover" ? ["background", "autoThreshold"] : photoConf.fit === "contain" ? ["autoThreshold"] : [])];
  const nSample = photos.length ? photosForSample() : 0;

  return (
    <div className="editor">
      <p className="desktop-only-note card">O editor de estilos foi feito para tela de computador. No celular, use a aba Novo vídeo.</p>
      <div className="editor-grid">
        <div className="editor-controls stack">
          <section className="card">
            <div className="row wrap">
              <label className="grow">
                Abrir um estilo
                <select value="" onChange={(e) => e.target.value && void open(e.target.value)}>
                  <option value="">Escolher…</option>
                  {presets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <button onClick={() => setCurrent(newFrom(base, "Novo estilo"))}>Novo (a partir do Limpo)</button>
              <button onClick={() => setCurrent(newFrom(current, `${current.name} (cópia)`))}>Duplicar este</button>
              <button onClick={() => importInput.current?.click()}>Importar JSON</button>
              <input
                ref={importInput}
                type="file"
                hidden
                accept="application/json,.json"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) void importFile(f);
                }}
              />
            </div>
            <div className="row wrap">
              <label className="grow">
                Nome
                <input
                  value={current.name ?? ""}
                  maxLength={60}
                  onChange={(e) => setCurrent((c) => ({ ...c!, name: e.target.value, ...(idEdited ? {} : { id: slugify(e.target.value) }) }))}
                />
              </label>
              <label className="grow">
                Identificador (nome do arquivo)
                <input
                  value={current.id ?? ""}
                  maxLength={40}
                  onChange={(e) => {
                    setIdEdited(true);
                    set("id", e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""));
                  }}
                />
              </label>
              <label style={{ width: 110 }}>
                Versão
                <input type="number" min={1} value={current.version ?? 1} onChange={(e) => set("version", Math.max(1, Number(e.target.value) | 0))} />
              </label>
            </div>
            <label>
              Descrição (aparece na escolha do estilo)
              <input value={current.description ?? ""} maxLength={300} onChange={(e) => set("description", e.target.value || undefined)} />
            </label>
            {current.id !== BASE_ID && presets.some((p) => p.id === current.id) && (
              <p className="muted small">
                Este identificador já existe: ao exportar, o arquivo substitui o estilo "{current.id}". Para um estilo novo, mude o identificador.
              </p>
            )}
          </section>

          {BLOCKS.map((key) => (
            <details key={key} className="card group" open={key === "photo"}>
              <summary>
                <h2>{BLOCK_TITLES[key]}</h2>
              </summary>
              {key === "photo" ? (
                <>
                  <SchemaField name="photo" node={schema.properties.photo} value={current.photo} onChange={(v) => set("photo", v)} skip={photoSkip} flat />
                  <FiltersEditor schema={schema} luts={luts} value={current.photo?.filters ?? []} onChange={(v) => set("photo", { ...current.photo, filters: v })} />
                </>
              ) : key === "transition" ? (
                <TransitionsEditor node={schema.properties.transition} value={current.transition} onChange={(v) => set("transition", v)} />
              ) : (
                <SchemaField name={key} node={schema.properties[key]} value={current[key]} onChange={(v) => set(key, v)} flat />
              )}
            </details>
          ))}
        </div>

        <aside className="editor-side stack">
          <section className="card">
            <div className="section-head">
              <h2>Prévia rápida</h2>
              <select value={platformId} onChange={(e) => setPlatformId(e.target.value)} aria-label="Plataforma da prévia">
                {platforms.map((p) => (
                  <option key={p.id} value={p.id}>
                    {PLATFORM_LABELS[p.id] ?? p.id}
                  </option>
                ))}
              </select>
            </div>
            <InstantPreview preset={current} platform={platform} photos={photos} logos={logoUrls} />
            <p className="muted small">Aproximada: serve para ajustar rápido. Para aprovar, use a amostra real.</p>
          </section>

          <section className="card">
            <h2>Fotos e logos de exemplo</h2>
            <div className="sample-thumbs">
              {photos.map((p, i) => (
                <button
                  key={p.url}
                  className="sample-thumb"
                  title="Remover"
                  onClick={() => {
                    URL.revokeObjectURL(p.url);
                    setPhotos((list) => list.filter((_, j) => j !== i));
                  }}
                >
                  <img src={p.url} alt="" />
                </button>
              ))}
              {photos.length < MAX_SAMPLE_PHOTOS && (
                <label className="sample-thumb add">
                  +
                  <input
                    type="file"
                    hidden
                    multiple
                    accept="image/jpeg,image/png,image/webp"
                    onChange={(e) => {
                      if (e.target.files) void addPhotos(e.target.files);
                      e.target.value = "";
                    }}
                  />
                </label>
              )}
            </div>
            <p className="muted small">Até {MAX_SAMPLE_PHOTOS} fotos. Toque numa foto para tirá-la.</p>
            <div className="row wrap">
              <FilePick label="Logo de marca" accept="image/png,image/jpeg,image/webp" file={logos.brand} onFile={(f) => setLogos((l) => ({ ...l, brand: f }))} />
              <FilePick label="Logo de parceiro" accept="image/png,image/jpeg,image/webp" file={logos.partner} onFile={(f) => setLogos((l) => ({ ...l, partner: f }))} />
            </div>
          </section>

          <section className="card">
            <h2>Amostra real</h2>
            <p className="muted small">
              Vídeo de {SAMPLE_SECONDS} s, em metade da resolução, gerado pelo motor com este estilo.
              {photos.length > 0 && nSample < photos.length ? ` Usa ${nSample} das ${photos.length} fotos (o que cabe em ${SAMPLE_SECONDS} s).` : ""}
            </p>
            <div className="row wrap">
              <FilePick label="Música (opcional)" accept="audio/*,.mp3,.m4a,.wav" file={music?.file} onFile={(f) => setMusic(f ? { file: f, start: 0 } : null)} />
              {music && (
                <label style={{ width: 140 }}>
                  Início (s)
                  <input type="number" min={0} value={music.start} onChange={(e) => setMusic({ ...music, start: Math.max(0, Number(e.target.value)) })} />
                </label>
              )}
            </div>
            <button
              className="primary big"
              disabled={photos.length === 0 || validation.state !== "ok" || sample.sending || (sample.job && ["queued", "processing"].includes(sample.job.status))}
              onClick={() => void renderSample()}
            >
              Renderizar amostra
            </button>
            {photos.length === 0 && <p className="muted small">Adicione fotos de exemplo para gerar a amostra.</p>}
            {sample.sending && <p className="muted small">Enviando…</p>}
            {sample.error && <p className="error small">{sample.error}</p>}
            {sample.job && (sample.job.status === "queued" || sample.job.status === "processing") && (
              <>
                <p className="muted small">{sample.job.status === "queued" ? "Na fila…" : `Gerando… ${Math.round(sample.job.progress)}%`}</p>
                <div className="progress">
                  <div style={{ width: `${Math.max(3, sample.job.progress)}%` }} />
                </div>
              </>
            )}
            {sample.job?.status === "failed" && <p className="error small">{sample.job.error?.message}</p>}
            {sample.job?.status === "done" && sample.id && (
              <video className="final sample-video" src={api.previewDownloadUrl(sample.id)} controls autoPlay loop playsInline />
            )}
            {sample.job && sample.job.warnings.length > 0 && (
              <ul className="warnings">
                {sample.job.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            )}
          </section>

          <section className="card">
            <h2>Exportar</h2>
            <p className={validation.state === "error" ? "error small" : "muted small"}>
              {validation.state === "checking" ? "Conferindo…" : validation.state === "ok" ? "Estilo válido." : `Ajuste antes de exportar: ${validation.message}`}
            </p>
            <div className="row wrap">
              <button className="primary" disabled={validation.state !== "ok"} onClick={download}>
                Baixar {exported.id}.json
              </button>
              <button disabled={validation.state !== "ok"} onClick={() => void navigator.clipboard?.writeText(JSON.stringify(exported, null, 2))}>
                Copiar JSON
              </button>
            </div>
            <p className="muted small">
              O arquivo herda do Limpo e traz só o que mudou. Para o estilo aparecer no site, mande o arquivo ao Claude: ele entra no repositório e no
              próximo deploy.
            </p>
            <details>
              <summary className="small">Ver o JSON</summary>
              <pre className="json">{JSON.stringify(exported, null, 2)}</pre>
            </details>
          </section>
        </aside>
      </div>
    </div>
  );
}

function FilePick(props: { label: string; accept: string; file?: File; onFile: (f?: File) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="grow file-pick">
      <span className="label">{props.label}</span>
      <div className="row">
        <button onClick={() => input.current?.click()}>{props.file ? "Trocar" : "Escolher"}</button>
        {props.file && (
          <>
            <span className="small ellipsis grow">{props.file.name}</span>
            <button className="icon" aria-label={`Tirar ${props.label}`} onClick={() => props.onFile(undefined)}>
              ✕
            </button>
          </>
        )}
      </div>
      <input
        ref={input}
        type="file"
        hidden
        accept={props.accept}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) props.onFile(f);
        }}
      />
    </div>
  );
}
