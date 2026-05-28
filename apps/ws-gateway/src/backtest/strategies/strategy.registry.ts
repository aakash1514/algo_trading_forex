import { Injectable } from '@nestjs/common';
import { IStrategy } from './strategy.interface';
import { MovingAverageCrossoverStrategy } from './ma-crossover.strategy';
import { LondonBreakoutStrategy } from './london-breakout.strategy';

@Injectable()
export class StrategyRegistry {
  private readonly strategies = new Map<string, IStrategy>([
    ['ma_crossover', new MovingAverageCrossoverStrategy()],
    ['london_breakout', new LondonBreakoutStrategy()],
  ]);

  get(name: string): IStrategy {
    const strategy = this.strategies.get(name);
    if (!strategy) {
      throw new Error(`Strategy '${name}' not found. Available: ${[...this.strategies.keys()].join(', ')}`);
    }
    return strategy;
  }

  list(): string[] {
    return [...this.strategies.keys()];
  }
}