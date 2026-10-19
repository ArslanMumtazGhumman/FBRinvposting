import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateBusinessDto } from './dto/update-business.dto';

@Injectable()
export class BusinessService {
  constructor(private readonly prisma: PrismaService) {}

  getBusiness(businessId: string) {
    return this.prisma.business.findUnique({
      where: { id: businessId },
      select: {
        id: true,
        name: true,
        phone: true,
        address: true,
        createdAt: true,
        updatedAt: true,
      },
    }).then((business) => {
      if (!business) {
        throw new NotFoundException('Business not found.');
      }
      return business;
    });
  }

  updateBusiness(businessId: string, dto: UpdateBusinessDto) {
    return this.prisma.business.update({
      where: { id: businessId },
      data: dto,
      select: {
        id: true,
        name: true,
        phone: true,
        address: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }
}
