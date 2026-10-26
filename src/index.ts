// Public surface of the module for the rest of ReelScript AI.
export { createReelIngest, InputError, type ImportRequest, type ImportStatusView, type ReelIngest } from './module.js';
export { buildServer } from './api/server.js';
export { loadConfig, type Config } from './config.js';
export { analyzePerformance, type PerformanceSummary } from './analytics/performance.js';
export { extractContentFeatures, type ContentFeatures } from './analytics/content.js';
export { buildProfileReport, type ProfileReport, type Hypothesis } from './analytics/report.js';
export type * from './providers/types.js';
export type { ReelView } from './repository.js';
