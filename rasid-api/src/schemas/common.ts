import { z } from 'zod';

/** Client-generated ids (rasid-web uid()) or server ones: prefix + uuid. */
export const Id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'Invalid id');

export const text = (max: number) => z.string().trim().max(max);
export const money = z.number().finite().min(-1e13).max(1e13);

/** YYYY-MM-DD that is a real calendar date. */
export const IsoDate = z.iso.date({ message: 'Use YYYY-MM-DD' });

/** NTN (7 or 9 digits) or CNIC (13 digits); empty allowed where the buyer is unregistered. */
export const NtnCnic = z.string().trim().regex(/^(\d{7}|\d{9}|\d{13})?$/, 'NTN must be 7 digits or CNIC 13 digits');
export const SellerNtnCnic = z.string().regex(/^(\d{7}|\d{13})$/, 'Seller NTN/CNIC must be 7 or 13 digits.');

export const FbrEnv = z.enum(['sandbox', 'production']);
export const RegistrationType = z.enum(['Registered', 'Unregistered']);
export const InvoiceType = z.enum(['Sale Invoice', 'Debit Note']);
