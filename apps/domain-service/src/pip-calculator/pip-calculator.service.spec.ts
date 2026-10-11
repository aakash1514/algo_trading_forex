import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { PipCalculatorService } from './pip-calculator.service';
import { InstrumentEntity } from '@forexedge/database';

const mockEurUsd: Partial<InstrumentEntity> = {
  pair: 'EUR/USD',
  pipSize: 0.0001,
  pipDecimalPlaces: 4,
  lotSize: 100000,
  maxLeverage: null,
};

const mockUsdJpy: Partial<InstrumentEntity> = {
  pair: 'USD/JPY',
  pipSize: 0.01,
  pipDecimalPlaces: 2,
  lotSize: 100000,
  maxLeverage: null,
};

const mockEurGbp: Partial<InstrumentEntity> = {
  pair: 'EUR/GBP',
  pipSize: 0.0001,
  pipDecimalPlaces: 4,
  lotSize: 100000,
  maxLeverage: null,
};

const mockGbpJpy: Partial<InstrumentEntity> = {
  pair: 'GBP/JPY',
  pipSize: 0.01,
  pipDecimalPlaces: 2,
  lotSize: 100000,
  maxLeverage: null,
};

describe('PipCalculatorService', () => {
  let service: PipCalculatorService;
  let mockRedis: { get: jest.Mock };
  let mockRepo: { findOne: jest.Mock };

  beforeEach(async () => {
    mockRedis = { get: jest.fn() };
    mockRepo = { findOne: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PipCalculatorService,
        { provide: getRepositoryToken(InstrumentEntity), useValue: mockRepo },
        { provide: 'REDIS_CLIENT', useValue: mockRedis },
      ],
    }).compile();

    service = module.get<PipCalculatorService>(PipCalculatorService);
  });

  describe('DIRECT pairs — quote is USD', () => {
    it('EUR/USD 1 lot → $10.00', async () => {
      mockRepo.findOne.mockResolvedValue(mockEurUsd);
      const result = await service.calculatePipValue('EUR/USD', 1);
      expect(result.pipValue).toBe(10);
      expect(result.calculationPath).toBe('DIRECT');
    });

    it('EUR/USD 0.1 lot → $1.00', async () => {
      mockRepo.findOne.mockResolvedValue(mockEurUsd);
      const result = await service.calculatePipValue('EUR/USD', 0.1);
      expect(result.pipValue).toBe(1);
      expect(result.calculationPath).toBe('DIRECT');
    });

    it('EUR/USD 2.5 lots → $25.00', async () => {
      mockRepo.findOne.mockResolvedValue(mockEurUsd);
      const result = await service.calculatePipValue('EUR/USD', 2.5);
      expect(result.pipValue).toBe(25);
      expect(result.calculationPath).toBe('DIRECT');
    });
  });

  describe('INDIRECT pairs — base is USD', () => {
    it('USD/JPY 1 lot at 149.50 → $6.69', async () => {
      mockRepo.findOne.mockResolvedValue(mockUsdJpy);
      mockRedis.get.mockResolvedValue(JSON.stringify({ mid: 149.50 }));
      const result = await service.calculatePipValue('USD/JPY', 1);
      expect(result.pipValue).toBe(6.69);
      expect(result.calculationPath).toBe('INDIRECT');
    });

    it('USD/JPY 2 lots at 150.00 → $13.33', async () => {
      mockRepo.findOne.mockResolvedValue(mockUsdJpy);
      mockRedis.get.mockResolvedValue(JSON.stringify({ mid: 150.00 }));
      const result = await service.calculatePipValue('USD/JPY', 2);
      expect(result.pipValue).toBe(13.33);
      expect(result.calculationPath).toBe('INDIRECT');
    });
  });

  describe('CROSS pairs — USD is neither base nor quote', () => {
    it('EUR/GBP 1 lot, GBP/USD at 1.27 → $12.70', async () => {
      mockRepo.findOne.mockResolvedValue(mockEurGbp);
      mockRedis.get.mockResolvedValue(JSON.stringify({ mid: 1.27 }));
      const result = await service.calculatePipValue('EUR/GBP', 1);
      expect(result.pipValue).toBe(12.70);
      expect(result.calculationPath).toBe('CROSS');
    });

    it('GBP/JPY 1 lot — tries GBP/USD first, then inverts USD/JPY', async () => {
      mockRepo.findOne.mockResolvedValue(mockGbpJpy);
      // First call: JPY/USD — will fail (no such pair in Redis)
      // Second call: USD/JPY at 149.50 — inverted = 0.006689
      mockRedis.get
        .mockResolvedValueOnce(null)           // JPY/USD not found
        .mockResolvedValueOnce(JSON.stringify({ mid: 149.50 })); // USD/JPY
      const result = await service.calculatePipValue('GBP/JPY', 1);
      // pipValueInQuote = 100000 × 0.01 = 1000 JPY
      // quoteToUsd = 1/149.50 = 0.006689
      // pipValue = 1000 × 0.006689 = 6.69
      expect(result.pipValue).toBe(6.69);
      expect(result.calculationPath).toBe('CROSS');
    });
  });

  describe('Error handling', () => {
    it('throws NotFoundException for unknown pair', async () => {
      mockRepo.findOne.mockResolvedValue(null);
      await expect(service.calculatePipValue('XXX/YYY', 1)).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when Redis has no price', async () => {
      mockRepo.findOne.mockResolvedValue(mockUsdJpy);
      mockRedis.get.mockResolvedValue(null);
      await expect(service.calculatePipValue('USD/JPY', 1)).rejects.toThrow(NotFoundException);
    });
  });
});