import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { isUniqueViolation } from '../common/db-errors';
import { UsersService } from '../users/users.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { JwtPayload } from './strategies/jwt.strategy';

export interface AuthResponse {
  accessToken: string;
  user: { id: string; email: string; displayName: string | null };
}

export interface RegisterResponse {
  message: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
  ) {}

  async register(dto: RegisterDto): Promise<RegisterResponse> {
    const passwordHash = await argon2.hash(dto.password);
    try {
      await this.users.create({ ...dto, passwordHash });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
    return {
      message: 'Successfully registered',
    };
  }

  async login(dto: LoginDto): Promise<AuthResponse> {
    const user = await this.users.findByEmailWithPassword(dto.email);
    const ok = user
      ? await argon2.verify(user.passwordHash, dto.password)
      : false;
    if (!user || !ok) throw new UnauthorizedException('Invalid credentials');
    return this.issue(user);
  }

  private async issue(user: {
    id: string;
    email: string;
    displayName: string | null;
  }): Promise<AuthResponse> {
    const payload: JwtPayload = { sub: user.id, email: user.email };
    return {
      accessToken: await this.jwt.signAsync(payload),
      user: { id: user.id, email: user.email, displayName: user.displayName },
    };
  }
}
