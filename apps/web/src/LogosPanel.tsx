import { useEffect, useMemo, useRef } from "react";
import { brandingSlots, LIMITS_MB } from "./lib.ts";

interface Props {
  logos: { brand?: File; partner?: File };
  onChange: (logos: { brand?: File; partner?: File }) => void;
  /** Bloco `branding` do preset escolhido. */
  branding: unknown;
}

export function LogosPanel({ logos, onChange, branding }: Props) {
  const slots = brandingSlots(branding);
  return (
    <section className="card">
      <h2>Logos</h2>
      <p className="muted small hint">
        O estilo escolhido define onde cada logo aparece. Use PNG com fundo transparente para a marca d'água.
      </p>
      <div className="logos">
        <LogoSlot
          label="Marca"
          where={slots.brand}
          file={logos.brand}
          onFile={(f) => onChange({ ...logos, brand: f })}
        />
        <LogoSlot
          label="Parceiro / patrocinador"
          where={slots.partner}
          file={logos.partner}
          onFile={(f) => onChange({ ...logos, partner: f })}
        />
      </div>
    </section>
  );
}

function LogoSlot(props: { label: string; where: string[]; file?: File; onFile: (f?: File) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const url = useMemo(() => (props.file ? URL.createObjectURL(props.file) : undefined), [props.file]);
  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url);
  }, [url]);
  const unused = props.where.length === 0;
  return (
    <div className="logo-slot">
      <span className="label">{props.label}</span>
      <div className="logo-preview" onClick={() => input.current?.click()} role="button" tabIndex={0}>
        {url ? <img src={url} alt="" /> : <span className="muted small">Escolher imagem</span>}
      </div>
      <span className={unused && props.file ? "error small" : "muted small"}>
        {unused ? (props.file ? "Este estilo não usa esta logo." : "Não usada por este estilo.") : `Aparece em: ${props.where.join(", ")}.`}
      </span>
      {props.file && (
        <button className="link" onClick={() => props.onFile(undefined)}>
          Remover
        </button>
      )}
      <input
        ref={input}
        type="file"
        hidden
        accept="image/png,image/jpeg,image/webp"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          if (f.size > LIMITS_MB.logo * 1024 * 1024) {
            alert(`A logo passa de ${LIMITS_MB.logo} MB.`);
            return;
          }
          props.onFile(f);
        }}
      />
    </div>
  );
}
