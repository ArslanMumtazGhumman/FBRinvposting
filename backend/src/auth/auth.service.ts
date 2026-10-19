import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { MembershipRole, Prisma } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from '../prisma/prisma.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';

const publicUserSelect = {
  id: true,
  name: true,
  email: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async register(dto: RegisterDto) {
    const passwordHash = await bcrypt.hash(dto.password, 12);
    try {
      const user = await this.prisma.$transaction(async (transaction) => {
        const createdUser = await transaction.user.create({
          data: { name: dto.name, email: dto.email, passwordHash },
          select: publicUserSelect,
        });
        const business = await transaction.business.create({ data: { name: dto.businessName } });
        await transaction.membership.create({
          data: {
            userId: createdUser.id,
            businessId: business.id,
            role: MembershipRole.OWNER,
          },
        });
        return { user: createdUser, business };
      });
      return this.createAuthResponse(user.user, user.business.id);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('An account with this email already exists.');
      }
      throw error;
    }
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (!user || !(await bcrypt.compare(dto.password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid email or password.');
    }
    const membership = await this.prisma.membership.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: 'asc' },
      select: { businessId: true },
    });
    if (!membership) {
      throw new UnauthorizedException('This account has no business membership.');
    }
    return this.createAuthResponse({
      id: user.id,
      name: user.name,
      email: user.email,
      createdAt: user.createdAt,
    }, membership.businessId);
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        ...publicUserSelect,
        memberships: {
          select: {
            id: true,
            role: true,
            createdAt: true,
            business: {
              select: { id: true, name: true, phone: true, address: true },
            },
          },
        },
      },
    });
    if (!user) {
      throw new UnauthorizedException();
    }
    return user;
  }

  private async createAuthResponse(
    user: { id: string; name: string; email: string; createdAt: Date },
    businessId: string,
  ) {
    const accessToken = await this.jwt.signAsync(
      { sub: user.id, businessId },
      { expiresIn: this.config.get<string>('JWT_EXPIRES_IN', '1d') as `${number}${'s' | 'm' | 'h' | 'd'}` },
    );
    return { accessToken, tokenType: 'Bearer', user };
  }
}
