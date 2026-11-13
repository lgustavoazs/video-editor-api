export { EngineError } from "./errors.js";
export { loadPreset, parsePreset, type Preset, type PhotoFilter } from "./preset.js";
export { getPlatform, listPlatforms, type PlatformProfile } from "./platforms.js";
export {
  computeTiming,
  parseTime,
  resolveAudioSegment,
  type AudioSegment,
  type AudioSegmentInput,
  type TimingResult,
} from "./timing.js";
export { buildFiltergraph } from "./filtergraph.js";
export { probe } from "./ffmpeg.js";
export { renderVideo, MAX_PHOTOS, type RenderRequest, type RenderResult } from "./render.js";
