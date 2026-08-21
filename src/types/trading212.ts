import type { ActivityImport } from '@wealthfolio/addon-sdk';

export type ActivityImportWithIsin = ActivityImport & {
  // Wealthfolio 3.6.2's Rust ActivityImport wire model requires these fields
  // even though the SDK declaration currently marks several as optional.
  date: string;
  symbol: string;
  currency: string;
  isin?: string;
};

export interface Trading212Instrument {
  currency?: string;
  isin?: string;
  name?: string;
  ticker?: string;
  type?: string;
}

export interface Trading212Tax {
  chargedAt?: string;
  currency?: string;
  name?: string;
  quantity?: number;
}

export interface Trading212FillWalletImpact {
  currency?: string;
  fxRate?: number;
  netValue?: number;
  realisedProfitLoss?: number;
  taxes?: Trading212Tax[];
}

export interface Trading212Fill {
  filledAt?: string;
  id?: number | string;
  price?: number;
  quantity?: number;
  type?: string;
  walletImpact?: Trading212FillWalletImpact;
}

export interface Trading212Order {
  createdAt?: string;
  currency?: string;
  id?: number | string;
  instrument?: Trading212Instrument;
  side?: 'BUY' | 'SELL' | string;
  status?: string;
  ticker?: string;
}

export interface Trading212HistoricalOrder {
  fill?: Trading212Fill;
  order?: Trading212Order;
}

export interface Trading212Dividend {
  amount?: number;
  currency?: string;
  grossAmountPerShare?: number;
  instrument?: Trading212Instrument;
  paidOn?: string;
  quantity?: number;
  reference?: string;
  ticker?: string;
  tickerCurrency?: string;
  type?: string;
}

export interface Trading212Transaction {
  amount?: number;
  currency?: string;
  dateTime?: string;
  reference?: string;
  type?: string;
}

export interface Trading212Page<T> {
  items?: T[];
  nextPagePath?: string | null;
}

export interface Trading212AccountSummary {
  id?: number | string;
  currency?: string;
  totalValue?: number;
  cash?: {
    availableToTrade?: number;
    inPies?: number;
    reservedForOrders?: number;
  };
}

export interface Trading212Position {
  instrument?: Trading212Instrument;
  quantity?: number;
}

export interface AssetBinding {
  assetId: string;
  symbol: string;
  name?: string;
  exchangeMic?: string;
  currency?: string;
  isin?: string;
  instrumentKey?: string;
}

export interface MappingContext {
  accountId: string;
  remoteAccountFingerprint: string;
  accountCurrency: string;
  assetsById: Map<string, AssetBinding>;
  /** Run-local identities verified by native save results; never persisted as a UUID map. */
  resolvedAssetIdsByInstrument: Map<string, string>;
}

export type StreamName = 'orders' | 'dividends' | 'transactions' | 'portfolio';

export interface MappedActivity {
  stream: StreamName;
  remoteKey: string;
  remoteDate: string;
  signature: string;
  activity: ActivityImportWithIsin;
  /**
   * Stable Trading 212 security identity. Cash rows intentionally omit it.
   * Wealthfolio may add an assetId during checkImport; this identity lets the
   * controller prove that every row for one remote security resolved the same
   * way without keeping a user-maintained UUID mapping.
   */
  instrumentIdentity?: string;
  remoteInstrument?: {
    ticker: string;
    isin: string;
    currency: string;
    name?: string;
    type?: string;
  };
}

export interface PendingEvent {
  stream: StreamName;
  remoteKey: string;
  remoteDate?: string;
  reason: string;
  blocksAutomaticImport?: boolean;
  /**
   * A history row that was previously verified and persisted may use its
   * exact local source identity when Trading 212 later omits enrichment fields.
   * New/unpersisted rows never receive this exception.
   */
  persistedHistoryFallbackAllowed?: boolean;
  assetMapping?: {
    instrumentIdentity: string;
    remoteTicker?: string;
    remoteIsin?: string;
    remoteCurrency?: string;
    remoteName?: string;
    suggestedAssetId?: string;
    suggestedAssetSymbol?: string;
    suggestedAssetName?: string;
    suggestedExchangeMic?: string;
    suggestedCurrency?: string;
  };
}

export interface MappingResult {
  mapped?: MappedActivity;
  pending?: PendingEvent;
}

export interface SeenEntry {
  signature: string;
  seenAt: string;
}

export interface ReconciliationResult {
  complete: boolean;
  remoteCash?: number;
  localCash?: number;
  cashDifference?: number;
  remotePositionCount: number;
  positionDifferences: Array<{
    symbol: string;
    remote: number;
    local: number;
  }>;
}

export interface SyncRunSummary {
  mode: 'preview' | 'import';
  historyStartAt?: string;
  streamCoverage?: Record<'orders' | 'dividends' | 'transactions', {
    fetched: number;
    earliestAt?: string;
    latestAt?: string;
  }>;
  mappedTypeCounts?: Record<string, number>;
  fetched: number;
  beforeBaseline: number;
  alreadySeen: number;
  duplicates: number;
  valid: number;
  imported: number;
  pendingTotal: number;
  mappingPendingTotal: number;
  pending: PendingEvent[];
  completedAt: string;
  reconciliation?: ReconciliationResult;
  autoPaused?: boolean;
  autoPauseReason?: string;
}

export interface BaselineProposal {
  accountId: string;
  baselineAt: string;
  localActivityCount: number;
}

export interface ControllerState {
  initialized: boolean;
  configured: boolean;
  autoEnabled: boolean;
  syncing: boolean;
  accounts: Array<{
    id: string;
    name: string;
    currency: string;
    trackingMode: string;
  }>;
  accountId?: string;
  remoteAccountFingerprint?: string;
  baselineAt?: string;
  baselineConfirmed?: boolean;
  isaConfirmed?: boolean;
  availableAssets?: AssetBinding[];
  lastSuccessfulSyncAt?: string;
  nextSyncAt?: string;
  lastSummary?: SyncRunSummary;
  lastError?: string;
}
