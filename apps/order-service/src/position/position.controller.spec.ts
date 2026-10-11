import { PositionController } from './position.controller';
import { PositionService } from './position.service';

// JwtStrategy puts the user id on req.user.id (not userId). Reading userId gave
// undefined, which TypeORM drops from the WHERE clause, so every user saw and
// could close every user's positions.
describe('PositionController user scoping', () => {
  const req = { user: { id: 'user-1', email: 'a@b.c', role: 'TRADER' } };
  const service = {
    getOpenPositions: jest.fn().mockResolvedValue([]),
    getPosition: jest.fn().mockResolvedValue({}),
    closeAtMarket: jest.fn().mockResolvedValue({}),
  };
  const controller = new PositionController(service as unknown as PositionService);

  afterEach(() => jest.clearAllMocks());

  it('lists only the requesting user\'s positions', async () => {
    await controller.getOpenPositions(req);
    expect(service.getOpenPositions).toHaveBeenCalledWith('user-1');
  });

  it('fetches a position scoped to the requesting user', async () => {
    await controller.getPosition(req, 'pos-1');
    expect(service.getPosition).toHaveBeenCalledWith('user-1', 'pos-1');
  });

  it('closes a position at market scoped to the requesting user', async () => {
    await controller.closePosition(req, 'pos-1');
    expect(service.closeAtMarket).toHaveBeenCalledWith('user-1', 'pos-1');
  });
});

// PATCH /positions/:id body, validated with the app's real ValidationPipe options
describe('PATCH /positions/:id body', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ValidationPipe } = require('@nestjs/common');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { UpdateExitLevelsDto } = require('./dto/update-exit-levels.dto');
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const validate = (body: unknown) => pipe.transform(body, { type: 'body', metatype: UpdateExitLevelsDto });
  const req = { user: { id: 'user-1' } };
  const service = { updateExitLevels: jest.fn().mockResolvedValue({}) };
  const controller = new PositionController(service as unknown as PositionService);

  afterEach(() => jest.clearAllMocks());

  it('passes only the fields sent: a number sets, null clears, absent keeps', async () => {
    await controller.updateExitLevels(req, 'pos-1', await validate({ stopLoss: 1.075, takeProfit: null }));
    expect(service.updateExitLevels).toHaveBeenCalledWith('user-1', 'pos-1', { stopLoss: 1.075, takeProfit: null });

    await controller.updateExitLevels(req, 'pos-1', await validate({ takeProfit: 1.09 }));
    expect(service.updateExitLevels).toHaveBeenLastCalledWith('user-1', 'pos-1', { takeProfit: 1.09 });
  });

  it.each([
    [{ stopLoss: -1 }],
    [{ stopLoss: '1.07' }],
    [{ takeProfit: Number.NaN }],
    [{ stopLoss: 1.07, lots: 2 }],
  ])('rejects %j (400)', async (body) => {
    await expect(validate(body)).rejects.toMatchObject({ status: 400 });
  });
});
