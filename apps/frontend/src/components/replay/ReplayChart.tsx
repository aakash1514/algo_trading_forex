'use client';

import { useEffect, useRef } from 'react';
import { createChart, CandlestickSeries } from 'lightweight-charts';
import type { CandlestickData, IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts';
import { useAppSelector } from '../../store';
import { CANDLE_OPTIONS, CHART_OPTIONS } from '../charts/chart-options';
import type { ReplayBar } from '../../types/replay.types';

// Bars shown when a state loads; the rest of the 500 are a scroll to the left away
const VISIBLE_BARS = 150;

// Bid candles, as MetaTrader draws them: exact prices (a mid can fall between two
// points), and the side a long's stop loss is checked on. The ask is in the order panel.
export function toReplayCandle(bar: ReplayBar): CandlestickData<UTCTimestamp> {
  return {
    time: (Date.parse(bar.time) / 1000) as UTCTimestamp, // a branded number, so the cast is required
    open: Number(bar.bid.open),
    high: Number(bar.bid.high),
    low: Number(bar.bid.low),
    close: Number(bar.bid.close),
  };
}

// The replay chart. lightweight-charts keeps its own copy of the bars, so React only
// tells it what changed:
//   a new full state (stateVersion: load, reconnect, timeframe) -> setData, all bars
//   the current bar changed -> update(bar): same start time redraws that candle in
//   place (the partial bar grows); a later start time adds a candle
export function ReplayChart() {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const stateVersion = useAppSelector((s) => s.replay.stateVersion);
  const bars = useAppSelector((s) => s.replay.bars);
  const currentBar = useAppSelector((s) => s.replay.currentBar);
  const priceDecimals = useAppSelector((s) => s.replay.priceDecimals);
  // read by the reload effect, which must run on a new state only, not on every bar
  const latest = useRef({ bars, currentBar });
  latest.current = { bars, currentBar };

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      ...CHART_OPTIONS,
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
    });
    const series = chart.addSeries(CandlestickSeries, CANDLE_OPTIONS);
    chartRef.current = chart;
    seriesRef.current = series;
    const ro = new ResizeObserver(() => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth, height: containerRef.current.clientHeight });
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

  // EUR/USD and GBP/USD 5 decimals, USD/JPY and XAU/USD 3 (the server's priceDecimals)
  useEffect(() => {
    seriesRef.current?.applyOptions({
      priceFormat: { type: 'price', precision: priceDecimals, minMove: Number((10 ** -priceDecimals).toFixed(priceDecimals)) },
    });
  }, [priceDecimals]);

  // Declared before the bar effect: on a new state, setData runs first
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    const { bars: history, currentBar: current } = latest.current;
    const data = (current ? [...history, current] : history).map(toReplayCandle);
    series.setData(data);
    if (data.length > 0) {
      chartRef.current?.timeScale().setVisibleLogicalRange({ from: data.length - VISIBLE_BARS, to: data.length + 5 });
    }
  }, [stateVersion]);

  useEffect(() => {
    if (currentBar) seriesRef.current?.update(toReplayCandle(currentBar));
  }, [currentBar]);

  return <div ref={containerRef} data-testid="replay-chart" className="flex-1 min-h-0" />;
}
