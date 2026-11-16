export { EngineError } from "./errors.js";
export { presetSchema } from "./schema.js";
export {
  loadPreset,
  mergePreset,
  parsePreset,
  type CardConfig,
  type LogoRole,
  type PhotoFilter,
  type Preset,
  type TextStyle,
  type TitleStyle,
  type WatermarkConfig,
} from "./preset.js";
export { getPlatform, listPlatforms, type PlatformProfile, type SafeZone } from "./platforms.js";
export {
  ALL_TRANSITIONS,
  pickTransitions,
  supportedTransitions,
  type TransitionConfig,
  type TransitionName,
} from "./transitions.js";
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
export type { Focus } from "./prepare.js";
export { renderVideo, MAX_ITEMS, type RenderItem, type RenderRequest, type RenderResult } from "./render.js";
