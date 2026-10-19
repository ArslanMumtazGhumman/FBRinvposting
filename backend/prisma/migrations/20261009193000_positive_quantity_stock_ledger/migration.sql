CREATE TYPE "StockMovementType_new" AS ENUM (
  'OPENING',
  'PURCHASE',
  'SALE',
  'SALE_RETURN',
  'PURCHASE_RETURN',
  'DAMAGE',
  'ADJUSTMENT_IN',
  'ADJUSTMENT_OUT'
);

ALTER TABLE "StockMovement"
  ADD COLUMN "type_new" "StockMovementType_new",
  ADD COLUMN "quantity" DECIMAL(12,3);

UPDATE "StockMovement"
SET
  "type_new" = CASE
    WHEN "type" = 'OPENING' THEN 'OPENING'::"StockMovementType_new"
    WHEN "type" = 'RESTOCK' THEN 'PURCHASE'::"StockMovementType_new"
    WHEN "type" = 'DAMAGE' THEN 'DAMAGE'::"StockMovementType_new"
    WHEN "type" = 'ADJUSTMENT' AND "delta" >= 0 THEN 'ADJUSTMENT_IN'::"StockMovementType_new"
    ELSE 'ADJUSTMENT_OUT'::"StockMovementType_new"
  END,
  "quantity" = ABS("delta")::DECIMAL(12,3);

ALTER TABLE "StockMovement"
  ALTER COLUMN "type_new" SET NOT NULL,
  ALTER COLUMN "quantity" SET NOT NULL,
  ADD CONSTRAINT "StockMovement_quantity_positive_check" CHECK ("quantity" > 0);

ALTER TABLE "StockMovement" RENAME COLUMN "userId" TO "createdById";

ALTER TABLE "StockMovement"
  DROP CONSTRAINT "StockMovement_userId_fkey",
  DROP COLUMN "type",
  DROP COLUMN "delta";

ALTER TABLE "StockMovement" RENAME COLUMN "type_new" TO "type";
ALTER TABLE "StockMovement"
  ALTER COLUMN "createdById" DROP NOT NULL;

DROP TYPE "StockMovementType";
ALTER TYPE "StockMovementType_new" RENAME TO "StockMovementType";

DROP INDEX "StockMovement_userId_idx";
CREATE INDEX "StockMovement_createdById_idx" ON "StockMovement"("createdById");

ALTER TABLE "StockMovement"
  ADD CONSTRAINT "StockMovement_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "StockMovement"
  ADD COLUMN "referenceType" VARCHAR(80),
  ADD COLUMN "referenceId" VARCHAR(120);
