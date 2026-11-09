import { ColorType, type CandlestickSeriesPartialOptions, type DeepPartial, type ChartOptions } from 'lightweight-charts';

// The terminal's chart look, shared by the live chart and the replay chart
export const CHART_OPTIONS: DeepPartial<ChartOptions> = {
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
};

export const CANDLE_OPTIONS: CandlestickSeriesPartialOptions = {
  upColor: '#22c55e',
  downColor: '#ef4444',
  borderUpColor: '#22c55e',
  borderDownColor: '#ef4444',
  wickUpColor: '#22c55e',
  wickDownColor: '#ef4444',
};
