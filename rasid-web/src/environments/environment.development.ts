/**
 * Development settings (`npm start`). useApi=false runs the offline demo: data
 * lives in localStorage (StoreService) and a local FBR simulator answers
 * (validation rules, IRN generation, occasional 500s to exercise retries), so
 * the whole app can be tried without tokens or a backend.
 * Set useApi=true to develop against a local rasid-api.
 */
export const environment = {
  production: false,
  useApi: false,
  apiBaseUrl: 'http://localhost:3000/api',
};
