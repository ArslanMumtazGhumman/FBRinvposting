import { Routes } from '@angular/router';
import { authGuard } from './core/auth';
import { ShellComponent } from './layout/shell.component';

export const routes: Routes = [
  { path: 'login', loadComponent: () => import('./features/auth/login.component').then(m => m.LoginComponent), title: 'Sign in · Rasid' },
  {
    path: '', component: ShellComponent, canActivate: [authGuard],
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
      { path: 'dashboard', loadComponent: () => import('./features/dashboard/dashboard.component').then(m => m.DashboardComponent), title: 'Dashboard · Rasid' },
      { path: 'invoices', loadComponent: () => import('./features/invoices/invoice-list.component').then(m => m.InvoiceListComponent), title: 'Invoices · Rasid' },
      { path: 'invoices/new', loadComponent: () => import('./features/invoices/invoice-editor.component').then(m => m.InvoiceEditorComponent), title: 'New invoice · Rasid' },
      { path: 'invoices/:id/edit', loadComponent: () => import('./features/invoices/invoice-editor.component').then(m => m.InvoiceEditorComponent), title: 'Edit invoice · Rasid' },
      { path: 'invoices/:id', loadComponent: () => import('./features/invoices/invoice-detail.component').then(m => m.InvoiceDetailComponent), title: 'Invoice · Rasid' },
      { path: 'import', loadComponent: () => import('./features/import/bulk-import.component').then(m => m.BulkImportComponent), title: 'Bulk import · Rasid' },
      { path: 'customers', loadComponent: () => import('./features/masters/customers.component').then(m => m.CustomersComponent), title: 'Customers · Rasid' },
      { path: 'products', loadComponent: () => import('./features/masters/products.component').then(m => m.ProductsComponent), title: 'Products · Rasid' },
      { path: 'scenarios', loadComponent: () => import('./features/scenarios/scenarios.component').then(m => m.ScenariosComponent), title: 'Sandbox scenarios · Rasid' },
      { path: 'settings', loadComponent: () => import('./features/settings/settings.component').then(m => m.SettingsComponent), title: 'Settings · Rasid' },
    ],
  },
  { path: '**', redirectTo: '' },
];
