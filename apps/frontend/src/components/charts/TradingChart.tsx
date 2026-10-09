'use client';

import { useEffect, useRef, useState } from 'react';
import { createChart, CandlestickSeries, ColorType } from 'lightweight-charts';
import type { CandlestickData, IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts';
import { useAppSelector } from '../../store';
import { useGetCandlesQuery } from '../../store/api/market.api';
import { PAIR_DISPLAY, TIMEFRAMES, type Timeframe } from '../../lib/constants';
import { getPriceDecimals, priceToPips } from '../../lib/pip';
import { alignToBarStart } from '../../lib/timeframe';
import type { Candle } from '../../types/api.types';
import { cn } from '../../lib/cn';

interface TradingChartProps {
  pair: string;
}

// Postgres NUMERIC columns arrive as strings, so prices may be string or number.
// Returns NaN for empty/invalid input so callers can filter the row out.
function toPrice(value: number | string): number {
  if (typeof value === 'number') return value;
  return value.trim() === '' ? NaN : Number(value);
}

// UTCTimestamp is a branded number (seconds since epoch), so the cast is required.
function toUtcTimestamp(value: string | number | undefined): UTCTimestamp {
  const ms = value === undefined ? NaN : new Date(value).getTime();
  return Math.floor(ms / 1000) as UTCTimestamp;
}

function toCandlestick(c: Candle): CandlestickData<UTCTimestamp> {
  return {
    time: toUtcTimestamp(c.bucket ?? c.time),
    open: toPrice(c.open),
    high: toPrice(c.high),
    low: toPrice(c.low),
    close: toPrice(c.close),
  };
}

function isValidCandle(c: CandlestickData<UTCTimestamp>): boolean {
  return (
    Number.isFinite(c.time) &&
    c.time > 0 &&
    [c.open, c.high, c.low, c.close].every(Number.isFinite)
  );
}

export function TradingChart({ pair }: TradingChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  // Bar that live ticks extend; only valid once history for the current
  // pair/timeframe has been loaded into the series.
  const lastBarRef = useRef<CandlestickData<UTCTimestamp> | null>(null);
  const historyLoadedRef = useRef(false);
  const [timeframe, setTimeframe] = useState<Timeframe>('1h');

  const prices = useAppSelector((s) => s.market.prices);
  const currentPrice = prices[pair];

  // currentData (not data): data keeps the previous pair/timeframe's candles
  // while refetching, which would mix bar sizes in the series.
  const { currentData: candles } = useGetCandlesQuery(
    { pair, timeframe, limit: 200 },
    { skip: !pair }
  );

  // Initialize chart
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#0d0f12' },
        textColor: '#6b7280',
        fontSize: 11,
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
      },
      grid: {
        vertLines: { color: '#1c1f28' },
        horzLines: { color: '#1c1f28' },
      },
      crosshair: {
        vertLine: { color: '#3b4151', width: 1, style: 3 },
        horzLine: { color: '#3b4151', width: 1, style: 3 },
      },
      rightPriceScale: {
        borderColor: '#2a2d35',
        textColor: '#6b7280',
      },
      // Time-scale labels inherit layout.textColor (v5 has no timeScale.textColor).
      timeScale: {
        borderColor: '#2a2d35',
        timeVisible: true,
        secondsVisible: false,
      },
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#22c55e',
      downColor: '#ef4444',
      borderUpColor: '#22c55e',
      borderDownColor: '#ef4444',
      wickUpColor: '#22c55e',
      wickDownColor: '#ef4444',
    });

    chartRef.current = chart;
    seriesRef.current = series;

    const ro = new ResizeObserver(() => {
      if (containerRef.current) {
        chart.applyOptions({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight,
        });
      }
    });
    ro.observe(containerRef.current);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // Load historical candles
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    if (!candles) {
      // History for a new pair/timeframe is loading; hold live ticks until it lands.
      historyLoadedRef.current = false;
      lastBarRef.current = null;
      return;
    }

    const formatted = candles
      .map(toCandlestick)
      .filter(isValidCandle)
      .sort((a, b) => a.time - b.time);

    // setData also clears bars left over from the previous pair/timeframe.
    series.setData(formatted);
    lastBarRef.current = formatted.at(-1) ?? null;
    historyLoadedRef.current = true;
    if (formatted.length > 0) chartRef.current?.timeScale().fitContent();
  }, [candles]);

  // Live tick update: extend the bar the tick falls in, or open the next one.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || !currentPrice || !historyLoadedRef.current) return;

    const tickMs = Date.parse(currentPrice.timestamp);
    const tickSeconds = (Number.isFinite(tickMs) ? tickMs : Date.now()) / 1000;
    // UTCTimestamp is a branded number, so the cast is required.
    const time = alignToBarStart(tickSeconds, timeframe) as UTCTimestamp;
    // Candles are aggregated from mid prices, so live bars use mid too.
    const price = (currentPrice.bid + currentPrice.ask) / 2;
    const last = lastBarRef.current;

    // Out-of-order tick for an earlier bar; series.update() rejects older times.
    if (last && time < last.time) return;

    const bar: CandlestickData<UTCTimestamp> =
      last && time === last.time
        ? {
            ...last,
            high: Math.max(last.high, price),
            low: Math.min(last.low, price),
            close: price,
          }
        : { time, open: price, high: price, low: price, close: price };

    series.update(bar);
    lastBarRef.current = bar;
  }, [currentPrice, timeframe]);

  const lastCandle = candles?.[candles.length - 1];
  const pipChange = currentPrice && lastCandle
    ? priceToPips(
        (currentPrice.bid + currentPrice.ask) / 2 - toPrice(lastCandle.open),
        pair,
      ).toFixed(1)
    : null;
  const isPositive = pipChange ? parseFloat(pipChange) >= 0 : true;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-4 px-4 py-2.5 border-b border-terminal-border bg-terminal-surface shrink-0">
        <span className="text-sm font-medium text-[#e2e4e9]">
          {PAIR_DISPLAY[pair] ?? pair}
        </span>
        {currentPrice && (
          <>
            <span className="tabular-nums text-xl font-medium text-[#e2e4e9]">
              {currentPrice.bid.toFixed(getPriceDecimals(pair))}
            </span>
            {pipChange && (
              <span className={cn(
                'text-[11px] font-medium px-2 py-0.5 rounded tabular-nums',
                isPositive ? 'bg-accent-green/10 text-accent-green' : 'bg-accent-red/10 text-accent-red'
              )}>
                {isPositive ? '▲' : '▼'} {Math.abs(parseFloat(pipChange))} pips
              </span>
            )}
            <span className="text-[11px] text-terminal-muted tabular-nums">
              Spread: {priceToPips(currentPrice.spread, pair).toFixed(1)}
            </span>
          </>
        )}
        <div className="flex items-center gap-1 ml-auto">
          {TIMEFRAMES.map((tf) => (
            <button key={tf} onClick={() => setTimeframe(tf)}
              className={cn(
                'px-2 py-1 text-[11px] rounded transition-colors',
                timeframe === tf
                  ? 'bg-accent-blue/10 text-accent-blue border border-accent-blue/30'
                  : 'text-terminal-muted hover:text-[#e2e4e9]'
              )}>
              {tf}
            </button>
          ))}
        </div>
      </div>
      <div ref={containerRef} className="flex-1 min-h-0" />
    </div>
  );
}