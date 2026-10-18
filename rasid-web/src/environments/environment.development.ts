/**
 * Development settings. mockFbr=true runs a local FBR simulator in the browser
 * (validation rules, IRN generation, occasional 500s to exercise retries),
 * so the whole app can be tried without tokens or a backend.
 */
export const environment = {
  production: false,
  mockFbr: true,
  apiBaseUrl: 'http://localhost:3000/api',
};
