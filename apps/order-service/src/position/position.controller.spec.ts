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
