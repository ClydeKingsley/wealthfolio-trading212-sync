export const TRADING212_ORIGIN = 'https://live.trading212.com';
export const TRADING212_AUTH_SECRET = 'trading212-basic-auth';
export const TRADING212_CANDIDATE_AUTH_SECRET = 'trading212-candidate-basic-auth';
// Internal no-cutoff marker. It is never sent as a Trading 212 `time` query;
// history always starts with the API's documented limit-only first request.
export const FULL_HISTORY_START_AT = '1900-01-01T00:00:00.000Z';
export const SYNC_INTERVAL_MS = 5 * 60 * 1000;
export const HISTORY_PAGE_DELAY_MS = 10_500;
export const MAX_HISTORY_PAGES = 20;
export const SEEN_SHARD_COUNT = 16;
export const MAX_SEEN_RECORDS_PER_SHARD = 1_000;
export const TRADE_RECONCILIATION_TOLERANCE = 0.02;
export const POSITION_TOLERANCE = 0.00000001;

export const STORAGE_KEYS = {
  configured: 'config.credentials-configured',
  accountId: 'config.account-id',
  remoteAccountFingerprint: 'config.trading212-account-fingerprint',
  bindingUpdateInProgress: 'config.binding-update-in-progress',
  credentialCleanupBlocked: 'config.credential-cleanup-blocked',
  fullHistoryResetInProgress: 'config.full-history-reset-in-progress',
  baselineConfirmation: 'config.baseline-confirmation',
  isaConfirmed: 'config.isa-confirmed',
  // Cleanup-only key from 0.1.7. New versions never read or write UUID maps.
  legacyAssetBindings: 'config.asset-bindings',
  autoEnabled: 'config.auto-enabled',
  baselineAt: 'sync.baseline-at',
  lastSuccessfulSyncAt: 'sync.last-success-at',
  reconciliationBlocked: 'sync.reconciliation-blocked',
  importInProgress: 'sync.import-in-progress',
  seenShardPrefix: 'sync.seen-records.',
  lastSummary: 'sync.last-summary',
} as const;
