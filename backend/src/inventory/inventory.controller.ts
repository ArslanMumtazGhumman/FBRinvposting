import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { MembershipRole } from '@prisma/client';
import { CurrentBusiness } from '../auth/decorators/current-business.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtPayload } from '../auth/auth.types';
import { BusinessContextGuard } from '../auth/guards/business-context.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CreateCategoryDto } from './dto/create-category.dto';
import { CreateStockAdjustmentDto } from './dto/create-stock-adjustment.dto';
import { CreateProductDto } from './dto/create-product.dto';
import { CreateStockMovementDto } from './dto/create-stock-movement.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { InventoryService } from './inventory.service';

@Controller()
@UseGuards(JwtAuthGuard, BusinessContextGuard, RolesGuard)
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Get('categories')
  listCategories(@CurrentBusiness() context: { businessId: string }) {
    return this.inventory.listCategories(context.businessId);
  }

  @Post('categories')
  @Roles(MembershipRole.OWNER, MembershipRole.ADMIN)
  createCategory(
    @CurrentBusiness() context: { businessId: string },
    @Body() dto: CreateCategoryDto,
  ) {
    return this.inventory.createCategory(context.businessId, dto);
  }

  @Patch('categories/:id')
  @Roles(MembershipRole.OWNER, MembershipRole.ADMIN)
  updateCategory(
    @CurrentBusiness() context: { businessId: string },
    @Param('id', new ParseUUIDPipe()) categoryId: string,
    @Body() dto: UpdateCategoryDto,
  ) {
    return this.inventory.updateCategory(context.businessId, categoryId, dto);
  }

  @Delete('categories/:id')
  @Roles(MembershipRole.OWNER, MembershipRole.ADMIN)
  deleteCategory(
    @CurrentBusiness() context: { businessId: string },
    @Param('id', new ParseUUIDPipe()) categoryId: string,
  ) {
    return this.inventory.deleteCategory(context.businessId, categoryId);
  }

  @Get('products')
  listProducts(@CurrentBusiness() context: { businessId: string }) {
    return this.inventory.listProducts(context.businessId);
  }

  @Get('products/:id')
  getProduct(
    @CurrentBusiness() context: { businessId: string },
    @Param('id', new ParseUUIDPipe()) productId: string,
  ) {
    return this.inventory.getProduct(context.businessId, productId);
  }

  @Post('products')
  @Roles(MembershipRole.OWNER, MembershipRole.ADMIN)
  createProduct(
    @CurrentBusiness() context: { businessId: string },
    @CurrentUser() user: JwtPayload,
    @Body() dto: CreateProductDto,
  ) {
    return this.inventory.createProduct(context.businessId, user.sub, dto);
  }

  @Patch('products/:id')
  @Roles(MembershipRole.OWNER, MembershipRole.ADMIN)
  updateProduct(
    @CurrentBusiness() context: { businessId: string },
    @Param('id', new ParseUUIDPipe()) productId: string,
    @Body() dto: UpdateProductDto,
  ) {
    return this.inventory.updateProduct(context.businessId, productId, dto);
  }

  @Delete('products/:id')
  @Roles(MembershipRole.OWNER, MembershipRole.ADMIN)
  archiveProduct(
    @CurrentBusiness() context: { businessId: string },
    @Param('id', new ParseUUIDPipe()) productId: string,
  ) {
    return this.inventory.archiveProduct(context.businessId, productId);
  }

  @Get('products/:id/movements')
  listMovements(
    @CurrentBusiness() context: { businessId: string },
    @Param('id', new ParseUUIDPipe()) productId: string,
  ) {
    return this.inventory.listMovements(context.businessId, productId);
  }

  @Get('products/:id/stock-history')
  listStockHistory(
    @CurrentBusiness() context: { businessId: string },
    @Param('id', new ParseUUIDPipe()) productId: string,
  ) {
    return this.inventory.listMovements(context.businessId, productId);
  }

  @Post('products/:id/stock/adjust')
  createStockAdjustment(
    @CurrentBusiness() context: { businessId: string },
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe()) productId: string,
    @Body() dto: CreateStockAdjustmentDto,
  ) {
    return this.inventory.createStockAdjustment(context.businessId, user.sub, productId, dto);
  }

  @Post('products/:id/movements')
  createMovement(
    @CurrentBusiness() context: { businessId: string },
    @CurrentUser() user: JwtPayload,
    @Param('id', new ParseUUIDPipe()) productId: string,
    @Body() dto: CreateStockMovementDto,
  ) {
    return this.inventory.createMovement(context.businessId, user.sub, productId, dto);
  }
}
