import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserEntity } from '@forexedge/database';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
  ) {}

  async findByEmail(email: string): Promise<UserEntity | null> {
    return this.userRepo.findOne({ where: { email } });
  }

  async findById(id: string): Promise<UserEntity | null> {
    return this.userRepo.findOne({ where: { id } });
  }

  async create(data: Partial<UserEntity>): Promise<UserEntity> {
    if (!data.email || !data.username) {
      throw new ConflictException('Email and username are required');
    }

    // Check for existing email
    const existingEmail = await this.findByEmail(data.email);
    if (existingEmail) {
      throw new ConflictException('Email already registered');
    }

    // Check for existing username
    const existingUsername = await this.userRepo.findOne({
      where: { username: data.username },
    });
    if (existingUsername) {
      throw new ConflictException('Username already taken');
    }

    const user = this.userRepo.create(data);
    return this.userRepo.save(user);
  }

  async updateLastLogin(id: string): Promise<void> {
    await this.userRepo.update(id, { lastLoginAt: new Date() });
  }
}