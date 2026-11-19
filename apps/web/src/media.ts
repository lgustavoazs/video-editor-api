/** Leitura de dimensões e duração no navegador, e conversão de HEIC. */

export function imageSize(url: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error("Não foi possível abrir a imagem"));
    img.src = url;
  });
}

export function videoInfo(url: string): Promise<{ width: number; height: number; duration: number }> {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    v.onloadedmetadata = () => resolve({ width: v.videoWidth, height: v.videoHeight, duration: v.duration });
    v.onerror = () => reject(new Error("Não foi possível abrir o vídeo neste navegador"));
    v.src = url;
  });
}

export function audioDuration(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const a = document.createElement("audio");
    a.preload = "metadata";
    a.onloadedmetadata = () => resolve(a.duration);
    a.onerror = () => reject(new Error("Não foi possível abrir o áudio neste navegador"));
    a.src = url;
  });
}

/**
 * Converte HEIC/HEIF (padrão do iPhone) em JPEG. A biblioteca (LGPL) é carregada
 * só quando aparece um arquivo HEIC, como um arquivo separado.
 */
export async function heicToJpeg(file: File): Promise<File> {
  const { heicTo } = await import("heic-to/csp");
  const blob = await heicTo({ blob: file, type: "image/jpeg", quality: 0.92 });
  const name = file.name.replace(/\.(heic|heif)$/i, "") + ".jpg";
  return new File([blob], name, { type: "image/jpeg", lastModified: file.lastModified });
}
