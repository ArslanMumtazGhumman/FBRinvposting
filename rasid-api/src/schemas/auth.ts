import { z } from 'zod';
import { FbrEnv } from './common.js';
import { FbrInvoicePayload } from './invoice.js';

export const LoginBody = z.object({
  email: z.string().max(254),
  password: z.string().max(1024),
  otp: z.string().max(10).optional(),
});

export const TokenBody = z.object({ token: z.string().max(4200) });

export const FbrCallBody = z.object({
  environment: FbrEnv.optional(),
  payload: FbrInvoicePayload,
});

export const RegTypeBody = z.object({ Registration_No: z.string().max(20) });
