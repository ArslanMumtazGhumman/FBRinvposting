import { MembershipRole } from '@prisma/client';

export interface JwtPayload {
  sub: string;
  businessId: string;
}

export interface AuthenticatedRequest {
  user: JwtPayload;
  businessContext?: {
    businessId: string;
    userId: string;
    role: MembershipRole;
  };
}
