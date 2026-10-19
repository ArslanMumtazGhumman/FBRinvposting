import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedRequest } from '../auth.types';

@Injectable()
export class BusinessContextGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const { sub: userId, businessId } = request.user;
    if (!userId || !businessId) {
      throw new UnauthorizedException();
    }

    const membership = await this.prisma.membership.findUnique({
      where: { userId_businessId: { userId, businessId } },
      select: { userId: true, businessId: true, role: true },
    });
    if (!membership) {
      throw new ForbiddenException('You do not have access to this business.');
    }

    request.businessContext = {
      userId: membership.userId,
      businessId: membership.businessId,
      role: membership.role,
    };
    return true;
  }
}
