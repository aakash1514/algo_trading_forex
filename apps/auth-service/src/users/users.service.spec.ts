import { UnauthorizedException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import type { UserEntity } from '@forexedge/database';
import { UsersService } from './users.service';

describe('UsersService.findById', () => {
  // TypeORM drops undefined from `where`, so findOne({ where: { id: undefined } })
  // would return the first user in the table.
  it('refuses a missing id instead of returning an arbitrary user', async () => {
    const repo = { findOne: jest.fn().mockResolvedValue({ id: 'first-user' }) };
    const service = new UsersService(repo as unknown as Repository<UserEntity>);
    await expect(service.findById(undefined as unknown as string)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(repo.findOne).not.toHaveBeenCalled();
  });

  it('looks a user up by id', async () => {
    const repo = { findOne: jest.fn().mockResolvedValue({ id: 'u1' }) };
    const service = new UsersService(repo as unknown as Repository<UserEntity>);
    await expect(service.findById('u1')).resolves.toEqual({ id: 'u1' });
    expect(repo.findOne).toHaveBeenCalledWith({ where: { id: 'u1' } });
  });
});
