import { ApplicationConfig, provideBrowserGlobalErrorListeners, provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideRouter, withComponentInputBinding, withInMemoryScrolling } from '@angular/router';
import { routes } from './app.routes';
import { environment } from '../environments/environment';
import { ApiStoreService } from './core/api-store.service';
import { apiInterceptor } from './core/auth';
import { Store } from './core/store';
import { StoreService } from './core/store.service';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideRouter(routes, withComponentInputBinding(), withInMemoryScrolling({ scrollPositionRestoration: 'top' })),
    provideHttpClient(withInterceptors([apiInterceptor])),
    // Offline demo (npm start) keeps data in localStorage; builds with useApi talk to rasid-api.
    { provide: Store, useClass: environment.useApi ? ApiStoreService : StoreService },
  ],
};
