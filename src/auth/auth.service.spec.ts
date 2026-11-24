import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import * as argon2 from 'argon2';
import { QueryFailedError } from 'typeorm';
import { UsersService } from '../users/users.service';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  let service: AuthService;
  const users = { create: jest.fn(), findByEmailWithPassword: jest.fn() };
  const jwt = { signAsync: jest.fn().mockResolvedValue('token') };

  beforeEach(async () => {
    jest.clearAllMocks();
    const mod = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: users },
        { provide: JwtService, useValue: jwt },
      ],
    }).compile();
    service = mod.get(AuthService);
  });

  it('register hashes the password and returns a generic message', async () => {
    users.create.mockImplementation((d: { passwordHash: string }) =>
      Promise.resolve({ id: 'u1', email: 'a@b.co', displayName: null, ...d }),
    );
    const res = await service.register({
      email: 'a@b.co',
      password: 'secret123',
    });
    const [[{ passwordHash }]] = users.create.mock.calls as [
      [{ passwordHash: string }],
    ];
    expect(passwordHash).not.toBe('secret123');
    expect(await argon2.verify(passwordHash, 'secret123')).toBe(true);
    expect(res).toEqual({ message: 'Successfully registered' });
    expect(jwt.signAsync).not.toHaveBeenCalled();
  });

  it('register answers a taken email exactly like a new one', async () => {
    users.create.mockRejectedValue(
      new QueryFailedError(
        '',
        [],
        Object.assign(new Error(), { code: '23505' }),
      ),
    );
    await expect(
      service.register({ email: 'a@b.co', password: 'secret123' }),
    ).resolves.toEqual({ message: 'Successfully registered' });
  });

  it('register rethrows unexpected database errors', async () => {
    users.create.mockRejectedValue(new Error('db down'));
    await expect(
      service.register({ email: 'a@b.co', password: 'secret123' }),
    ).rejects.toThrow('db down');
  });

  it('login rejects unknown email and wrong password identically', async () => {
    users.findByEmailWithPassword.mockResolvedValueOnce(null);
    await expect(
      service.login({ email: 'x@y.co', password: 'whatever1' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    users.findByEmailWithPassword.mockResolvedValueOnce({
      id: 'u1',
      email: 'a@b.co',
      displayName: null,
      passwordHash: await argon2.hash('right-password'),
    });
    await expect(
      service.login({ email: 'a@b.co', password: 'wrong-password' }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
