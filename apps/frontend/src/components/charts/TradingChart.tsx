'use client';

import { useEffect, useRef, useState } from 'react';
import { createChart, CandlestickSeries, ColorType } from 'lightweight-charts';
import type { CandlestickData, IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts';
import { useAppSelector } from '../../store';
import { useGetCandlesQuery } from '../../store/api/market.api';
import { PAIR_DISPLAY, TIMEFRAMES, type Timeframe } from '../../lib/constants';
import { cn } from '../../lib/cn';

interface TradingChartProps {
  pair: string;
}

export function TradingChart({ pair }: TradingChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const [timeframe, setTimeframe] = useState<Timeframe>('1h');

  const prices = useAppSelector((s) => s.market.prices);
  const currentPrice = prices[pair];

  const { data: candles } = useGetCandlesQuery(
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
      timeScale: {
        borderColor: '#2a2d35',
        textColor: '#6b7280',
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
    if (!seriesRef.current || !candles?.length) return;
    const formatted = candles
      .map((c): CandlestickData => ({
        time: Math.floor(new Date(c.bucket ?? c.time).getTime() / 1000) as UTCTimestamp,
        open: parseFloat(c.open),
        high: parseFloat(c.high),
        low: parseFloat(c.low),
        close: parseFloat(c.close),
      }))
      .filter((c) => !isNaN(c.time) && c.time > 0 && !isNaN(c.open))
      .sort((a, b) => a.time - b.time);

    if (formatted.length === 0) return;

    seriesRef.current.setData(formatted);
    chartRef.current?.timeScale().fitContent();
  }, [candles]);

  // Live tick update
  useEffect(() => {
    if (!seriesRef.current || !currentPrice) return;
    seriesRef.current.update({
      time: Math.floor(Date.now() / 1000) as UTCTimestamp,
      open: currentPrice.bid,
      high: currentPrice.bid,
      low: currentPrice.bid,
      close: currentPrice.bid,
    });
  }, [currentPrice]);

        const lastCandle = candles?.[candles.length - 1];
        const pipChange = currentPrice && lastCandle
        ? ((currentPrice.bid - parseFloat(String(lastCandle.open))) * 10000).toFixed(1)
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
              {currentPrice.bid.toFixed(pair.includes('JPY') ? 3 : 5)}
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
              Spread: {(currentPrice.spread * 10000).toFixed(1)}
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