import type { ActivityType } from '@wealthfolio/addon-sdk';
import { TRADE_RECONCILIATION_TOLERANCE } from './constants';
import type {
  AssetBinding,
  MappedActivity,
  MappingContext,
  MappingResult,
  PendingEvent,
  StreamName,
  Trading212Dividend,
  Trading212HistoricalOrder,
  Trading212Instrument,
  Trading212Position,
  Trading212Tax,
  Trading212Transaction,
} from '../types/trading212';
import {
  asFiniteNumber,
  asNonEmptyString,
  decimalString,
  isoDate,
  normalizeCurrency,
  stableHash,
} from './utils';

const FEE_NAMES = new Set([
  'COMMISSION_TURNOVER',
  'CURRENCY_CONVERSION_FEE',
  'FINRA_FEE',
  'TRANSACTION_FEE',
]);

const TAX_NAMES = new Set([
  'FRENCH_TRANSACTION_TAX',
  'PTM_LEVY',
  'STAMP_DUTY',
  'STAMP_DUTY_RESERVE_TAX',
  'SDRT',
]);

const SAFE_DIVIDEND_TYPES = new Set([
  'ORDINARY',
  'BONUS',
  'PROPERTY_INCOME',
  'INTEREST',
  'DIVIDEND',
  'ORDINARY_MANUFACTURED_PAYMENT',
  'BONUS_MANUFACTURED_PAYMENT',
  'PROPERTY_INCOME_MANUFACTURED_PAYMENT',
  'INTEREST_MANUFACTURED_PAYMENT',
  'DIVIDENDS_PAID_BY_US_CORPORATIONS',
  'DIVIDENDS_PAID_BY_FOREIGN_CORPORATIONS',
  'DIVIDENDS_PAID_BY_US_CORPORATIONS_MANUFACTURED_PAYMENT',
  'DIVIDENDS_PAID_BY_FOREIGN_CORPORATIONS_MANUFACTURED_PAYMENT',
]);

interface ResolvedInstrument {
  asset?: AssetBinding;
  suggestedAsset?: AssetBinding;
  symbol: string;
  name?: string;
  isin?: string;
  rawTicker?: string;
  remoteCurrency?: string;
  instrumentIdentity?: string;
  type?: string;
  issue?: string;
}

export function extractOrderDate(item: Trading212HistoricalOrder): string | undefined {
  return isoDate(item.fill?.filledAt);
}

export function extractDividendDate(item: Trading212Dividend): string | undefined {
  return isoDate(item.paidOn);
}

export function extractTransactionDate(item: Trading212Transaction): string | undefined {
  return isoDate(item.dateTime);
}

export function mapOrder(
  item: Trading212HistoricalOrder,
  context: MappingContext,
): MappingResult {
  const stream: StreamName = 'orders';
  const order = item.order;
  const fill = item.fill;
  const remoteDate = extractOrderDate(item);
  const fillId = fill?.id;
  const pendingFillKey = `missing-fill-id-${stableHash(item)}`;
  const remoteKey = `t212:${context.remoteAccountFingerprint}:fill:${fillId ?? pendingFillKey}`;

  // The orders endpoint also returns cancelled/unfilled rows. They have no
  // economic activity to import, so do not require a complete security
  // identity before classifying them as a non-blocking review item.
  if (!fill || !remoteDate) {
    return pending(stream, remoteKey, 'Order or fill fields are incomplete.', remoteDate);
  }
  if (fill.id === undefined || fill.id === null || String(fill.id).trim() === '') {
    return pending(stream, remoteKey, 'Trading 212 fill ID is missing.', remoteDate);
  }
  if (fill.type !== 'TRADE') {
    return pending(
      stream,
      remoteKey,
      `Unsupported corporate-action fill type: ${fill.type ?? 'UNKNOWN'}.`,
      remoteDate,
    );
  }

  if (!order) {
    return pendingWithPersistedHistoryFallback(
      stream,
      remoteKey,
      'Order fields are incomplete; the instrument identity cannot be verified.',
      remoteDate,
    );
  }

  const embeddedTicker = asNonEmptyString(order.instrument?.ticker);
  const orderTicker = asNonEmptyString(order.ticker);
  if (embeddedTicker && orderTicker && embeddedTicker !== orderTicker) {
    return pending(
      stream,
      remoteKey,
      'Trading 212 returned conflicting embedded and order ticker identities.',
      remoteDate,
      undefined,
      true,
    );
  }

  const rawInstrumentCurrency = order.instrument?.currency;
  if (!asNonEmptyString(rawInstrumentCurrency)) {
    return pendingWithPersistedHistoryFallback(
      stream,
      remoteKey,
      'Instrument source quote currency is missing.',
      remoteDate,
    );
  }
  const instrument = resolveInstrument(
    order.instrument,
    order.ticker,
    rawInstrumentCurrency,
    context,
  );
  if (instrument.issue) {
    return pendingWithPersistedHistoryFallback(
      stream,
      remoteKey,
      instrument.issue,
      remoteDate,
    );
  }

  const side = asNonEmptyString(order.side)?.toUpperCase();
  if (side !== 'BUY' && side !== 'SELL') {
    return pending(stream, remoteKey, 'Order side is neither BUY nor SELL.', remoteDate);
  }

  const quantity = Math.abs(asFiniteNumber(fill.quantity) ?? 0);
  const rawPrice = asFiniteNumber(fill.price);
  if (!(quantity > 0) || rawPrice === undefined || !(rawPrice > 0)) {
    return pending(stream, remoteKey, 'Trade quantity or price is invalid.', remoteDate);
  }
  const isPence = isPenceCurrency(rawInstrumentCurrency);
  const activityCurrency = isPence
    ? 'GBP'
    : normalizeCurrency(rawInstrumentCurrency) || context.accountCurrency;
  const unitPrice = isPence ? rawPrice / 100 : rawPrice;
  const wallet = fill.walletImpact;
  const walletCurrency = normalizeCurrency(wallet?.currency);
  if (!walletCurrency || walletCurrency !== context.accountCurrency) {
    return pending(
      stream,
      remoteKey,
      `Wallet impact currency ${walletCurrency || 'UNKNOWN'} does not match ${context.accountCurrency}.`,
      remoteDate,
    );
  }
  const netValue = Math.abs(asFiniteNumber(wallet?.netValue) ?? 0);
  if (!(netValue > 0)) {
    return pending(stream, remoteKey, 'Trade cash impact is missing.', remoteDate);
  }

  if (wallet?.taxes !== undefined && !Array.isArray(wallet.taxes)) {
    return pending(stream, remoteKey, 'Trading 212 returned malformed trade tax/fee data.', remoteDate);
  }
  const taxItems = Array.isArray(wallet?.taxes) ? wallet.taxes : [];
  if (taxItems.some((tax) => asFiniteNumber(tax.quantity) === undefined)) {
    return pending(stream, remoteKey, 'A Trading 212 tax or fee amount is missing or invalid.', remoteDate);
  }
  if (
    taxItems.some(
      (tax) => Math.abs(asFiniteNumber(tax.quantity) ?? 0) > 0 && !asNonEmptyString(tax.currency),
    )
  ) {
    return pending(stream, remoteKey, 'A Trading 212 tax or fee currency is missing.', remoteDate);
  }
  const unknownTaxes = taxItems.filter(
    (tax) =>
      Math.abs(asFiniteNumber(tax.quantity) ?? 0) > 0 &&
      !FEE_NAMES.has(String(tax.name ?? '').toUpperCase()) &&
      !TAX_NAMES.has(String(tax.name ?? '').toUpperCase()),
  );
  if (unknownTaxes.length > 0) {
    return pending(
      stream,
      remoteKey,
      `Unsupported Trading 212 tax/fee type: ${unknownTaxes[0]?.name ?? 'UNKNOWN'}.`,
      remoteDate,
    );
  }

  const candidateRates = buildFxCandidates(
    activityCurrency,
    context.accountCurrency,
    wallet?.fxRate,
  );
  const evaluated = candidateRates
    .map((rate) => evaluateTradeCash(side, quantity, unitPrice, rate, taxItems, activityCurrency, context.accountCurrency))
    .filter((value): value is TradeEvaluation => value !== undefined)
    .map((value) => ({ ...value, delta: Math.abs(value.accountCash - netValue) }))
    .sort((left, right) => left.delta - right.delta);
  const best = evaluated[0];

  if (!best || best.delta > TRADE_RECONCILIATION_TOLERANCE) {
    const detail = best ? ` Best cash delta is ${best.delta.toFixed(4)}.` : '';
    return pending(
      stream,
      remoteKey,
      `Trade FX/fee/tax cash invariant failed.${detail}`,
      remoteDate,
    );
  }

  const activity = {
    accountId: context.accountId,
    activityType: side === 'BUY' ? 'BUY' : 'SELL',
    date: remoteDate,
    currency: activityCurrency,
    quantity: decimalString(quantity),
    unitPrice: decimalString(unitPrice),
    fee: best.feeNative > 0 ? decimalString(best.feeNative) : null,
    tax: best.taxNative > 0 ? decimalString(best.taxNative) : null,
    fxRate: decimalString(best.rate),
    comment: `Trading 212 | fill:${fillId} | order:${order.id ?? 'unknown'}`,
    isValid: true,
    isDraft: false,
    forceImport: false,
    ...(instrument.asset
      ? { assetId: instrument.asset.assetId, symbol: instrument.asset.symbol }
      : { symbol: instrument.symbol }),
    symbolName: instrument.name,
    isin: instrument.isin,
    exchangeMic: instrument.asset?.exchangeMic,
    quoteCcy: wealthfolioQuoteCurrency(instrument.remoteCurrency) ?? activityCurrency,
    instrumentType: 'EQUITY',
  } as const;

  return mapped(stream, remoteKey, remoteDate, activity, instrument);
}

export function mapDividend(
  item: Trading212Dividend,
  context: MappingContext,
): MappingResult {
  const stream: StreamName = 'dividends';
  const remoteDate = extractDividendDate(item);
  const reference = asNonEmptyString(item.reference);
  const pendingReference = `missing-reference-${stableHash(item)}`;
  const remoteKey = `t212:${context.remoteAccountFingerprint}:dividend:${reference ?? pendingReference}`;
  const type = String(item.type ?? '').toUpperCase();

  const embeddedTicker = asNonEmptyString(item.instrument?.ticker);
  const dividendTicker = asNonEmptyString(item.ticker);
  if (embeddedTicker && dividendTicker && embeddedTicker !== dividendTicker) {
    return pending(
      stream,
      remoteKey,
      'Trading 212 returned conflicting embedded and dividend ticker identities.',
      remoteDate,
      undefined,
      true,
    );
  }

  const embeddedCurrency = sourceInstrumentCurrency(item.instrument?.currency);
  const tickerCurrency = sourceInstrumentCurrency(item.tickerCurrency);
  if (embeddedCurrency && tickerCurrency && embeddedCurrency !== tickerCurrency) {
    return pending(
      stream,
      remoteKey,
      'Trading 212 returned conflicting dividend instrument quote currencies.',
      remoteDate,
      undefined,
      true,
    );
  }

  const rawInstrumentCurrency = item.instrument?.currency ?? item.tickerCurrency;
  if (!asNonEmptyString(rawInstrumentCurrency)) {
    return pendingWithPersistedHistoryFallback(
      stream,
      remoteKey,
      'Dividend instrument source quote currency is missing.',
      remoteDate,
    );
  }
  const instrument = resolveInstrument(
    item.instrument,
    item.ticker,
    rawInstrumentCurrency,
    context,
  );
  if (instrument.issue) {
    return pendingWithPersistedHistoryFallback(
      stream,
      remoteKey,
      instrument.issue,
      remoteDate,
    );
  }
  if (!remoteDate) {
    return pending(stream, remoteKey, 'Dividend payment date is missing.');
  }
  if (!reference) {
    return pending(stream, remoteKey, 'Trading 212 dividend reference is missing.', remoteDate);
  }
  if (!SAFE_DIVIDEND_TYPES.has(type)) {
    return pending(
      stream,
      remoteKey,
      `Dividend type requires manual review: ${type || 'UNKNOWN'}.`,
      remoteDate,
    );
  }

  const amount = asFiniteNumber(item.amount) ?? 0;
  if (!(amount > 0)) {
    return pending(stream, remoteKey, 'Dividend net amount is invalid.', remoteDate);
  }
  const dividendCurrency = normalizeCurrency(item.currency);
  if (!dividendCurrency || dividendCurrency !== context.accountCurrency) {
    return pending(
      stream,
      remoteKey,
      `Dividend currency ${dividendCurrency || 'UNKNOWN'} does not match ${context.accountCurrency}.`,
      remoteDate,
    );
  }
  const activityType: ActivityType = type.includes('INTEREST') ? 'INTEREST' : 'DIVIDEND';

  const activity = {
    accountId: context.accountId,
    activityType,
    date: remoteDate,
    currency: context.accountCurrency,
    amount: decimalString(amount),
    quantity: null,
    unitPrice: null,
    fee: null,
    tax: null,
    fxRate: '1',
    comment: `Trading 212 | dividend:${reference} | net cash`,
    isValid: true,
    isDraft: false,
    forceImport: false,
    ...(instrument.asset
      ? { assetId: instrument.asset.assetId, symbol: instrument.asset.symbol }
      : { symbol: instrument.symbol }),
    symbolName: instrument.name,
    isin: instrument.isin,
    exchangeMic: instrument.asset?.exchangeMic,
    quoteCcy:
      wealthfolioQuoteCurrency(instrument.remoteCurrency) ??
      wealthfolioQuoteCurrency(item.tickerCurrency),
    instrumentType: 'EQUITY',
  } as const;

  return mapped(stream, remoteKey, remoteDate, activity, instrument);
}

export function mapTransaction(
  item: Trading212Transaction,
  context: MappingContext,
): MappingResult {
  const stream: StreamName = 'transactions';
  const remoteDate = extractTransactionDate(item);
  const reference = asNonEmptyString(item.reference);
  const pendingReference = `missing-reference-${stableHash(item)}`;
  const remoteKey = `t212:${context.remoteAccountFingerprint}:transaction:${reference ?? pendingReference}`;
  const rawType = String(item.type ?? '').toUpperCase();
  const rawAmount = asFiniteNumber(item.amount);
  const currency = normalizeCurrency(item.currency);

  if (!remoteDate || rawAmount === undefined || rawAmount === 0 || !currency) {
    return pending(stream, remoteKey, 'Cash transaction fields are incomplete.', remoteDate);
  }
  if (!reference) {
    return pending(stream, remoteKey, 'Trading 212 transaction reference is missing.', remoteDate);
  }
  if (currency !== context.accountCurrency) {
    return pending(
      stream,
      remoteKey,
      `Cash transaction currency ${currency} differs from account currency ${context.accountCurrency}.`,
      remoteDate,
    );
  }
  if (rawType === 'TRANSFER') {
    return pending(
      stream,
      remoteKey,
      'Internal TRANSFER requires manual direction and contribution review.',
      remoteDate,
    );
  }

  let activityType: ActivityType;
  let subtype: string | undefined;
  switch (rawType) {
    case 'DEPOSIT':
      if (rawAmount < 0) {
        return pending(stream, remoteKey, 'Negative deposit reversal requires manual review.', remoteDate);
      }
      activityType = 'DEPOSIT';
      break;
    case 'WITHDRAW':
      if (rawAmount > 0) {
        return pending(stream, remoteKey, 'Positive withdrawal amount requires manual review.', remoteDate);
      }
      activityType = 'WITHDRAWAL';
      break;
    case 'INTEREST_ON_FREE_CASH':
      if (rawAmount < 0) {
        return pending(stream, remoteKey, 'Negative cash-interest reversal requires manual review.', remoteDate);
      }
      activityType = 'INTEREST';
      break;
    case 'LENDING_INTEREST':
      if (rawAmount < 0) {
        return pending(stream, remoteKey, 'Negative lending-interest reversal requires manual review.', remoteDate);
      }
      activityType = 'INTEREST';
      subtype = 'LENDING_INTEREST';
      break;
    case 'FEE':
      return pending(
        stream,
        remoteKey,
        'Standalone FEE is held for review because the API may also embed the same charge in a trade fill.',
        remoteDate,
      );
    default:
      return pending(
        stream,
        remoteKey,
        `Unsupported cash transaction type: ${rawType || 'UNKNOWN'}.`,
        remoteDate,
      );
  }

  const activity = {
    accountId: context.accountId,
    activityType,
    subtype,
    date: remoteDate,
    // Wealthfolio's Rust import command requires the symbol field to exist;
    // an empty string is the documented cash-movement representation.
    symbol: '',
    currency,
    amount: decimalString(Math.abs(rawAmount)),
    fee: null,
    tax: null,
    fxRate: '1',
    comment: `Trading 212 | transaction:${reference}`,
    isValid: true,
    isDraft: false,
    forceImport: false,
  } as const;

  return mapped(stream, remoteKey, remoteDate, activity);
}

export function symbolCandidates(ticker: string | undefined): string[] {
  const raw = String(ticker ?? '').trim();
  if (!raw) return [];
  // Trading 212's lower-case `l_EQ` suffix identifies London listings. Strip
  // it before upper-casing; `/l_EQ$/i` would corrupt symbols like VWRL_EQ.
  const withoutSuffix = raw.endsWith('l_EQ')
    ? raw.slice(0, -4)
    : raw.replace(/_US_EQ$/i, '').replace(/_EQ$/i, '');
  const candidates = [raw, withoutSuffix];
  candidates.push(withoutSuffix.replace('.', '-'), withoutSuffix.replace('-', '.'));
  return [...new Set(candidates.map((value) => value.toUpperCase()).filter(Boolean))];
}

export function trading212InstrumentIdentity(
  instrument: Trading212Instrument | undefined,
  fallbackTicker?: string,
  fallbackCurrency?: string,
): string | undefined {
  const ticker = asNonEmptyString(instrument?.ticker ?? fallbackTicker);
  const isin = asNonEmptyString(instrument?.isin)?.toUpperCase();
  const currency = sourceInstrumentCurrency(instrument?.currency ?? fallbackCurrency);
  if (!ticker || !isin || !isValidIsin(isin) || !currency) return undefined;
  return JSON.stringify([ticker, isin, currency]);
}

export function reviewPositionInstrument(
  position: Trading212Position,
  context: MappingContext,
): PendingEvent | undefined {
  const resolved = resolveInstrument(
    position.instrument,
    position.instrument?.ticker,
    position.instrument?.currency,
    context,
  );
  if (!resolved.issue) return undefined;
  const identity = resolved.instrumentIdentity;
  const remoteKey = `t212:${context.remoteAccountFingerprint}:instrument:${stableHash(identity ?? position)}`;
  return pending(
    'portfolio',
    remoteKey,
    resolved.issue,
    undefined,
    undefined,
    true,
  ).pending;
}

export function resolveMappedAsset(
  instrument: Trading212Instrument | undefined,
  fallbackTicker: string | undefined,
  fallbackCurrency: string | undefined,
  context: MappingContext,
): AssetBinding | undefined {
  return resolveInstrument(instrument, fallbackTicker, fallbackCurrency, context).asset;
}

function resolveInstrument(
  instrument: Trading212Instrument | undefined,
  fallbackTicker: string | undefined,
  fallbackCurrency: string | undefined,
  context: MappingContext,
): ResolvedInstrument {
  const rawTicker = instrument?.ticker ?? fallbackTicker;
  const candidates = symbolCandidates(rawTicker);
  const isin = asNonEmptyString(instrument?.isin)?.toUpperCase();
  const remoteCurrency = sourceInstrumentCurrency(instrument?.currency ?? fallbackCurrency);
  const instrumentIdentity = trading212InstrumentIdentity(
    instrument,
    fallbackTicker,
    fallbackCurrency,
  );
  const base: ResolvedInstrument = {
    symbol: candidates.find((candidate) => !/_EQ$/i.test(candidate)) ?? candidates[0] ?? '',
    name: instrument?.name,
    isin,
    rawTicker,
    remoteCurrency,
    instrumentIdentity,
    type: asNonEmptyString(instrument?.type)?.toUpperCase(),
  };
  if (!instrumentIdentity) {
    return {
      ...base,
      issue: 'Trading 212 instrument ticker, ISIN, or source quote currency is missing; strict mapping is blocked.',
    };
  }
  const resolvedAssetId = context.resolvedAssetIdsByInstrument.get(instrumentIdentity);
  if (resolvedAssetId) {
    const resolved = context.assetsById.get(resolvedAssetId);
    if (!resolved) {
      return { ...base, issue: 'The run-local Wealthfolio asset is no longer available.' };
    }
    if (!currenciesCompatible(remoteCurrency, resolved.currency)) {
      return {
        ...base,
        suggestedAsset: resolved,
        issue: `The resolved asset currency ${resolved.currency ?? 'UNKNOWN'} no longer matches Trading 212 ${remoteCurrency}.`,
      };
    }
    if (isin && resolved.isin && isin !== resolved.isin.toUpperCase()) {
      return {
        ...base,
        suggestedAsset: resolved,
        issue: 'The Trading 212 ISIN conflicts with the resolved Wealthfolio asset.',
      };
    }
    return { ...base, asset: resolved, symbol: resolved.symbol, name: instrument?.name ?? resolved.name };
  }

  // No local UUID is required here. The complete Trading 212 identity is
  // passed through checkImport and then Wealthfolio's native saveMany asset
  // pipeline, which owns exact reuse or creation.
  return base;
}

function sourceInstrumentCurrency(value: string | undefined): string | undefined {
  if (isPenceCurrency(value)) return 'GBX';
  const normalized = normalizeCurrency(value);
  return normalized || undefined;
}

function wealthfolioQuoteCurrency(value: string | undefined): string | undefined {
  const sourceCurrency = sourceInstrumentCurrency(value);
  return sourceCurrency === 'GBX' ? 'GBp' : sourceCurrency;
}

function isValidIsin(value: string): boolean {
  return /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(value);
}

function currenciesCompatible(
  remoteCurrency: string | undefined,
  localCurrency: string | undefined,
): boolean {
  return Boolean(
    remoteCurrency &&
      localCurrency &&
      remoteCurrency === sourceInstrumentCurrency(localCurrency),
  );
}

interface TradeEvaluation {
  rate: number;
  feeNative: number;
  taxNative: number;
  accountCash: number;
}

function evaluateTradeCash(
  side: string,
  quantity: number,
  unitPrice: number,
  rate: number,
  taxes: Trading212Tax[],
  activityCurrency: string,
  accountCurrency: string,
): TradeEvaluation | undefined {
  if (!(rate > 0) || !Number.isFinite(rate)) return undefined;
  let feeNative = 0;
  let taxNative = 0;

  for (const tax of taxes) {
    const rawAmount = Math.abs(asFiniteNumber(tax.quantity) ?? 0);
    const amount = isPenceCurrency(tax.currency) ? rawAmount / 100 : rawAmount;
    if (amount === 0) continue;
    const taxCurrency = isPenceCurrency(tax.currency)
      ? 'GBP'
      : normalizeCurrency(tax.currency);
    if (!taxCurrency) return undefined;
    let nativeAmount: number;
    if (taxCurrency === activityCurrency) nativeAmount = amount;
    else if (taxCurrency === accountCurrency) nativeAmount = amount / rate;
    else return undefined;

    const name = String(tax.name ?? '').toUpperCase();
    if (FEE_NAMES.has(name)) feeNative += nativeAmount;
    else if (TAX_NAMES.has(name)) taxNative += nativeAmount;
  }

  const grossNative = quantity * unitPrice;
  const accountCash =
    side === 'BUY'
      ? (grossNative + feeNative + taxNative) * rate
      : (grossNative - feeNative - taxNative) * rate;
  return { rate, feeNative, taxNative, accountCash };
}

function buildFxCandidates(
  activityCurrency: string,
  accountCurrency: string,
  rawRate: unknown,
): number[] {
  if (activityCurrency === accountCurrency) return [1];
  const rate = asFiniteNumber(rawRate);
  if (!rate || !(rate > 0)) return [];
  return [...new Set([rate, 1 / rate].filter((value) => Number.isFinite(value) && value > 0))];
}

function isPenceCurrency(value: string | undefined): boolean {
  return value === 'GBp' || /^GBX$/i.test(String(value ?? ''));
}

function mapped(
  stream: StreamName,
  remoteKey: string,
  remoteDate: string,
  activity: MappedActivity['activity'],
  instrument?: ResolvedInstrument,
): MappingResult {
  const signature = mappedActivitySignature(activity);
  const instrumentIdentity = instrument?.instrumentIdentity;
  const ticker = asNonEmptyString(instrument?.rawTicker);
  const isin = asNonEmptyString(instrument?.isin)?.toUpperCase();
  const currency = sourceInstrumentCurrency(instrument?.remoteCurrency);
  const type = asNonEmptyString(instrument?.type)?.toUpperCase();
  const remoteInstrument =
    instrumentIdentity && ticker && isin && currency
      ? {
          ticker,
          isin,
          currency,
          ...(asNonEmptyString(instrument?.name)
            ? { name: asNonEmptyString(instrument?.name) }
            : {}),
          ...(type ? { type } : {}),
        }
      : undefined;
  return {
    mapped: {
      stream,
      remoteKey,
      remoteDate,
      signature,
      activity,
      ...(instrumentIdentity ? { instrumentIdentity } : {}),
      ...(remoteInstrument ? { remoteInstrument } : {}),
    },
  };
}

export function mappedActivitySignature(activity: MappedActivity['activity']): string {
  return stableHash({
    activityType: activity.activityType,
    subtype: activity.subtype,
    date: activity.date,
    symbol: activity.symbol,
    amount: activity.amount,
    quantity: activity.quantity,
    unitPrice: activity.unitPrice,
    fee: activity.fee,
    tax: activity.tax,
    currency: activity.currency,
    fxRate: activity.fxRate,
    assetId: activity.assetId,
    isin: activity.isin,
    symbolName: activity.symbolName,
    exchangeMic: activity.exchangeMic,
    quoteCcy: activity.quoteCcy,
    instrumentType: activity.instrumentType,
    providerId: activity.providerId,
    providerSymbol: activity.providerSymbol,
  });
}

/**
 * Seen-state tracks the immutable source/economic payload, not the local UUID
 * that Wealthfolio adds when a newly created security becomes an existing one
 * on the next run. Keep mappedActivitySignature unchanged for crash-ledger
 * compatibility and use this UUID-free form only for seen-state comparisons.
 */
export function mappedActivitySeenSignature(activity: MappedActivity['activity']): string {
  return stableHash({
    activityType: activity.activityType,
    subtype: activity.subtype,
    date: activity.date,
    symbol: activity.symbol,
    amount: activity.amount,
    quantity: activity.quantity,
    unitPrice: activity.unitPrice,
    fee: activity.fee,
    tax: activity.tax,
    currency: activity.currency,
    fxRate: activity.fxRate,
    isin: activity.isin,
    symbolName: activity.symbolName,
    exchangeMic: activity.exchangeMic,
    quoteCcy: activity.quoteCcy,
    instrumentType: activity.instrumentType,
    providerId: activity.providerId,
    providerSymbol: activity.providerSymbol,
  });
}

function pending(
  stream: StreamName,
  remoteKey: string,
  reason: string,
  remoteDate?: string,
  assetMapping?: PendingEvent['assetMapping'],
  blocksAutomaticImport = false,
): MappingResult {
  const event: PendingEvent = { stream, remoteKey, reason };
  if (remoteDate) event.remoteDate = remoteDate;
  if (assetMapping) event.assetMapping = assetMapping;
  if (blocksAutomaticImport) event.blocksAutomaticImport = true;
  return { pending: event };
}

function pendingWithPersistedHistoryFallback(
  stream: StreamName,
  remoteKey: string,
  reason: string,
  remoteDate?: string,
): MappingResult {
  const result = pending(stream, remoteKey, reason, remoteDate, undefined, true);
  if (result.pending) result.pending.persistedHistoryFallbackAllowed = true;
  return result;
}
