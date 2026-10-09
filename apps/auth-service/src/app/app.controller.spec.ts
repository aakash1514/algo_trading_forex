import { Test, TestingModule } from '@nestjs/testing';
import { FOREXEDGE_VERSION } from '@forexedge/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';

describe('AppController', () => {
  let app: TestingModule;

  beforeAll(async () => {
    app = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
    }).compile();
  });

  describe('getData', () => {
    it('returns the service info from AppService', () => {
      const appController = app.get<AppController>(AppController);
      expect(appController.getData()).toEqual({
        message: 'ForexEdge Auth Service',
        version: FOREXEDGE_VERSION,
      });
    });
  });
});
