import { useState } from "react";
import { SchemaField } from "./SchemaField.tsx";
import { filterSchemas, label, newFilter, SAMPLE_ONLY, type Json } from "./schemaUtil.ts";

/** Lista de filtros: aplicados na ordem em que aparecem. */
export function FiltersEditor(props: { schema: Json; luts: string[]; value: Json[]; onChange: (v: Json[]) => void }) {
  const kinds = filterSchemas(props.schema);
  const [adding, setAdding] = useState(kinds[0]?.properties?.type?.const ?? "color");
  const list = props.value ?? [];
  const max: number = props.schema?.properties?.photo?.properties?.filters?.maxItems ?? 12;

  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    const copy = list.slice();
    [copy[i], copy[j]] = [copy[j], copy[i]];
    props.onChange(copy);
  };

  return (
    <fieldset className="schema-object">
      <legend>Filtros (aplicados de cima para baixo)</legend>
      {list.length === 0 && <p className="muted small">Nenhum filtro: cores originais.</p>}
      <ol className="filter-list">
        {list.map((f, i) => {
          const node = kinds.find((k) => k.properties?.type?.const === f.type);
          return (
            <li key={i} className="filter-item">
              <div className="filter-head">
                <strong>{node?.title ?? f.type}</strong>
                {SAMPLE_ONLY.has(f.type) && <span className="tag">só na amostra</span>}
                <span className="grow" />
                <button className="icon" aria-label="Subir filtro" disabled={i === 0} onClick={() => move(i, -1)}>
                  ↑
                </button>
                <button className="icon" aria-label="Descer filtro" disabled={i === list.length - 1} onClick={() => move(i, 1)}>
                  ↓
                </button>
                <button className="icon" aria-label="Remover filtro" onClick={() => props.onChange(list.filter((_, j) => j !== i))}>
                  ✕
                </button>
              </div>
              {f.type === "lut" ? (
                <label className="field">
                  <span className="field-label">Arquivo LUT</span>
                  <select value={f.file ?? ""} onChange={(e) => props.onChange(list.map((x, j) => (j === i ? { ...x, file: e.target.value } : x)))}>
                    {props.luts.map((l) => (
                      <option key={l} value={l}>
                        {l}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <SchemaField
                  name={f.type}
                  node={node}
                  value={f}
                  flat
                  onChange={(v) => props.onChange(list.map((x, j) => (j === i ? { ...v, type: f.type } : x)))}
                />
              )}
            </li>
          );
        })}
      </ol>
      <div className="row">
        <label className="grow">
          Adicionar filtro
          <select value={adding} onChange={(e) => setAdding(e.target.value)}>
            {kinds.map((k) => {
              const t = k.properties?.type?.const as string;
              return (
                <option key={t} value={t} disabled={t === "lut" && props.luts.length === 0}>
                  {k.title}
                  {SAMPLE_ONLY.has(t) ? " (só na amostra)" : ""}
                </option>
              );
            })}
          </select>
        </label>
        <button disabled={list.length >= max} onClick={() => props.onChange([...list, newFilter(props.schema, adding, props.luts)])}>
          Adicionar
        </button>
      </div>
    </fieldset>
  );
}

/** Transições: uma lista (uma só = sempre a mesma), em rodízio ou sorteio, e a duração. */
export function TransitionsEditor(props: { node: Json; value: Json; onChange: (v: Json) => void }) {
  const all: string[] = props.node?.properties?.types?.items?.enum ?? [];
  const value = props.value ?? {};
  const types: string[] = value.types ?? (value.type ? [value.type] : ["fade"]);
  const [adding, setAdding] = useState(all.find((t) => !types.includes(t)) ?? "fade");
  // O editor sempre grava a lista ("types"); uma lista de um item equivale a "type".
  const set = (patch: Json) => {
    const next = { ...value, ...patch };
    delete next.type;
    props.onChange(next);
  };
  return (
    <div className="fields">
      <div className="field">
        <span className="field-label">Tipos de transição</span>
        <div className="chips">
          {types.map((t) => (
            <span key={t} className="chip">
              {t}
              <button aria-label={`Tirar ${t}`} disabled={types.length === 1} onClick={() => set({ types: types.filter((x) => x !== t) })}>
                ✕
              </button>
            </span>
          ))}
        </div>
        <div className="row">
          <select className="grow" value={adding} onChange={(e) => setAdding(e.target.value)} aria-label="Transição para adicionar">
            {all.map((t) => (
              <option key={t} value={t} disabled={types.includes(t)}>
                {t}
              </option>
            ))}
          </select>
          <button disabled={types.includes(adding) || types.length >= 20} onClick={() => set({ types: [...types, adding] })}>
            Adicionar
          </button>
        </div>
        <span className="muted small">A prévia rápida mostra todas como dissolver; a amostra real mostra cada uma.</span>
      </div>
      {types.length > 1 && (
        <SchemaField name="order" node={props.node.properties.order} value={value.order} onChange={(v) => set({ order: v })} />
      )}
      {types.length > 1 && value.order === "random" && (
        <SchemaField name="seed" node={props.node.properties.seed} value={value.seed} onChange={(v) => set({ seed: v })} />
      )}
      <SchemaField name="duration" node={props.node.properties.duration} value={value.duration} onChange={(v) => set({ duration: v })} />
      <p className="muted small">Passagens que tocam um cartão de logo são sempre dissolvidas ({label("fade")}).</p>
    </div>
  );
}
