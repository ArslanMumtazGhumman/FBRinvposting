import { createParamDecorator, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { AuthenticatedRequest } from '../auth.types';

export const CurrentBusiness = createParamDecorator(
  (_data: unknown, context: ExecutionContext) => {
    const businessContext = context.switchToHttp().getRequest<AuthenticatedRequest>().businessContext;
    if (!businessContext) {
      throw new ForbiddenException('Business context is not available.');
    }
    return businessContext;
  },
);
