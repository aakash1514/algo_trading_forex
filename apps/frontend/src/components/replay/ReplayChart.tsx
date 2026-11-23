'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { createChart, createSeriesMarkers, CandlestickSeries } from 'lightweight-charts';
import type {
  CandlestickData, IChartApi, ISeriesApi, ISeriesMarkersPluginApi, MouseEventParams, Time, UTCTimestamp,
} from 'lightweight-charts';
import { useAppSelector } from '../../store';
import { selectReplayCalendarEvents } from '../../store/slices/replay.slice';
import { CANDLE_OPTIONS, CHART_OPTIONS } from '../charts/chart-options';
import type { CalendarEvent, ReplayBar } from '../../types/replay.types';
import { calendarMarkers, CalendarHoverCard, ReplayCalendarBar, shownCalendarEvents } from './ReplayCalendar';

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
// Calendar events the clock has reached (the server sends no later one) are markers on
// the bar that holds them; hovering that bar shows their card.
export function ReplayChart() {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const stateVersion = useAppSelector((s) => s.replay.stateVersion);
  const bars = useAppSelector((s) => s.replay.bars);
  const currentBar = useAppSelector((s) => s.replay.currentBar);
  const priceDecimals = useAppSelector((s) => s.replay.priceDecimals);
  const calendar = useAppSelector(selectReplayCalendarEvents);
  const covered = useAppSelector((s) => s.replay.calendar.covered);
  const [showMedium, setShowMedium] = useState(false);
  const shown = useMemo(() => shownCalendarEvents(calendar, showMedium), [calendar, showMedium]);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const [hover, setHover] = useState<{ events: CalendarEvent[]; x: number; y: number } | null>(null);
  // read by the crosshair handler, which is subscribed once
  const shownRef = useRef(shown);
  shownRef.current = shown;
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
    markersRef.current = createSeriesMarkers(series, []);
    const onCrosshair = (param: MouseEventParams<Time>) => {
      const here = param.time === undefined || !param.point ? []
        : shownRef.current.filter((e) => Date.parse(e.barTime) / 1000 === param.time);
      setHover(here.length > 0 && param.point ? { events: here, x: param.point.x, y: param.point.y } : null);
    };
    chart.subscribeCrosshairMove(onCrosshair);
    const ro = new ResizeObserver(() => {
      if (containerRef.current) {
        chart.applyOptions({ width: containerRef.current.clientWidth, height: containerRef.current.clientHeight });
      }
    });
    ro.observe(containerRef.current);
    return () => {
      ro.disconnect();
      chart.unsubscribeCrosshairMove(onCrosshair);
      markersRef.current = null;
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

  // After the bars (declared later): a new state's markers land on its new bars
  useEffect(() => {
    markersRef.current?.setMarkers(calendarMarkers(shown));
  }, [shown, stateVersion]);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <ReplayCalendarBar covered={covered} shown={shown.length} showMedium={showMedium}
        onToggleMedium={() => setShowMedium((v) => !v)} />
      {/* the hover card is placed in the chart pane's own coordinates */}
      <div className="relative flex-1 min-h-0 flex">
        <div ref={containerRef} data-testid="replay-chart" className="flex-1 min-h-0" />
        {hover && <CalendarHoverCard events={hover.events} x={hover.x} y={hover.y} />}
      </div>
    </div>
  );
}
