import {
  Controller, Post, Get, Delete, Body, Param, Query,
  Headers, HttpCode, HttpStatus, UseGuards, Request,
  BadRequestException, Res,
} from '@nestjs/common';
import { Response } from 'express';
import { OrderService } from './order.service';
import { SubmitOrderDto } from './dto/submit-order.dto';
import { OrderStatus } from '@forexedge/database';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

@Controller('orders')
@UseGuards(JwtAuthGuard)
export class OrderController {
  constructor(private readonly orderService: OrderService) {}

  // POST /api/orders
  // Requires X-Idempotency-Key header
  // Returns 200 if key already exists, 201 on new order
  @Post()
  async submitOrder(
    @Request() req: any,
    @Body() dto: SubmitOrderDto,
    @Headers('x-idempotency-key') idempotencyKey: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!idempotencyKey) {
      throw new BadRequestException('X-Idempotency-Key header is required');
    }

    const isExisting = await this.orderService.idempotencyKeyExists(idempotencyKey);

    const order = await this.orderService.submitOrder(
      req.user.id,
      dto,
      idempotencyKey,
    );

    res.status(isExisting ? HttpStatus.OK : HttpStatus.CREATED);
    return order;
  }

  // GET /api/orders
  @Get()
  async getOrders(
    @Request() req: any,
    @Query('status') status?: OrderStatus,
    @Query('pair') pair?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    return this.orderService.getOrders(req.user.id, {
      status,
      pair,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  // GET /api/orders/:id
  @Get(':id')
  async getOrder(@Request() req: any, @Param('id') id: string) {
    return this.orderService.getOrder(req.user.id, id);
  }

  // DELETE /api/orders/:id
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async cancelOrder(@Request() req: any, @Param('id') id: string) {
    return this.orderService.cancelOrder(req.user.id, id);
  }
}