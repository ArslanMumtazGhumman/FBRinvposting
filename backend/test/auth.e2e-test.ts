import 'dotenv/config';
import assert from 'node:assert/strict';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { MembershipRole } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

const registeredEmails: string[] = [];
const registeredBusinessNames: string[] = [];
let app!: INestApplication;
let prisma!: PrismaService;
let jwt!: JwtService;

async function main(): Promise<void> {
  app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }));
  await app.init();
  prisma = app.get(PrismaService);
  jwt = app.get(JwtService);

  try {
    await runTest('registration creates a user, business, and OWNER membership without exposing the password hash', registrationTest);
    await runTest('duplicate email is rejected with a conflict response', duplicateEmailTest);
    await runTest('login accepts the correct password and rejects an invalid password', loginTest);
    await runTest('/auth/me returns user and memberships and rejects anonymous requests', currentUserTest);
    await runTest('business access is derived from authenticated membership, not a request businessId', businessIsolationTest);
    await runTest('OWNER and ADMIN can manage business details; STAFF cannot', roleAuthorizationTest);
    await runTest('products, categories, and opening stock are persisted within the current business', createProductAndCategoryTest);
    await runTest('positive-quantity stock adjustments append typed ledger entries and cannot make stock negative', stockMovementTest);
    await runTest('product and movement endpoints isolate tenant data', productTenantIsolationTest);
    await runTest('staff can record operational stock movements but cannot administer products', inventoryRoleAuthorizationTest);
  } finally {
    await prisma.business.deleteMany({ where: { name: { in: registeredBusinessNames } } });
    await prisma.user.deleteMany({ where: { email: { in: registeredEmails } } });
    await app.close();
  }
}

async function registrationTest(): Promise<void> {
  const account = await register('register');
  assert.equal(account.user.passwordHash, undefined);
  assert.equal(account.user.email, account.email);
  assert.ok(account.accessToken);

  const membership = await prisma.membership.findUnique({
    where: {
      userId_businessId: {
        userId: account.user.id,
        businessId: account.business.id,
      },
    },
  });
  assert.equal(membership?.role, MembershipRole.OWNER);

  const invalid = await request(app.getHttpServer())
    .post('/auth/register')
    .send({
      name: 'Bad Password',
      email: `short-${crypto.randomUUID()}@example.test`,
      password: 'short',
      businessName: 'Invalid Shop',
    });
  assert.equal(invalid.status, 400);
}

async function duplicateEmailTest(): Promise<void> {
  const account = await register('duplicate');
  const response = await request(app.getHttpServer())
    .post('/auth/register')
    .send({
      name: 'Duplicate Owner',
      email: account.email,
      password: 'safe-password-123',
      businessName: `Duplicate Shop ${crypto.randomUUID()}`,
    });
  assert.equal(response.status, 409);
  assert.match(response.body.message, /already exists/i);
}

async function loginTest(): Promise<void> {
  const account = await register('login');
  const success = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email: account.email, password: 'safe-password-123' });
  assert.equal(success.status, 201);
  assert.ok(success.body.accessToken);

  const failure = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email: account.email, password: 'incorrect-password' });
  assert.equal(failure.status, 401);
}

async function currentUserTest(): Promise<void> {
  const anonymous = await request(app.getHttpServer()).get('/auth/me');
  assert.equal(anonymous.status, 401);

  const account = await register('me');
  const response = await request(app.getHttpServer())
    .get('/auth/me')
    .set('Authorization', `Bearer ${account.accessToken}`);
  assert.equal(response.status, 200);
  assert.equal(response.body.email, account.email);
  assert.equal(response.body.memberships[0].role, MembershipRole.OWNER);
  assert.equal(response.body.passwordHash, undefined);
}

async function businessIsolationTest(): Promise<void> {
  const accountA = await register('tenant-a');
  const accountB = await register('tenant-b');

  const anonymous = await request(app.getHttpServer()).get('/business/me');
  assert.equal(anonymous.status, 401);

  const ownBusiness = await request(app.getHttpServer())
    .get('/business/me')
    .set('Authorization', `Bearer ${accountA.accessToken}`);
  assert.equal(ownBusiness.status, 200);
  assert.equal(ownBusiness.body.id, accountA.business.id);

  const alteredBusinessToken = await jwt.signAsync({
    sub: accountA.user.id,
    businessId: accountB.business.id,
  });
  const crossTenant = await request(app.getHttpServer())
    .get('/business/me')
    .set('Authorization', `Bearer ${alteredBusinessToken}`);
  assert.equal(crossTenant.status, 403);

  const suppliedBusinessId = await request(app.getHttpServer())
    .patch('/business/me')
    .set('Authorization', `Bearer ${accountA.accessToken}`)
    .send({ name: 'Modified Shop', businessId: accountB.business.id });
  assert.equal(suppliedBusinessId.status, 400);

  const updated = await request(app.getHttpServer())
    .patch('/business/me')
    .set('Authorization', `Bearer ${accountA.accessToken}`)
    .send({ name: 'Tenant A Updated' });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.id, accountA.business.id);

  const otherBusiness = await prisma.business.findUnique({ where: { id: accountB.business.id } });
  assert.equal(otherBusiness?.name, accountB.business.name);
}

async function roleAuthorizationTest(): Promise<void> {
  const account = await register('roles');
  const membershipWhere = {
    userId_businessId: {
      userId: account.user.id,
      businessId: account.business.id,
    },
  };

  const ownerUpdate = await request(app.getHttpServer())
    .patch('/business/me')
    .set('Authorization', `Bearer ${account.accessToken}`)
    .send({ name: 'Owner Updated Shop' });
  assert.equal(ownerUpdate.status, 200);

  await prisma.membership.update({
    where: membershipWhere,
    data: { role: MembershipRole.ADMIN },
  });
  const adminUpdate = await request(app.getHttpServer())
    .patch('/business/me')
    .set('Authorization', `Bearer ${account.accessToken}`)
    .send({ name: 'Admin Updated Shop' });
  assert.equal(adminUpdate.status, 200);

  await prisma.membership.update({
    where: membershipWhere,
    data: { role: MembershipRole.STAFF },
  });
  const staffRead = await request(app.getHttpServer())
    .get('/business/me')
    .set('Authorization', `Bearer ${account.accessToken}`);
  assert.equal(staffRead.status, 200);

  const staffUpdate = await request(app.getHttpServer())
    .patch('/business/me')
    .set('Authorization', `Bearer ${account.accessToken}`)
    .send({ name: 'Staff Cannot Update' });
  assert.equal(staffUpdate.status, 403);
}

async function createProductAndCategoryTest(): Promise<void> {
  const account = await register('products');
  const product = await createProduct(account.accessToken, {
    name: 'Cedar Seed 5kg',
    categoryName: 'Seeds',
    sku: 'CEDAR-5KG',
    unit: 'bag',
    purchasePrice: 1250.5,
    salePrice: 1900,
    openingStock: 8,
    lowStockThreshold: 2,
  });

  assert.equal(product.body.stock, 8);
  assert.equal(product.body.purchasePrice, 1250.5);
  assert.equal(product.body.category, 'Seeds');

  const catalog = await request(app.getHttpServer())
    .get('/products')
    .set('Authorization', `Bearer ${account.accessToken}`);
  assert.equal(catalog.status, 200);
  assert.equal(catalog.body.length, 1);
  assert.equal(catalog.body[0].id, product.body.id);

  const categories = await request(app.getHttpServer())
    .get('/categories')
    .set('Authorization', `Bearer ${account.accessToken}`);
  assert.equal(categories.status, 200);
  assert.equal(categories.body.length, 1);
  assert.equal(categories.body[0].name, 'Seeds');
  assert.equal(categories.body[0].id.length > 0, true);

  const productDetails = await request(app.getHttpServer())
    .get(`/products/${product.body.id}`)
    .set('Authorization', `Bearer ${account.accessToken}`);
  assert.equal(productDetails.status, 200);
  assert.equal(productDetails.body.id, product.body.id);

  const movements = await request(app.getHttpServer())
    .get(`/products/${product.body.id}/movements`)
    .set('Authorization', `Bearer ${account.accessToken}`);
  assert.equal(movements.status, 200);
  assert.equal(movements.body.length, 1);
  assert.equal(movements.body[0].type, 'OPENING');
  assert.equal(movements.body[0].delta, 8);
  assert.equal(movements.body[0].quantity, 8);
  assert.equal(movements.body[0].resultingStock, 8);

  const createdCategory = await request(app.getHttpServer())
    .post('/categories')
    .set('Authorization', `Bearer ${account.accessToken}`)
    .send({ name: 'Seasonal' });
  assert.equal(createdCategory.status, 201);
  assert.equal(createdCategory.body.name, 'Seasonal');

  const duplicateCategory = await request(app.getHttpServer())
    .post('/categories')
    .set('Authorization', `Bearer ${account.accessToken}`)
    .send({ name: 'Seasonal' });
  assert.equal(duplicateCategory.status, 409);

  const updatedCategory = await request(app.getHttpServer())
    .patch(`/categories/${createdCategory.body.id}`)
    .set('Authorization', `Bearer ${account.accessToken}`)
    .send({ name: 'Seasonal goods' });
  assert.equal(updatedCategory.status, 200);
  assert.equal(updatedCategory.body.name, 'Seasonal goods');

  const deletedCategory = await request(app.getHttpServer())
    .delete(`/categories/${createdCategory.body.id}`)
    .set('Authorization', `Bearer ${account.accessToken}`);
  assert.equal(deletedCategory.status, 200);

  const referencedCategoryDelete = await request(app.getHttpServer())
    .delete(`/categories/${categories.body[0].id}`)
    .set('Authorization', `Bearer ${account.accessToken}`);
  assert.equal(referencedCategoryDelete.status, 409);

  const updated = await request(app.getHttpServer())
    .patch(`/products/${product.body.id}`)
    .set('Authorization', `Bearer ${account.accessToken}`)
    .send({ name: 'Cedar Seed 5kg Premium', categoryName: 'Crop care', salePrice: 2100 });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.name, 'Cedar Seed 5kg Premium');
  assert.equal(updated.body.category, 'Crop care');
  assert.equal(updated.body.stock, 8);

  const duplicateSku = await createProduct(account.accessToken, {
    name: 'Another seed',
    categoryName: 'Seeds',
    sku: 'CEDAR-5KG',
    purchasePrice: 10,
    salePrice: 20,
  });
  assert.equal(duplicateSku.status, 409);

  const archived = await request(app.getHttpServer())
    .delete(`/products/${product.body.id}`)
    .set('Authorization', `Bearer ${account.accessToken}`);
  assert.equal(archived.status, 200);
  assert.equal(archived.body.isActive, false);

  const activeProducts = await request(app.getHttpServer())
    .get('/products')
    .set('Authorization', `Bearer ${account.accessToken}`);
  assert.deepEqual(activeProducts.body, []);

  const archivedHistory = await request(app.getHttpServer())
    .get(`/products/${product.body.id}/movements`)
    .set('Authorization', `Bearer ${account.accessToken}`);
  assert.equal(archivedHistory.status, 200);
  assert.equal(archivedHistory.body.length, 1);
}

async function stockMovementTest(): Promise<void> {
  const account = await register('ledger');
  const product = await createProduct(account.accessToken, {
    name: 'Ledger product',
    categoryName: 'Inventory',
    purchasePrice: 5,
    salePrice: 10,
    openingStock: 8,
  });
  const productId = product.body.id as string;

  const purchase = await request(app.getHttpServer())
    .post(`/products/${productId}/stock/adjust`)
    .set('Authorization', `Bearer ${account.accessToken}`)
    .send({ type: 'PURCHASE', quantity: 5, note: 'Supplier delivery' });
  assert.equal(purchase.status, 201);
  assert.equal(purchase.body.stock, 13);
  assert.equal(purchase.body.movement.quantity, 5);
  assert.equal(purchase.body.movement.delta, 5);
  const persistedPurchase = await prisma.stockMovement.findUnique({
    where: { id: purchase.body.movement.id },
  });
  assert.equal(persistedPurchase?.quantity.toNumber(), 5);

  const adjustmentOut = await request(app.getHttpServer())
    .post(`/products/${productId}/stock/adjust`)
    .set('Authorization', `Bearer ${account.accessToken}`)
    .send({ type: 'ADJUSTMENT_OUT', quantity: 2, note: 'Counted stock' });
  assert.equal(adjustmentOut.status, 201);
  assert.equal(adjustmentOut.body.stock, 11);

  const fractional = await request(app.getHttpServer())
    .post(`/products/${productId}/stock/adjust`)
    .set('Authorization', `Bearer ${account.accessToken}`)
    .send({ type: 'ADJUSTMENT_IN', quantity: 0.375 });
  assert.equal(fractional.status, 201);
  assert.equal(fractional.body.stock, 11.375);

  const fractionOut = await request(app.getHttpServer())
    .post(`/products/${productId}/stock/adjust`)
    .set('Authorization', `Bearer ${account.accessToken}`)
    .send({ type: 'DAMAGE', quantity: 1.125 });
  assert.equal(fractionOut.status, 201);
  assert.equal(fractionOut.body.stock, 10.25);

  const zeroQuantity = await request(app.getHttpServer())
    .post(`/products/${productId}/stock/adjust`)
    .set('Authorization', `Bearer ${account.accessToken}`)
    .send({ type: 'PURCHASE', quantity: 0 });
  assert.equal(zeroQuantity.status, 400);
  const negativeQuantity = await request(app.getHttpServer())
    .post(`/products/${productId}/stock/adjust`)
    .set('Authorization', `Bearer ${account.accessToken}`)
    .send({ type: 'PURCHASE', quantity: -1 });
  assert.equal(negativeQuantity.status, 400);

  const restock = await addMovement(account.accessToken, productId, {
    type: 'RESTOCK',
    delta: 5,
    note: 'Supplier delivery',
  });
  assert.equal(restock.status, 201);
  assert.equal(restock.body.stock, 15.25);

  const adjustment = await addMovement(account.accessToken, productId, {
    type: 'ADJUSTMENT',
    delta: -2,
    note: 'Counted stock',
  });
  assert.equal(adjustment.status, 201);
  assert.equal(adjustment.body.stock, 13.25);

  const damage = await addMovement(account.accessToken, productId, {
    type: 'DAMAGE',
    delta: -1,
  });
  assert.equal(damage.status, 201);
  assert.equal(damage.body.stock, 12.25);

  const inconsistentType = await addMovement(account.accessToken, productId, {
    type: 'RESTOCK',
    delta: -1,
  });
  assert.equal(inconsistentType.status, 422);
  const zeroMovement = await addMovement(account.accessToken, productId, {
    type: 'ADJUSTMENT',
    delta: 0,
  });
  assert.equal(zeroMovement.status, 422);
  const negativeInventory = await addMovement(account.accessToken, productId, {
    type: 'ADJUSTMENT',
    delta: -13,
  });
  assert.equal(negativeInventory.status, 422);

  const history = await request(app.getHttpServer())
    .get(`/products/${productId}/stock-history`)
    .set('Authorization', `Bearer ${account.accessToken}`);
  assert.equal(history.body.length, 8);
  assert.equal(history.body[0].resultingStock, 12.25);
  assert.ok(history.body[0].quantity > 0);
  const catalog = await request(app.getHttpServer())
    .get('/products')
    .set('Authorization', `Bearer ${account.accessToken}`);
  assert.equal(catalog.body[0].stock, 12.25);
}

async function productTenantIsolationTest(): Promise<void> {
  const businessA = await register('product-tenant-a');
  const businessB = await register('product-tenant-b');
  const product = await createProduct(businessA.accessToken, {
    name: 'Private product',
    categoryName: 'Private category',
    purchasePrice: 10,
    salePrice: 15,
    openingStock: 4,
  });
  const productId = product.body.id as string;
  const otherProduct = await createProduct(businessB.accessToken, {
    name: 'Other business product',
    categoryName: 'Other category',
    purchasePrice: 10,
    salePrice: 15,
    openingStock: 2,
  });
  const otherProductId = otherProduct.body.id as string;

  const otherCatalog = await request(app.getHttpServer())
    .get('/products')
    .set('Authorization', `Bearer ${businessB.accessToken}`);
  assert.equal(otherCatalog.status, 200);
  assert.equal(otherCatalog.body.length, 1);
  assert.equal(otherCatalog.body[0].id, otherProductId);

  const otherCategories = await request(app.getHttpServer())
    .get('/categories')
    .set('Authorization', `Bearer ${businessB.accessToken}`);
  assert.equal(otherCategories.status, 200);
  assert.equal(otherCategories.body.length, 1);
  assert.equal(otherCategories.body[0].name, 'Other category');

  const otherBusinessProduct = await request(app.getHttpServer())
    .get(`/products/${otherProductId}`)
    .set('Authorization', `Bearer ${businessA.accessToken}`);
  assert.equal(otherBusinessProduct.status, 404);

  const otherBusinessHistory = await request(app.getHttpServer())
    .get(`/products/${otherProductId}/stock-history`)
    .set('Authorization', `Bearer ${businessA.accessToken}`);
  assert.equal(otherBusinessHistory.status, 404);

  const otherBusinessEdit = await request(app.getHttpServer())
    .patch(`/products/${otherProductId}`)
    .set('Authorization', `Bearer ${businessA.accessToken}`)
    .send({ name: 'Cross-tenant edit' });
  assert.equal(otherBusinessEdit.status, 404);

  const otherBusinessDelete = await request(app.getHttpServer())
    .delete(`/products/${otherProductId}`)
    .set('Authorization', `Bearer ${businessA.accessToken}`);
  assert.equal(otherBusinessDelete.status, 404);

  const otherBusinessAdjustment = await request(app.getHttpServer())
    .post(`/products/${otherProductId}/stock/adjust`)
    .set('Authorization', `Bearer ${businessA.accessToken}`)
    .send({ type: 'ADJUSTMENT_OUT', quantity: 1 });
  assert.equal(otherBusinessAdjustment.status, 404);

  const crossTenantCategory = await createProduct(businessA.accessToken, {
    name: 'Cannot use other category',
    categoryId: otherCategories.body[0].id,
    purchasePrice: 1,
    salePrice: 2,
  });
  assert.equal(crossTenantCategory.status, 404);

  const crossTenantCategoryEdit = await request(app.getHttpServer())
    .patch(`/products/${productId}`)
    .set('Authorization', `Bearer ${businessA.accessToken}`)
    .send({ categoryId: otherCategories.body[0].id });
  assert.equal(crossTenantCategoryEdit.status, 404);

  const crossTenantCategoryDelete = await request(app.getHttpServer())
    .delete(`/categories/${otherCategories.body[0].id}`)
    .set('Authorization', `Bearer ${businessA.accessToken}`);
  assert.equal(crossTenantCategoryDelete.status, 404);

  const crossTenantRead = await request(app.getHttpServer())
    .get(`/products/${productId}/movements`)
    .set('Authorization', `Bearer ${businessB.accessToken}`);
  assert.equal(crossTenantRead.status, 404);

  const crossTenantDetails = await request(app.getHttpServer())
    .get(`/products/${productId}`)
    .set('Authorization', `Bearer ${businessB.accessToken}`);
  assert.equal(crossTenantDetails.status, 404);

  const crossTenantUpdate = await request(app.getHttpServer())
    .patch(`/products/${productId}`)
    .set('Authorization', `Bearer ${businessB.accessToken}`)
    .send({ name: 'Stolen product' });
  assert.equal(crossTenantUpdate.status, 404);

  const crossTenantWrite = await addMovement(businessB.accessToken, productId, {
    type: 'RESTOCK',
    delta: 7,
  });
  assert.equal(crossTenantWrite.status, 404);

  const crossTenantDelete = await request(app.getHttpServer())
    .delete(`/products/${productId}`)
    .set('Authorization', `Bearer ${businessB.accessToken}`);
  assert.equal(crossTenantDelete.status, 404);

  const ownCatalog = await request(app.getHttpServer())
    .get('/products')
    .set('Authorization', `Bearer ${businessA.accessToken}`);
  assert.equal(ownCatalog.body[0].name, 'Private product');
  assert.equal(ownCatalog.body[0].stock, 4);
}

async function inventoryRoleAuthorizationTest(): Promise<void> {
  const account = await register('inventory-staff');
  const product = await createProduct(account.accessToken, {
    name: 'Operational stock',
    categoryName: 'Stock',
    purchasePrice: 10,
    salePrice: 20,
    openingStock: 2,
  });
  const productId = product.body.id as string;
  await prisma.membership.update({
    where: {
      userId_businessId: {
        userId: account.user.id,
        businessId: account.business.id,
      },
    },
    data: { role: MembershipRole.STAFF },
  });

  const restock = await addMovement(account.accessToken, productId, {
    type: 'RESTOCK',
    delta: 1,
  });
  assert.equal(restock.status, 201);

  const productCreate = await createProduct(account.accessToken, {
    name: 'Staff cannot add product',
    categoryName: 'Stock',
    purchasePrice: 1,
    salePrice: 2,
  });
  assert.equal(productCreate.status, 403);
}

async function createProduct(
  accessToken: string,
  body: {
    name: string;
    categoryName?: string;
    categoryId?: string;
    purchasePrice: number;
    salePrice: number;
    sku?: string;
    unit?: string;
    openingStock?: number;
    lowStockThreshold?: number;
  },
) {
  return request(app.getHttpServer())
    .post('/products')
    .set('Authorization', `Bearer ${accessToken}`)
    .send(body);
}

async function addMovement(
  accessToken: string,
  productId: string,
  body: { type: 'RESTOCK' | 'ADJUSTMENT' | 'DAMAGE'; delta: number; note?: string },
) {
  return request(app.getHttpServer())
    .post(`/products/${productId}/movements`)
    .set('Authorization', `Bearer ${accessToken}`)
    .send(body);
}

async function register(label: string) {
  const suffix = crypto.randomUUID();
  const email = `${label}-${suffix}@example.test`;
  const businessName = `${label} shop ${suffix}`;
  registeredEmails.push(email);
  registeredBusinessNames.push(businessName);

  const response = await request(app.getHttpServer())
    .post('/auth/register')
    .send({
      name: 'Test Owner',
      email,
      password: 'safe-password-123',
      businessName,
    });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const business = await prisma.business.findFirst({ where: { name: businessName } });
  assert.ok(business);
  return { ...response.body, email, business };
}

async function runTest(name: string, test: () => Promise<void>): Promise<void> {
  await test();
  console.log(`PASS ${name}`);
}

void main().catch((error: unknown) => {
  console.error('Backend integration test failed:', error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});
