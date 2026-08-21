import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from '@wealthfolio/ui';
import type { SyncController } from '../lib/sync-controller';
import type { ControllerState } from '../types/trading212';
import { FULL_HISTORY_START_AT } from '../lib/constants';
import { formatError } from '../lib/utils';

interface Props {
  controller: SyncController;
}

const EMPTY_STATE: ControllerState = {
  initialized: false,
  configured: false,
  autoEnabled: false,
  syncing: false,
  accounts: [],
};

export function SyncSettingsPage({ controller }: Props) {
  const [state, setState] = useState<ControllerState>(() => controller.getState() ?? EMPTY_STATE);
  const [accountId, setAccountId] = useState(state.accountId ?? '');
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [isaConfirmed, setIsaConfirmed] = useState(false);
  const [actionError, setActionError] = useState<string>();

  useEffect(() => controller.subscribe(setState), [controller]);

  useEffect(() => {
    if (state.accountId && !accountId) setAccountId(state.accountId);
  }, [accountId, state.accountId]);

  const selectedAccount = useMemo(
    () => state.accounts.find((account) => account.id === accountId),
    [accountId, state.accounts],
  );

  const runAction = async (action: () => Promise<unknown>) => {
    setActionError(undefined);
    try {
      await action();
    } catch (error) {
      setActionError(formatError(error));
    }
  };

  const connectAndSync = () =>
    runAction(async () => {
      try {
        await controller.configure(
          accountId,
          apiKey,
          apiSecret,
          FULL_HISTORY_START_AT,
          isaConfirmed,
        );
      } finally {
        setApiKey('');
        setApiSecret('');
      }
    });

  const forgetCredentials = () => {
    if (
      !window.confirm(
        'Remove the saved Trading 212 API credentials from this device and stop automatic sync?',
      )
    ) {
      return;
    }
    void runAction(async () => {
      await controller.forgetCredentials();
      setApiKey('');
      setApiSecret('');
      setIsaConfirmed(false);
    });
  };

  const summary = state.lastSummary;
  const reconciliation = summary?.reconciliation;
  const pendingEvents = summary?.pending ?? [];
  const positionMismatch = (reconciliation?.positionDifferences.length ?? 0) > 0;

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Trading 212 Sync</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Read-only synchronization of investment activity, positions, and cash. Checks every
            five minutes while Wealthfolio is open.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge variant={state.configured ? 'default' : 'secondary'}>
            {state.configured ? 'API connected' : 'Not connected'}
          </Badge>
          <Badge variant={state.autoEnabled ? 'default' : 'outline'}>
            {state.autoEnabled ? 'Automatic sync on' : 'Automatic sync paused'}
          </Badge>
        </div>
      </div>

      <Alert>
        <AlertTitle>Use read-only API credentials</AlertTitle>
        <AlertDescription>
          In Trading 212, enable only Account data, Portfolio, and the History scopes for orders,
          dividends, and transactions. Do not enable permissions to place, modify, or cancel
          orders. The API secret is stored only in your operating system credential store.
        </AlertDescription>
      </Alert>

      {(actionError || state.lastError) && (
        <Alert variant="destructive">
          <AlertTitle>Action not completed</AlertTitle>
          <AlertDescription>{actionError ?? state.lastError}</AlertDescription>
        </Alert>
      )}

      {!state.configured && (
        <Card>
          <CardHeader>
            <CardTitle>Connect and run the first sync</CardTitle>
            <CardDescription>
              Select a new, empty account and enter the API key and secret. After verification,
              the add-on reads all history available from Trading 212, identifies securities
              automatically, and imports it in one pass.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5 md:grid-cols-2">
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="wealthfolio-account">Target Wealthfolio account</Label>
              <select
                id="wealthfolio-account"
                value={accountId}
                onChange={(event) => setAccountId(event.target.value)}
                disabled={state.syncing}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="">Select an account</option>
                {state.accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name} · {account.currency} · {formatTrackingMode(account.trackingMode)}
                  </option>
                ))}
              </select>
              {selectedAccount && selectedAccount.trackingMode !== 'TRANSACTIONS' && (
                <p className="text-sm text-destructive">
                  Select an account that uses transaction tracking.
                </p>
              )}
              {state.accounts.length === 0 && state.initialized && (
                <p className="text-sm text-muted-foreground">
                  No eligible account is available. First create a GBP securities account in
                  Wealthfolio that uses transaction tracking.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="t212-key">Trading 212 API Key</Label>
              <Input
                id="t212-key"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="Enter the API key on this device"
                disabled={state.syncing}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="t212-secret">Trading 212 API Secret</Label>
              <Input
                id="t212-secret"
                type="password"
                autoComplete="off"
                value={apiSecret}
                onChange={(event) => setApiSecret(event.target.value)}
                placeholder="Enter the API secret on this device"
                disabled={state.syncing}
              />
            </div>

            <label className="flex items-start gap-3 rounded-md border p-3 text-sm md:col-span-2">
              <input
                type="checkbox"
                checked={isaConfirmed}
                onChange={(event) => setIsaConfirmed(event.target.checked)}
                disabled={state.syncing}
                className="mt-1"
              />
              <span>
                I confirm that this API key and secret were created for my Trading 212
                <strong> Stocks &amp; Shares ISA </strong>
                account, not an Invest, CFD, or other account.
              </span>
            </label>

            <div className="md:col-span-2">
              <Button
                onClick={() => void connectAndSync()}
                disabled={
                  state.syncing ||
                  !accountId ||
                  !apiKey.trim() ||
                  !apiSecret.trim() ||
                  !isaConfirmed ||
                  selectedAccount?.trackingMode !== 'TRANSACTIONS'
                }
              >
                {state.syncing ? 'Syncing…' : 'Connect and sync full history'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {state.configured && (
        <Card>
          <CardHeader>
            <CardTitle>Sync controls</CardTitle>
            <CardDescription>
              Automatic sync only reads Trading 212 data and writes new Wealthfolio activities.
              It does not run while Wealthfolio is closed or the computer is asleep.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => void runAction(() => controller.setAutoEnabled(!state.autoEnabled))}
                disabled={
                  state.syncing ||
                  !state.baselineConfirmed ||
                  !state.isaConfirmed
                }
                variant={state.autoEnabled ? 'outline' : 'default'}
              >
                {state.autoEnabled ? 'Pause automatic sync' : 'Enable five-minute sync'}
              </Button>
              <Button
                variant="secondary"
                onClick={() => void runAction(() => controller.syncNow())}
                disabled={state.syncing}
              >
                {state.syncing ? 'Syncing…' : 'Sync now'}
              </Button>
              <Button variant="destructive" onClick={forgetCredentials} disabled={state.syncing}>
                Remove saved credentials
              </Button>
            </div>

            <dl className="grid gap-3 text-sm sm:grid-cols-3">
              <StatusItem label="Target account" value={selectedAccount?.name ?? 'Configured account'} />
              <StatusItem label="Last successful sync" value={formatDate(state.lastSuccessfulSyncAt)} />
              <StatusItem label="Next automatic check" value={formatDate(state.nextSyncAt)} />
            </dl>
          </CardContent>
        </Card>
      )}

      {summary && (
        <Card>
          <CardHeader>
            <CardTitle>Latest sync result</CardTitle>
            <CardDescription>{formatDate(summary.completedAt)}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <Metric label="API records" value={summary.fetched} />
              <Metric label="Already synced" value={summary.alreadySeen} />
              <Metric label="Duplicates" value={summary.duplicates} />
              <Metric label="Validated" value={summary.valid} />
              <Metric label="Imported now" value={summary.imported} />
              <Metric label="Pending" value={summary.pendingTotal ?? pendingEvents.length} />
            </div>

            {summary.streamCoverage && (
              <div>
                <h3 className="mb-2 font-medium">Data coverage</h3>
                <div className="grid gap-3 md:grid-cols-3">
                  {(['orders', 'dividends', 'transactions'] as const).map((stream) => {
                    const coverage = summary.streamCoverage![stream];
                    return (
                      <div key={stream} className="rounded-md border p-3 text-sm">
                        <div className="font-medium">
                          {streamLabel(stream)}: {coverage.fetched} records
                        </div>
                        <div className="mt-1 text-muted-foreground">
                          Earliest: {formatDate(coverage.earliestAt)}
                        </div>
                        <div className="text-muted-foreground">
                          Latest: {formatDate(coverage.latestAt)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {summary.autoPaused && summary.autoPauseReason && (
              <Alert variant="destructive">
                <AlertTitle>Automatic sync paused</AlertTitle>
                <AlertDescription>{summary.autoPauseReason}</AlertDescription>
              </Alert>
            )}

            {reconciliation && (
              <div className="rounded-lg border p-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                  <h3 className="font-medium">Position and cash reconciliation</h3>
                  <Badge variant={reconciliation.complete ? 'default' : 'destructive'}>
                    {reconciliation.complete ? 'Reconciled' : 'Differences found or data not yet updated'}
                  </Badge>
                </div>
                <dl className="grid gap-3 text-sm sm:grid-cols-3">
                  <StatusItem
                    label="Trading 212 cash"
                    value={formatMoney(reconciliation.remoteCash)}
                  />
                  <StatusItem
                    label="Wealthfolio cash"
                    value={formatMoney(reconciliation.localCash)}
                  />
                  <StatusItem label="Cash difference" value={formatMoney(reconciliation.cashDifference)} />
                </dl>
                {positionMismatch && (
                  <div className="mt-4">
                    <p className="mb-2 text-sm font-medium text-destructive">Position differences</p>
                    <ul className="space-y-1 text-sm text-destructive">
                      {reconciliation.positionDifferences.slice(0, 20).map((difference) => (
                        <li key={difference.symbol}>
                          {difference.symbol}: Trading 212 {difference.remote} / Wealthfolio{' '}
                          {difference.local}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            {pendingEvents.length > 0 && (
              <div>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-medium">Pending review</h3>
                  <span className="text-sm text-muted-foreground">
                    These records have not been written, preventing an unsafe import.
                  </span>
                </div>
                <ul className="max-h-72 space-y-2 overflow-auto text-sm">
                  {pendingEvents.slice(0, 50).map((event) => (
                    <li key={`${event.remoteKey}-${event.reason}`} className="rounded-md border p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-mono text-xs text-muted-foreground">
                          {event.remoteKey}
                        </span>
                        <Badge variant={event.blocksAutomaticImport ? 'destructive' : 'secondary'}>
                          {event.blocksAutomaticImport ? 'Pauses automatic import' : 'Review only'}
                        </Badge>
                      </div>
                      <div className="mt-1">{event.reason}</div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border p-3 text-center">
      <div className="text-2xl font-semibold">{value}</div>
      <div className="mt-1 text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function StatusItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-1 font-medium">{value}</dd>
    </div>
  );
}

function formatTrackingMode(value: string): string {
  return value === 'TRANSACTIONS' ? 'Transaction tracking' : value;
}

function streamLabel(stream: 'orders' | 'dividends' | 'transactions'): string {
  if (stream === 'orders') return 'Orders';
  if (stream === 'dividends') return 'Dividends';
  return 'Cash transactions';
}

function formatDate(value: string | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('en-GB');
}

function formatMoney(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(value);
}
