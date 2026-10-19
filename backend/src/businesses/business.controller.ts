import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { MembershipRole } from '@prisma/client';
import { CurrentBusiness } from '../auth/decorators/current-business.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { BusinessContextGuard } from '../auth/guards/business-context.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { BusinessService } from './business.service';
import { UpdateBusinessDto } from './dto/update-business.dto';

@Controller('business')
@UseGuards(JwtAuthGuard, BusinessContextGuard, RolesGuard)
export class BusinessController {
  constructor(private readonly businesses: BusinessService) {}

  @Get('me')
  getBusiness(@CurrentBusiness() context: { businessId: string }) {
    return this.businesses.getBusiness(context.businessId);
  }

  @Patch('me')
  @Roles(MembershipRole.OWNER, MembershipRole.ADMIN)
  updateBusiness(
    @CurrentBusiness() context: { businessId: string },
    @Body() dto: UpdateBusinessDto,
  ) {
    return this.businesses.updateBusiness(context.businessId, dto);
  }
}
