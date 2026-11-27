import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { Platform } from "../api.ts";
import { cropLoss } from "../lib.ts";
import { approxLook, previewPhotoSeconds, type Json, type Preset } from "./schemaUtil.ts";

export interface SamplePhoto {
  url: string;
  width: number;
  height: number;
}

interface Props {
  preset: Preset;
  platform: Platform;
  photos: SamplePhoto[];
  logos: { brand?: string; partner?: string };
}

interface Segment {
  kind: "photo" | "card";
  seconds: number;
  photo?: SamplePhoto;
  photoIndex?: number;
  card?: Json;
}

const FRAME_W = 300;

/** Textura de grão (ruído cinza), gerada uma vez. */
function useGrainTexture(): string {
  return useMemo(() => {
    if (typeof document === "undefined") return "";
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const ctx = c.getContext("2d");
    if (!ctx) return "";
    const img = ctx.createImageData(128, 128);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.random() * 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return c.toDataURL();
  }, []);
}

/** Linha do tempo da prévia: cartões e fotos, como o motor monta. */
function buildTimeline(preset: Preset, photos: SamplePhoto[]): Segment[] {
  const b = preset.branding ?? {};
  const per = previewPhotoSeconds(preset.timing);
  const segs: Segment[] = [];
  if (b.intro) segs.push({ kind: "card", seconds: b.intro.duration ?? 2, card: b.intro });
  photos.forEach((p, i) => {
    if (i > 0 && b.between && i % (b.between.every ?? 3) === 0) segs.push({ kind: "card", seconds: b.between.duration ?? 2, card: b.between });
    segs.push({ kind: "photo", seconds: per, photo: p, photoIndex: i });
  });
  if (b.outro) segs.push({ kind: "card", seconds: b.outro.duration ?? 2, card: b.outro });
  return segs;
}

/**
 * Prévia aproximada, desenhada pelo navegador: serve para ajustar rápido.
 * A referência para aprovar é a amostra real.
 */
export function InstantPreview({ preset, platform, photos, logos }: Props) {
  const grain = useGrainTexture();
  const [playing, setPlaying] = useState(true);
  const [samples, setSamples] = useState(true);
  const [t, setT] = useState(0);
  const last = useRef<number | null>(null);

  const timeline = useMemo(() => buildTimeline(preset, photos), [preset, photos]);
  const total = timeline.reduce((s, x) => s + x.seconds, 0);
  const H = Math.round((FRAME_W * platform.height) / platform.width);
  const look = approxLook(preset.photo?.filters);
  const transition = Math.min(preset.transition?.duration ?? 0.5, 1.5);

  useEffect(() => {
    if (!playing || total === 0) return;
    let raf = 0;
    const loop = (now: number) => {
      if (last.current !== null) setT((x) => (x + (now - last.current!) / 1000) % total);
      last.current = now;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      last.current = null;
    };
  }, [playing, total]);

  let acc = 0;
  let active = 0;
  for (const [i, s] of timeline.entries()) {
    if (t >= acc && t < acc + s.seconds) active = i;
    acc += s.seconds;
  }
  const activeSeg = timeline[active];
  const sz = platform.safeZone;

  if (photos.length === 0) {
    return (
      <div className="preview-frame empty" style={{ width: FRAME_W, height: H }}>
        <span className="muted small">Adicione fotos de exemplo para ver a prévia.</span>
      </div>
    );
  }

  const text = preset.text ?? {};
  const titleOn = samples && text.title && t >= (text.title.start ?? 0) && t < (text.title.start ?? 0) + (text.title.duration ?? 3.5);
  const captionOn = samples && text.caption && activeSeg?.kind === "photo" && (activeSeg.photoIndex ?? 0) % 2 === 1;
  const wm = preset.branding?.watermark;
  const wmLogo = wm ? (wm.role === "partner" ? logos.partner : logos.brand) : undefined;

  return (
    <div>
      <div className="preview-frame" style={{ width: FRAME_W, height: H }}>
        {timeline.map((seg, i) => (
          <div
            key={i}
            className="layer"
            style={{ opacity: i === active ? 1 : 0, transition: `opacity ${transition}s linear` }}
            aria-hidden={i !== active}
          >
            {seg.kind === "photo" ? (
              <PhotoLayer seg={seg} preset={preset} frameW={FRAME_W} frameH={H} active={i === active} filterCss={look.css} />
            ) : (
              <CardLayer card={seg.card} logos={logos} frameW={FRAME_W} frameH={H} />
            )}
          </div>
        ))}
        {/* efeitos sobre a imagem inteira, como no motor */}
        {activeSeg?.kind === "photo" && look.tint && (
          <div className="overlay" style={{ background: look.tint.color, opacity: look.tint.opacity, mixBlendMode: "soft-light" }} />
        )}
        {activeSeg?.kind === "photo" && look.vignette > 0 && (
          <div
            className="overlay"
            style={{ background: `radial-gradient(ellipse at center, transparent 45%, rgba(0,0,0,${Math.min(0.95, look.vignette * 1.1)}) 100%)` }}
          />
        )}
        {activeSeg?.kind === "photo" && look.grain > 0 && grain && (
          <div className="overlay grain" style={{ backgroundImage: `url(${grain})`, opacity: Math.min(0.6, look.grain / 60), mixBlendMode: "overlay" }} />
        )}
        {(preset.letterbox ?? 0) > 0 && (
          <>
            <div className="bar top" style={{ height: `${preset.letterbox * 100}%` }} />
            <div className="bar bottom" style={{ height: `${preset.letterbox * 100}%` }} />
          </>
        )}
        {titleOn && <TextBox conf={text.title} text="Título de exemplo" frameH={H} safe={sz} />}
        {captionOn && <TextBox conf={text.caption} text="Legenda de exemplo" frameH={H} safe={sz} />}
        {wm && activeSeg?.kind === "photo" && <Watermark conf={wm} logo={wmLogo} frameW={FRAME_W} frameH={H} safe={sz} />}
      </div>
      <div className="row preview-controls">
        <button onClick={() => setPlaying((p) => !p)}>{playing ? "Pausar" : "Tocar"}</button>
        <label className="check inline">
          <input type="checkbox" checked={samples} onChange={(e) => setSamples(e.target.checked)} />
          Textos de exemplo
        </label>
        <span className="muted small">
          {t.toFixed(1).replace(".", ",")} / {total.toFixed(1).replace(".", ",")} s
        </span>
      </div>
      {look.sampleOnly.length > 0 && (
        <p className="muted small">Fora desta prévia (veja na amostra real): {[...new Set(look.sampleOnly)].join(", ")}.</p>
      )}
    </div>
  );
}

function PhotoLayer(props: { seg: Segment; preset: Preset; frameW: number; frameH: number; active: boolean; filterCss: string }) {
  const { seg, preset, frameW, frameH } = props;
  const p = seg.photo!;
  const conf = preset.photo ?? {};
  const loss = cropLoss(p.width, p.height, frameW / frameH);
  const fit = conf.fit === "auto" ? (loss > (conf.autoThreshold ?? 0.5) ? "contain" : "cover") : (conf.fit ?? "cover");
  const motion = preset.motion ?? {};
  const kb = motion.type === "kenburns";
  const idx = seg.photoIndex ?? 0;
  const zoomIn = motion.direction === "in" || (motion.direction !== "out" && idx % 2 === 0);
  const from = zoomIn ? (motion.zoomFrom ?? 1) : (motion.zoomTo ?? 1.12);
  const to = zoomIn ? (motion.zoomTo ?? 1.12) : (motion.zoomFrom ?? 1);
  const panDir = motion.pan === "alternate" ? (["left", "right"] as const)[idx % 2] : motion.pan;
  const shift = Math.max(0, (Math.max(from, to) - 1) / 2) * 100;
  const pan = { left: [shift, -shift, 0, 0], right: [-shift, shift, 0, 0], up: [0, 0, shift, -shift], down: [0, 0, -shift, shift] }[
    panDir as "left" | "right" | "up" | "down"
  ] ?? [0, 0, 0, 0];

  const anim: CSSProperties = kb && props.active
    ? ({
        animation: `kb ${seg.seconds + 1}s linear forwards`,
        "--kb-from": from,
        "--kb-to": to,
        "--kb-x0": `${pan[0]}%`,
        "--kb-x1": `${pan[1]}%`,
        "--kb-y0": `${pan[2]}%`,
        "--kb-y1": `${pan[3]}%`,
      } as CSSProperties)
    : { transform: `scale(${kb ? from : 1})` };

  const bg = conf.background ?? {};
  return (
    <div className="photo-layer" style={{ filter: props.filterCss || undefined }}>
      {fit === "contain" &&
        (bg.type === "color" ? (
          <div className="fill" style={{ background: bg.color ?? "#000" }} />
        ) : (
          <img
            className="fill"
            src={p.url}
            alt=""
            style={{ objectFit: "cover", filter: `blur(${(bg.blur ?? 40) / 8}px) brightness(${1 - (bg.darken ?? 0.35)})`, transform: "scale(1.1)" }}
          />
        ))}
      <div className="kb" style={anim} key={props.active ? "on" : "off"}>
        <img className="fill" src={p.url} alt="" style={{ objectFit: fit === "contain" ? "contain" : "cover" }} />
      </div>
    </div>
  );
}

function CardLayer(props: { card: Json; logos: { brand?: string; partner?: string }; frameW: number; frameH: number }) {
  const c = props.card ?? {};
  const logo = c.role === "partner" ? props.logos.partner : props.logos.brand;
  return (
    <div className="card-layer" style={{ background: c.background ?? "#000" }}>
      {logo ? (
        <img src={logo} alt="" style={{ width: `${(c.width ?? 0.5) * 100}%` }} />
      ) : (
        <div className="logo-placeholder" style={{ width: `${(c.width ?? 0.5) * 100}%` }}>
          {c.role === "partner" ? "LOGO PARCEIRO" : "LOGO MARCA"}
        </div>
      )}
      {c.caption && (
        <span style={{ color: c.captionColor ?? "#fff", fontSize: props.frameH * 0.03 }} className="card-caption">
          {c.caption}
        </span>
      )}
    </div>
  );
}

function hexToRgba(hex: string, a: number): string {
  const n = parseInt((hex ?? "#000000").slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function TextBox(props: { conf: Json; text: string; frameH: number; safe: Platform["safeZone"] }) {
  const c = props.conf ?? {};
  const pos: Record<string, CSSProperties> = {
    top: { top: `${props.safe.top * 100}%` },
    center: { top: "50%", transform: "translateY(-50%)" },
    bottom: { bottom: `${props.safe.bottom * 100}%` },
  };
  return (
    <div className="text-row" style={{ ...pos[c.position ?? "bottom"], left: `${props.safe.left * 100}%`, right: `${props.safe.right * 100}%` }}>
      <span
        style={{
          fontSize: (c.size ?? 0.04) * props.frameH,
          color: c.color ?? "#fff",
          fontWeight: c.font === "sans" ? 400 : 700,
          background: c.box === false ? "transparent" : hexToRgba(c.boxColor ?? "#000000", c.boxOpacity ?? 0.5),
          padding: c.box === false ? 0 : "0.15em 0.4em",
        }}
      >
        {props.text}
      </span>
    </div>
  );
}

function Watermark(props: { conf: Json; logo?: string; frameW: number; frameH: number; safe: Platform["safeZone"] }) {
  const c = props.conf;
  const [v, h] = (c.position ?? "top-right").split("-") as [string, string];
  const m = c.margin ?? 0.02;
  const style: CSSProperties = { width: `${(c.width ?? 0.16) * 100}%`, opacity: c.opacity ?? 0.9 };
  if (v === "top") style.top = `${(props.safe.top + m) * 100}%`;
  else style.bottom = `${(props.safe.bottom + m) * 100}%`;
  if (h === "left") style.left = `${(props.safe.left + m) * 100}%`;
  else if (h === "right") style.right = `${(props.safe.right + m) * 100}%`;
  else {
    style.left = "50%";
    style.transform = "translateX(-50%)";
  }
  return props.logo ? (
    <img className="watermark" src={props.logo} alt="" style={style} />
  ) : (
    <div className="watermark logo-placeholder small" style={style}>
      {c.role === "partner" ? "PARCEIRO" : "MARCA"}
    </div>
  );
}
