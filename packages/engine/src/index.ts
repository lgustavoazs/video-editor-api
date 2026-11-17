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
export { availableFilters, probe, probeClip, type ClipInfo } from "./ffmpeg.js";
export { MAX_CLIP_SIDE, MAX_CLIPS, MIN_CLIP_SECONDS, resolveClipRange } from "./clip.js";
export type { Focus } from "./prepare.js";
export {
  defaultThreads,
  MAX_ITEMS,
  planRender,
  renderVideo,
  type PlanRequest,
  type RenderItem,
  type RenderPlan,
  type RenderRequest,
  type RenderResult,
} from "./render.js";
export { ENGINE_ASSETS, PRESETS_DIR, REPO_ROOT, TEST_ASSETS_DIR } from "./cli/paths.js";
export { makeTestAssets, type TestClips } from "./cli/make-test-assets.js";
export { listPresetFiles } from "./preset.js";
