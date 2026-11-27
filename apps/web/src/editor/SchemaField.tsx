import { defaultsFor, fieldKind, isNullable, label, type Json } from "./schemaUtil.ts";

interface Props {
  node: Json;
  value: Json;
  onChange: (v: Json) => void;
  /** Rótulo quando o nó não tem `title`. */
  name: string;
  /** Campos a não desenhar dentro de um objeto (tratados à parte). */
  skip?: string[];
  /** Desenha os filhos de um objeto sem a moldura (o grupo já tem título). */
  flat?: boolean;
}

function step(min: number, max: number, integer: boolean): number {
  if (integer) return 1;
  const span = max - min;
  if (span <= 1) return 0.01;
  if (span <= 10) return 0.05;
  return 1;
}

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0$/, "").replace(".", ","));

/**
 * Um campo do preset desenhado a partir do schema: as faixas, os textos e os valores
 * possíveis vêm de lá, então o editor não deixa sair do que o motor aceita.
 */
export function SchemaField({ node, value, onChange, name, skip = [], flat = false }: Props) {
  const kind = fieldKind(node);
  const title: string = node?.title ?? name;
  const hint: string | undefined = node?.description;
  const current = value === undefined ? node?.default : value;

  if (kind === "object") {
    const nullable = isNullable(node);
    const on = current !== null && current !== undefined;
    const children = Object.entries<Json>(node.properties ?? {}).filter(([k, child]) => !skip.includes(k) && child.const === undefined);
    const body = on && (
      <div className={flat ? "fields" : "fields nested"}>
        {children.map(([key, child]) => (
          <SchemaField
            key={key}
            name={key}
            node={child}
            value={current?.[key]}
            onChange={(v) => {
              const next = { ...(current ?? {}) };
              if (v === undefined) delete next[key];
              else next[key] = v;
              onChange(next);
            }}
          />
        ))}
      </div>
    );
    if (flat && !nullable) return <>{body}</>;
    return (
      <fieldset className="schema-object">
        <legend>
          {nullable ? (
            <label className="check inline">
              <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked ? defaultsFor(node) : null)} />
              {title}
            </label>
          ) : (
            title
          )}
        </legend>
        {hint && <p className="muted small">{hint}</p>}
        {body}
      </fieldset>
    );
  }

  if (kind === "number" || kind === "integer") {
    const min: number = node.minimum ?? 0;
    const max: number = node.maximum ?? 100;
    const v: number = typeof current === "number" ? current : min;
    const st = step(min, max, kind === "integer");
    return (
      <label className="field">
        <span className="field-label">
          {title}: <strong>{fmt(v)}</strong>
        </span>
        <span className="range-row">
          <input type="range" min={min} max={max} step={st} value={v} aria-label={title} onChange={(e) => onChange(Number(e.target.value))} />
          <input
            className="num"
            type="number"
            min={min}
            max={max}
            step={st}
            value={v}
            aria-label={`${title} (valor)`}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n)));
            }}
          />
        </span>
        {hint && <span className="muted small">{hint}</span>}
      </label>
    );
  }

  if (kind === "enum") {
    return (
      <label className="field">
        <span className="field-label">{title}</span>
        <select value={current ?? ""} onChange={(e) => onChange(e.target.value)}>
          {(node.enum as string[]).map((opt) => (
            <option key={opt} value={opt}>
              {label(opt)}
            </option>
          ))}
        </select>
        {hint && <span className="muted small">{hint}</span>}
      </label>
    );
  }

  if (kind === "color") {
    return (
      <label className="field color-field">
        <span className="field-label">{title}</span>
        <input type="color" value={current ?? "#000000"} onChange={(e) => onChange(e.target.value)} />
      </label>
    );
  }

  if (kind === "boolean") {
    return (
      <label className="check">
        <input type="checkbox" checked={Boolean(current)} onChange={(e) => onChange(e.target.checked)} />
        {title}
      </label>
    );
  }

  if (kind === "string") {
    return (
      <label className="field">
        <span className="field-label">{title}</span>
        <input value={current ?? ""} maxLength={node.maxLength} onChange={(e) => onChange(e.target.value || undefined)} />
        {hint && <span className="muted small">{hint}</span>}
      </label>
    );
  }

  return null;
}
