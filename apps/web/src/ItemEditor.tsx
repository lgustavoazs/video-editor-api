import { useEffect, useRef, useState, type PointerEvent } from "react";
import { cropLoss, cropRect, formatTime, parseTime, round3, type DraftItem } from "./lib.ts";

interface Props {
  item: DraftItem;
  index: number;
  /** Proporção largura/altura da plataforma escolhida (9:16 = 0,5625). */
  aspect: number;
  /** Bloco `photo` do preset escolhido (para explicar o enquadramento). */
  photoConf?: { fit?: string; autoThreshold?: number };
  /** O estilo escolhido mostra legendas? */
  captions: boolean;
  onChange: (item: DraftItem) => void;
  onClose: () => void;
}

export function ItemEditor({ item, index, aspect, photoConf, captions, onChange, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal card" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="section-head">
          <h2>
            Item {index + 1} · {item.kind === "photo" ? "foto" : "clipe"}
          </h2>
          <button className="icon" onClick={onClose} aria-label="Fechar">
            ✕
          </button>
        </div>
        <p className="muted small ellipsis">{item.file.name}</p>
        {item.kind === "photo" ? (
          <PhotoFocus item={item} aspect={aspect} photoConf={photoConf} onChange={onChange} />
        ) : (
          <ClipTrim item={item} onChange={onChange} />
        )}
        <label>
          Legenda (opcional)
          <input
            value={item.caption}
            maxLength={120}
            placeholder="Texto que aparece sobre este item"
            onChange={(e) => onChange({ ...item, caption: e.target.value })}
          />
          {!captions && <span className={item.caption ? "error small" : "muted small"}>Este estilo não mostra legendas.</span>}
        </label>
        <div className="actions">
          <button className="primary" onClick={onClose}>
            Pronto
          </button>
        </div>
      </div>
    </div>
  );
}

function PhotoFocus({ item, aspect, photoConf, onChange }: Omit<Props, "index" | "onClose" | "captions">) {
  const box = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const w = item.width ?? 1;
  const h = item.height ?? 1;
  const rect = cropRect(w, h, aspect, item.focus);
  const loss = cropLoss(w, h, aspect);
  const fit = photoConf?.fit ?? "cover";
  const threshold = photoConf?.autoThreshold ?? 0.35;

  const setFromPointer = (e: PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    onChange({ ...item, focus: { x: round3(x), y: round3(y) } });
  };

  // Mesma regra do motor: "auto" mostra a foto inteira se o corte tiraria demais, a não ser que haja um ponto marcado.
  let note: string;
  if (loss < 0.01) note = "A foto já tem o formato do vídeo: nada é cortado.";
  else if (fit === "contain") note = "Este estilo mostra a foto inteira, com fundo desfocado. O ponto marcado só centraliza o movimento.";
  else if (fit === "auto" && !item.focus && loss > threshold)
    note = "Este estilo vai mostrar a foto inteira, com fundo desfocado, porque o corte tiraria muito dela. Toque na foto para preferir o corte centrado no ponto escolhido.";
  else note = "A área clara é o que aparece no vídeo. Toque ou arraste sobre o assunto principal para centralizar o corte.";

  const showFrame = loss >= 0.01 && fit !== "contain" && !(fit === "auto" && !item.focus && loss > threshold);

  return (
    <div>
      <div
        ref={box}
        className="focus-box"
        style={{ aspectRatio: `${w} / ${h}` }}
        onPointerDown={(e) => {
          dragging.current = true;
          (e.target as Element).setPointerCapture?.(e.pointerId);
          setFromPointer(e);
        }}
        onPointerMove={(e) => dragging.current && setFromPointer(e)}
        onPointerUp={() => (dragging.current = false)}
      >
        <img src={item.url} alt="" draggable={false} />
        {showFrame && (
          <div
            className="crop-frame"
            style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }}
          />
        )}
        {item.focus && <div className="focus-dot" style={{ left: `${item.focus.x * 100}%`, top: `${item.focus.y * 100}%` }} />}
      </div>
      <p className="muted small">{note}</p>
      {item.focus && (
        <button className="link" onClick={() => onChange({ ...item, focus: undefined })}>
          Voltar ao centro
        </button>
      )}
    </div>
  );
}

function ClipTrim({ item, onChange }: { item: DraftItem; onChange: (item: DraftItem) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const total = item.sourceDuration ?? 0;
  const start = item.start ?? 0;
  const end = item.end ?? total;
  const [startText, setStartText] = useState(formatTime(start, 1));
  const [endText, setEndText] = useState(formatTime(end, 1));
  const stopAt = useRef<number | null>(null);

  useEffect(() => setStartText(formatTime(start, 1)), [start]);
  useEffect(() => setEndText(formatTime(end, 1)), [end]);

  const set = (s: number, e: number) => {
    s = Math.max(0, Math.min(s, total));
    e = Math.max(0, Math.min(e, total));
    onChange({ ...item, start: round3(s), end: round3(e) });
  };

  const current = () => video.current?.currentTime ?? 0;

  const playRange = () => {
    const v = video.current;
    if (!v) return;
    v.currentTime = start;
    stopAt.current = end;
    void v.play();
  };

  const length = end - start;
  return (
    <div>
      <video
        ref={video}
        className="clip-player"
        src={item.url}
        controls
        playsInline
        preload="metadata"
        onTimeUpdate={(e) => {
          if (stopAt.current !== null && e.currentTarget.currentTime >= stopAt.current) {
            e.currentTarget.pause();
            stopAt.current = null;
          }
        }}
      />
      <div className="row">
        <label className="grow">
          Início
          <input
            inputMode="decimal"
            value={startText}
            onChange={(e) => setStartText(e.target.value)}
            onBlur={() => {
              const v = parseTime(startText);
              if (v === undefined) setStartText(formatTime(start, 1));
              else set(v, end);
            }}
          />
        </label>
        <button onClick={() => set(current(), end)}>Início aqui</button>
      </div>
      <div className="row">
        <label className="grow">
          Fim
          <input
            inputMode="decimal"
            value={endText}
            onChange={(e) => setEndText(e.target.value)}
            onBlur={() => {
              const v = parseTime(endText);
              if (v === undefined) setEndText(formatTime(end, 1));
              else set(start, v);
            }}
          />
        </label>
        <button onClick={() => set(start, current())}>Fim aqui</button>
      </div>
      <p className={length < 1 ? "error small" : "muted small"}>
        Trecho de {formatTime(Math.max(0, length), 1)} (de {formatTime(total, 1)}). {length < 1 ? "O mínimo é 1 segundo." : "O clipe entra no vídeo com essa duração."}
      </p>
      <div className="row">
        <button onClick={playRange}>Assistir o trecho</button>
        {(start > 0 || end < total) && <button className="link" onClick={() => set(0, total)}>Usar o clipe inteiro</button>}
      </div>
      <label className="check">
        <input type="checkbox" checked={item.keepAudio} onChange={(e) => onChange({ ...item, keepAudio: e.target.checked })} />
        Manter o som original do clipe (a música abaixa enquanto ele toca)
      </label>
      {item.keepAudio && (
        <label>
          Volume do som original: {Math.round(item.volume * 100)}%
          <input type="range" min={0} max={2} step={0.05} value={item.volume} onChange={(e) => onChange({ ...item, volume: Number(e.target.value) })} />
        </label>
      )}
    </div>
  );
}
