import { Injectable } from '@nestjs/common';
import { FOREXEDGE_VERSION } from '@forexedge/common';

@Injectable()
export class AppService {
  getData(): { message: string; version: string } {
    return {
      message: 'ForexEdge Auth Service',
      version: FOREXEDGE_VERSION,
    };
  }
}