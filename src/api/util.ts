import type { z } from 'zod';
import { InvoiceError } from '../services/invoices.js';

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    throw new InvoiceError(r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), 400, 'validation_error');
  }
  return r.data;
}

export function httpError(statusCode: number, code: string, message: string): InvoiceError {
  return new InvoiceError(message, statusCode, code);
}
