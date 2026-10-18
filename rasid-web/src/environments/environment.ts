/**
 * Production build settings.
 * mockFbr=false → all FBR calls go through the Rasid API (rasid-api), which holds
 * the encrypted bearer tokens. The browser never sees a token after it is saved.
 */
export const environment = {
  production: true,
  mockFbr: false,
  apiBaseUrl: '/api',
};
