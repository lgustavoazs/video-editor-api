import { useEffect, useMemo, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import RegionsPlugin, { type Region } from "wavesurfer.js/dist/plugins/regions.esm.js";
import { api, type Track } from "./api.ts";
import { FADE_CHOICES, formatTime, LIMITS_MB, parseTime, round3, type Draft, type MusicChoice } from "./lib.ts";

interface Props {
  music: MusicChoice;
  onChange: (m: MusicChoice) => void;
  /** Duração máxima da plataforma, em segundos. */
  maxDuration: number;
  tracks: Track[];
  fades: Draft["fades"];
  onFades: (f: Draft["fades"]) => void;
  /** Entrada e saída definidas pelo estilo escolhido (o padrão). */
  presetAudio?: { fadeIn?: number; fadeOut?: number };
}

const DEFAULT_SEGMENT = 30;

export function MusicPanel({ music, onChange, maxDuration, tracks, fades, onFades, presetAudio }: Props) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [lastFile, setLastFile] = useState<File | undefined>(music.kind === "file" ? music.file : undefined);
  const [fileError, setFileError] = useState("");

  const fileUrl = useMemo(() => (lastFile ? URL.createObjectURL(lastFile) : undefined), [lastFile]);
  useEffect(() => () => {
    if (fileUrl) URL.revokeObjectURL(fileUrl);
  }, [fileUrl]);

  const url = music.kind === "file" ? fileUrl : music.kind === "library" ? api.audioFileUrl(music.id) : undefined;

  const choose = (kind: MusicChoice["kind"]) => {
    if (kind === music.kind) return;
    if (kind === "none") onChange({ kind: "none", duration: 15 });
    else if (kind === "file") {
      if (lastFile) onChange({ kind: "file", file: lastFile, start: 0, end: 0, loop: false });
      else fileInput.current?.click();
    } else if (tracks[0]) onChange({ kind: "library", id: tracks[0].id, start: 0, end: 0, loop: false });
  };

  return (
    <section className="card">
      <h2>Música</h2>
      <div className="segmented" role="radiogroup">
        <button role="radio" aria-checked={music.kind === "none"} className={music.kind === "none" ? "on" : ""} onClick={() => choose("none")}>
          Sem música
        </button>
        <button role="radio" aria-checked={music.kind === "file"} className={music.kind === "file" ? "on" : ""} onClick={() => choose("file")}>
          Enviar arquivo
        </button>
        <button
          role="radio"
          aria-checked={music.kind === "library"}
          className={music.kind === "library" ? "on" : ""}
          disabled={tracks.length === 0}
          title={tracks.length === 0 ? "A biblioteca ainda está vazia" : undefined}
          onClick={() => choose("library")}
        >
          Biblioteca
        </button>
      </div>
      <input
        ref={fileInput}
        type="file"
        hidden
        accept="audio/*,.mp3,.m4a,.wav,.ogg,.flac"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          if (f.size > LIMITS_MB.audio * 1024 * 1024) {
            setFileError(`O arquivo passa de ${LIMITS_MB.audio} MB.`);
            return;
          }
          setFileError("");
          setLastFile(f);
          onChange({ kind: "file", file: f, start: 0, end: 0, loop: false });
        }}
      />
      {fileError && <p className="error small">{fileError}</p>}

      {music.kind === "none" && (
        <label>
          Duração do vídeo (segundos)
          <input
            type="number"
            min={3}
            max={maxDuration}
            step={1}
            value={music.duration}
            onChange={(e) => onChange({ kind: "none", duration: Number(e.target.value) })}
          />
        </label>
      )}

      {music.kind === "file" && (
        <p className="small">
          <strong>{music.file.name}</strong>{" "}
          <button className="link" onClick={() => fileInput.current?.click()}>
            trocar
          </button>
        </p>
      )}

      {music.kind === "library" && (
        <label>
          Faixa
          <select value={music.id} onChange={(e) => onChange({ kind: "library", id: e.target.value, start: 0, end: 0, loop: false })}>
            {tracks.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({formatTime(t.duration, 0)}) · {t.moods.join(", ")}
              </option>
            ))}
          </select>
          {tracks.find((t) => t.id === music.id)?.attribution && (
            <span className="muted small">Crédito: {tracks.find((t) => t.id === music.id)?.attribution}</span>
          )}
        </label>
      )}

      {music.kind !== "none" && url && (
        <Segment
          key={url}
          url={url}
          start={music.start}
          end={music.end}
          maxDuration={maxDuration}
          onRange={(start, end) => onChange({ ...music, start, end })}
        />
      )}

      {music.kind !== "none" && (
        <div className="row wrap">
          <FadeSelect
            label="Início da música"
            value={fades.fadeIn}
            styleValue={presetAudio?.fadeIn}
            onChange={(v) => onFades({ ...fades, fadeIn: v })}
          />
          <FadeSelect
            label="Fim da música"
            value={fades.fadeOut}
            styleValue={presetAudio?.fadeOut}
            onChange={(v) => onFades({ ...fades, fadeOut: v })}
          />
        </div>
      )}
    </section>
  );
}

/** Forma de onda com o trecho escolhido (arrastar para mover, puxar as bordas para ajustar). */
function Segment(props: { url: string; start: number; end: number; maxDuration: number; onRange: (s: number, e: number) => void }) {
  const container = useRef<HTMLDivElement>(null);
  const region = useRef<Region | null>(null);
  const ws = useRef<WaveSurfer | null>(null);
  const [total, setTotal] = useState(0);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [playing, setPlaying] = useState(false);
  const onRange = useRef(props.onRange);
  onRange.current = props.onRange;
  const maxLen = props.maxDuration;

  useEffect(() => {
    const regions = RegionsPlugin.create();
    const css = getComputedStyle(document.documentElement);
    const w = WaveSurfer.create({
      container: container.current!,
      url: props.url,
      height: 88,
      normalize: true,
      waveColor: css.getPropertyValue("--wave").trim() || "#5b6170",
      progressColor: css.getPropertyValue("--wave-progress").trim() || "#9aa3b5",
      cursorColor: css.getPropertyValue("--accent").trim() || "#ff7a45",
      barWidth: 2,
      barGap: 1,
      plugins: [regions],
    });
    ws.current = w;
    w.on("decode", (duration) => {
      setTotal(duration);
      setState("ready");
      // Mantém o trecho já escolhido; senão, começa com os primeiros segundos.
      let s = props.start;
      let e = props.end > props.start ? props.end : Math.min(duration, DEFAULT_SEGMENT, maxLen);
      e = Math.min(e, duration, s + maxLen);
      if (s >= e) s = 0;
      region.current = regions.addRegion({ start: s, end: e, drag: true, resize: true, color: "rgba(255,122,69,0.25)" });
      onRange.current(round3(s), round3(e));
    });
    w.on("error", () => setState("error"));
    w.on("play", () => setPlaying(true));
    w.on("pause", () => setPlaying(false));
    regions.on("region-updated", (r) => {
      // Respeita a duração máxima da plataforma.
      if (r.end - r.start > maxLen) r.setOptions({ end: r.start + maxLen });
      onRange.current(round3(r.start), round3(r.end));
    });
    return () => {
      region.current = null;
      ws.current = null;
      w.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.url]);

  // Mudanças feitas pelos campos de texto refletem na forma de onda.
  useEffect(() => {
    const r = region.current;
    if (r && (Math.abs(r.start - props.start) > 0.001 || Math.abs(r.end - props.end) > 0.001) && props.end > props.start) {
      r.setOptions({ start: props.start, end: props.end });
    }
  }, [props.start, props.end]);

  const length = props.end - props.start;
  return (
    <div className="segment">
      <div ref={container} className="wave" />
      {state === "loading" && <p className="muted small">Lendo o áudio…</p>}
      {state === "error" && <p className="error small">Este navegador não conseguiu abrir o áudio. O envio ainda funciona: informe o trecho nos campos abaixo.</p>}
      <div className="row">
        <TimeField label="Início" value={props.start} onCommit={(v) => props.onRange(round3(v), Math.max(props.end, v + 3))} />
        <TimeField label="Fim" value={props.end} onCommit={(v) => props.onRange(props.start, round3(Math.min(v, total || v)))} />
        <div className="grow">
          <span className="label">Duração do vídeo</span>
          <strong>{formatTime(Math.max(0, length), 1)}</strong>
        </div>
      </div>
      {state === "ready" && (
        <div className="row">
          <button onClick={() => (playing ? ws.current?.pause() : region.current?.play(true))}>{playing ? "Parar" : "Ouvir o trecho"}</button>
          <span className="muted small">
            Arraste a faixa laranja para mover o trecho; puxe as bordas para mudar o tamanho. Faixa inteira: {formatTime(total, 0)}.
          </span>
        </div>
      )}
      {length > maxLen && <p className="error small">O máximo da plataforma é {formatTime(maxLen, 0)}.</p>}
      {length > 0 && length < 3 && <p className="error small">O trecho precisa ter pelo menos 3 segundos.</p>}
    </div>
  );
}

export function TimeField({ label, value, onCommit }: { label: string; value: number; onCommit: (v: number) => void }) {
  const [text, setText] = useState(formatTime(value, 1));
  const editing = useRef(false);
  // Atualiza o texto quando o valor muda por fora (forma de onda, outro campo), mas nunca
  // enquanto a pessoa está digitando neste campo.
  useEffect(() => {
    if (!editing.current) setText(formatTime(value, 1));
  }, [value]);
  return (
    <label className="grow">
      {label}
      <input
        inputMode="decimal"
        value={text}
        onFocus={() => (editing.current = true)}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          editing.current = false;
          const v = parseTime(text);
          if (v === undefined) setText(formatTime(value, 1));
          else onCommit(v);
        }}
      />
    </label>
  );
}

const seconds = (v: number) => `${String(v).replace(".", ",")} s`;

/** Entrada ou saída da música: padrão do estilo, corte seco ou suave com duração. */
function FadeSelect(props: { label: string; value?: number; styleValue?: number; onChange: (v?: number) => void }) {
  const describe = (v: number) => (v === 0 ? "Corte seco" : `Suave, ${seconds(v)}`);
  return (
    <label className="grow">
      {props.label}
      <select
        value={props.value === undefined ? "" : String(props.value)}
        onChange={(e) => props.onChange(e.target.value === "" ? undefined : Number(e.target.value))}
      >
        <option value="">Padrão do estilo{props.styleValue !== undefined ? ` (${describe(props.styleValue).toLowerCase()})` : ""}</option>
        {FADE_CHOICES.map((v) => (
          <option key={v} value={String(v)}>
            {describe(v)}
          </option>
        ))}
      </select>
    </label>
  );
}
