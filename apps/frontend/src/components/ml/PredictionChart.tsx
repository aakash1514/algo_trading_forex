'use client';

import { useEffect, useRef } from 'react';
import { createChart, createSeriesMarkers, CandlestickSeries, ColorType } from 'lightweight-charts';
import type { CandlestickData, SeriesMarker, UTCTimestamp } from 'lightweight-charts';
import type { MlPrediction } from '../../types/api.types';
import { getPriceFormat } from '../../lib/pip';

// One historical month: each H1 target bar as a candle (its mid OHLC), with a marker for
// the model's predicted direction: an arrow up/down, green when it matched the bar's
// actual open-to-close direction, red when it didn't, grey when the bar isn't scored
// (flat, or under 30 minutes).
export function PredictionChart({ pair, predictions }: { pair: string; predictions: MlPrediction[] }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current || predictions.length === 0) return;
    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: '#0d0f12' },
        textColor: '#6b7280',
        fontSize: 11,
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
      },
      grid: { vertLines: { color: '#1c1f28' }, horzLines: { color: '#1c1f28' } },
      rightPriceScale: { borderColor: '#2a2d35' },
      timeScale: { borderColor: '#2a2d35', timeVisible: true, secondsVisible: false },
      width: containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#4b5563',
      downColor: '#1f2937',
      borderUpColor: '#9ca3af',
      borderDownColor: '#6b7280',
      wickUpColor: '#9ca3af',
      wickDownColor: '#6b7280',
      priceFormat: getPriceFormat(pair),
    });
    const time = (iso: string) => (Date.parse(iso) / 1000) as UTCTimestamp;
    series.setData(
      predictions.map<CandlestickData<UTCTimestamp>>((p) => ({ time: time(p.targetBarTime), ...p.bar })),
    );
    const markers: SeriesMarker<UTCTimestamp>[] = predictions.map((p) => ({
      time: time(p.targetBarTime),
      position: p.predicted === 'UP' ? 'belowBar' : 'aboveBar',
      shape: p.predicted === 'UP' ? 'arrowUp' : 'arrowDown',
      color: !p.scored ? '#6b7280' : p.predicted === p.actual ? '#22c55e' : '#ef4444',
      size: 0.6,
    }));
    createSeriesMarkers(series, markers);
    chart.timeScale().fitContent();

    const ro = new ResizeObserver(() => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth, height: containerRef.current.clientHeight });
      }
    });
    ro.observe(containerRef.current);
    return () => {
      ro.disconnect();
      chart.remove();
    };
  }, [pair, predictions]);

  return <div ref={containerRef} className="w-full h-[360px]" data-testid="prediction-chart" />;
}
