export type PaymentMethod = 'cash' | 'bank' | 'jazzcash' | 'credit' | 'partial';
export type SaleStatus = 'PAID' | 'PARTIAL' | 'CREDIT';
export type SalesPeriod = 'today' | 'week' | 'month';

export interface Product {
  id: string;
  sku?: string | null;
  unit?: string;
  categoryId?: string;
  name: string;
  category: string;
  purchasePrice: number;
  salePrice: number;
  stock: number;
  isActive?: boolean;
  popular: boolean;
  lowStockThreshold: number;
  soldToday?: number;
  soldThisMonth?: number;
}

export interface ProductCategory {
  id: string;
  name: string;
}

export type StockMovementType =
  | 'OPENING'
  | 'PURCHASE'
  | 'SALE'
  | 'SALE_RETURN'
  | 'PURCHASE_RETURN'
  | 'DAMAGE'
  | 'ADJUSTMENT_IN'
  | 'ADJUSTMENT_OUT';

export interface StockMovement {
  id: string;
  type: StockMovementType;
  quantity: number;
  delta: number;
  resultingStock: number;
  note: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
  createdAt: string;
  user?: { id: string; name: string };
}

export interface Customer {
  id: string;
  name: string;
  phone?: string;
  balance: number;
  totalPurchases: number;
}

export interface SaleItem {
  productId: string;
  name: string;
  category: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export interface Payment {
  method: PaymentMethod;
  amount: number;
  receivedAt: Date;
}

export interface Sale {
  id: string;
  number: number;
  createdAt: Date;
  customerId: string | null;
  customerName: string;
  items: SaleItem[];
  subtotal: number;
  total: number;
  paid: number;
  balance: number;
  status: SaleStatus;
  payments: Payment[];
}
