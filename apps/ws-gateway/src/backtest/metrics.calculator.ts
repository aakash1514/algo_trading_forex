import { Trade } from './strategies/strategy.interface';

export class MetricsCalculator {

  // Win rate: % of trades that closed in profit
  static calculateWinRate(trades: Trade[]): number {
    if (trades.length === 0) return 0;
    const winners = trades.filter((t) => t.netPnl > 0).length;
    return parseFloat(((winners / trades.length) * 100).toFixed(2));
  }

  // Profit factor: gross profit / gross loss
  // > 1 = profitable, > 1.5 = decent, > 2 = good
  static calculateProfitFactor(trades: Trade[]): number {
    const grossProfit = trades
      .filter((t) => t.netPnl > 0)
      .reduce((sum, t) => sum + t.netPnl, 0);
    const grossLoss = Math.abs(
      trades.filter((t) => t.netPnl < 0).reduce((sum, t) => sum + t.netPnl, 0),
    );
    if (grossLoss === 0) return grossProfit > 0 ? 999 : 0; // avoid division by zero
    return parseFloat((grossProfit / grossLoss).toFixed(4));
  }

  // Sharpe ratio: (mean daily return) / (std deviation of daily returns)
  // Risk-free rate = 0 for simplicity
  // > 1 acceptable, > 2 good, > 3 excellent
  static calculateSharpeRatio(trades: Trade[]): number {
    if (trades.length < 2) return 0;

    const returns = trades.map((t) => t.netPnl);
    const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
    const variance =
      returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / (returns.length - 1);
    const stdDev = Math.sqrt(variance);

    if (stdDev === 0) return 0;

    // Annualise: multiply by sqrt(252) trading days
    const sharpe = (mean / stdDev) * Math.sqrt(252);
    return parseFloat(sharpe.toFixed(4));
  }

  // Max drawdown: largest peak-to-trough decline in the equity curve
  // Expressed as percentage of peak equity
  static calculateMaxDrawdown(equityCurve: number[]): number {
    if (equityCurve.length < 2) return 0;

    let peak = equityCurve[0];
    let maxDrawdown = 0;

    for (const value of equityCurve) {
      if (value > peak) peak = value;
      const drawdown = peak === 0 ? 0 : ((peak - value) / peak) * 100;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }

    return parseFloat(maxDrawdown.toFixed(4));
  }

  // Build equity curve from trade list — starts at 10,000 base
  static buildEquityCurve(trades: Trade[], startingEquity = 10_000): number[] {
    const curve: number[] = [startingEquity];
    let equity = startingEquity;
    for (const trade of trades) {
      equity += trade.netPnl;
      curve.push(parseFloat(equity.toFixed(2)));
    }
    return curve;
  }
}