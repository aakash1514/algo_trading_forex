import { Test } from '@nestjs/testing';
import { FOREXEDGE_VERSION } from '@forexedge/common';
import { AppService } from './app.service';

describe('AppService', () => {
  let service: AppService;

  beforeAll(async () => {
    const app = await Test.createTestingModule({
      providers: [AppService],
    }).compile();

    service = app.get<AppService>(AppService);
  });

  describe('getData', () => {
    it('returns the service name and shared version', () => {
      expect(service.getData()).toEqual({
        message: 'ForexEdge Auth Service',
        version: FOREXEDGE_VERSION,
      });
    });
  });
});
