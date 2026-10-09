import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { AppController } from './app.controller';
import { PipCalculatorService } from '../pip-calculator/pip-calculator.service';
import { SessionClockService } from '../session-clock/session-clock.service';
import { SpreadMonitorService } from '../spread-monitor/spread-monitor.service';
import { SwapCalculationService } from '../swap-calculation/swap-calculation.service';
import { MarginEngineService } from '../margin-engine/margin-engine.service';
import { EconomicCalendarService } from '../economic-calendar/economic-calendar.service';

describe('AppController', () => {
  let controller: AppController;
  const pipCalculator = { calculatePipValue: jest.fn() };
  const spreadMonitor = { getSpreadStatus: jest.fn() };
  const swapCalculation = { getSwapRate: jest.fn() };
  const marginEngine = { calculateMarginRequired: jest.fn() };

  beforeEach(async () => {
    jest.resetAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        { provide: PipCalculatorService, useValue: pipCalculator },
        { provide: SessionClockService, useValue: {} },
        { provide: SpreadMonitorService, useValue: spreadMonitor },
        { provide: SwapCalculationService, useValue: swapCalculation },
        { provide: MarginEngineService, useValue: marginEngine },
        { provide: EconomicCalendarService, useValue: {} },
      ],
    }).compile();

    controller = module.get(AppController);
  });

  describe('getPipValue', () => {
    it('normalizes EUR_USD to the DB slash format before calculating', async () => {
      pipCalculator.calculatePipValue.mockResolvedValue({ pipValue: 10 });

      await expect(controller.getPipValue('EUR_USD', 1, 'USD')).resolves.toEqual({ pipValue: 10 });
      expect(pipCalculator.calculatePipValue).toHaveBeenCalledWith('EUR/USD', 1, 'USD');
    });
  });

  describe('getSwapRate', () => {
    it('looks up the slash-format pair', async () => {
      const rate = { pair: 'EUR/USD' };
      swapCalculation.getSwapRate.mockResolvedValue(rate);

      await expect(controller.getSwapRate('EUR_USD')).resolves.toBe(rate);
      expect(swapCalculation.getSwapRate).toHaveBeenCalledWith('EUR/USD');
    });

    it('throws NotFoundException when no rate exists', async () => {
      swapCalculation.getSwapRate.mockResolvedValue(null);

      await expect(controller.getSwapRate('EUR_USD')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('getSpreadStatus', () => {
    it('passes the underscore instrument through unchanged', () => {
      const status = { instrument: 'EUR_USD' };
      spreadMonitor.getSpreadStatus.mockReturnValue(status);

      expect(controller.getSpreadStatus('EUR_USD')).toBe(status);
      expect(spreadMonitor.getSpreadStatus).toHaveBeenCalledWith('EUR_USD');
    });

    it('throws NotFoundException when no spread data exists', () => {
      spreadMonitor.getSpreadStatus.mockReturnValue(null);

      expect(() => controller.getSpreadStatus('EUR_USD')).toThrow(NotFoundException);
    });
  });

  describe('calculateMargin', () => {
    it('forwards the body fields to the margin engine', () => {
      marginEngine.calculateMarginRequired.mockReturnValue({ marginRequired: 1085 });

      expect(
        controller.calculateMargin({ pair: 'EUR/USD', lots: 1, leverage: 100, currentPrice: 1.085 }),
      ).toEqual({ marginRequired: 1085 });
      expect(marginEngine.calculateMarginRequired).toHaveBeenCalledWith('EUR/USD', 1, 100, 1.085);
    });
  });
});
