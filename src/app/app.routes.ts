import { Component } from '@angular/core';
import { Routes } from '@angular/router';
import { AuthComponent } from './auth/auth.component';
import { authGuard } from './auth/auth.guard';
import { SalesComponent } from './sales/sales.component';
import { StockComponent } from './stock/stock.component';

@Component({ template: '' })
class HomeRouteComponent {}

export const routes: Routes = [
  { path: 'login', component: AuthComponent },
  { path: 'register', component: AuthComponent },
  { path: '', pathMatch: 'full', component: HomeRouteComponent, canActivate: [authGuard] },
  { path: 'stock', component: StockComponent, canActivate: [authGuard] },
  { path: 'sales', component: SalesComponent, canActivate: [authGuard] },
  { path: 'sales/new', component: SalesComponent, canActivate: [authGuard] },
  { path: 'sales/success/:id', component: SalesComponent, canActivate: [authGuard] },
  { path: 'sales/:id', component: SalesComponent, canActivate: [authGuard] },
  { path: '**', redirectTo: '' },
];
