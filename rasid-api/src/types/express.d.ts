import type { Membership, User } from './models.js';

declare global {
  namespace Express {
    interface Request {
      /** Set by requireAuth. */
      user: User;
      /** Set by requireBusiness on business-scoped routes. */
      membership?: Membership;
    }
  }
}

export {};
