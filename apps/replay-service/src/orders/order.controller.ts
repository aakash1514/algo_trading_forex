import { Body, Controller, HttpCode, HttpStatus, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PlaceOrderDto } from './dto/place-order.dto';
import { ReplayOrderService } from './order.service';

interface AuthenticatedRequest extends Request {
  user: { id: string; email: string; role: string };
}

@Controller('replay/sessions/active')
@UseGuards(JwtAuthGuard)
export class ReplayOrderController {
  constructor(private readonly orders: ReplayOrderService) {}

  // POST /api/replay/sessions/active/orders — a market order, PENDING until the next minute
  @Post('orders')
  place(@Req() req: AuthenticatedRequest, @Body() dto: PlaceOrderDto) {
    return this.orders.place(req.user.id, dto);
  }

  // POST /api/replay/sessions/active/orders/:id/cancel — a PENDING order only (409 once filled)
  @Post('orders/:id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.orders.cancel(req.user.id, id);
  }

  // POST /api/replay/sessions/active/positions/:id/close — fills at the next minute's open
  @Post('positions/:id/close')
  @HttpCode(HttpStatus.OK)
  close(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.orders.close(req.user.id, id);
  }
}
