/**
 * Production build settings.
 * useApi=true → data comes from the Rasid API (ApiStoreService) and every FBR
 * call goes through it; posting runs on the server queue. The API holds the
 * encrypted bearer tokens: the browser never sees a token after it is saved.
 */
export const environment = {
  production: true,
  useApi: true,
  apiBaseUrl: '/api',
};
