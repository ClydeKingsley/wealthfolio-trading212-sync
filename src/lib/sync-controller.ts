import type {
  Account,
  Activity,
  ActivityBulkMutationResult,
  ActivityCreate,
  ActivityDetails,
  ActivityImport,
  AddonContext,
  Asset,
  Holding,
  SymbolSearchResult,
} from '@wealthfolio/addon-sdk';
import {
  FULL_HISTORY_START_AT,
  MAX_SEEN_RECORDS_PER_SHARD,
  POSITION_TOLERANCE,
  SEEN_SHARD_COUNT,
  STORAGE_KEYS,
  SYNC_INTERVAL_MS,
  TRADING212_AUTH_SECRET,
  TRADING212_CANDIDATE_AUTH_SECRET,
} from './constants';
import {
  extractDividendDate,
  extractOrderDate,
  extractTransactionDate,
  mapDividend,
  mappedActivitySeenSignature,
  mappedActivitySignature,
  mapOrder,
  mapTransaction,
  resolveMappedAsset,
  reviewPositionInstrument,
  trading212InstrumentIdentity,
} from './mapping';
import { Trading212Api } from './trading212-api';
import type {
  AssetBinding,
  BaselineProposal,
  ControllerState,
  MappedActivity,
  MappingContext,
  MappingResult,
  PendingEvent,
  ReconciliationResult,
  SeenEntry,
  SyncRunSummary,
  Trading212AccountSummary,
  Trading212Dividend,
  Trading212HistoricalOrder,
  Trading212Instrument,
  Trading212Position,
} from '../types/trading212';
import {
  decimalString,
  encodeBasicCredentials,
  formatError,
  normalizeCurrency,
  sha256Hex,
  sleep,
  stableHash,
} from './utils';

type Listener = (state: ControllerState) => void;

interface SeenCache {
  entries: Record<string, SeenEntry>;
  shards: Map<number, Record<string, SeenEntry>>;
}

interface BaselineConfirmation {
  accountId: string;
  baselineAt: string;
}

interface NativeMarketIdentityBase {
  symbol: string;
  name: string;
  exchangeMic: string;
  quoteCcy: string;
  instrumentType: 'EQUITY';
  resolutionMethod: 'symbol' | 'isin';
}

type NativeMarketIdentity = NativeMarketIdentityBase &
  (
    | {
        kind: 'existing';
        assetId: string;
        providerId?: string;
        providerSymbol?: string;
      }
    | {
        kind: 'new';
        providerId: string;
        providerSymbol: string;
      }
  );

type SyncActivityCreate = ActivityCreate & {
  sourceSystem: 'TRADING212';
  sourceRecordId: string;
  idempotencyKey: string;
  needsReview: false;
};

type ImportLedgerAssetExpectation =
  | { kind: 'cash' }
  | {
      kind: 'existing';
      assetId: string;
      identity: string;
      symbol: string;
      exchangeMic: string;
      quoteCcy: string;
    }
  | {
      kind: 'new';
      identity: string;
      symbol: string;
      exchangeMic: string;
      quoteCcy: string;
    };

interface ImportLedgerEntryV3 {
  tempId: string;
  remoteKey: string;
  signature: string;
  idempotencyKey: string;
  payloadDigest: string;
  asset: ImportLedgerAssetExpectation;
}

interface ImportLedgerV3 {
  schemaVersion: 3;
  phase: 'prepared' | 'write-attempted' | 'committed';
  accountId: string;
  remoteAccountFingerprint: string;
  startedAt: string;
  candidateCount: number;
  candidates: ImportLedgerEntryV3[];
  batchFingerprint: string;
  committedMappings?: Array<{ tempId: string; activityId: string }>;
}

export class SyncController {
  private readonly api: Trading212Api;
  private readonly listeners = new Set<Listener>();
  private timerId?: number;
  private startupId?: number;
  private activeRun?: Promise<SyncRunSummary>;
  private activeRunMode?: 'preview' | 'full-preview' | 'import';
  private disposed = false;
  private state: ControllerState = {
    initialized: false,
    configured: false,
    autoEnabled: false,
    syncing: false,
    accounts: [],
  };

  constructor(private readonly ctx: AddonContext) {
    this.api = new Trading212Api(ctx);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => this.listeners.delete(listener);
  }

  getState(): ControllerState {
    return structuredClone(this.state);
  }

  async initialize(): Promise<void> {
    if (this.state.initialized) return;
    let candidateCleanupFailed = false;
    try {
      await this.clearCandidateCredential();
    } catch {
      candidateCleanupFailed = true;
      this.ctx.api.logger.error('Trading 212 temporary credential cleanup failed during startup.');
    }
    try {
      await this.ctx.api.storage.delete(STORAGE_KEYS.legacyAssetBindings);
      const [
        accounts,
        configured,
        accountId,
        remoteAccountFingerprint,
        bindingUpdateInProgress,
        fullHistoryResetInProgress,
        baselineConfirmationValue,
        isaConfirmedValue,
        autoEnabled,
        baselineAt,
        lastSuccessfulSyncAt,
        reconciliationBlocked,
        importInProgress,
        lastSummary,
      ] =
        await Promise.all([
          this.ctx.api.accounts.getAll(),
          this.ctx.api.storage.get(STORAGE_KEYS.configured),
          this.ctx.api.storage.get(STORAGE_KEYS.accountId),
          this.ctx.api.storage.get(STORAGE_KEYS.remoteAccountFingerprint),
          this.ctx.api.storage.get(STORAGE_KEYS.bindingUpdateInProgress),
          this.ctx.api.storage.get(STORAGE_KEYS.fullHistoryResetInProgress),
          this.ctx.api.storage.get(STORAGE_KEYS.baselineConfirmation),
          this.ctx.api.storage.get(STORAGE_KEYS.isaConfirmed),
          this.ctx.api.storage.get(STORAGE_KEYS.autoEnabled),
          this.ctx.api.storage.get(STORAGE_KEYS.baselineAt),
          this.ctx.api.storage.get(STORAGE_KEYS.lastSuccessfulSyncAt),
          this.ctx.api.storage.get(STORAGE_KEYS.reconciliationBlocked),
          this.ctx.api.storage.get(STORAGE_KEYS.importInProgress),
          this.ctx.api.storage.get(STORAGE_KEYS.lastSummary),
        ]);

      const eligibleAccounts = accounts
        .filter((account) => account.accountType === 'SECURITIES' && account.isActive && !account.isArchived)
        .map(toStateAccount);
      const wasConfigured = configured === 'true';
      const boundAccount = eligibleAccounts.find((account) => account.id === accountId);
      let effectiveBaselineAt = baselineAt ?? undefined;
      let baselineConfirmation = parseJson<BaselineConfirmation>(baselineConfirmationValue);
      const isaConfirmed = isaConfirmedValue === 'true';
      // Versions before 0.1.10 stored a user-data-derived cutoff here. That
      // cutoff is obsolete: every history run now starts from Trading 212's
      // first limit-only page. Migrate the saved marker during startup so an
      // upgrade cannot keep silently excluding older activity.
      if (
        wasConfigured &&
        accountId &&
        boundAccount &&
        remoteAccountFingerprint &&
        isaConfirmed &&
        (effectiveBaselineAt !== FULL_HISTORY_START_AT ||
          baselineConfirmation?.accountId !== accountId ||
          baselineConfirmation.baselineAt !== FULL_HISTORY_START_AT)
      ) {
        baselineConfirmation = { accountId, baselineAt: FULL_HISTORY_START_AT };
        await Promise.all([
          this.ctx.api.storage.set(STORAGE_KEYS.baselineAt, FULL_HISTORY_START_AT),
          this.ctx.api.storage.set(
            STORAGE_KEYS.baselineConfirmation,
            JSON.stringify(baselineConfirmation),
          ),
        ]);
        effectiveBaselineAt = FULL_HISTORY_START_AT;
      }
      const baselineConfirmed = Boolean(
        accountId &&
          effectiveBaselineAt &&
          baselineConfirmation?.accountId === accountId &&
          baselineConfirmation.baselineAt === effectiveBaselineAt,
      );
      const parsedSummary = parseJson<SyncRunSummary>(lastSummary) ?? undefined;
      const priorReconciliationFailed = Boolean(
        parsedSummary?.mode === 'import' &&
          parsedSummary.reconciliation &&
          !parsedSummary.reconciliation.complete,
      );
      const priorRunAutoPaused = parsedSummary?.autoPaused === true;
      const uncertainImport = Boolean(importInProgress);
      const invalidBinding =
        bindingUpdateInProgress === 'true' ||
        (wasConfigured &&
          (!boundAccount ||
            !remoteAccountFingerprint ||
            !isaConfirmed ||
            boundAccount.trackingMode !== 'TRANSACTIONS'));
      const mustStopAuto =
        candidateCleanupFailed ||
        invalidBinding ||
        fullHistoryResetInProgress === 'true' ||
        !baselineConfirmed ||
        uncertainImport ||
        reconciliationBlocked === 'true' ||
        priorRunAutoPaused ||
        priorReconciliationFailed;
      if (mustStopAuto) {
        const writes = [this.ctx.api.storage.set(STORAGE_KEYS.autoEnabled, 'false')];
        if (invalidBinding) writes.push(this.ctx.api.storage.set(STORAGE_KEYS.configured, 'false'));
        if (uncertainImport) {
          writes.push(this.ctx.api.storage.set(STORAGE_KEYS.reconciliationBlocked, 'true'));
        }
        await Promise.all(writes);
      }
      const effectiveConfigured = wasConfigured && !invalidBinding;
      const preferred = effectiveConfigured
        ? boundAccount
        : eligibleAccounts.find((account) => /trading\s*212/i.test(account.name)) ??
          eligibleAccounts[0];

      this.patchState({
        initialized: true,
        configured: effectiveConfigured,
        autoEnabled: autoEnabled === 'true' && !mustStopAuto && effectiveConfigured,
        accounts: eligibleAccounts,
        accountId: preferred?.id,
        remoteAccountFingerprint: remoteAccountFingerprint ?? undefined,
        baselineAt: effectiveBaselineAt,
        baselineConfirmed,
        isaConfirmed,
        availableAssets: [],
        lastSuccessfulSyncAt: lastSuccessfulSyncAt ?? undefined,
        lastSummary: parsedSummary,
        lastError: candidateCleanupFailed
          ? 'Temporary Trading 212 credentials could not be cleaned up. Use “Delete local credentials” and retry.'
          : invalidBinding
            ? 'The previous binding is incomplete or unsafe; automatic sync was stopped. Delete local credentials and reconnect.'
            : fullHistoryResetInProgress === 'true'
              ? 'A full-history reset did not finish. Automatic sync is paused; run the read-only full-history audit again before retrying the reset.'
            : uncertainImport
              ? 'A previous Wealthfolio import did not finish its safety checks. Automatic sync is paused; review the account and run “Sync now” manually.'
            : reconciliationBlocked === 'true' || priorReconciliationFailed
              ? 'Automatic sync remains paused because the last holdings/cash reconciliation did not match.'
              : priorRunAutoPaused
                ? parsedSummary?.autoPauseReason ?? 'Automatic sync remains paused after the previous safety stop.'
              : !baselineConfirmed && effectiveConfigured
                ? 'Automatic sync is blocked until full-history mode is verified.'
                : undefined,
      });
      this.startTimer();

      if (this.state.configured && this.state.autoEnabled && this.state.accountId) {
        this.startupId = window.setTimeout(() => {
          void this.syncNow().catch(() => undefined);
        }, 1_500);
      }
    } catch (error) {
      this.patchState({ initialized: true, lastError: formatError(error) });
    }
  }

  async getBaselineProposal(accountId: string): Promise<BaselineProposal> {
    const selectedAccount = this.state.accounts.find((candidate) => candidate.id === accountId);
    if (!selectedAccount) throw new Error('The selected Wealthfolio account no longer exists.');
    const activities = await this.ctx.api.activities.getAll(accountId);
    return {
      accountId,
      baselineAt: FULL_HISTORY_START_AT,
      localActivityCount: activities.length,
    };
  }

  async configure(
    accountId: string,
    apiKey: string,
    apiSecret: string,
    confirmedBaselineAt: string,
    isaAccountConfirmed: boolean,
  ): Promise<SyncRunSummary> {
    if (!accountId) throw new Error('Select a Wealthfolio account.');
    const selectedAccount = this.state.accounts.find((candidate) => candidate.id === accountId);
    if (!selectedAccount) throw new Error('The selected Wealthfolio account no longer exists.');
    if (selectedAccount.trackingMode !== 'TRANSACTIONS') {
      throw new Error('Trading 212 sync requires a Wealthfolio account in Transactions tracking mode.');
    }
    if (!apiKey.trim() || !apiSecret.trim()) {
      throw new Error('Enter both the Trading 212 API key and secret.');
    }
    if (!isaAccountConfirmed) {
      throw new Error('Confirm that the API key was created inside the Trading 212 Stocks & Shares ISA account.');
    }
    const initialProposal = await this.getBaselineProposal(accountId);
    if (initialProposal.baselineAt !== confirmedBaselineAt) {
      throw new Error('The full-history start marker is invalid. Refresh the add-on before connecting.');
    }
    if (initialProposal.localActivityCount !== 0) {
      throw new Error(
        `The selected Wealthfolio account already contains ${initialProposal.localActivityCount} activities. Use a new empty Transactions account for a full Trading 212 rebuild.`,
      );
    }
    if (this.state.syncing) throw new Error('Another Trading 212 operation is already running.');
    if (
      (await this.ctx.api.storage.get(STORAGE_KEYS.credentialCleanupBlocked)) === 'true'
    ) {
      throw new Error(
        'Temporary Trading 212 credentials could not be cleared. Delete local credentials and retry before reconnecting.',
      );
    }
    if (await this.ctx.api.storage.get(STORAGE_KEYS.importInProgress)) {
      throw new Error(
        'A previous Wealthfolio import is awaiting manual recovery. Use “Sync now” or delete local credentials before reconnecting.',
      );
    }

    const encoded = encodeBasicCredentials(apiKey, apiSecret);
    this.patchState({ syncing: true, lastError: undefined });
    let commitStarted = false;
    let commitComplete = false;

    try {
      await this.ctx.api.secrets.set(TRADING212_CANDIDATE_AUTH_SECRET, encoded);
      const candidateApi = new Trading212Api(this.ctx, TRADING212_CANDIDATE_AUTH_SECRET);
      const remote = await candidateApi.getAccountSummary();
      await candidateApi.probeReadAccess();
      const remoteCurrency = normalizeCurrency(remote.currency);
      if (!remoteCurrency) {
        throw new Error('Trading 212 did not return a primary account currency.');
      }
      if (remoteCurrency !== normalizeCurrency(selectedAccount.currency)) {
        throw new Error(
          `Currency mismatch: Trading 212 is ${remote.currency}, Wealthfolio is ${selectedAccount.currency}.`,
        );
      }
      const remoteAccountId = String(remote.id ?? '').trim();
      if (!remoteAccountId) {
        throw new Error('Trading 212 did not return a stable account ID.');
      }
      const remoteAccountFingerprint = await sha256Hex(remoteAccountId);

      const [previousAccountId, previousRemoteAccountFingerprint] = await Promise.all([
        this.ctx.api.storage.get(STORAGE_KEYS.accountId),
        this.ctx.api.storage.get(STORAGE_KEYS.remoteAccountFingerprint),
      ]);
      if (previousAccountId && previousAccountId !== accountId) {
        throw new Error(
          'This sync profile is already bound to another Wealthfolio account. Delete local credentials before changing the target account.',
        );
      }
      if (
        previousRemoteAccountFingerprint &&
        previousRemoteAccountFingerprint !== remoteAccountFingerprint
      ) {
        throw new Error(
          'This sync profile is already bound to a different Trading 212 account.',
        );
      }
      const latestProposal = await this.getBaselineProposal(accountId);
      if (latestProposal.baselineAt !== confirmedBaselineAt) {
        throw new Error('The full-history start marker changed while connecting. Refresh and retry.');
      }

      await this.ctx.api.storage.set(STORAGE_KEYS.bindingUpdateInProgress, 'true');
      commitStarted = true;
      this.patchState({ configured: false, autoEnabled: false });
      await this.ctx.api.storage.set(STORAGE_KEYS.configured, 'false');
      await this.ctx.api.storage.set(STORAGE_KEYS.autoEnabled, 'false');
      await this.ctx.api.storage.set(STORAGE_KEYS.accountId, accountId);
      await this.ctx.api.storage.set(
        STORAGE_KEYS.remoteAccountFingerprint,
        remoteAccountFingerprint,
      );
      await this.ctx.api.storage.set(STORAGE_KEYS.baselineAt, confirmedBaselineAt);
      await this.ctx.api.storage.set(
        STORAGE_KEYS.baselineConfirmation,
        JSON.stringify({ accountId, baselineAt: confirmedBaselineAt } satisfies BaselineConfirmation),
      );
      await this.ctx.api.storage.set(STORAGE_KEYS.isaConfirmed, 'true');
      if (!previousAccountId) {
        await this.clearSeenShards();
        await this.ctx.api.storage.delete(STORAGE_KEYS.lastSuccessfulSyncAt);
        await this.ctx.api.storage.delete(STORAGE_KEYS.lastSummary);
        await this.ctx.api.storage.delete(STORAGE_KEYS.legacyAssetBindings);
      }
      await this.ctx.api.secrets.set(TRADING212_AUTH_SECRET, encoded);
      await this.ctx.api.storage.set(STORAGE_KEYS.configured, 'true');
      await this.ctx.api.storage.delete(STORAGE_KEYS.bindingUpdateInProgress);
      commitComplete = true;
      this.patchState({
        configured: true,
        autoEnabled: false,
        syncing: false,
        accountId,
        remoteAccountFingerprint,
        baselineAt: confirmedBaselineAt,
        baselineConfirmed: true,
        isaConfirmed: true,
        availableAssets: [],
        lastSuccessfulSyncAt: previousAccountId === accountId ? this.state.lastSuccessfulSyncAt : undefined,
        lastError: undefined,
      });
      const firstSync = await this.syncNow();
      if (!firstSync.autoPaused && firstSync.reconciliation?.complete) {
        await this.ctx.api.storage.set(STORAGE_KEYS.autoEnabled, 'true');
        this.patchState({ autoEnabled: true, lastError: undefined });
        this.resetNextSync();
      }
      return firstSync;
    } catch (error) {
      if (commitStarted && !commitComplete) {
        await Promise.allSettled([
          this.ctx.api.storage.set(STORAGE_KEYS.configured, 'false'),
          this.ctx.api.storage.set(STORAGE_KEYS.autoEnabled, 'false'),
        ]);
        this.patchState({ configured: false, autoEnabled: false });
      }
      this.patchState({ lastError: formatError(error) });
      throw error;
    } finally {
      try {
        await this.clearCandidateCredential();
      } catch {
        this.ctx.api.logger.error('Trading 212 temporary credential cleanup failed after configuration.');
        this.patchState({
          autoEnabled: false,
          nextSyncAt: undefined,
          lastError: 'Temporary Trading 212 credentials could not be cleaned up. Use “Delete local credentials” and retry.',
        });
      }
      this.patchState({ syncing: false });
    }
  }

  async setAutoEnabled(enabled: boolean): Promise<void> {
    if (enabled && !this.state.configured) throw new Error('Connect and preview first.');
    if (enabled && (!this.state.baselineConfirmed || !this.state.isaConfirmed)) {
      throw new Error('The ISA account and full-history mode must be verified first.');
    }
    if (
      enabled &&
      (await this.ctx.api.storage.get(STORAGE_KEYS.reconciliationBlocked)) === 'true'
    ) {
      throw new Error('Automatic sync is blocked by a prior reconciliation difference. Run “Sync now” after correcting it.');
    }
    if (
      enabled &&
      (await this.ctx.api.storage.get(STORAGE_KEYS.credentialCleanupBlocked)) === 'true'
    ) {
      throw new Error(
        'Automatic sync is blocked until the temporary Trading 212 credential is confirmed deleted.',
      );
    }
    if (enabled && (await this.ctx.api.storage.get(STORAGE_KEYS.importInProgress))) {
      throw new Error(
        'Automatic sync is blocked by an unfinished import. Review the account and run “Sync now” manually.',
      );
    }
    if (enabled && this.state.baselineAt !== FULL_HISTORY_START_AT) {
      throw new Error('Run the full-history audit and activate full-history mode before enabling automatic sync.');
    }
    await this.ctx.api.storage.set(STORAGE_KEYS.autoEnabled, enabled ? 'true' : 'false');
    this.patchState({ autoEnabled: enabled, lastError: undefined });
    this.resetNextSync();
    if (enabled) {
      try {
        await this.syncNow();
      } catch (error) {
        await this.pauseAuto('Automatic sync was paused because the first synchronized check failed.');
        throw error;
      }
    }
  }

  async preview(): Promise<SyncRunSummary> {
    return this.run(false);
  }

  async previewFullHistory(): Promise<SyncRunSummary> {
    if (!this.state.configured) throw new Error('Trading 212 credentials are not configured.');
    return this.run(false, FULL_HISTORY_START_AT);
  }

  async activateFullHistoryMode(): Promise<void> {
    if (this.state.syncing) throw new Error('Another Trading 212 operation is already running.');
    const accountId = this.state.accountId;
    if (!this.state.configured || !accountId || !this.state.remoteAccountFingerprint) {
      throw new Error('Connect Trading 212 before enabling full-history mode.');
    }
    if (this.state.autoEnabled) {
      throw new Error('Pause automatic sync before enabling full-history mode.');
    }
    if (await this.ctx.api.storage.get(STORAGE_KEYS.importInProgress)) {
      throw new Error('An unfinished Wealthfolio import must be resolved before resetting history.');
    }
    const audit = this.state.lastSummary;
    if (
      audit?.mode !== 'preview' ||
      audit.historyStartAt !== FULL_HISTORY_START_AT ||
      !audit.streamCoverage
    ) {
      throw new Error('Run the read-only full-history audit immediately before resetting history.');
    }
    const localActivities = await this.ctx.api.activities.getAll(accountId);
    if (localActivities.length > 0) {
      throw new Error(
        `The Wealthfolio account still contains ${localActivities.length} activities. Delete them before enabling a from-zero full-history rebuild.`,
      );
    }

    this.patchState({ syncing: true, autoEnabled: false, nextSyncAt: undefined, lastError: undefined });
    await this.ctx.api.storage.set(STORAGE_KEYS.autoEnabled, 'false');
    await this.ctx.api.storage.set(STORAGE_KEYS.fullHistoryResetInProgress, 'true');
    try {
      await this.clearSeenShards();
      await this.ctx.api.storage.set(STORAGE_KEYS.baselineAt, FULL_HISTORY_START_AT);
      await this.ctx.api.storage.set(
        STORAGE_KEYS.baselineConfirmation,
        JSON.stringify({ accountId, baselineAt: FULL_HISTORY_START_AT } satisfies BaselineConfirmation),
      );
      await this.ctx.api.storage.delete(STORAGE_KEYS.lastSuccessfulSyncAt);
      await this.ctx.api.storage.set(STORAGE_KEYS.reconciliationBlocked, 'true');

      const [storedBaselineAt, storedConfirmationValue] = await Promise.all([
        this.ctx.api.storage.get(STORAGE_KEYS.baselineAt),
        this.ctx.api.storage.get(STORAGE_KEYS.baselineConfirmation),
      ]);
      const storedConfirmation = parseJson<BaselineConfirmation>(storedConfirmationValue);
      if (
        storedBaselineAt !== FULL_HISTORY_START_AT ||
        storedConfirmation?.accountId !== accountId ||
        storedConfirmation.baselineAt !== FULL_HISTORY_START_AT
      ) {
        throw new Error('The full-history reset could not be verified after saving.');
      }
      await this.ctx.api.storage.delete(STORAGE_KEYS.fullHistoryResetInProgress);
      this.patchState({
        baselineAt: FULL_HISTORY_START_AT,
        baselineConfirmed: true,
        lastSuccessfulSyncAt: undefined,
      });
    } catch (error) {
      this.patchState({ lastError: formatError(error) });
      throw error;
    } finally {
      this.patchState({ syncing: false });
      this.resetNextSync();
    }
  }

  async syncNow(): Promise<SyncRunSummary> {
    if (!this.state.configured) throw new Error('Trading 212 credentials are not configured.');
    if (this.state.baselineAt !== FULL_HISTORY_START_AT) {
      throw new Error('Run the full-history audit and activate full-history mode before importing.');
    }
    if (!this.state.baselineConfirmed || !this.state.isaConfirmed) {
      throw new Error('The ISA account and full-history mode are not verified.');
    }
    if (
      (await this.ctx.api.storage.get(STORAGE_KEYS.credentialCleanupBlocked)) === 'true'
    ) {
      throw new Error(
        'Synchronization is blocked until the temporary Trading 212 credential is confirmed deleted.',
      );
    }
    return this.run(true);
  }

  async forgetCredentials(): Promise<void> {
    this.patchState({
      configured: false,
      autoEnabled: false,
      baselineConfirmed: false,
      isaConfirmed: false,
      nextSyncAt: undefined,
    });
    await Promise.allSettled([
      this.ctx.api.storage.set(STORAGE_KEYS.bindingUpdateInProgress, 'true'),
      this.ctx.api.storage.set(STORAGE_KEYS.configured, 'false'),
      this.ctx.api.storage.set(STORAGE_KEYS.autoEnabled, 'false'),
    ]);
    let candidateCleanupFailed = false;
    try {
      await this.clearCandidateCredential();
    } catch {
      candidateCleanupFailed = true;
    }
    const results = await Promise.allSettled([
      this.ctx.api.secrets.delete(TRADING212_AUTH_SECRET),
      this.ctx.api.storage.delete(STORAGE_KEYS.accountId),
      this.ctx.api.storage.delete(STORAGE_KEYS.remoteAccountFingerprint),
      this.ctx.api.storage.delete(STORAGE_KEYS.fullHistoryResetInProgress),
      this.ctx.api.storage.delete(STORAGE_KEYS.baselineAt),
      this.ctx.api.storage.delete(STORAGE_KEYS.baselineConfirmation),
      this.ctx.api.storage.delete(STORAGE_KEYS.isaConfirmed),
      this.ctx.api.storage.delete(STORAGE_KEYS.legacyAssetBindings),
      this.ctx.api.storage.delete(STORAGE_KEYS.lastSuccessfulSyncAt),
      this.ctx.api.storage.delete(STORAGE_KEYS.reconciliationBlocked),
      this.ctx.api.storage.delete(STORAGE_KEYS.importInProgress),
      this.ctx.api.storage.delete(STORAGE_KEYS.lastSummary),
      this.clearSeenShards(),
    ]);
    const cleanupFailed =
      candidateCleanupFailed || results.some((result) => result.status === 'rejected');
    if (!cleanupFailed) {
      await this.ctx.api.storage.delete(STORAGE_KEYS.bindingUpdateInProgress);
    }
    this.patchState({
      remoteAccountFingerprint: undefined,
      baselineAt: undefined,
      availableAssets: [],
      lastSuccessfulSyncAt: undefined,
      lastSummary: undefined,
      lastError: cleanupFailed
        ? 'Some local Trading 212 credentials or metadata could not be deleted. Retry this action.'
        : undefined,
    });
    this.resetNextSync();
    if (cleanupFailed) {
      throw new Error('Some local Trading 212 credentials or metadata could not be deleted. Retry this action.');
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timerId !== undefined) window.clearInterval(this.timerId);
    if (this.startupId !== undefined) window.clearTimeout(this.startupId);
    this.listeners.clear();
  }

  private startTimer(): void {
    if (this.timerId !== undefined) return;
    this.timerId = window.setInterval(() => {
      this.resetNextSync();
      if (this.state.configured && this.state.autoEnabled && !this.state.syncing) {
        void this.syncNow().catch(() => undefined);
      }
    }, SYNC_INTERVAL_MS);
    this.resetNextSync();
  }

  private resetNextSync(): void {
    this.patchState({
      nextSyncAt:
        this.state.configured && this.state.autoEnabled
          ? new Date(Date.now() + SYNC_INTERVAL_MS).toISOString()
          : undefined,
    });
  }

  private async attachNativeMarketIdentities(
    results: MappingResult[],
  ): Promise<MappingResult[]> {
    const representativeByIdentity = new Map<string, MappedActivity>();
    for (const result of results) {
      const mapped = result.mapped;
      if (!mapped?.instrumentIdentity || !mapped.remoteInstrument) continue;
      if (!representativeByIdentity.has(mapped.instrumentIdentity)) {
        representativeByIdentity.set(mapped.instrumentIdentity, mapped);
      }
    }

    const resolvedByIdentity = new Map<
      string,
      { identity?: NativeMarketIdentity; problem?: string }
    >();
    await Promise.all(
      [...representativeByIdentity].map(async ([instrumentIdentity, candidate]) => {
        const remote = candidate.remoteInstrument!;
        const remoteType = String(remote.type ?? '').trim().toUpperCase();
        if (remoteType && remoteType !== 'STOCK' && remoteType !== 'ETF') {
          resolvedByIdentity.set(instrumentIdentity, {
            problem: `Trading 212 instrument type ${remoteType || 'UNKNOWN'} is not a supported stock or ETF.`,
          });
          return;
        }

        const query = String(candidate.activity.symbol ?? '').trim();
        if (!query) {
          resolvedByIdentity.set(instrumentIdentity, {
            problem: 'Trading 212 did not yield a canonical security symbol.',
          });
          return;
        }

        const search = async (value: string): Promise<SymbolSearchResult[]> => {
          try {
            return await this.ctx.api.market.searchTicker(value);
          } catch (error) {
            throw new Error(
              `Wealthfolio market lookup failed for ${value}: ${formatError(error)}`,
            );
          }
        };
        const symbolResolution = selectUniqueNativeMarketIdentity(
          candidate,
          await search(query),
        );
        if (symbolResolution.identity) {
          resolvedByIdentity.set(instrumentIdentity, symbolResolution);
          return;
        }

        // Historical Trading 212 records can retain an obsolete ticker after a
        // corporate rename. The stable ISIN is the only safe alias available in
        // those records, so use it for a second native lookup and still require
        // one compatible Wealthfolio market identity.
        const isin = String(remote.isin ?? '').trim().toUpperCase();
        if (!/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(isin)) {
          resolvedByIdentity.set(instrumentIdentity, symbolResolution);
          return;
        }
        const isinResolution = selectUniqueNativeMarketIdentity(
          candidate,
          await search(isin),
          { lookupKind: 'isin', lookupValue: isin },
        );
        if (isinResolution.identity?.kind === 'existing') {
          const identity = isinResolution.identity;
          const profile = await this.ctx.api.assets.getProfile(identity.assetId);
          const binding = assetBindingFromProfile(profile);
          if (
            !binding ||
            profile.id !== identity.assetId ||
            binding.symbol.trim().toUpperCase() !== identity.symbol.trim().toUpperCase() ||
            binding.exchangeMic?.trim().toUpperCase() !==
              identity.exchangeMic.trim().toUpperCase() ||
            !sourceCurrenciesCompatible(identity.quoteCcy, binding.currency)
          ) {
            resolvedByIdentity.set(instrumentIdentity, {
              problem:
                'An existing Wealthfolio asset returned by the exact ISIN lookup conflicts with its current symbol, exchange, currency, or type profile.',
            });
            return;
          }
          // Asset activation is lifecycle state, not market identity. A deleted
          // account can leave an exact native asset inactive; Wealthfolio 3.6.2
          // intentionally reactivates that asset inside ensure_assets/saveMany.
          // The exact validated ISIN query plus one unique native market identity
          // remains the primary proof. If any profile field carries an ISIN,
          // every occurrence must be valid and equal.
          if (!assetProfileIsinConsistent(profile, isin)) {
            resolvedByIdentity.set(instrumentIdentity, {
              problem:
                'An existing Wealthfolio asset returned by the exact ISIN lookup carries a conflicting ISIN.',
            });
            return;
          }
        }
        resolvedByIdentity.set(
          instrumentIdentity,
          isinResolution.identity
            ? isinResolution
            : {
                problem: `${symbolResolution.problem ?? 'The ticker lookup did not resolve uniquely'} ISIN lookup also failed: ${isinResolution.problem ?? 'no unique compatible identity was returned'}`,
              },
        );
      }),
    );

    return results.map((result): MappingResult => {
      const mapped = result.mapped;
      if (!mapped?.instrumentIdentity) return result;
      const resolved = resolvedByIdentity.get(mapped.instrumentIdentity);
      if (!resolved?.identity) {
        return {
          pending: {
            stream: mapped.stream,
            remoteKey: mapped.remoteKey,
            remoteDate: mapped.remoteDate,
            reason:
              resolved?.problem ??
              'Wealthfolio did not return a unique native market identity for this security.',
            blocksAutomaticImport: true,
            persistedHistoryFallbackAllowed: true,
            assetMapping: {
              instrumentIdentity: mapped.instrumentIdentity,
              remoteTicker: mapped.remoteInstrument?.ticker,
              remoteIsin: mapped.remoteInstrument?.isin,
              remoteCurrency: mapped.remoteInstrument?.currency,
              remoteName: mapped.remoteInstrument?.name,
            },
          },
        };
      }
      const native = resolved.identity;
      const activity = {
        ...mapped.activity,
        symbol: native.symbol,
        symbolName: native.name,
        exchangeMic: native.exchangeMic,
        quoteCcy: native.quoteCcy,
        instrumentType: native.instrumentType,
        ...(native.kind === 'existing' ? { assetId: native.assetId } : {}),
        ...(native.providerId ? { providerId: native.providerId } : {}),
        ...(native.providerSymbol ? { providerSymbol: native.providerSymbol } : {}),
      };
      return {
        mapped: {
          ...mapped,
          activity,
          signature: mappedActivitySignature(activity),
        },
      };
    });
  }

  private run(apply: boolean, baselineAtOverride?: string): Promise<SyncRunSummary> {
    const requestedMode = apply ? 'import' : baselineAtOverride ? 'full-preview' : 'preview';
    if (this.activeRun) {
      if (this.activeRunMode === requestedMode) return this.activeRun;
      return Promise.reject(new Error('A different Trading 212 sync operation is already running.'));
    }
    if (this.state.syncing) {
      return Promise.reject(new Error('Another Trading 212 operation is already running.'));
    }
    this.activeRunMode = requestedMode;
    this.activeRun = this.executeRun(apply, baselineAtOverride).finally(() => {
      this.activeRun = undefined;
      this.activeRunMode = undefined;
      this.patchState({ syncing: false });
      this.resetNextSync();
    });
    return this.activeRun;
  }

  private async executeRun(
    apply: boolean,
    baselineAtOverride?: string,
  ): Promise<SyncRunSummary> {
    let wealthfolioWriteAttempted = false;
    let uncertainImportRecovery = false;
    let retryLedger: ImportLedgerV3 | undefined;
    let writeFinalized = false;
    const accountId = this.state.accountId;
    const remoteAccountFingerprint = this.state.remoteAccountFingerprint;
    const cachedAccount = this.state.accounts.find((candidate) => candidate.id === accountId);
    if (!accountId || !remoteAccountFingerprint || !cachedAccount) {
      throw new Error('Select a valid Wealthfolio account and reconnect Trading 212.');
    }
    if (cachedAccount.trackingMode !== 'TRANSACTIONS') {
      throw new Error('Automatic import is blocked because the account is not in Transactions mode.');
    }
    if (this.disposed) throw new Error('Trading 212 sync was disabled before this run started.');

    this.patchState({ syncing: true, lastError: undefined });
    try {
      // The marker is retained only for upgrade/state compatibility. It is a
      // fixed no-cutoff sentinel and must never be replaced by a date derived
      // from Wealthfolio activity.
      const baselineAt = FULL_HISTORY_START_AT;
      if (apply && (!this.state.baselineConfirmed || !this.state.isaConfirmed)) {
        throw new Error('The ISA account and full-history mode are not verified.');
      }
      const baseline = new Date(baselineAt);
      if (!Number.isFinite(baseline.getTime())) {
        throw new Error('The history start marker is invalid; automatic import was blocked.');
      }
      let account: ControllerState['accounts'][number];
      try {
        account = await this.assertBoundAccountCurrent(accountId, cachedAccount.currency);
      } catch (error) {
        if (apply) {
          await this.pauseAuto(
            `Automatic sync was paused because the Wealthfolio target account changed: ${formatError(error)}`,
          );
        }
        throw error;
      }

      const localActivities = await this.ctx.api.activities.getAll(accountId);
      if (apply) {
        const recovery = await this.inspectImportRecovery(
          accountId,
          remoteAccountFingerprint,
          localActivities,
        );
        retryLedger = recovery.retryLedger;
        uncertainImportRecovery = Boolean(retryLedger);
      }
      const mappingContext: MappingContext = {
        accountId,
        remoteAccountFingerprint,
        accountCurrency: normalizeCurrency(account.currency),
        assetsById: new Map(),
        resolvedAssetIdsByInstrument: new Map(),
      };
      this.patchState({ availableAssets: [] });

      const [remoteSummary, remotePositions, rawOrders, rawDividends, transactions] = await Promise.all([
        this.api.getAccountSummary(),
        this.api.getPositions(),
        this.api.getHistory('orders'),
        this.api.getHistory('dividends'),
        this.api.getHistory('transactions'),
      ]);
      const currentInstrumentBySecurity = buildCurrentPositionInstrumentIndex(remotePositions);
      const orders = rawOrders.map((order) =>
        alignOrderWithCurrentPosition(order, currentInstrumentBySecurity),
      );
      const dividends = rawDividends.map((dividend) =>
        alignDividendWithCurrentPosition(dividend, currentInstrumentBySecurity),
      );
      const currentRemoteAccountId = String(remoteSummary.id ?? '').trim();
      if (
        !currentRemoteAccountId ||
        (await sha256Hex(currentRemoteAccountId)) !== remoteAccountFingerprint
      ) {
        throw new Error('Trading 212 account identity changed; automatic import was blocked.');
      }
      if (
        normalizeCurrency(remoteSummary.currency) !== normalizeCurrency(account.currency)
      ) {
        throw new Error('Trading 212 account currency changed; automatic import was blocked.');
      }

      const rawResults = [
        ...orders.map((item) => mapOrder(item, mappingContext)),
        ...dividends.map((item) => mapDividend(item, mappingContext)),
        ...transactions.map((item) => mapTransaction(item, mappingContext)),
      ];
      const remoteIdentityConflicts = findRemoteInstrumentConflictReasons(
        rawResults.flatMap((result) => (result.mapped ? [result.mapped] : [])),
        remotePositions,
      );
      const identityCheckedResults = rawResults.map((result): MappingResult => {
        const mapped = result.mapped;
        const conflictReason = mapped?.instrumentIdentity
          ? remoteIdentityConflicts.get(mapped.instrumentIdentity)
          : undefined;
        if (!mapped || !conflictReason) return result;
        return {
          pending: {
            stream: mapped.stream,
            remoteKey: mapped.remoteKey,
            remoteDate: mapped.remoteDate,
            reason: conflictReason,
            blocksAutomaticImport: true,
          },
        };
      });
      const nativeIdentityResults = await this.attachNativeMarketIdentities(
        identityCheckedResults,
      );
      const streamCoverage = {
        orders: historyCoverage(orders, extractOrderDate),
        dividends: historyCoverage(dividends, extractDividendDate),
        transactions: historyCoverage(transactions, extractTransactionDate),
      };
      const mappedTypeCounts = nativeIdentityResults.reduce<Record<string, number>>((counts, result) => {
        const activityType = result.mapped?.activity.activityType;
        if (activityType) counts[activityType] = (counts[activityType] ?? 0) + 1;
        return counts;
      }, {});
      const positionReviewEvents = remotePositions
        .map((position) => reviewPositionInstrument(position, mappingContext))
        .filter((event): event is PendingEvent => Boolean(event));
      for (const [instrumentIdentity, reason] of remoteIdentityConflicts) {
        positionReviewEvents.push({
          stream: 'portfolio',
          remoteKey: `t212:${remoteAccountFingerprint}:instrument:${stableHash(instrumentIdentity)}`,
          reason,
          blocksAutomaticImport: true,
        });
      }
      const { results, batchDuplicates } = collapseBatchResults(nativeIdentityResults);
      const sourceKeys = results.flatMap((result) =>
        result.mapped
          ? [result.mapped.remoteKey]
          : result.pending
            ? [result.pending.remoteKey]
            : [],
      );
      const seenCache = await this.loadSeen(sourceKeys);
      const seen = seenCache.entries;
      const candidates: MappedActivity[] = [];
      const pendingEvents: PendingEvent[] = [...positionReviewEvents];
      const seenSignatureMigrations: MappedActivity[] = [];
      const localActivitiesBySourceRecordId = indexPersistedSourceActivities(localActivities);
      const beforeBaseline = 0;
      let alreadySeen = 0;

      for (const result of results) {
        if (result.pending) {
          const prior = seen[result.pending.remoteKey];
          pendingEvents.push(
            canUsePersistedHistoryFallback(
              result.pending,
              prior,
              localActivitiesBySourceRecordId,
              accountId,
            )
              ? {
                  ...result.pending,
                  reason: `Previously imported Trading 212 history is retained because the API now omits identity enrichment. ${result.pending.reason}`,
                  blocksAutomaticImport: undefined,
                }
              : result.pending,
          );
          continue;
        }
        if (!result.mapped) continue;
        const prior = seen[result.mapped.remoteKey];
        const canonicalSeenSignature = mappedActivitySeenSignature(result.mapped.activity);
        if (
          prior?.signature === canonicalSeenSignature ||
          prior?.signature === result.mapped.signature
        ) {
          alreadySeen += 1;
          if (prior.signature !== canonicalSeenSignature) {
            seenSignatureMigrations.push(result.mapped);
          }
          continue;
        }
        if (prior && prior.signature !== result.mapped.signature) {
          pendingEvents.push({
            stream: result.mapped.stream,
            remoteKey: result.mapped.remoteKey,
            remoteDate: result.mapped.remoteDate,
            reason: 'Trading 212 changed a previously imported record; automatic overwrite is blocked.',
          });
          continue;
        }
        candidates.push(result.mapped);
      }

      const rows = candidates.map((candidate, index) => ({
        ...candidate.activity,
        lineNumber: index + 1,
      }));
      assertImportWireRows(rows);
      const checked = rows.length > 0 ? await this.ctx.api.activities.checkImport(rows) : [];
      const assetResolutionProblems = nativeAssetResolutionProblems(candidates, checked);
      const acceptedCandidates: MappedActivity[] = [];
      const acceptedRows: ActivityImport[] = [];
      const duplicateCandidates: MappedActivity[] = [];
      const nativeAssetIdsByInstrument = new Map<string, string>();
      const checkedIndexes = new Set<number>();
      const localActivitiesById = new Map(
        localActivities.map((activity) => [activity.id, activity]),
      );

      for (const checkedRow of checked) {
        const lineNumber = checkedRow.lineNumber;
        if (!Number.isInteger(lineNumber) || !lineNumber || lineNumber < 1) continue;
        const index = lineNumber - 1;
        const candidate = candidates[index];
        if (!candidate || checkedIndexes.has(index)) continue;
        checkedIndexes.add(index);
        const assetResolutionProblem = assetResolutionProblems.get(index);
        if (assetResolutionProblem) {
          pendingEvents.push({
            stream: candidate.stream,
            remoteKey: candidate.remoteKey,
            remoteDate: candidate.remoteDate,
            reason: assetResolutionProblem,
            blocksAutomaticImport: true,
          });
          continue;
        }
        const changedFields = immutableImportDifferences(candidate.activity, checkedRow);
        if (changedFields.length > 0) {
          pendingEvents.push({
            stream: candidate.stream,
            remoteKey: candidate.remoteKey,
            remoteDate: candidate.remoteDate,
            reason: `Wealthfolio validation changed immutable import fields: ${changedFields.join(', ')}.`,
          });
          continue;
        }
        if (checkedRow.duplicateOfId) {
          const duplicateActivity = localActivitiesById.get(checkedRow.duplicateOfId);
          const duplicateProblem = validateDuplicateReference(
            candidate,
            duplicateActivity,
            accountId,
            checkedRow.assetId,
          );
          if (duplicateProblem) {
            pendingEvents.push({
              stream: candidate.stream,
              remoteKey: candidate.remoteKey,
              remoteDate: candidate.remoteDate,
              reason: duplicateProblem,
            });
            continue;
          }
          rememberNativeAssetId(nativeAssetIdsByInstrument, candidate, checkedRow.assetId);
          duplicateCandidates.push(candidate);
          continue;
        }
        if (checkedRow.duplicateOfLineNumber !== undefined) {
          pendingEvents.push({
            stream: candidate.stream,
            remoteKey: candidate.remoteKey,
            remoteDate: candidate.remoteDate,
            reason: 'Wealthfolio considered this a duplicate of another row in the same batch; manual review is required.',
          });
          continue;
        }
        if (!checkedRow.isValid) {
          pendingEvents.push({
            stream: candidate.stream,
            remoteKey: candidate.remoteKey,
            remoteDate: candidate.remoteDate,
            reason: flattenValidationErrors(checkedRow.errors) || 'Wealthfolio rejected the activity.',
          });
          continue;
        }
        const warnings = flattenValidationErrors(checkedRow.warnings);
        if (warnings) {
          pendingEvents.push({
            stream: candidate.stream,
            remoteKey: candidate.remoteKey,
            remoteDate: candidate.remoteDate,
            reason: `Wealthfolio validation warning blocked automatic import: ${warnings}`,
          });
          continue;
        }
        rememberNativeAssetId(nativeAssetIdsByInstrument, candidate, checkedRow.assetId);
        acceptedCandidates.push(candidate);
        acceptedRows.push(checkedRow);
      }
      for (let index = 0; index < candidates.length; index += 1) {
        if (!checkedIndexes.has(index)) {
          const candidate = candidates[index];
          pendingEvents.push({
            stream: candidate.stream,
            remoteKey: candidate.remoteKey,
            remoteDate: candidate.remoteDate,
            reason: 'Wealthfolio did not return a validation result for this record.',
          });
        }
      }
      await this.assertCheckedExistingAssetsCurrent(acceptedCandidates, acceptedRows);
      const nativeCreates = acceptedCandidates.map((candidate, index) =>
        toSyncActivityCreate(candidate, acceptedRows[index]!, accountId),
      );
      const preparedLedger = acceptedCandidates.length > 0
        ? createImportLedger(
            accountId,
            remoteAccountFingerprint,
            acceptedCandidates,
            nativeCreates,
          )
        : undefined;
      if (
        retryLedger &&
        (!preparedLedger || preparedLedger.batchFingerprint !== retryLedger.batchFingerprint)
      ) {
        throw new Error(
          'The unfinished Trading 212 batch no longer matches the current verified API data; automatic retry was blocked.',
        );
      }

      let imported = 0;
      let reconciliation: ReconciliationResult | undefined;
      let autoPauseReason: string | undefined;
      const completedAt = new Date().toISOString();
      const firstBlockingIdentityProblem = pendingEvents.find(
        (event) => event.blocksAutomaticImport,
      );
      if (apply && firstBlockingIdentityProblem) {
        autoPauseReason =
          `Automatic sync was paused before importing anything because a Trading 212 security identity is incomplete or conflicting. ${firstBlockingIdentityProblem.reason}`;
        await this.pauseAuto(autoPauseReason);
      } else if (apply) {
        if (this.disposed) {
          throw new Error('Trading 212 sync was disabled before the import step.');
        }
        try {
          await this.assertBoundAccountCurrent(accountId, account.currency);
        } catch (error) {
          await this.pauseAuto(
            `Automatic sync was paused because the Wealthfolio target account changed before import: ${formatError(error)}`,
          );
          throw error;
        }
        if (this.disposed) {
          throw new Error('Trading 212 sync was disabled before the import step.');
        }
        if (acceptedCandidates.length > 0) {
          let activeLedger: ImportLedgerV3;
          try {
            if (!preparedLedger) {
              throw new Error('The Trading 212 import ledger was not prepared.');
            }
            activeLedger = retryLedger ?? preparedLedger;
            await this.persistImportLedger(activeLedger);
            uncertainImportRecovery = true;
          } catch (error) {
            await this.pauseAuto(
              'Automatic sync was paused because its crash-recovery marker could not be verified; no import was started.',
              true,
            );
            throw error;
          }
          if (this.disposed) {
            throw new Error('Trading 212 sync was disabled before the import step.');
          }
          try {
            await this.assertBoundAccountCurrent(accountId, account.currency);
          } catch (error) {
            await this.pauseAuto(
              `Automatic sync was paused because the Wealthfolio target account changed before import: ${formatError(error)}`,
              true,
            );
            throw error;
          }
          if (this.disposed) {
            throw new Error('Trading 212 sync was disabled before the import step.');
          }
          activeLedger = await this.updateImportLedgerPhase(
            activeLedger,
            'write-attempted',
          );
          wealthfolioWriteAttempted = true;
          const nativeResult = await this.ctx.api.activities.saveMany({
            creates: nativeCreates,
          });
          const createdAssets = validateNativeSaveManyResult(
            nativeCreates,
            acceptedCandidates,
            nativeResult,
            accountId,
          );
          const candidateByRemoteKey = new Map(
            acceptedCandidates.map((candidate) => [candidate.remoteKey, candidate]),
          );
          for (const [remoteKey, assetId] of createdAssets) {
            const candidate = candidateByRemoteKey.get(remoteKey);
            if (!candidate) {
              throw new Error(
                'Wealthfolio returned an unknown Trading 212 source record after native save.',
              );
            }
            rememberNativeAssetId(nativeAssetIdsByInstrument, candidate, assetId);
          }
          activeLedger = await this.updateImportLedgerPhase(
            activeLedger,
            'committed',
            nativeResult.createdMappings.map((mapping) => ({
              tempId: String(mapping.tempId ?? ''),
              activityId: String(mapping.activityId ?? ''),
            })),
          );
          imported = nativeResult.created.length;
          if (imported !== acceptedCandidates.length) {
            throw new Error(
              'Wealthfolio did not persist every accepted Trading 212 activity.',
            );
          }
        }
        try {
          const refreshedActivities = await this.ctx.api.activities.getAll(accountId);
          assertPersistedSourceActivities(
            acceptedCandidates,
            nativeCreates,
            refreshedActivities,
            accountId,
          );
          await this.hydrateNativeAssetMappings(
            mappingContext,
            results.flatMap((result) => (result.mapped ? [result.mapped] : [])),
            nativeAssetIdsByInstrument,
            refreshedActivities,
          );
          reconciliation = await this.reconcile(
            accountId,
            mappingContext,
            remoteSummary,
            remotePositions,
          );
          if (reconciliation.complete) {
            await this.markSeen(seenCache, [
              ...acceptedCandidates,
              ...duplicateCandidates,
              ...seenSignatureMigrations,
            ]);
          }
        } catch (error) {
          await this.pauseAuto(
            'Automatic sync was paused because the post-import reconciliation could not be completed.',
            true,
          );
          throw error;
        }
        if (reconciliation.complete) {
          await this.ctx.api.storage.delete(STORAGE_KEYS.reconciliationBlocked);
          await this.ctx.api.storage.set(STORAGE_KEYS.lastSuccessfulSyncAt, completedAt);
          this.patchState({ lastSuccessfulSyncAt: completedAt });
        } else {
          autoPauseReason =
            'Automatic sync was paused because Trading 212 and Wealthfolio holdings or cash do not match.';
          await this.pauseAuto(autoPauseReason, true);
        }
      }

      const uniquePendingEvents = deduplicatePendingEvents(pendingEvents);
      const summarizedPendingEvents = [...uniquePendingEvents].sort(
        (left, right) => Number(Boolean(right.blocksAutomaticImport)) - Number(Boolean(left.blocksAutomaticImport)),
      );
      const summary: SyncRunSummary = {
        mode: apply ? 'import' : 'preview',
        historyStartAt: baseline.toISOString(),
        streamCoverage,
        mappedTypeCounts,
        fetched: orders.length + dividends.length + transactions.length,
        beforeBaseline,
        alreadySeen,
        duplicates: duplicateCandidates.length + batchDuplicates,
        valid: acceptedCandidates.length,
        imported,
        pendingTotal: uniquePendingEvents.length,
        // Retained as a wire-compatible summary field for upgrades from 0.1.7;
        // user-confirmed UUID mappings no longer exist.
        mappingPendingTotal: 0,
        pending: summarizedPendingEvents.slice(0, 100),
        completedAt,
        reconciliation,
        autoPaused: Boolean(autoPauseReason),
        autoPauseReason,
      };
      await this.ctx.api.storage.set(STORAGE_KEYS.lastSummary, JSON.stringify(summary));
      if (apply && reconciliation?.complete && uncertainImportRecovery) {
        await this.clearImportMarker();
        writeFinalized = true;
      }
      this.patchState({ lastSummary: summary, lastError: autoPauseReason });
      if (apply) {
        if (autoPauseReason) {
          this.ctx.api.toast.warning(
            `${imported > 0 ? `Imported ${imported} ${imported === 1 ? 'record' : 'records'}; ` : ''}${autoPauseReason}`,
          );
        } else {
          this.ctx.api.toast.success(
            imported > 0
              ? `Trading 212 synchronized ${imported} new ${imported === 1 ? 'record' : 'records'}.`
              : 'Trading 212 checked; no new records were found.',
          );
        }
      }
      return summary;
    } catch (error) {
      const message = formatError(error);
      if (
        apply &&
        (wealthfolioWriteAttempted || uncertainImportRecovery) &&
        !writeFinalized
      ) {
        await this.pauseAuto(
          'Automatic sync was paused because a Wealthfolio import was attempted but its final state could not be verified. Review the account, then use “Sync now” manually.',
          true,
        );
      }
      this.patchState({ lastError: message });
      this.ctx.api.logger.error(`Trading 212 sync failed: ${message}`);
      if (apply) this.ctx.api.toast.error(`Trading 212 sync failed: ${message}`);
      throw error;
    }
  }

  private async reconcile(
    accountId: string,
    mappingContext: MappingContext,
    remoteSummary: Trading212AccountSummary,
    remotePositions: Trading212Position[],
  ): Promise<ReconciliationResult> {
    let best: ReconciliationResult | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const localHoldings = await this.ctx.api.portfolio.getHoldings(accountId);
      const current = compareHoldings(
        localHoldings,
        mappingContext,
        remoteSummary,
        remotePositions,
      );
      if (!best || reconciliationScore(current) < reconciliationScore(best)) best = current;
      if (current.complete) return current;
      if (attempt < 2) await sleep(750);
    }
    return best!;
  }

  /**
   * `checkImport` is allowed to reuse a Wealthfolio asset, but the add-on must
   * prove that the returned ID is still the same market instrument before any
   * write. Inactive assets are accepted here because Wealthfolio's native
   * `ensure_assets` path reactivates an exact reused asset as part of saveMany.
   */
  private async assertCheckedExistingAssetsCurrent(
    candidates: MappedActivity[],
    rows: ActivityImport[],
  ): Promise<void> {
    if (candidates.length !== rows.length) {
      throw new Error('Trading 212 validation rows no longer align with their source records.');
    }

    const securityByAssetId = new Map<string, string>();
    const assetIdByIdentity = new Map<string, string>();
    const profiles = new Map<string, Asset>();
    const assetIds = [
      ...new Set(
        rows
          .map((row) => String(row.assetId ?? '').trim())
          .filter((assetId): assetId is string => Boolean(assetId)),
      ),
    ];
    const loadedProfiles = await Promise.all(
      assetIds.map(async (assetId) => ({
        assetId,
        profile: await this.ctx.api.assets.getProfile(assetId),
      })),
    );
    for (const { assetId, profile } of loadedProfiles) {
      if (profile.id !== assetId) {
        throw new Error('Wealthfolio returned a mismatched asset profile before import.');
      }
      profiles.set(assetId, profile);
    }

    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index]!;
      const row = rows[index]!;
      const assetId = String(row.assetId ?? '').trim();
      if (!candidate.instrumentIdentity) {
        if (assetId) {
          throw new Error('Wealthfolio unexpectedly linked a cash activity to a security asset.');
        }
        continue;
      }
      if (!assetId) continue;

      const requestedAssetId = String(candidate.activity.assetId ?? '').trim();
      if (requestedAssetId && requestedAssetId !== assetId) {
        throw new Error('Wealthfolio changed an exact existing-asset selection during validation.');
      }
      const remote = candidate.remoteInstrument;
      const profile = profiles.get(assetId);
      const binding = profile ? assetBindingFromProfile(profile) : undefined;
      if (!remote || !profile || !binding) {
        throw new Error('Wealthfolio could not provide a complete equity profile before import.');
      }
      const expectedSymbol = String(candidate.activity.symbol ?? '').trim().toUpperCase();
      const expectedMic = String(candidate.activity.exchangeMic ?? '').trim().toUpperCase();
      const expectedQuoteCcy = String(candidate.activity.quoteCcy ?? '').trim();
      if (
        binding.symbol.trim().toUpperCase() !== expectedSymbol ||
        !expectedSymbol ||
        !expectedMic ||
        binding.exchangeMic?.trim().toUpperCase() !== expectedMic ||
        !sourceCurrenciesCompatible(expectedQuoteCcy, binding.currency) ||
        !sourceCurrenciesCompatible(remote.currency, binding.currency)
      ) {
        throw new Error('Wealthfolio resolved a Trading 212 security to a conflicting local asset.');
      }
      if (!assetProfileIsinConsistent(profile, remote.isin)) {
        throw new Error('Wealthfolio resolved a Trading 212 security to a conflicting ISIN.');
      }

      const securityKey = `${remote.isin.toUpperCase()}|${normalizeSourceCurrency(remote.currency)}`;
      const priorSecurityKey = securityByAssetId.get(assetId);
      if (priorSecurityKey && priorSecurityKey !== securityKey) {
        throw new Error('Wealthfolio resolved conflicting Trading 212 securities to one local asset.');
      }
      securityByAssetId.set(assetId, securityKey);

      const priorAssetId = assetIdByIdentity.get(candidate.instrumentIdentity);
      if (priorAssetId && priorAssetId !== assetId) {
        throw new Error('Wealthfolio resolved one Trading 212 security to multiple local assets.');
      }
      assetIdByIdentity.set(candidate.instrumentIdentity, assetId);
    }
  }

  private async hydrateNativeAssetMappings(
    mappingContext: MappingContext,
    mappedActivities: MappedActivity[],
    nativeAssetIdsByInstrument: Map<string, string>,
    localActivities: ActivityDetails[],
  ): Promise<void> {
    const localByComment = new Map<string, ActivityDetails[]>();
    for (const activity of localActivities) {
      const comment = activity.comment?.trim();
      if (!comment || !activity.assetId?.trim()) continue;
      const matches = localByComment.get(comment) ?? [];
      matches.push(activity);
      localByComment.set(comment, matches);
    }

    const remoteByIdentity = new Map<
      string,
      NonNullable<MappedActivity['remoteInstrument']>
    >();
    const expectedNativeByIdentity = new Map<
      string,
      { symbol: string; exchangeMic: string; quoteCcy: string }
    >();
    for (const candidate of mappedActivities) {
      if (!candidate.instrumentIdentity || !candidate.remoteInstrument) continue;
      remoteByIdentity.set(candidate.instrumentIdentity, candidate.remoteInstrument);
      const expectedNative = {
        symbol: String(candidate.activity.symbol ?? '').trim().toUpperCase(),
        exchangeMic: String(candidate.activity.exchangeMic ?? '').trim().toUpperCase(),
        quoteCcy: String(candidate.activity.quoteCcy ?? '').trim(),
      };
      const priorExpected = expectedNativeByIdentity.get(candidate.instrumentIdentity);
      if (
        !expectedNative.symbol ||
        !expectedNative.exchangeMic ||
        !expectedNative.quoteCcy ||
        (priorExpected && stableHash(priorExpected) !== stableHash(expectedNative))
      ) {
        throw new Error('Trading 212 native asset expectations became inconsistent after import.');
      }
      expectedNativeByIdentity.set(candidate.instrumentIdentity, expectedNative);
      const comment = candidate.activity.comment?.trim();
      if (!comment) continue;
      const assetIds = new Set(
        (localByComment.get(comment) ?? [])
          .map((activity) => activity.assetId?.trim())
          .filter((assetId): assetId is string => Boolean(assetId)),
      );
      if (assetIds.size > 1) {
        throw new Error(
          'Wealthfolio linked one Trading 212 source record to more than one local asset.',
        );
      }
      const assetId = [...assetIds][0];
      if (assetId) rememberNativeAssetId(nativeAssetIdsByInstrument, candidate, assetId);
    }

    const profiles = await Promise.all(
      [...nativeAssetIdsByInstrument].map(async ([identity, assetId]) => {
        const profile = await this.ctx.api.assets.getProfile(assetId);
        return { identity, assetId, profile };
      }),
    );
    const assetIdentityById = new Map<string, string>();
    for (const { identity, assetId, profile } of profiles) {
      if (profile.id !== assetId || profile.isActive === false) {
        throw new Error('Wealthfolio returned an inactive or mismatched native asset profile.');
      }
      const binding = assetBindingFromProfile(profile);
      const remote = remoteByIdentity.get(identity);
      const expectedNative = expectedNativeByIdentity.get(identity);
      if (!binding || !remote || !expectedNative) {
        throw new Error('Wealthfolio could not provide a complete equity profile after import.');
      }
      if (
        binding.symbol.trim().toUpperCase() !== expectedNative.symbol ||
        binding.exchangeMic?.trim().toUpperCase() !== expectedNative.exchangeMic ||
        !sourceCurrenciesCompatible(expectedNative.quoteCcy, binding.currency)
      ) {
        throw new Error('Wealthfolio created or reused a conflicting native market identity.');
      }
      if (!sourceCurrenciesCompatible(remote.currency, binding.currency)) {
        throw new Error('Wealthfolio linked a Trading 212 security to an incompatible currency.');
      }
      if (!assetProfileIsinConsistent(profile, remote.isin)) {
        throw new Error('Wealthfolio linked a Trading 212 security to a conflicting ISIN.');
      }
      const securityKey = `${remote.isin}|${normalizeSourceCurrency(remote.currency)}`;
      const priorSecurityKey = assetIdentityById.get(assetId);
      if (priorSecurityKey && priorSecurityKey !== securityKey) {
        throw new Error('Wealthfolio linked conflicting Trading 212 securities to one local asset.');
      }
      assetIdentityById.set(assetId, securityKey);
      mappingContext.assetsById.set(assetId, binding);
      mappingContext.resolvedAssetIdsByInstrument.set(identity, assetId);
    }
  }

  private async assertBoundAccountCurrent(
    accountId: string,
    expectedCurrency: string,
  ): Promise<ControllerState['accounts'][number]> {
    const accounts = await this.ctx.api.accounts.getAll();
    const current = accounts.find((candidate) => candidate.id === accountId);
    const problem = boundAccountProblem(current, expectedCurrency);
    if (!current || problem) throw new Error(problem ?? 'The bound account is missing.');
    return toStateAccount(current);
  }

  private async persistImportLedger(marker: ImportLedgerV3): Promise<void> {
    const serialized = JSON.stringify(marker);
    await this.ctx.api.storage.set(STORAGE_KEYS.importInProgress, serialized);
    const verified = await this.ctx.api.storage.get(STORAGE_KEYS.importInProgress);
    if (verified !== serialized) {
      throw new Error('The Wealthfolio import crash-recovery marker could not be verified.');
    }
  }

  private async updateImportLedgerPhase(
    marker: ImportLedgerV3,
    phase: ImportLedgerV3['phase'],
    committedMappings?: ImportLedgerV3['committedMappings'],
  ): Promise<ImportLedgerV3> {
    const next: ImportLedgerV3 = {
      ...marker,
      phase,
      ...(committedMappings ? { committedMappings } : {}),
    };
    await this.persistImportLedger(next);
    return next;
  }

  private async inspectImportRecovery(
    accountId: string,
    remoteAccountFingerprint: string,
    activities: ActivityDetails[],
  ): Promise<{ retryLedger?: ImportLedgerV3 }> {
    const raw = await this.ctx.api.storage.get(STORAGE_KEYS.importInProgress);
    if (!raw) return {};
    const marker = parseJson<unknown>(raw);
    if (!isImportLedgerV3(marker)) {
      throw new Error(
        'An older or damaged Trading 212 import marker cannot be recovered automatically. Delete local add-on credentials during the planned reset.',
      );
    }
    if (
      marker.accountId !== accountId ||
      marker.remoteAccountFingerprint !== remoteAccountFingerprint
    ) {
      throw new Error('The unfinished Trading 212 import belongs to a different account.');
    }

    const byIdempotencyKey = new Map<string, ActivityDetails[]>();
    const bySourceRecordId = new Map<string, ActivityDetails[]>();
    for (const activity of activities) {
      if (activity.sourceSystem !== 'TRADING212') continue;
      if (activity.idempotencyKey) {
        const matches = byIdempotencyKey.get(activity.idempotencyKey) ?? [];
        matches.push(activity);
        byIdempotencyKey.set(activity.idempotencyKey, matches);
      }
      if (activity.sourceRecordId) {
        const matches = bySourceRecordId.get(activity.sourceRecordId) ?? [];
        matches.push(activity);
        bySourceRecordId.set(activity.sourceRecordId, matches);
      }
    }

    let present = 0;
    let missing = 0;
    for (const entry of marker.candidates) {
      const byKey = byIdempotencyKey.get(entry.idempotencyKey) ?? [];
      const bySource = bySourceRecordId.get(entry.remoteKey) ?? [];
      if (byKey.length === 0 && bySource.length === 0) {
        missing += 1;
        continue;
      }
      if (
        byKey.length !== 1 ||
        bySource.length !== 1 ||
        byKey[0]!.id !== bySource[0]!.id
      ) {
        throw new Error(
          'The unfinished Trading 212 batch has conflicting source identities in Wealthfolio; automatic retry was blocked.',
        );
      }
      const activity = byKey[0]!;
      if (activity.status !== 'POSTED' || activity.isUserModified !== false) {
        throw new Error(
          'A persisted activity from the unfinished Trading 212 batch was edited or is no longer posted.',
        );
      }
      if (
        persistedActivityDetailsDigest(activity) !== entry.payloadDigest &&
        persistedActivityDetailsLegacyPreProjectionDigest(activity) !== entry.payloadDigest
      ) {
        throw new Error(
          'A persisted activity from the unfinished Trading 212 batch differs from its verified payload.',
        );
      }
      await this.assertRecoveryAssetExpectation(activity, entry.asset);
      present += 1;
    }

    if (present > 0 && missing > 0) {
      throw new Error(
        'Only part of the unfinished Trading 212 activity batch is present; automatic retry was blocked.',
      );
    }
    if (present === marker.candidateCount) {
      const seenCache = await this.loadSeen(
        marker.candidates.map((candidate) => candidate.remoteKey),
      );
      await this.markSeenEntries(
        seenCache,
        marker.candidates.map((candidate) => ({
          remoteKey: candidate.remoteKey,
          signature: candidate.signature,
        })),
      );
      await this.clearImportMarker();
      return {};
    }
    if (missing === marker.candidateCount && marker.phase !== 'committed') {
      return { retryLedger: marker };
    }
    throw new Error('The unfinished Trading 212 import marker contradicts Wealthfolio data.');
  }

  private async assertRecoveryAssetExpectation(
    activity: ActivityDetails,
    expectation: ImportLedgerAssetExpectation,
  ): Promise<void> {
    const assetId = String(activity.assetId ?? '').trim();
    if (expectation.kind === 'cash') {
      if (assetId) throw new Error('A recovered cash activity is linked to a security asset.');
      return;
    }
    if (!assetId || (expectation.kind === 'existing' && assetId !== expectation.assetId)) {
      throw new Error('A recovered Trading 212 security is linked to an unexpected asset.');
    }
    const profile = await this.ctx.api.assets.getProfile(assetId);
    const binding = profile.id === assetId ? assetBindingFromProfile(profile) : undefined;
    if (
      !binding ||
      profile.isActive === false ||
      binding.symbol.trim().toUpperCase() !== expectation.symbol.toUpperCase() ||
      binding.exchangeMic?.trim().toUpperCase() !== expectation.exchangeMic.toUpperCase() ||
      !sourceCurrenciesCompatible(expectation.quoteCcy, binding.currency)
    ) {
      throw new Error('A recovered Trading 212 activity has a conflicting asset profile.');
    }
  }

  private async clearImportMarker(): Promise<void> {
    await this.ctx.api.storage.delete(STORAGE_KEYS.importInProgress);
    if (await this.ctx.api.storage.get(STORAGE_KEYS.importInProgress)) {
      throw new Error('The Wealthfolio import crash-recovery marker could not be cleared.');
    }
  }

  private async clearCandidateCredential(): Promise<void> {
    try {
      await this.ctx.api.secrets.delete(TRADING212_CANDIDATE_AUTH_SECRET);
      await this.ctx.api.storage.delete(STORAGE_KEYS.credentialCleanupBlocked);
    } catch (error) {
      await Promise.allSettled([
        this.ctx.api.storage.set(STORAGE_KEYS.credentialCleanupBlocked, 'true'),
        this.ctx.api.storage.set(STORAGE_KEYS.autoEnabled, 'false'),
      ]);
      this.patchState({ autoEnabled: false, nextSyncAt: undefined });
      throw error;
    }
  }

  private async pauseAuto(reason: string, reconciliationBlocked = false): Promise<void> {
    this.patchState({ autoEnabled: false, nextSyncAt: undefined, lastError: reason });
    const writes: Promise<void>[] = [
      this.ctx.api.storage.set(STORAGE_KEYS.autoEnabled, 'false'),
    ];
    if (reconciliationBlocked) {
      writes.push(this.ctx.api.storage.set(STORAGE_KEYS.reconciliationBlocked, 'true'));
    }
    const results = await Promise.allSettled(writes);
    if (results.some((result) => result.status === 'rejected')) {
      this.ctx.api.logger.error('Trading 212 automatic-sync pause could not be fully persisted.');
    }
  }

  private async loadSeen(remoteKeys: string[]): Promise<SeenCache> {
    const shardNumbers = [...new Set(remoteKeys.map(seenShardNumber))];
    const shardValues = await Promise.all(
      shardNumbers.map(async (shardNumber) => {
        const value = await this.ctx.api.storage.get(seenShardKey(shardNumber));
        return [
          shardNumber,
          parseJson<Record<string, SeenEntry>>(value) ?? {},
        ] as const;
      }),
    );
    const shards = new Map<number, Record<string, SeenEntry>>(shardValues);
    const entries: Record<string, SeenEntry> = {};
    for (const shard of shards.values()) Object.assign(entries, shard);
    return { entries, shards };
  }

  private async markSeen(cache: SeenCache, candidates: MappedActivity[]): Promise<void> {
    return this.markSeenEntries(
      cache,
      candidates.map((candidate) => ({
        remoteKey: candidate.remoteKey,
        signature: mappedActivitySeenSignature(candidate.activity),
      })),
    );
  }

  private async markSeenEntries(
    cache: SeenCache,
    candidates: Array<{ remoteKey: string; signature: string }>,
  ): Promise<void> {
    if (candidates.length === 0) return;
    const now = new Date().toISOString();
    const dirty = new Set<number>();
    for (const candidate of candidates) {
      const shardNumber = seenShardNumber(candidate.remoteKey);
      const shard = cache.shards.get(shardNumber) ?? {};
      shard[candidate.remoteKey] = { signature: candidate.signature, seenAt: now };
      cache.shards.set(shardNumber, shard);
      dirty.add(shardNumber);
    }

    await Promise.all(
      [...dirty].map(async (shardNumber) => {
        const shard = cache.shards.get(shardNumber) ?? {};
        const retained = Object.entries(shard)
          .sort((left, right) => left[1].seenAt.localeCompare(right[1].seenAt))
          .slice(-MAX_SEEN_RECORDS_PER_SHARD);
        await this.ctx.api.storage.set(
          seenShardKey(shardNumber),
          JSON.stringify(Object.fromEntries(retained)),
        );
      }),
    );
  }

  private async clearSeenShards(): Promise<void> {
    await Promise.all(
      Array.from({ length: SEEN_SHARD_COUNT }, (_, shardNumber) =>
        this.ctx.api.storage.delete(seenShardKey(shardNumber)),
      ),
    );
  }

  private patchState(patch: Partial<ControllerState>): void {
    this.state = { ...this.state, ...patch };
    const snapshot = this.getState();
    for (const listener of this.listeners) listener(snapshot);
  }
}

export function createImportLedger(
  accountId: string,
  remoteAccountFingerprint: string,
  candidates: MappedActivity[],
  creates: SyncActivityCreate[],
): ImportLedgerV3 {
  if (candidates.length === 0 || candidates.length !== creates.length) {
    throw new Error('Trading 212 cannot prepare an empty or misaligned import ledger.');
  }
  const entries = candidates.map((candidate, index): ImportLedgerEntryV3 => {
    const create = creates[index]!;
    const tempId = String(create.id ?? '').trim();
    if (!tempId || create.sourceRecordId !== candidate.remoteKey) {
      throw new Error('Trading 212 import ledger source identifiers are incomplete.');
    }
    let asset: ImportLedgerAssetExpectation;
    if (!candidate.instrumentIdentity) {
      if (create.asset) throw new Error('A cash activity unexpectedly contains an asset.');
      asset = { kind: 'cash' };
    } else {
      const symbol = String(candidate.activity.symbol ?? '').trim().toUpperCase();
      const exchangeMic = String(candidate.activity.exchangeMic ?? '').trim().toUpperCase();
      const quoteCcy = String(candidate.activity.quoteCcy ?? '').trim();
      if (!symbol || !exchangeMic || !quoteCcy) {
        throw new Error('A Trading 212 security ledger identity is incomplete.');
      }
      const existingAssetId = String(create.asset?.id ?? '').trim();
      asset = existingAssetId
        ? {
            kind: 'existing',
            assetId: existingAssetId,
            identity: candidate.instrumentIdentity,
            symbol,
            exchangeMic,
            quoteCcy,
          }
        : {
            kind: 'new',
            identity: candidate.instrumentIdentity,
            symbol,
            exchangeMic,
            quoteCcy,
          };
    }
    return {
      tempId,
      remoteKey: candidate.remoteKey,
      signature: candidate.signature,
      idempotencyKey: create.idempotencyKey,
      payloadDigest: persistedActivityCreateDigest(create),
      asset,
    };
  }).sort((left, right) => left.remoteKey.localeCompare(right.remoteKey));
  return {
    schemaVersion: 3,
    phase: 'prepared',
    accountId,
    remoteAccountFingerprint,
    startedAt: new Date().toISOString(),
    candidateCount: entries.length,
    candidates: entries,
    batchFingerprint: stableHash(entries),
  };
}

function persistedActivityCreateDigest(create: SyncActivityCreate): string {
  return stableHash({
    accountId: create.accountId,
    activityType: create.activityType,
    subtype: nullishText(create.subtype),
    date: canonicalDate(create.activityDate),
    currency: normalizeCurrency(create.currency),
    amount: canonicalPersistedAmount(
      create.activityType,
      create.amount,
      create.quantity,
      create.unitPrice,
    ),
    quantity: canonicalNumber(create.quantity),
    unitPrice: canonicalNumber(create.unitPrice),
    fee: canonicalNumber(create.fee),
    tax: canonicalNumber(create.tax),
    fxRate: canonicalNumber(create.fxRate),
    comment: nullishText(create.comment),
    sourceSystem: create.sourceSystem,
    sourceRecordId: create.sourceRecordId,
    idempotencyKey: create.idempotencyKey,
    needsReview: create.needsReview,
  });
}

function persistedActivityDetailsDigest(activity: ActivityDetails): string {
  return stableHash({
    accountId: activity.accountId,
    activityType: activity.activityType,
    subtype: nullishText(activity.subtype),
    date: canonicalDate(activity.date),
    currency: normalizeCurrency(activity.currency),
    amount: canonicalPersistedAmount(
      activity.activityType,
      activity.amount,
      activity.quantity,
      activity.unitPrice,
    ),
    quantity: canonicalNumber(activity.quantity),
    unitPrice: canonicalNumber(activity.unitPrice),
    fee: canonicalNumber(activity.fee),
    tax: canonicalNumber(activity.tax),
    fxRate: canonicalNumber(activity.fxRate),
    comment: nullishText(activity.comment),
    sourceSystem: activity.sourceSystem,
    sourceRecordId: activity.sourceRecordId,
    idempotencyKey: activity.idempotencyKey,
    needsReview: Boolean(activity.needsReview),
  });
}

// 0.1.11 and an early 0.1.12 bundle built their recovery digest before
// accounting for Wealthfolio's ActivityDetails projection, which derives
// BUY/SELL amount as quantity × unitPrice. Accept that one legacy digest only
// while recovering an already committed batch; current markers use the
// normalized digest above.
function persistedActivityDetailsLegacyPreProjectionDigest(activity: ActivityDetails): string {
  return stableHash({
    accountId: activity.accountId,
    activityType: activity.activityType,
    subtype: nullishText(activity.subtype),
    date: canonicalDate(activity.date),
    currency: normalizeCurrency(activity.currency),
    amount:
      activity.activityType === 'BUY' || activity.activityType === 'SELL'
        ? undefined
        : canonicalNumber(activity.amount),
    quantity: canonicalNumber(activity.quantity),
    unitPrice: canonicalNumber(activity.unitPrice),
    fee: canonicalNumber(activity.fee),
    tax: canonicalNumber(activity.tax),
    fxRate: canonicalNumber(activity.fxRate),
    comment: nullishText(activity.comment),
    sourceSystem: activity.sourceSystem,
    sourceRecordId: activity.sourceRecordId,
    idempotencyKey: activity.idempotencyKey,
    needsReview: Boolean(activity.needsReview),
  });
}

function isImportLedgerV3(value: unknown): value is ImportLedgerV3 {
  if (!value || typeof value !== 'object') return false;
  const marker = value as Partial<ImportLedgerV3>;
  if (
    marker.schemaVersion !== 3 ||
    !['prepared', 'write-attempted', 'committed'].includes(String(marker.phase)) ||
    typeof marker.accountId !== 'string' ||
    !marker.accountId ||
    typeof marker.remoteAccountFingerprint !== 'string' ||
    !marker.remoteAccountFingerprint ||
    typeof marker.startedAt !== 'string' ||
    !Number.isFinite(new Date(marker.startedAt).getTime()) ||
    !Number.isInteger(marker.candidateCount) ||
    Number(marker.candidateCount) < 1 ||
    !Array.isArray(marker.candidates) ||
    marker.candidates.length !== marker.candidateCount ||
    typeof marker.batchFingerprint !== 'string' ||
    !marker.batchFingerprint
  ) {
    return false;
  }
  const tempIds = new Set<string>();
  const remoteKeys = new Set<string>();
  const idempotencyKeys = new Set<string>();
  for (const entry of marker.candidates) {
    if (!entry || typeof entry !== 'object') return false;
    const candidate = entry as Partial<ImportLedgerEntryV3>;
    if (
      typeof candidate.tempId !== 'string' ||
      !candidate.tempId ||
      typeof candidate.remoteKey !== 'string' ||
      !candidate.remoteKey ||
      typeof candidate.signature !== 'string' ||
      !candidate.signature ||
      typeof candidate.idempotencyKey !== 'string' ||
      !candidate.idempotencyKey ||
      typeof candidate.payloadDigest !== 'string' ||
      !candidate.payloadDigest ||
      !candidate.asset ||
      typeof candidate.asset !== 'object' ||
      !['cash', 'existing', 'new'].includes(String(candidate.asset.kind)) ||
      tempIds.has(candidate.tempId) ||
      remoteKeys.has(candidate.remoteKey) ||
      idempotencyKeys.has(candidate.idempotencyKey)
    ) {
      return false;
    }
    if (candidate.asset.kind !== 'cash') {
      if (
        typeof candidate.asset.identity !== 'string' ||
        !candidate.asset.identity ||
        typeof candidate.asset.symbol !== 'string' ||
        !candidate.asset.symbol ||
        typeof candidate.asset.exchangeMic !== 'string' ||
        !/^[A-Z0-9]{4}$/.test(candidate.asset.exchangeMic) ||
        typeof candidate.asset.quoteCcy !== 'string' ||
        !candidate.asset.quoteCcy ||
        (candidate.asset.kind === 'existing' &&
          (typeof candidate.asset.assetId !== 'string' || !candidate.asset.assetId))
      ) {
        return false;
      }
    }
    tempIds.add(candidate.tempId);
    remoteKeys.add(candidate.remoteKey);
    idempotencyKeys.add(candidate.idempotencyKey);
  }
  const sorted = [...marker.candidates].sort((left, right) =>
    left.remoteKey.localeCompare(right.remoteKey));
  if (stableHash(sorted) !== marker.batchFingerprint) return false;
  if (marker.phase === 'committed') {
    if (!Array.isArray(marker.committedMappings) || marker.committedMappings.length !== marker.candidateCount) {
      return false;
    }
    const mappedTempIds = new Set<string>();
    const activityIds = new Set<string>();
    for (const mapping of marker.committedMappings) {
      if (
        !mapping ||
        typeof mapping.tempId !== 'string' ||
        !tempIds.has(mapping.tempId) ||
        mappedTempIds.has(mapping.tempId) ||
        typeof mapping.activityId !== 'string' ||
        !mapping.activityId ||
        activityIds.has(mapping.activityId)
      ) {
        return false;
      }
      mappedTempIds.add(mapping.tempId);
      activityIds.add(mapping.activityId);
    }
  }
  return true;
}

export function selectUniqueNativeMarketIdentity(
  candidate: MappedActivity,
  searchResults: SymbolSearchResult[],
  options: { lookupKind?: 'symbol' | 'isin'; lookupValue?: string } = {},
): { identity?: NativeMarketIdentity; problem?: string } {
  const remote = candidate.remoteInstrument;
  const expectedSymbol = String(candidate.activity.symbol ?? '').trim().toUpperCase();
  const expectedCurrency = normalizeSourceCurrency(
    String(remote?.currency ?? candidate.activity.quoteCcy ?? ''),
  );
  const remoteType = String(remote?.type ?? '').trim().toUpperCase();
  if (!remote || !expectedSymbol || !expectedCurrency) {
    return { problem: 'The Trading 212 security identity is incomplete before market lookup.' };
  }
  const lookupKind = options.lookupKind ?? 'symbol';
  if (
    lookupKind === 'isin' &&
    (String(options.lookupValue ?? '').trim().toUpperCase() !== remote.isin.trim().toUpperCase() ||
      !/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(remote.isin.trim().toUpperCase()))
  ) {
    return { problem: 'The ISIN lookup did not use the exact validated Trading 212 ISIN.' };
  }

  const compatible = searchResults.flatMap((result): NativeMarketIdentity[] => {
    const canonicalSymbol = String(
      result.canonicalSymbol ?? result.symbol ?? '',
    ).trim().toUpperCase();
    const exchangeMic = String(
      result.canonicalExchangeMic ?? result.exchangeMic ?? '',
    ).trim().toUpperCase();
    const quoteCcy = String(result.currency ?? '').trim();
    const quoteType = String(result.quoteType ?? '').trim().toUpperCase();
    const providerId = String(result.providerId ?? result.dataSource ?? '').trim();
    const providerSymbol = String(result.providerSymbol ?? '').trim();
    const existingAssetId = String(result.existingAssetId ?? '').trim();
    const name = String(result.longName ?? result.shortName ?? remote.name ?? '').trim();
    const typeCompatible =
      remoteType === 'ETF'
        ? quoteType === 'ETF' || quoteType === 'EQUITY'
        : remoteType === 'STOCK'
          ? quoteType === 'EQUITY'
          : !remoteType && (quoteType === 'EQUITY' || quoteType === 'ETF');
    if (
      (lookupKind !== 'isin' && canonicalSymbol !== expectedSymbol) ||
      !/^[A-Z0-9]{4}$/.test(exchangeMic) ||
      normalizeSourceCurrency(quoteCcy) !== expectedCurrency ||
      !typeCompatible ||
      !name
    ) {
      return [];
    }
    const base: NativeMarketIdentityBase = {
      symbol: canonicalSymbol,
      name,
      exchangeMic,
      quoteCcy,
      instrumentType: 'EQUITY',
      resolutionMethod: lookupKind,
    };
    if (existingAssetId) {
      return [{
        ...base,
        kind: 'existing',
        assetId: existingAssetId,
        ...(providerId ? { providerId } : {}),
        ...(providerSymbol ? { providerSymbol } : {}),
      }];
    }
    if (!providerId || !providerSymbol) return [];
    return [{ ...base, kind: 'new', providerId, providerSymbol }];
  });

  const existing = [
    ...new Map(
      compatible
        .filter((identity): identity is NativeMarketIdentity & { kind: 'existing' } =>
          identity.kind === 'existing')
        .map((identity) => [identity.assetId, identity]),
    ).values(),
  ];
  if (existing.length === 1) return { identity: existing[0] };
  if (existing.length > 1) {
    return {
      problem: `Wealthfolio market data returned ${existing.length} conflicting existing assets for ${expectedSymbol}; automatic selection was blocked.`,
    };
  }

  const unique = [
    ...new Map(
      compatible
        .filter((identity): identity is NativeMarketIdentity & { kind: 'new' } =>
          identity.kind === 'new')
        .map((identity) => [
          [
            identity.symbol,
            identity.exchangeMic,
            normalizeSourceCurrency(identity.quoteCcy),
            identity.instrumentType,
            identity.providerId,
            identity.providerSymbol,
          ].join('|'),
          identity,
        ]),
    ).values(),
  ];
  if (unique.length !== 1) {
    return {
      problem:
        unique.length === 0
          ? `Wealthfolio market data could not uniquely resolve ${expectedSymbol} / ${expectedCurrency}.`
          : `Wealthfolio market data returned ${unique.length} conflicting exact identities for ${expectedSymbol}; automatic selection was blocked.`,
    };
  }
  return { identity: unique[0] };
}

export function toSyncActivityCreate(
  candidate: MappedActivity,
  checked: ActivityImport,
  accountId: string,
): SyncActivityCreate {
  const date = checked.date instanceof Date
    ? checked.date.toISOString()
    : String(checked.date ?? '').trim();
  const currency = String(checked.currency ?? '').trim();
  if (!date || !Number.isFinite(new Date(date).getTime()) || !currency) {
    throw new Error('A Trading 212 activity did not have a valid date or currency.');
  }

  let asset: ActivityCreate['asset'];
  if (candidate.instrumentIdentity) {
    const existingAssetId = String(checked.assetId ?? '').trim();
    if (existingAssetId) {
      asset = { id: existingAssetId };
    } else {
      // Asset creation uses the exact market identity verified before
      // checkImport. The checked row is authoritative for validation status and
      // economic fields, but it must not silently replace that identity.
      const symbol = String(candidate.activity.symbol ?? '').trim().toUpperCase();
      const name = String(candidate.activity.symbolName ?? '').trim();
      const exchangeMic = String(candidate.activity.exchangeMic ?? '').trim().toUpperCase();
      const quoteCcy = String(candidate.activity.quoteCcy ?? '').trim();
      const instrumentType = String(candidate.activity.instrumentType ?? '')
        .trim()
        .toUpperCase();
      const providerId = String(candidate.activity.providerId ?? '').trim();
      const providerSymbol = String(candidate.activity.providerSymbol ?? '').trim();
      if (
        !symbol ||
        !name ||
        !/^[A-Z0-9]{4}$/.test(exchangeMic) ||
        !quoteCcy ||
        instrumentType !== 'EQUITY' ||
        !providerId ||
        !providerSymbol
      ) {
        throw new Error(
          'A Trading 212 security did not have enough verified native metadata for Wealthfolio asset creation.',
        );
      }
      asset = {
        symbol,
        exchangeMic,
        kind: 'INVESTMENT',
        name,
        quoteMode: 'MARKET',
        quoteCcy,
        instrumentType: 'EQUITY',
        providerId,
        providerSymbol,
      };
    }
  } else if (String(checked.assetId ?? '').trim()) {
    throw new Error('A Trading 212 cash activity unexpectedly resolved to a security asset.');
  }

  return {
    id: `t212-${stableHash(candidate.remoteKey)}`,
    accountId,
    activityType: String(checked.activityType),
    subtype: checked.subtype ?? null,
    activityDate: date,
    ...(asset ? { asset } : {}),
    quantity: checked.quantity,
    unitPrice: checked.unitPrice,
    amount: checked.amount,
    currency,
    fee: checked.fee,
    tax: checked.tax,
    comment: checked.comment ?? null,
    fxRate: checked.fxRate,
    metadata: JSON.stringify({
      trading212: {
        schemaVersion: 1,
        remoteKey: candidate.remoteKey,
      },
    }),
    sourceSystem: 'TRADING212',
    sourceRecordId: candidate.remoteKey,
    // Keep the complete account/source identity. SQLite stores this as TEXT,
    // so avoiding a shortened hash removes even a theoretical collision.
    idempotencyKey: `trading212-sync:v1:${accountId}:${candidate.remoteKey}`,
    needsReview: false,
  };
}

export function validateNativeSaveManyResult(
  creates: SyncActivityCreate[],
  candidates: MappedActivity[],
  result: ActivityBulkMutationResult,
  accountId: string,
): Map<string, string> {
  if (
    !result ||
    !Array.isArray(result.errors) ||
    !Array.isArray(result.updated) ||
    !Array.isArray(result.deleted) ||
    !Array.isArray(result.created) ||
    !Array.isArray(result.createdMappings)
  ) {
    throw new Error('Wealthfolio returned a malformed native save result.');
  }
  if (
    creates.length !== candidates.length ||
    result.errors.length !== 0 ||
    result.updated.length !== 0 ||
    result.deleted.length !== 0 ||
    result.created.length !== creates.length ||
    result.createdMappings.length !== creates.length
  ) {
    throw new Error(
      'Wealthfolio did not atomically create the expected Trading 212 activities and assets.',
    );
  }

  const expectedByTempId = new Map<string, { create: SyncActivityCreate; candidate: MappedActivity }>();
  for (let index = 0; index < creates.length; index += 1) {
    const create = creates[index]!;
    const candidate = candidates[index]!;
    const tempId = String(create.id ?? '').trim();
    if (!tempId || expectedByTempId.has(tempId)) {
      throw new Error('Trading 212 native create identifiers were missing or duplicated.');
    }
    expectedByTempId.set(tempId, { create, candidate });
  }

  const createdById = new Map<string, Activity>();
  for (const activity of result.created) {
    const activityId = String(activity.id ?? '').trim();
    if (!activityId || createdById.has(activityId)) {
      throw new Error('Wealthfolio returned missing or duplicated created activity IDs.');
    }
    createdById.set(activityId, activity);
  }
  if (createdById.size !== creates.length) {
    throw new Error('Wealthfolio returned an unexpected number of created activity IDs.');
  }
  const seenTempIds = new Set<string>();
  const seenActivityIds = new Set<string>();
  const assetIdByRemoteKey = new Map<string, string>();
  const assetIdsByInstrument = new Map<string, Set<string>>();
  const securityByAssetId = new Map<string, string>();
  for (const mapping of result.createdMappings) {
    const tempId = String(mapping.tempId ?? '').trim();
    const activityId = String(mapping.activityId ?? '').trim();
    const expected = expectedByTempId.get(tempId);
    const created = createdById.get(activityId);
    if (
      !expected ||
      !created ||
      seenTempIds.has(tempId) ||
      seenActivityIds.has(activityId)
    ) {
      throw new Error('Wealthfolio returned ambiguous native activity identifier mappings.');
    }
    seenTempIds.add(tempId);
    seenActivityIds.add(activityId);
    const differences = nativeCreatedActivityDifferences(expected.create, created, accountId);
    if (differences.length > 0) {
      throw new Error(
        `Wealthfolio changed native Trading 212 activity fields: ${differences.join(', ')}.`,
      );
    }
    const assetId = String(created.assetId ?? '').trim();
    if (!expected.candidate.instrumentIdentity) {
      if (assetId) {
        throw new Error('Wealthfolio linked a Trading 212 cash activity to a security asset.');
      }
      continue;
    }
    if (!assetId) {
      throw new Error('Wealthfolio created a Trading 212 security activity without linking its asset.');
    }
    const requestedAssetId = String(expected.create.asset?.id ?? '').trim();
    if (requestedAssetId && requestedAssetId !== assetId) {
      throw new Error('Wealthfolio changed the exact existing asset selected for an activity.');
    }
    assetIdByRemoteKey.set(expected.candidate.remoteKey, assetId);
    const identity = expected.candidate.instrumentIdentity!;
    const ids = assetIdsByInstrument.get(identity) ?? new Set<string>();
    ids.add(assetId);
    assetIdsByInstrument.set(identity, ids);
    const remote = expected.candidate.remoteInstrument!;
    const securityKey = `${remote.isin}|${normalizeSourceCurrency(remote.currency)}`;
    const prior = securityByAssetId.get(assetId);
    if (prior && prior !== securityKey) {
      throw new Error('Wealthfolio linked conflicting Trading 212 securities to one asset.');
    }
    securityByAssetId.set(assetId, securityKey);
  }
  if (
    seenTempIds.size !== creates.length ||
    seenActivityIds.size !== creates.length ||
    [...createdById].some(([activityId]) => !seenActivityIds.has(activityId)) ||
    [...assetIdsByInstrument.values()].some((assetIds) => assetIds.size !== 1)
  ) {
    throw new Error('Wealthfolio resolved one Trading 212 security to multiple native assets.');
  }
  return assetIdByRemoteKey;
}

function nativeCreatedActivityDifferences(
  expected: SyncActivityCreate,
  actual: Activity,
  accountId: string,
): string[] {
  const differences: string[] = [];
  const compare = (field: string, left: unknown, right: unknown) => {
    if (left !== right) differences.push(field);
  };
  compare('accountId', accountId, actual.accountId);
  compare('activityType', expected.activityType, actual.activityType);
  compare('status', 'POSTED', actual.status);
  compare('isUserModified', false, actual.isUserModified);
  compare('subtype', nullishText(expected.subtype), nullishText(actual.subtype));
  compare('date', canonicalDate(expected.activityDate), canonicalDate(actual.activityDate));
  compare('currency', normalizeCurrency(expected.currency), normalizeCurrency(actual.currency));
  compare('amount', canonicalNumber(expected.amount), canonicalNumber(actual.amount));
  compare('quantity', canonicalNumber(expected.quantity), canonicalNumber(actual.quantity));
  compare('unitPrice', canonicalNumber(expected.unitPrice), canonicalNumber(actual.unitPrice));
  compare('fee', canonicalNumber(expected.fee), canonicalNumber(actual.fee));
  compare('tax', canonicalNumber(expected.tax), canonicalNumber(actual.tax));
  compare('fxRate', canonicalNumber(expected.fxRate), canonicalNumber(actual.fxRate));
  compare('comment', nullishText(expected.comment), nullishText(actual.notes));
  compare('sourceSystem', expected.sourceSystem, actual.sourceSystem);
  compare('sourceRecordId', expected.sourceRecordId, actual.sourceRecordId);
  compare('idempotencyKey', expected.idempotencyKey, actual.idempotencyKey);
  compare('needsReview', false, Boolean(actual.needsReview));
  return differences;
}

export function assertPersistedSourceActivities(
  candidates: MappedActivity[],
  creates: SyncActivityCreate[],
  activities: ActivityDetails[],
  accountId: string,
): void {
  if (candidates.length !== creates.length) {
    throw new Error('Trading 212 persisted-activity verification lost row alignment.');
  }
  const bySourceRecordId = new Map<string, ActivityDetails[]>();
  for (const activity of activities) {
    if (activity.sourceSystem !== 'TRADING212' || !activity.sourceRecordId) continue;
    const matches = bySourceRecordId.get(activity.sourceRecordId) ?? [];
    matches.push(activity);
    bySourceRecordId.set(activity.sourceRecordId, matches);
  }

  for (let index = 0; index < creates.length; index += 1) {
    const create = creates[index]!;
    const candidate = candidates[index]!;
    const matches = bySourceRecordId.get(candidate.remoteKey) ?? [];
    if (matches.length !== 1) {
      throw new Error(
        `Wealthfolio persisted ${matches.length} activities for one Trading 212 source record.`,
      );
    }
    const actual = matches[0]!;
    const differences: string[] = [];
    const compare = (field: string, left: unknown, right: unknown) => {
      if (left !== right) differences.push(field);
    };
    compare('accountId', accountId, actual.accountId);
    compare('activityType', create.activityType, actual.activityType);
    compare('status', 'POSTED', actual.status);
    compare('isUserModified', false, actual.isUserModified);
    compare('subtype', nullishText(create.subtype), nullishText(actual.subtype));
    compare('date', canonicalDate(create.activityDate), canonicalDate(actual.date));
    compare('currency', normalizeCurrency(create.currency), normalizeCurrency(actual.currency));
    compare(
      'amount',
      canonicalPersistedAmount(
        create.activityType,
        create.amount,
        create.quantity,
        create.unitPrice,
      ),
      canonicalPersistedAmount(
        actual.activityType,
        actual.amount,
        actual.quantity,
        actual.unitPrice,
      ),
    );
    compare('quantity', canonicalNumber(create.quantity), canonicalNumber(actual.quantity));
    compare('unitPrice', canonicalNumber(create.unitPrice), canonicalNumber(actual.unitPrice));
    compare('fee', canonicalNumber(create.fee), canonicalNumber(actual.fee));
    compare('tax', canonicalNumber(create.tax), canonicalNumber(actual.tax));
    compare('fxRate', canonicalNumber(create.fxRate), canonicalNumber(actual.fxRate));
    compare('comment', nullishText(create.comment), nullishText(actual.comment));
    compare('sourceSystem', create.sourceSystem, actual.sourceSystem);
    compare('sourceRecordId', create.sourceRecordId, actual.sourceRecordId);
    compare('idempotencyKey', create.idempotencyKey, actual.idempotencyKey);
    compare('needsReview', false, Boolean(actual.needsReview));
    const actualAssetId = String(actual.assetId ?? '').trim();
    if (candidate.instrumentIdentity) {
      if (!actualAssetId) differences.push('assetId');
      const expectedAssetId = String(create.asset?.id ?? '').trim();
      if (expectedAssetId && expectedAssetId !== actualAssetId) differences.push('assetId');
    } else if (actualAssetId) {
      differences.push('assetId');
    }
    if (differences.length > 0) {
      throw new Error(
        `Wealthfolio persisted changed Trading 212 fields: ${[...new Set(differences)].join(', ')}.`,
      );
    }
  }
}

function toStateAccount(account: Account): ControllerState['accounts'][number] {
  return {
    id: account.id,
    name: account.name,
    currency: account.currency,
    trackingMode: account.trackingMode,
  };
}

export function boundAccountProblem(
  current: Account | undefined,
  expectedCurrency: string,
): string | undefined {
  if (
    !current ||
    current.accountType !== 'SECURITIES' ||
    !current.isActive ||
    current.isArchived ||
    current.trackingMode !== 'TRANSACTIONS'
  ) {
    return 'The bound account is missing, inactive, archived, or no longer in Transactions mode.';
  }
  if (normalizeCurrency(current.currency) !== normalizeCurrency(expectedCurrency)) {
    return 'The bound Wealthfolio account currency changed.';
  }
  return undefined;
}

export function collapseBatchResults(rawResults: MappingResult[]): {
  results: MappingResult[];
  batchDuplicates: number;
} {
  const grouped = new Map<string, MappingResult[]>();
  for (const result of rawResults) {
    const remoteKey = result.mapped?.remoteKey ?? result.pending?.remoteKey;
    if (!remoteKey) {
      const fallbackKey = `invalid-result:${stableHash(result)}`;
      grouped.set(fallbackKey, [
        {
          pending: {
            stream: 'transactions',
            remoteKey: fallbackKey,
            reason: 'An internal mapping result had no source ID; the batch was blocked.',
            blocksAutomaticImport: true,
          },
        },
      ]);
      continue;
    }
    const group = grouped.get(remoteKey);
    if (group) group.push(result);
    else grouped.set(remoteKey, [result]);
  }

  const results: MappingResult[] = [];
  let batchDuplicates = 0;
  for (const [remoteKey, group] of grouped) {
    if (group.length === 1) {
      results.push(group[0]);
      continue;
    }
    const mapped = group.flatMap((result) => (result.mapped ? [result.mapped] : []));
    const pending = group.flatMap((result) => (result.pending ? [result.pending] : []));
    if (
      mapped.length === group.length &&
      mapped.every((item) => item.signature === mapped[0]?.signature)
    ) {
      results.push({ mapped: mapped[0] });
      batchDuplicates += group.length - 1;
      continue;
    }
    if (
      pending.length === group.length &&
      pending.every((event) => stableHash(event) === stableHash(pending[0]))
    ) {
      results.push({ pending: pending[0] });
      batchDuplicates += group.length - 1;
      continue;
    }

    const first = mapped[0] ?? pending[0];
    const remoteDate = latestRemoteDate(group);
    const conflict: PendingEvent = {
      stream: first?.stream ?? 'transactions',
      remoteKey,
      reason:
        'The same Trading 212 source ID appeared as conflicting mapped or pending data in one API response.',
    };
    if (remoteDate) conflict.remoteDate = remoteDate;
    if (pending.some((event) => event.blocksAutomaticImport)) {
      conflict.blocksAutomaticImport = true;
    }
    results.push({ pending: conflict });
  }
  return { results, batchDuplicates };
}

export function findRemoteInstrumentConflictReasons(
  activities: MappedActivity[],
  positions: Trading212Position[] = [],
): Map<string, string> {
  const observations: Array<{
    identity: string;
    ticker: string;
    isin: string;
    currency: string;
    name?: string;
  }> = activities.flatMap((activity) => {
    if (!activity.instrumentIdentity || !activity.remoteInstrument) return [];
    return [{ identity: activity.instrumentIdentity, ...activity.remoteInstrument }];
  });
  for (const position of positions) {
    const instrument = position.instrument;
    const identity = trading212InstrumentIdentity(
      instrument,
      instrument?.ticker,
      instrument?.currency,
    );
    const ticker = String(instrument?.ticker ?? '').trim();
    const isin = String(instrument?.isin ?? '').trim().toUpperCase();
    const currency = normalizeSourceCurrency(String(instrument?.currency ?? ''));
    if (!identity || !ticker || !isin || !currency) continue;
    const name = String(instrument?.name ?? '').trim() || undefined;
    observations.push({ identity, ticker, isin, currency, name });
  }

  const conflicts = new Map<string, string>();
  const byTicker = new Map<string, typeof observations>();
  const byIdentity = new Map<string, typeof observations>();
  for (const observation of observations) {
    const tickerRows = byTicker.get(observation.ticker) ?? [];
    tickerRows.push(observation);
    byTicker.set(observation.ticker, tickerRows);
    const identityRows = byIdentity.get(observation.identity) ?? [];
    identityRows.push(observation);
    byIdentity.set(observation.identity, identityRows);
  }
  for (const rows of byTicker.values()) {
    const securityKeys = new Set(rows.map((row) => `${row.isin}|${row.currency}`));
    if (securityKeys.size <= 1) continue;
    for (const row of rows) {
      conflicts.set(
        row.identity,
        `Trading 212 returned ticker ${row.ticker} with conflicting ISIN or quote-currency identities.`,
      );
    }
  }
  for (const rows of byIdentity.values()) {
    const names = new Set(
      rows
        .map((row) => row.name?.replace(/\s+/g, ' ').trim().toUpperCase())
        .filter((name): name is string => Boolean(name)),
    );
    if (names.size <= 1) continue;
    for (const row of rows) {
      conflicts.set(
        row.identity,
        `Trading 212 returned one security identity with conflicting names for ${row.ticker}.`,
      );
    }
  }
  return conflicts;
}

function currentPositionSecurityKey(
  instrument: Trading212Instrument | undefined,
): string | undefined {
  const isin = String(instrument?.isin ?? '').trim().toUpperCase();
  const currency = normalizeSourceCurrency(String(instrument?.currency ?? ''));
  if (!/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(isin) || !currency) return undefined;
  return `${isin}|${currency}`;
}

function buildCurrentPositionInstrumentIndex(
  positions: Trading212Position[],
): Map<string, Trading212Instrument> {
  const candidates = new Map<string, Map<string, Trading212Instrument>>();
  for (const position of positions) {
    const instrument = position.instrument;
    const securityKey = currentPositionSecurityKey(instrument);
    const ticker = String(instrument?.ticker ?? '').trim();
    if (!securityKey || !ticker || !instrument) continue;
    const name = String(instrument.name ?? '').replace(/\s+/g, ' ').trim();
    const type = String(instrument.type ?? '').trim().toUpperCase();
    const fingerprint = `${ticker}|${name.toUpperCase()}|${type}`;
    const byFingerprint = candidates.get(securityKey) ?? new Map<string, Trading212Instrument>();
    byFingerprint.set(fingerprint, instrument);
    candidates.set(securityKey, byFingerprint);
  }

  const result = new Map<string, Trading212Instrument>();
  for (const [securityKey, byFingerprint] of candidates) {
    if (byFingerprint.size === 1) result.set(securityKey, [...byFingerprint.values()][0]!);
  }
  return result;
}

function alignInstrumentWithCurrentPosition(
  instrument: Trading212Instrument | undefined,
  currentBySecurity: Map<string, Trading212Instrument>,
): Trading212Instrument | undefined {
  if (!instrument) return instrument;
  const securityKey = currentPositionSecurityKey(instrument);
  const current = securityKey ? currentBySecurity.get(securityKey) : undefined;
  if (!current) return instrument;
  return {
    ...instrument,
    ticker: current.ticker,
    ...(current.name ? { name: current.name } : {}),
    ...(current.type ? { type: current.type } : {}),
  };
}

function alignOrderWithCurrentPosition(
  item: Trading212HistoricalOrder,
  currentBySecurity: Map<string, Trading212Instrument>,
): Trading212HistoricalOrder {
  if (!item.order?.instrument) return item;
  const originalEmbeddedTicker = String(item.order.instrument.ticker ?? '').trim();
  const originalFallbackTicker = String(item.order.ticker ?? '').trim();
  const aligned = alignInstrumentWithCurrentPosition(item.order.instrument, currentBySecurity);
  const canAlignFallback =
    !originalFallbackTicker || originalFallbackTicker === originalEmbeddedTicker;
  return {
    ...item,
    order: {
      ...item.order,
      instrument: aligned,
      ...(canAlignFallback && aligned?.ticker ? { ticker: aligned.ticker } : {}),
    },
  };
}

function alignDividendWithCurrentPosition(
  item: Trading212Dividend,
  currentBySecurity: Map<string, Trading212Instrument>,
): Trading212Dividend {
  if (!item.instrument) return item;
  const originalEmbeddedTicker = String(item.instrument.ticker ?? '').trim();
  const originalFallbackTicker = String(item.ticker ?? '').trim();
  const aligned = alignInstrumentWithCurrentPosition(item.instrument, currentBySecurity);
  const canAlignFallback =
    !originalFallbackTicker || originalFallbackTicker === originalEmbeddedTicker;
  return {
    ...item,
    instrument: aligned,
    ...(canAlignFallback && aligned?.ticker ? { ticker: aligned.ticker } : {}),
  };
}

function rememberNativeAssetId(
  target: Map<string, string>,
  candidate: MappedActivity,
  rawAssetId: string | undefined,
): void {
  if (!candidate.instrumentIdentity || rawAssetId === undefined) return;
  const assetId = String(rawAssetId).trim();
  if (!assetId) return;
  const existing = target.get(candidate.instrumentIdentity);
  if (existing && existing !== assetId) {
    throw new Error(
      'Wealthfolio resolved one Trading 212 security identity to conflicting local assets.',
    );
  }
  target.set(candidate.instrumentIdentity, assetId);
}

function latestRemoteDate(group: MappingResult[]): string | undefined {
  const times = group
    .map((result) => result.mapped?.remoteDate ?? result.pending?.remoteDate)
    .map((value) => (value ? new Date(value).getTime() : Number.NaN))
    .filter(Number.isFinite);
  return times.length > 0 ? new Date(Math.max(...times)).toISOString() : undefined;
}

export function compareHoldings(
  localHoldings: Holding[],
  mappingContext: MappingContext,
  remoteSummary: Trading212AccountSummary,
  remotePositions: Trading212Position[],
): ReconciliationResult {
  const localPositions = new Map<string, { symbol: string; quantity: number }>();
  let localCash: number | undefined;
  let localCashInvalid = false;
  const differences: ReconciliationResult['positionDifferences'] = [];

  for (const holding of localHoldings) {
    if (holding.holdingType === 'cash') {
      const holdingCurrency = normalizeCurrency(holding.localCurrency);
      const cashQuantity = strictFiniteNumber(holding.quantity);
      if (holdingCurrency === mappingContext.accountCurrency) {
        if (cashQuantity === undefined) localCashInvalid = true;
        else localCash = (localCash ?? 0) + cashQuantity;
      } else if (cashQuantity === undefined || Math.abs(cashQuantity) > 0.02) {
        differences.push({
          symbol: `CASH:${holdingCurrency || 'UNKNOWN'}`,
          remote: 0,
          local: cashQuantity ?? 0,
        });
      }
      continue;
    }
    const assetId = holding.instrument?.id;
    const symbol = holding.instrument?.symbol ?? 'UNKNOWN_LOCAL_ASSET';
    const quantity = strictFiniteNumber(holding.quantity);
    if (!assetId || quantity === undefined) {
      differences.push({ symbol, remote: 0, local: quantity ?? 0 });
      continue;
    }
    const existing = localPositions.get(assetId);
    localPositions.set(assetId, {
      symbol,
      quantity: (existing?.quantity ?? 0) + quantity,
    });
  }
  if (localCashInvalid) localCash = undefined;

  const remotePositionsByAsset = new Map<
    string,
    { binding: AssetBinding; quantity: number }
  >();
  for (const position of remotePositions) {
    const remoteQuantity = strictFiniteNumber(position.quantity);
    const binding = resolveMappedAsset(
      position.instrument,
      position.instrument?.ticker,
      position.instrument?.currency,
      mappingContext,
    );
    if (!binding || remoteQuantity === undefined) {
      differences.push({
        symbol: binding?.symbol ?? `UNMAPPED:${position.instrument?.ticker ?? 'UNKNOWN'}`,
        remote: remoteQuantity ?? 0,
        local: 0,
      });
      continue;
    }
    const existingRemote = remotePositionsByAsset.get(binding.assetId);
    remotePositionsByAsset.set(binding.assetId, {
      binding,
      quantity: (existingRemote?.quantity ?? 0) + remoteQuantity,
    });
  }

  for (const { binding, quantity: remoteQuantity } of remotePositionsByAsset.values()) {
    const local = localPositions.get(binding.assetId);
    const localQuantity = local?.quantity ?? 0;
    if (Math.abs(remoteQuantity - localQuantity) > POSITION_TOLERANCE) {
      differences.push({ symbol: binding.symbol, remote: remoteQuantity, local: localQuantity });
    }
    localPositions.delete(binding.assetId);
  }
  for (const local of localPositions.values()) {
    if (Math.abs(local.quantity) > POSITION_TOLERANCE) {
      differences.push({ symbol: local.symbol, remote: 0, local: local.quantity });
    }
  }

  const remoteCash = sumRemoteCash(remoteSummary.cash);
  const cashDifference =
    remoteCash !== undefined && localCash !== undefined ? localCash - remoteCash : undefined;
  return {
    complete:
      cashDifference !== undefined &&
      Math.abs(cashDifference) <= 0.02 &&
      differences.length === 0,
    remoteCash,
    localCash,
    cashDifference,
    remotePositionCount: remotePositions.length,
    positionDifferences: differences,
  };
}

function reconciliationScore(result: ReconciliationResult): number {
  const cashPenalty =
    result.cashDifference === undefined ? 1_000_000 : Math.abs(result.cashDifference);
  return result.positionDifferences.length * 1_000_000 + cashPenalty;
}

function sumRemoteCash(
  cash: { availableToTrade?: number; inPies?: number; reservedForOrders?: number } | undefined,
): number | undefined {
  if (!cash) return undefined;
  const values = [cash.availableToTrade, cash.inPies, cash.reservedForOrders].map(
    strictFiniteNumber,
  );
  return values.every((value): value is number => value !== undefined)
    ? values.reduce((sum, value) => sum + value, 0)
    : undefined;
}

function flattenValidationErrors(errors: Record<string, string[]> | undefined): string {
  if (!errors) return '';
  return Object.entries(errors)
    .flatMap(([field, messages]) => messages.map((message) => `${field}: ${message}`))
    .join('; ');
}

export function assertImportWireRows(rows: ActivityImport[]): void {
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const invalidFields: string[] = [];
    if (typeof row.accountId !== 'string' || !row.accountId.trim()) invalidFields.push('accountId');
    if (typeof row.activityType !== 'string' || !row.activityType.trim()) {
      invalidFields.push('activityType');
    }
    if (typeof row.date !== 'string' || !row.date.trim()) invalidFields.push('date');
    // Empty is correct for cash movements, but the Rust command still requires
    // the symbol key to be present and deserialize as a string.
    if (typeof row.symbol !== 'string') invalidFields.push('symbol');
    if (typeof row.currency !== 'string' || !row.currency.trim()) invalidFields.push('currency');
    if (typeof row.isValid !== 'boolean') invalidFields.push('isValid');
    if (typeof row.isDraft !== 'boolean') invalidFields.push('isDraft');
    if (typeof row.forceImport !== 'boolean') invalidFields.push('forceImport');
    if (!Number.isInteger(row.lineNumber) || Number(row.lineNumber) < 1) {
      invalidFields.push('lineNumber');
    }
    if (invalidFields.length > 0) {
      throw new Error(
        `Wealthfolio import row ${index + 1} is missing required import fields or invariants: ${invalidFields.join(', ')}; no import validation was attempted.`,
      );
    }
  }
}

export function immutableImportDifferences(
  candidate: ActivityImport,
  checked: ActivityImport,
): string[] {
  const differences: string[] = [];
  const compare = (field: string, left: unknown, right: unknown) => {
    if (left !== right) differences.push(field);
  };

  compare('accountId', candidate.accountId, checked.accountId);
  compare('activityType', candidate.activityType, checked.activityType);
  compare('subtype', nullishText(candidate.subtype), nullishText(checked.subtype));
  compare('date', canonicalDate(candidate.date), canonicalDate(checked.date));
  compare('currency', normalizeCurrency(candidate.currency), normalizeCurrency(checked.currency));
  // assetId is intentionally mutable here: Wealthfolio checkImport owns the
  // native create-or-reuse decision for a fully identified security.
  compare('amount', canonicalNumber(candidate.amount), canonicalNumber(checked.amount));
  compare('quantity', canonicalNumber(candidate.quantity), canonicalNumber(checked.quantity));
  compare('unitPrice', canonicalNumber(candidate.unitPrice), canonicalNumber(checked.unitPrice));
  compare('fee', canonicalNumber(candidate.fee), canonicalNumber(checked.fee));
  compare('tax', canonicalNumber(candidate.tax), canonicalNumber(checked.tax));
  compare('fxRate', canonicalNumber(candidate.fxRate), canonicalNumber(checked.fxRate));
  compare('comment', nullishText(candidate.comment), nullishText(checked.comment));
  compare('isDraft', Boolean(candidate.isDraft), Boolean(checked.isDraft));
  compare('forceImport', Boolean(candidate.forceImport), Boolean(checked.forceImport));
  return differences;
}

/**
 * Validate only the asset-resolution part that Wealthfolio is allowed to add
 * during checkImport. Economic fields are checked separately by
 * immutableImportDifferences.
 */
export function nativeAssetResolutionProblems(
  candidates: MappedActivity[],
  checkedRows: ActivityImport[],
): Map<number, string> {
  const problems = new Map<number, string>();
  const checkedByIndex = new Map<number, ActivityImport>();
  let structurallyAmbiguous = false;

  for (const row of checkedRows) {
    const lineNumber = row.lineNumber;
    if (
      !Number.isInteger(lineNumber) ||
      !lineNumber ||
      lineNumber < 1 ||
      lineNumber > candidates.length
    ) {
      structurallyAmbiguous = true;
      continue;
    }
    const index = lineNumber - 1;
    if (checkedByIndex.has(index)) structurallyAmbiguous = true;
    else checkedByIndex.set(index, row);
  }
  if (checkedByIndex.size !== candidates.length) structurallyAmbiguous = true;
  if (structurallyAmbiguous) {
    for (let index = 0; index < candidates.length; index += 1) {
      problems.set(
        index,
        'Wealthfolio returned ambiguous validation row identities; the entire batch was blocked.',
      );
    }
    return problems;
  }

  const groups = new Map<
    string,
    Array<{ index: number; fingerprint: string; assetId?: string; isin: string; currency: string }>
  >();

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index]!;
    if (!candidate.instrumentIdentity) continue;
    const remote = candidate.remoteInstrument;
    const checked = checkedByIndex.get(index)!;
    if (!remote) {
      problems.set(index, 'An internal Trading 212 security identity was incomplete.');
      continue;
    }

    const checkedWithIsin = checked as ActivityImport & { isin?: string };
    const checkedIsin = String(checkedWithIsin.isin ?? '').trim().toUpperCase();
    const checkedCurrency = normalizeSourceCurrency(String(checked.quoteCcy ?? ''));
    const checkedType = String(checked.instrumentType ?? '').trim().toUpperCase();
    const checkedSymbol = String(checked.symbol ?? '').trim().toUpperCase();
    const checkedMic = String(checked.exchangeMic ?? '').trim().toUpperCase();
    const checkedProviderId = String(checked.providerId ?? '').trim();
    const checkedProviderSymbol = String(checked.providerSymbol ?? '').trim();
    const rawAssetId = checked.assetId;
    const checkedAssetId =
      typeof rawAssetId === 'string' && rawAssetId.trim() ? rawAssetId.trim() : undefined;

    const expectedSymbol = String(candidate.activity.symbol ?? '').trim().toUpperCase();
    const expectedMic = String(candidate.activity.exchangeMic ?? '').trim().toUpperCase();
    const expectedCurrency = normalizeSourceCurrency(
      String(candidate.activity.quoteCcy ?? ''),
    );
    const expectedType = String(candidate.activity.instrumentType ?? '').trim().toUpperCase();
    const expectedProviderId = String(candidate.activity.providerId ?? '').trim();
    const expectedProviderSymbol = String(candidate.activity.providerSymbol ?? '').trim();
    const requestedAssetId = String(candidate.activity.assetId ?? '').trim();

    const identityProblems: string[] = [];
    if (!expectedSymbol || checkedSymbol !== expectedSymbol) identityProblems.push('symbol');
    if (checkedIsin !== remote.isin) identityProblems.push('isin');
    if (
      !expectedCurrency ||
      expectedCurrency !== normalizeSourceCurrency(remote.currency) ||
      checkedCurrency !== expectedCurrency
    ) {
      identityProblems.push('quoteCcy');
    }
    if (expectedType !== 'EQUITY' || checkedType !== expectedType) {
      identityProblems.push('instrumentType');
    }
    if (
      rawAssetId !== undefined &&
      rawAssetId !== null &&
      (typeof rawAssetId !== 'string' || !checkedAssetId || checkedAssetId.length > 128)
    ) {
      identityProblems.push('assetId');
    }
    if (requestedAssetId && checkedAssetId !== requestedAssetId) identityProblems.push('assetId');
    if (!expectedMic || checkedMic !== expectedMic) identityProblems.push('exchangeMic');
    if (!checkedAssetId && checkedProviderId !== expectedProviderId) {
      identityProblems.push('providerId');
    }
    if (!checkedAssetId && checkedProviderSymbol !== expectedProviderSymbol) {
      identityProblems.push('providerSymbol');
    }
    if (identityProblems.length > 0) {
      problems.set(
        index,
        `Wealthfolio validation returned incomplete or conflicting security identity fields: ${identityProblems.join(', ')}.`,
      );
      continue;
    }

    const fingerprint = checkedAssetId
      ? `asset:${checkedAssetId}`
      : `new:${expectedSymbol}|${expectedMic}|${expectedCurrency}|${expectedType}|${checkedIsin}|${expectedProviderId}|${expectedProviderSymbol}`;
    const group = groups.get(candidate.instrumentIdentity) ?? [];
    group.push({
      index,
      fingerprint,
      assetId: checkedAssetId,
      isin: remote.isin,
      currency: normalizeSourceCurrency(remote.currency),
    });
    groups.set(candidate.instrumentIdentity, group);
  }

  for (const group of groups.values()) {
    if (new Set(group.map((entry) => entry.fingerprint)).size <= 1) continue;
    for (const entry of group) {
      problems.set(
        entry.index,
        'Wealthfolio resolved one Trading 212 security identity in more than one way; those rows were blocked.',
      );
    }
  }

  const identitiesByAssetId = new Map<
    string,
    Array<{ index: number; isin: string; currency: string }>
  >();
  for (const group of groups.values()) {
    for (const entry of group) {
      if (!entry.assetId) continue;
      const rows = identitiesByAssetId.get(entry.assetId) ?? [];
      rows.push(entry);
      identitiesByAssetId.set(entry.assetId, rows);
    }
  }
  for (const rows of identitiesByAssetId.values()) {
    const securityKeys = new Set(rows.map((row) => `${row.isin}|${row.currency}`));
    if (securityKeys.size <= 1) continue;
    for (const row of rows) {
      problems.set(
        row.index,
        'Wealthfolio resolved conflicting Trading 212 securities to the same local asset; those rows were blocked.',
      );
    }
  }

  return problems;
}

export function validateDuplicateReference(
  candidate: MappedActivity,
  duplicateActivity: ActivityDetails | undefined,
  accountId: string,
  resolvedAssetId?: string,
): string | undefined {
  if (!duplicateActivity || duplicateActivity.accountId !== accountId) {
    return 'Wealthfolio returned a stale or cross-account duplicate reference; the record was not marked synchronized.';
  }
  if (duplicateActivity.needsReview) {
    return 'The possible existing duplicate still needs Wealthfolio review; the remote record was not marked synchronized.';
  }
  if (duplicateActivity.status !== 'POSTED' || duplicateActivity.isUserModified !== false) {
    return 'The possible existing duplicate was edited or is not posted; the remote record was not marked synchronized.';
  }
  if (
    (candidate.stream === 'orders' || candidate.stream === 'dividends') &&
    (!resolvedAssetId || duplicateActivity.assetId !== resolvedAssetId)
  ) {
    return 'A possible existing duplicate has no unambiguous native Wealthfolio asset resolution.';
  }
  const economicDifferences: string[] = [];
  const compare = (field: string, left: unknown, right: unknown) => {
    if (left !== right) economicDifferences.push(field);
  };
  compare('activityType', candidate.activity.activityType, duplicateActivity.activityType);
  compare(
    'subtype',
    nullishText(candidate.activity.subtype),
    nullishText(duplicateActivity.subtype),
  );
  compare('date', canonicalDate(candidate.activity.date), canonicalDate(duplicateActivity.date));
  compare(
    'currency',
    normalizeCurrency(candidate.activity.currency),
    normalizeCurrency(duplicateActivity.currency),
  );
  compare(
    'amount',
    canonicalPersistedAmount(
      candidate.activity.activityType,
      candidate.activity.amount,
      candidate.activity.quantity,
      candidate.activity.unitPrice,
    ),
    canonicalPersistedAmount(
      duplicateActivity.activityType,
      duplicateActivity.amount,
      duplicateActivity.quantity,
      duplicateActivity.unitPrice,
    ),
  );
  compare(
    'quantity',
    canonicalNumber(candidate.activity.quantity),
    canonicalNumber(duplicateActivity.quantity),
  );
  compare(
    'unitPrice',
    canonicalNumber(candidate.activity.unitPrice),
    canonicalNumber(duplicateActivity.unitPrice),
  );
  compare('fee', canonicalNumber(candidate.activity.fee), canonicalNumber(duplicateActivity.fee));
  compare('tax', canonicalNumber(candidate.activity.tax), canonicalNumber(duplicateActivity.tax));
  compare('fxRate', canonicalNumber(candidate.activity.fxRate), canonicalNumber(duplicateActivity.fxRate));
  if (economicDifferences.length > 0) {
    return `The possible existing duplicate differs in immutable economic fields: ${economicDifferences.join(', ')}.`;
  }
  return undefined;
}

function historyCoverage<T>(
  items: readonly T[],
  getDate: (item: T) => string | undefined,
): { fetched: number; earliestAt?: string; latestAt?: string } {
  const timestamps = items
    .map((item) => {
      const value = getDate(item);
      return value ? new Date(value).getTime() : Number.NaN;
    })
    .filter(Number.isFinite);
  if (timestamps.length === 0) return { fetched: items.length };
  return {
    fetched: items.length,
    earliestAt: new Date(Math.min(...timestamps)).toISOString(),
    latestAt: new Date(Math.max(...timestamps)).toISOString(),
  };
}

function nullishText(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function canonicalDate(value: Date | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : `INVALID:${String(value)}`;
}

function canonicalNumber(value: number | string | null | undefined): string | undefined {
  if (value === null || value === undefined || String(value).trim() === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? decimalString(number) ?? undefined : `INVALID:${String(value)}`;
}

function canonicalPersistedAmount(
  activityType: string,
  amount: number | string | null | undefined,
  quantity: number | string | null | undefined,
  unitPrice: number | string | null | undefined,
): string | undefined {
  if (activityType === 'BUY' || activityType === 'SELL') {
    const normalizedQuantity = strictFiniteNumber(quantity);
    const normalizedUnitPrice = strictFiniteNumber(unitPrice);
    if (normalizedQuantity !== undefined && normalizedUnitPrice !== undefined) {
      return decimalString(normalizedQuantity * normalizedUnitPrice) ?? undefined;
    }
  }
  return canonicalNumber(amount);
}

function strictFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

interface AssetIsinInspection {
  present: boolean;
  valid: boolean;
  values: string[];
}

function inspectAssetIsins(asset: Asset): AssetIsinInspection {
  const inspection: AssetIsinInspection = { present: false, valid: true, values: [] };
  collectIsinValues(asset.metadata, inspection);
  collectIsinValues(asset.providerConfig, inspection);
  return inspection;
}

function extractAssetIsin(asset: Asset): string | undefined {
  const inspection = inspectAssetIsins(asset);
  if (!inspection.present || !inspection.valid) return undefined;
  const unique = [...new Set(inspection.values)];
  return unique.length === 1 ? unique[0] : undefined;
}

function assetProfileIsinConsistent(asset: Asset, expectedIsin: string): boolean {
  const inspection = inspectAssetIsins(asset);
  if (!inspection.present) return true;
  const expected = expectedIsin.trim().toUpperCase();
  return Boolean(
    inspection.valid &&
      /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(expected) &&
      inspection.values.length > 0 &&
      inspection.values.every((value) => value === expected),
  );
}

function assetBindingFromProfile(profile: Asset): AssetBinding | undefined {
  const symbol = profile.instrumentSymbol?.trim() ?? profile.displayCode?.trim();
  if (!symbol || profile.instrumentType !== 'EQUITY' || !profile.quoteCcy) return undefined;
  return {
    assetId: profile.id,
    symbol,
    name: profile.name ?? undefined,
    exchangeMic: profile.instrumentExchangeMic ?? undefined,
    currency: profile.quoteCcy,
    isin: extractAssetIsin(profile),
    instrumentKey: profile.instrumentKey ?? undefined,
  };
}

function collectIsinValues(
  value: unknown,
  inspection: AssetIsinInspection,
  depth = 0,
): void {
  if (!value || typeof value !== 'object' || depth > 5) return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (/^isin$/i.test(key)) {
      inspection.present = true;
      if (typeof nested !== 'string') {
        inspection.valid = false;
        continue;
      }
      const candidate = nested.trim().toUpperCase();
      if (!/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(candidate)) {
        inspection.valid = false;
        continue;
      }
      inspection.values.push(candidate);
      continue;
    }
    collectIsinValues(nested, inspection, depth + 1);
  }
}

function sourceCurrenciesCompatible(
  remoteCurrency: string | undefined,
  localCurrency: string | undefined,
): boolean {
  return Boolean(
    remoteCurrency &&
      localCurrency &&
      normalizeSourceCurrency(remoteCurrency) === normalizeSourceCurrency(localCurrency),
  );
}

function normalizeSourceCurrency(value: string): string {
  if (value === 'GBp' || /^GBX$/i.test(value)) return 'GBX';
  return normalizeCurrency(value);
}

function indexPersistedSourceActivities(
  activities: ActivityDetails[],
): Map<string, ActivityDetails[]> {
  const bySourceRecordId = new Map<string, ActivityDetails[]>();
  for (const activity of activities) {
    if (activity.sourceSystem !== 'TRADING212' || !activity.sourceRecordId) continue;
    const matches = bySourceRecordId.get(activity.sourceRecordId) ?? [];
    matches.push(activity);
    bySourceRecordId.set(activity.sourceRecordId, matches);
  }
  return bySourceRecordId;
}

function canUsePersistedHistoryFallback(
  event: PendingEvent,
  prior: SeenEntry | undefined,
  activitiesBySourceRecordId: Map<string, ActivityDetails[]>,
  accountId: string,
): boolean {
  if (
    !event.blocksAutomaticImport ||
    !event.persistedHistoryFallbackAllowed ||
    !prior ||
    (event.stream !== 'orders' && event.stream !== 'dividends')
  ) {
    return false;
  }
  const matches = activitiesBySourceRecordId.get(event.remoteKey) ?? [];
  if (matches.length !== 1) return false;
  const activity = matches[0]!;
  return Boolean(
    activity.accountId === accountId &&
      activity.sourceSystem === 'TRADING212' &&
      activity.sourceRecordId === event.remoteKey &&
      activity.idempotencyKey === `trading212-sync:v1:${accountId}:${event.remoteKey}` &&
      activity.status === 'POSTED' &&
      activity.isUserModified === false &&
      !activity.needsReview &&
      String(activity.assetId ?? '').trim(),
  );
}

function deduplicatePendingEvents(events: PendingEvent[]): PendingEvent[] {
  const unique = new Map<string, PendingEvent>();
  for (const event of events) {
    const key = event.assetMapping
      ? `asset:${event.assetMapping.instrumentIdentity}`
      : `event:${event.remoteKey}:${event.reason}`;
    if (!unique.has(key)) unique.set(key, event);
  }
  return [...unique.values()];
}

function seenShardNumber(remoteKey: string): number {
  return Number.parseInt(stableHash(remoteKey).slice(0, 8), 16) % SEEN_SHARD_COUNT;
}

function seenShardKey(shardNumber: number): string {
  return `${STORAGE_KEYS.seenShardPrefix}${String(shardNumber).padStart(2, '0')}`;
}

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}
