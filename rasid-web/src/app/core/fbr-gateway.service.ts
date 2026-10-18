import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';
import { FbrEnvironment, FbrInvoicePayload, FbrItemStatus, FbrResponse } from './models';
import { HS_UOM_RULES, saleTypeDef } from './fbr-reference';
import { rateValue, round2 } from './tax';
import { sleep } from './util';

/** Transient error: network, timeout or HTTP 5xx. Safe to retry. */
export class TransientFbrError extends Error {
  constructor(message: string, readonly status = 0) { super(message); }
}
/** Auth / config error: token missing or not authorised (HTTP 401). Never retry. */
export class FbrAuthError extends Error {}
/** POST timed out at FBR: it may or may not be recorded. Never auto-retry; a person checks IRIS first. */
export class FbrUnknownOutcomeError extends Error {}

export interface FbrCall {
  businessId: string;
  environment: FbrEnvironment;
  payload: FbrInvoicePayload;
  /** Idempotency key = our localRef; the API refuses to post the same key twice. */
  idempotencyKey: string;
}

/**
 * Single entry point for FBR operations. In production it calls the Rasid API
 * (which injects the decrypted bearer token server-side). In development it
 * uses an in-browser simulator implementing a subset of PRAL v1.12 rules.
 */
@Injectable({ providedIn: 'root' })
export class FbrGatewayService {
  private http = inject(HttpClient);
  private readonly mock = environment.mockFbr;

  validate(call: FbrCall): Promise<FbrResponse> {
    return this.mock ? this.simulate(call, false) : this.send('validate', call);
  }

  post(call: FbrCall): Promise<FbrResponse> {
    return this.mock ? this.simulate(call, true) : this.send('post', call);
  }

  /** Registration-type check via /dist/v1/Get_Reg_Type (proxied). */
  async registrationType(businessId: string, ntn: string): Promise<'Registered' | 'Unregistered' | 'Unknown'> {
    if (this.mock) {
      await sleep(350);
      return ntn.length === 7 ? 'Registered' : ntn.length === 13 ? 'Unregistered' : 'Unknown';
    }
    const r = await firstValueFrom(this.http.post<{ REGISTRATION_TYPE?: string }>(
      `${environment.apiBaseUrl}/fbr/${businessId}/reg-type`, { Registration_No: ntn }, { withCredentials: true }));
    const t = (r.REGISTRATION_TYPE ?? '').toLowerCase();
    return t === 'registered' ? 'Registered' : t === 'unregistered' ? 'Unregistered' : 'Unknown';
  }

  private async send(kind: 'validate' | 'post', call: FbrCall): Promise<FbrResponse> {
    try {
      return await firstValueFrom(this.http.post<FbrResponse>(
        `${environment.apiBaseUrl}/fbr/${call.businessId}/${kind}`,
        { environment: call.environment, payload: call.payload },
        { withCredentials: true, headers: { 'Idempotency-Key': call.idempotencyKey } }));
    } catch (e) {
      const err = e as HttpErrorResponse;
      if (err.error?.code === 'OUTCOME_UNKNOWN') throw new FbrUnknownOutcomeError(err.error.message);
      if (err.status === 401 || err.status === 403) throw new FbrAuthError(err.error?.message ?? 'FBR token not authorised for this business');
      if (err.status === 0 || err.status >= 500 || err.status === 429) throw new TransientFbrError(err.message, err.status);
      throw e;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Simulator: realistic latency, PRAL-shaped responses, ~4% 5xx.       */
  /* ------------------------------------------------------------------ */
  private postedKeys = new Map<string, FbrResponse>();

  private async simulate(call: FbrCall, isPost: boolean): Promise<FbrResponse> {
    await sleep(250 + Math.random() * 500);
    if (isPost && this.postedKeys.has(call.idempotencyKey)) return this.postedKeys.get(call.idempotencyKey)!;
    if (Math.random() < 0.04) throw new TransientFbrError('Simulated FBR 500 Internal Server Error', 500);

    const p = call.payload;
    const dated = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const headerErr = (code: string, error: string): FbrResponse =>
      ({ dated, validationResponse: { statusCode: '01', status: 'Invalid', errorCode: code, error, invoiceStatuses: null } });

    if (!/^(\d{7}|\d{13})$/.test(p.sellerNTNCNIC)) return headerErr('0401', 'The provided seller NTN/CNIC does not have a valid or authorized access token');
    if (p.buyerNTNCNIC && !/^(\d{7}|\d{9}|\d{13})$/.test(p.buyerNTNCNIC)) return headerErr('0002', 'Invalid Buyer Registration No or NTN');
    if (p.buyerRegistrationType === 'Registered' && !p.buyerNTNCNIC) return headerErr('0009', 'Provide Buyer registration No.');
    if (!p.buyerBusinessName) return headerErr('0010', 'Provide Buyer Name.');
    if (p.invoiceType === 'Debit Note' && !p.invoiceRefNo) return headerErr('0026', 'Invoice Reference No. is required.');
    if (call.environment === 'sandbox' && !p.scenarioId) return headerErr('0001', 'Provide scenario id for sandbox.');

    const base = isPost ? `${p.sellerNTNCNIC}DI${Date.now()}` : undefined;
    const statuses: FbrItemStatus[] = p.items.map((it, i) => {
      const fail = (errorCode: string, error: string): FbrItemStatus =>
        ({ itemSNo: String(i + 1), statusCode: '01', status: 'Invalid', invoiceNo: null, errorCode, error });
      if (!/^\d{4}\.\d{4}$/.test(it.hsCode)) return fail('0019', 'Please provide HSCode');
      if (!it.rate) return fail('0046', 'Provide rate.');
      const def = saleTypeDef(it.saleType);
      if (!def) return fail('0013', 'Provide valid Sale type.');
      const fixed = HS_UOM_RULES[it.hsCode];
      if (fixed && it.uoM !== fixed) return fail('0096', 'For selected HSCode only KWH UOM is allowed.');
      if (it.hsCode.startsWith('2716') && def.name !== 'Electricity Supply to Retailers') return fail('0052', 'Please provide valid HS Code against invoice');
      const r = rateValue(it.rate);
      const b = def.usesRetailPrice ? it.fixedNotifiedValueOrRetailPrice : it.valueSalesExcludingST;
      const expected = def.exempt ? 0 : round2(b * r / 100);
      if (Math.abs(expected - it.salesTaxApplicable) > 1) {
        return def.usesRetailPrice ? fail('0102', 'Calculated tax not matched in 3rd schedule') : fail('0104', 'The calculated percentage sales tax does not match.');
      }
      return { itemSNo: String(i + 1), statusCode: '00', status: 'Valid', invoiceNo: base ? `${base}-${i + 1}` : null, errorCode: '', error: '' };
    });
    const ok = statuses.every(s => s.statusCode === '00');
    const res: FbrResponse = {
      invoiceNumber: ok ? base : undefined,
      dated,
      validationResponse: { statusCode: ok ? '00' : '01', status: ok ? 'Valid' : 'Invalid', error: '', invoiceStatuses: statuses },
    };
    if (isPost && ok) this.postedKeys.set(call.idempotencyKey, res);
    return res;
  }
}
