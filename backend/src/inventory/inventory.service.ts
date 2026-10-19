import { BadRequestException, ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma, StockMovementType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { CreateStockAdjustmentDto } from './dto/create-stock-adjustment.dto';
import { CreateProductDto } from './dto/create-product.dto';
import { CreateStockMovementDto } from './dto/create-stock-movement.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

const productInclude = { category: { select: { id: true, name: true } } } satisfies Prisma.ProductInclude;
type ProductWithCategory = Prisma.ProductGetPayload<{ include: typeof productInclude }>;
const increasingMovementTypes: StockMovementType[] = [
  StockMovementType.OPENING,
  StockMovementType.PURCHASE,
  StockMovementType.SALE_RETURN,
  StockMovementType.ADJUSTMENT_IN,
];

@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  async listCategories(businessId: string) {
    return this.prisma.category.findMany({
      where: { businessId },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, createdAt: true, updatedAt: true },
    });
  }

  async createCategory(businessId: string, dto: CreateCategoryDto) {
    try {
      return await this.prisma.category.create({
        data: { businessId, name: dto.name },
        select: { id: true, name: true, createdAt: true, updatedAt: true },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('A category with this name already exists.');
      }
      throw error;
    }
  }

  async updateCategory(businessId: string, categoryId: string, dto: UpdateCategoryDto) {
    if (dto.name === undefined) {
      throw new BadRequestException('A category name is required.');
    }
    try {
      const result = await this.prisma.category.updateMany({
        where: { id: categoryId, businessId },
        data: { name: dto.name },
      });
      if (result.count === 0) {
        throw new NotFoundException('Category not found.');
      }
      return this.prisma.category.findFirstOrThrow({
        where: { id: categoryId, businessId },
        select: { id: true, name: true, createdAt: true, updatedAt: true },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('A category with this name already exists.');
      }
      throw error;
    }
  }

  async deleteCategory(businessId: string, categoryId: string) {
    const category = await this.prisma.category.findFirst({
      where: { id: categoryId, businessId },
      select: { id: true },
    });
    if (!category) {
      throw new NotFoundException('Category not found.');
    }
    const products = await this.prisma.product.count({ where: { categoryId, businessId } });
    if (products > 0) {
      throw new ConflictException('Reassign the category products before deleting this category.');
    }
    try {
      await this.prisma.category.delete({ where: { id_businessId: { id: categoryId, businessId } } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
        throw new ConflictException('Reassign the category products before deleting this category.');
      }
      throw error;
    }
    return { id: categoryId, deleted: true };
  }

  async listProducts(businessId: string) {
    const products = await this.prisma.product.findMany({
      where: { businessId, isActive: true },
      include: productInclude,
      orderBy: [{ name: 'asc' }, { createdAt: 'asc' }],
    });
    const stockByProduct = await this.stockByProduct(businessId, products.map((product) => product.id));
    return products.map((product) => this.toProductResponse(product, stockByProduct.get(product.id) ?? 0));
  }

  async getProduct(businessId: string, productId: string) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, businessId, isActive: true },
      include: productInclude,
    });
    if (!product) {
      throw new NotFoundException('Product not found.');
    }
    const stock = await this.getStock(businessId, productId);
    return this.toProductResponse(product, stock);
  }

  async createProduct(businessId: string, userId: string, dto: CreateProductDto) {
    try {
      const product = await this.prisma.$transaction(async (transaction) => {
        const category = await this.resolveCategory(transaction, businessId, dto);
        const created = await transaction.product.create({
          data: {
            businessId,
            categoryId: category.id,
            name: dto.name,
            sku: dto.sku,
            unit: dto.unit ?? 'unit',
            purchasePrice: new Prisma.Decimal(String(dto.purchasePrice)),
            salePrice: new Prisma.Decimal(String(dto.salePrice)),
            lowStockThreshold: dto.lowStockThreshold ?? 0,
          },
          include: productInclude,
        });
        if ((dto.openingStock ?? 0) > 0) {
          await transaction.stockMovement.create({
            data: {
              businessId,
              createdById: userId,
              productId: created.id,
              type: StockMovementType.OPENING,
              quantity: new Prisma.Decimal(String(dto.openingStock)),
              note: 'Opening stock',
            },
          });
        }
        return created;
      });
      return this.toProductResponse(product, dto.openingStock ?? 0);
    } catch (error) {
      this.rethrowDuplicateSku(error);
    }
  }

  async updateProduct(businessId: string, productId: string, dto: UpdateProductDto) {
    try {
      const { categoryName, categoryId, ...productData } = dto;
      const product = await this.prisma.$transaction(async (transaction) => {
        let resolvedCategoryId: string | undefined;
        if (categoryName || categoryId) {
          const category = await this.resolveCategory(transaction, businessId, { categoryName, categoryId });
          resolvedCategoryId = category.id;
        }
        const updated = await transaction.product.updateMany({
          where: { id: productId, businessId, isActive: true },
          data: {
            ...productData,
            ...(productData.purchasePrice !== undefined
              ? { purchasePrice: new Prisma.Decimal(String(productData.purchasePrice)) }
              : {}),
            ...(productData.salePrice !== undefined
              ? { salePrice: new Prisma.Decimal(String(productData.salePrice)) }
              : {}),
            ...(resolvedCategoryId ? { categoryId: resolvedCategoryId } : {}),
          },
        });
        if (updated.count === 0) {
          throw new NotFoundException('Product not found.');
        }
        return transaction.product.findFirstOrThrow({
          where: { id: productId, businessId },
          include: productInclude,
        });
      });
      const stock = await this.getStock(businessId, productId);
      return this.toProductResponse(product, stock);
    } catch (error) {
      this.rethrowDuplicateSku(error);
    }
  }

  async archiveProduct(businessId: string, productId: string) {
    const result = await this.prisma.product.updateMany({
      where: { id: productId, businessId, isActive: true },
      data: { isActive: false },
    });
    if (result.count === 0) {
      throw new NotFoundException('Product not found.');
    }
    return { id: productId, isActive: false };
  }

  async listMovements(businessId: string, productId: string) {
    await this.requireProduct(businessId, productId, false);
    const ascending = await this.prisma.stockMovement.findMany({
      where: { businessId, productId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        type: true,
        quantity: true,
        note: true,
        referenceType: true,
        referenceId: true,
        createdAt: true,
        createdBy: { select: { id: true, name: true } },
      },
    });
    let balance = new Prisma.Decimal(0);
    const withBalances = ascending.map((movement) => {
      balance = balance.plus(this.signedQuantity(movement.type, movement.quantity));
      const delta = this.signedQuantity(movement.type, movement.quantity);
      return {
        ...movement,
        quantity: movement.quantity.toNumber(),
        delta: delta.toNumber(),
        resultingStock: balance.toNumber(),
        user: movement.createdBy,
      };
    });
    return withBalances.reverse();
  }

  async createStockAdjustment(
    businessId: string,
    userId: string,
    productId: string,
    dto: CreateStockAdjustmentDto,
  ) {
    return this.recordMovement(businessId, userId, productId, dto.type, dto.quantity, dto.note);
  }

  async createMovement(
    businessId: string,
    userId: string,
    productId: string,
    dto: CreateStockMovementDto,
  ) {
    if (dto.delta === 0
      || (dto.type === 'RESTOCK' && dto.delta < 0)
      || (dto.type === 'DAMAGE' && dto.delta > 0)) {
      throw new UnprocessableEntityException('Stock movement quantity and type do not match.');
    }
    const type = dto.type === 'RESTOCK'
      ? StockMovementType.PURCHASE
      : dto.type === 'DAMAGE'
        ? StockMovementType.DAMAGE
        : dto.delta > 0
          ? StockMovementType.ADJUSTMENT_IN
          : StockMovementType.ADJUSTMENT_OUT;
    return this.recordMovement(businessId, userId, productId, type, Math.abs(dto.delta), dto.note);
  }

  private async recordMovement(
    businessId: string,
    userId: string,
    productId: string,
    type: StockMovementType,
    quantity: number,
    note?: string,
  ) {
    return this.prisma.$transaction(async (transaction) => {
      const product = await transaction.product.findFirst({
        where: { id: productId, businessId, isActive: true },
        select: { id: true },
      });
      if (!product) {
        throw new NotFoundException('Product not found.');
      }

      await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "Product"
        WHERE "id" = ${productId}::uuid AND "businessId" = ${businessId}::uuid
        FOR UPDATE
      `;
      const currentStock = await this.stockForProduct(transaction, businessId, productId);
      const stockAfter = currentStock.plus(this.signedQuantity(type, new Prisma.Decimal(quantity)));
      if (stockAfter.lessThan(0)) {
        throw new UnprocessableEntityException('This movement would make stock negative.');
      }

      const movement = await transaction.stockMovement.create({
        data: {
          businessId,
          productId,
          createdById: userId,
          type,
          quantity: new Prisma.Decimal(String(quantity)),
          note,
        },
        select: { id: true, type: true, quantity: true, note: true, createdAt: true },
      });
      const delta = this.signedQuantity(type, movement.quantity);
      return {
        movement: { ...movement, quantity: movement.quantity.toNumber(), delta: delta.toNumber() },
        stock: stockAfter.toNumber(),
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }

  private async getStock(businessId: string, productId: string): Promise<number> {
    return (await this.stockForProduct(this.prisma, businessId, productId)).toNumber();
  }

  private async stockForProduct(
    transaction: Prisma.TransactionClient | PrismaService,
    businessId: string,
    productId: string,
  ): Promise<Prisma.Decimal> {
    const movements = await transaction.stockMovement.findMany({
      where: { businessId, productId },
      select: { type: true, quantity: true },
    });
    return movements.reduce(
      (stock, movement) => stock.plus(this.signedQuantity(movement.type, movement.quantity)),
      new Prisma.Decimal(0),
    );
  }

  private async stockByProduct(businessId: string, productIds: string[]): Promise<Map<string, number>> {
    if (productIds.length === 0) {
      return new Map();
    }
    const rows = await this.prisma.$queryRaw<Array<{ productId: string; stock: Prisma.Decimal }>>`
      SELECT "productId",
        SUM(CASE
          WHEN "type" IN ('OPENING', 'PURCHASE', 'SALE_RETURN', 'ADJUSTMENT_IN') THEN "quantity"
          ELSE -"quantity"
        END) AS "stock"
      FROM "StockMovement"
      WHERE "businessId" = ${businessId}::uuid AND "productId" IN (${Prisma.join(productIds.map((id) => Prisma.sql`${id}::uuid`))})
      GROUP BY "productId"
    `;
    return new Map(rows.map((row) => [row.productId, row.stock.toNumber()]));
  }

  private signedQuantity(type: StockMovementType, quantity: Prisma.Decimal): Prisma.Decimal {
    return increasingMovementTypes.includes(type)
      ? quantity
      : quantity.negated();
  }

  private async resolveCategory(
    transaction: Prisma.TransactionClient,
    businessId: string,
    dto: Pick<CreateProductDto, 'categoryName' | 'categoryId'>,
  ) {
    if (dto.categoryName && dto.categoryId) {
      throw new BadRequestException('Provide either categoryId or categoryName, not both.');
    }
    if (dto.categoryId) {
      const category = await transaction.category.findFirst({
        where: { id: dto.categoryId, businessId },
      });
      if (!category) {
        throw new NotFoundException('Category not found in this business.');
      }
      return category;
    }
    if (!dto.categoryName?.trim()) {
      throw new BadRequestException('A category is required.');
    }
    return transaction.category.upsert({
      where: { businessId_name: { businessId, name: dto.categoryName.trim() } },
      create: { businessId, name: dto.categoryName.trim() },
      update: {},
    });
  }

  private async requireProduct(
    businessId: string,
    productId: string,
    activeOnly = true,
  ): Promise<void> {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, businessId, ...(activeOnly ? { isActive: true } : {}) },
      select: { id: true },
    });
    if (!product) {
      throw new NotFoundException('Product not found.');
    }
  }

  private toProductResponse(product: ProductWithCategory, stock: number) {
    return {
      id: product.id,
      name: product.name,
      sku: product.sku,
      unit: product.unit,
      categoryId: product.categoryId,
      category: product.category.name,
      purchasePrice: product.purchasePrice.toNumber(),
      salePrice: product.salePrice.toNumber(),
      stock,
      isActive: product.isActive,
      lowStockThreshold: product.lowStockThreshold,
      popular: false,
      soldToday: 0,
      soldThisMonth: 0,
      createdAt: product.createdAt,
      updatedAt: product.updatedAt,
    };
  }

  private rethrowDuplicateSku(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ConflictException('A product with this SKU already exists in this business.');
    }
    throw error;
  }
}
