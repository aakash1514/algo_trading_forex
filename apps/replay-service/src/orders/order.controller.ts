import { Body, Controller, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PlaceOrderDto } from './dto/place-order.dto';
import { ReplayOrderService } from './order.service';

interface AuthenticatedRequest extends Request {
  user: { id: string; email: string; role: string };
}

// Every route names its session: the user's, not ENDED (else 404), and their current one
// (else 409 "This replay was paused because you opened another one")
@Controller('replay/sessions/:sessionId')
@UseGuards(JwtAuthGuard)
export class ReplayOrderController {
  constructor(private readonly orders: ReplayOrderService) {}

  // POST /api/replay/sessions/:sessionId/orders — a market order, PENDING until the next minute
  @Post('orders')
  place(@Req() req: AuthenticatedRequest, @Param('sessionId', ParseUUIDPipe) sessionId: string, @Body() dto: PlaceOrderDto) {
    return this.orders.place(req.user.id, sessionId, dto);
  }

  // POST /api/replay/sessions/:sessionId/orders/:id/cancel — a PENDING order only (409 once filled)
  @Post('orders/:id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(@Req() req: AuthenticatedRequest, @Param('sessionId', ParseUUIDPipe) sessionId: string, @Param('id') id: string) {
    return this.orders.cancel(req.user.id, sessionId, id);
  }

  // POST /api/replay/sessions/:sessionId/positions/:id/close — fills at the next minute's open
  @Post('positions/:id/close')
  @HttpCode(HttpStatus.OK)
  close(@Req() req: AuthenticatedRequest, @Param('sessionId', ParseUUIDPipe) sessionId: string, @Param('id') id: string) {
    return this.orders.close(req.user.id, sessionId, id);
  }
}
