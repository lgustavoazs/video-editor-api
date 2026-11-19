import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { rectSortingStrategy, SortableContext, sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useRef, useState, type DragEvent } from "react";
import { classify, formatTime, moveItem, naturalSort, type DraftItem } from "./lib.ts";
import { heicToJpeg, imageSize, videoInfo } from "./media.ts";

interface Props {
  items: DraftItem[];
  onChange: (items: DraftItem[]) => void;
  onEdit: (id: string) => void;
}

/** Fotos e clipes: adicionar, ordenar arrastando, remover e abrir o ajuste de cada um. */
export function ItemsPanel({ items, onChange, onEdit }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState("");
  const [problems, setProblems] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    // No celular: segurar um instante antes de arrastar, para a página continuar rolando.
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  async function addFiles(list: FileList | File[]) {
    const files = naturalSort(Array.from(list));
    const added: DraftItem[] = [];
    const errors: string[] = [];
    for (const [i, original] of files.entries()) {
      let file = original;
      let kind = classify(file);
      try {
        if (kind === "heic") {
          setBusy(`Convertendo foto do iPhone (${i + 1} de ${files.length})…`);
          file = await heicToJpeg(file);
          kind = "photo";
        } else {
          setBusy(`Lendo arquivos (${i + 1} de ${files.length})…`);
        }
        if (kind === "unknown") {
          errors.push(`${original.name}: formato não aceito (use JPEG, PNG, WebP, HEIC ou vídeo MP4/MOV).`);
          continue;
        }
        const url = URL.createObjectURL(file);
        const base: DraftItem = { id: crypto.randomUUID(), kind, file, url, caption: "", keepAudio: false, volume: 1 };
        if (kind === "photo") {
          const { width, height } = await imageSize(url);
          added.push({ ...base, width, height });
        } else {
          const v = await videoInfo(url);
          added.push({ ...base, width: v.width, height: v.height, sourceDuration: v.duration, start: 0, end: v.duration });
        }
      } catch (err) {
        errors.push(`${original.name}: ${(err as Error).message}`);
      }
    }
    setBusy("");
    setProblems(errors);
    if (added.length) onChange([...items, ...added]);
  }

  function onDragEnd(e: DragEndEvent) {
    if (!e.over || e.active.id === e.over.id) return;
    const from = items.findIndex((i) => i.id === e.active.id);
    const to = items.findIndex((i) => i.id === e.over!.id);
    onChange(moveItem(items, from, to));
  }

  function remove(id: string) {
    const it = items.find((i) => i.id === id);
    if (it) URL.revokeObjectURL(it.url);
    onChange(items.filter((i) => i.id !== id));
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files);
  };

  return (
    <section className="card">
      <div className="section-head">
        <h2>Fotos e clipes</h2>
        <span className="muted small">{items.length ? `${items.length} item(ns)` : ""}</span>
      </div>
      <div
        className={dragOver ? "dropzone over" : "dropzone"}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => input.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && input.current?.click()}
      >
        <strong>Adicionar fotos e clipes</strong>
        <span className="muted small">Toque para escolher ou arraste os arquivos para cá</span>
      </div>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        // Sem image/heic: assim o iPhone já entrega JPEG. HEIC arrastado no computador é convertido aqui.
        accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm,video/*"
        onChange={(e) => {
          if (e.target.files?.length) void addFiles(e.target.files);
          e.target.value = "";
        }}
      />
      {busy && <p className="muted small">{busy}</p>}
      {problems.map((p) => (
        <p key={p} className="error small">
          {p}
        </p>
      ))}
      {items.length > 0 && (
        <>
          <p className="muted small hint">
            A ordem abaixo é a ordem do vídeo. Arraste para mudar (no celular, segure um instante antes) ou use as setas.
            Toque num item para ajustar o corte, a legenda ou o trecho do clipe.
          </p>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={items.map((i) => i.id)} strategy={rectSortingStrategy}>
              <ol className="grid">
                {items.map((it, index) => (
                  <Tile
                    key={it.id}
                    item={it}
                    index={index}
                    last={index === items.length - 1}
                    onEdit={() => onEdit(it.id)}
                    onRemove={() => remove(it.id)}
                    onMove={(delta) => onChange(moveItem(items, index, index + delta))}
                  />
                ))}
              </ol>
            </SortableContext>
          </DndContext>
        </>
      )}
    </section>
  );
}

function Tile(props: {
  item: DraftItem;
  index: number;
  last: boolean;
  onEdit: () => void;
  onRemove: () => void;
  onMove: (delta: number) => void;
}) {
  const { item, index } = props;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
  const style = { transform: CSS.Transform.toString(transform), transition };
  const clipLength = item.kind === "clip" ? (item.end ?? 0) - (item.start ?? 0) : 0;
  return (
    <li ref={setNodeRef} style={style} className={isDragging ? "tile dragging" : "tile"}>
      <div className="thumb" {...attributes} {...listeners} onClick={props.onEdit} aria-label={`Item ${index + 1}: ${item.file.name}`}>
        {item.kind === "photo" ? (
          <img src={item.url} alt="" draggable={false} />
        ) : (
          <video src={`${item.url}#t=${item.start ?? 0}`} muted playsInline preload="metadata" />
        )}
        <span className="badge">{index + 1}</span>
        {item.kind === "clip" && (
          <span className="badge right">
            ▶ {formatTime(clipLength, 0)}
            {item.keepAudio ? " 🔊" : ""}
          </span>
        )}
        {item.caption && <span className="caption-flag">Aa</span>}
      </div>
      <div className="tile-actions">
        <button className="icon" title="Mover para trás" aria-label="Mover para trás" disabled={index === 0} onClick={() => props.onMove(-1)}>
          ←
        </button>
        <button className="icon" title="Ajustar" aria-label="Ajustar" onClick={props.onEdit}>
          ✎
        </button>
        <button className="icon" title="Remover" aria-label="Remover" onClick={props.onRemove}>
          ✕
        </button>
        <button className="icon" title="Mover para frente" aria-label="Mover para frente" disabled={props.last} onClick={() => props.onMove(1)}>
          →
        </button>
      </div>
    </li>
  );
}
