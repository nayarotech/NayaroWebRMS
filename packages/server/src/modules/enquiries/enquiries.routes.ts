import { Router } from 'express';
import type { EnquiryKind } from '@nayaro/shared';
import { z } from 'zod';
import { ApiError } from '../../utils/apiError';
import type { Logger } from '../../utils/logger';
import { clientAddress } from '../../utils/clientAddress';
import { createRateLimit } from '../../middleware/rateLimit';

/**
 * "Ask for a quote", "Book a demo" and contact requests from the RMS site.
 *
 * Nothing is stored here: every enquiry is forwarded to the central Nayaro
 * inbox (the nayaro.tech API), so requests from all Nayaro products land in
 * one dashboard and one email inbox. The forward happens server-side because
 * it carries this product's key, which must never reach a browser. Any future
 * Nayaro product connects the same way: its own key, the same call.
 */
export interface EnquiryHubConfig {
  /** e.g. https://api.nayaro.tech/api */
  readonly url: string;
  readonly key: string;
}

export interface EnquiriesRouterDeps {
  readonly hub: EnquiryHubConfig | null;
  readonly logger: Logger;
}

const KIND_LABEL: Record<EnquiryKind, string> = {
  quote: 'Quote request',
  demo: 'Demo request',
  contact: 'General enquiry',
};

const enquirySchema = z.object({
  kind: z.enum(['quote', 'demo', 'contact']),
  name: z.string().trim().min(1, 'Enter your name.').max(120),
  email: z.string().trim().toLowerCase().max(200).pipe(z.email('Enter a valid email address.')),
  phone: z.string().trim().max(40).optional(),
  company: z.string().trim().max(160).optional(),
  outlets: z.string().trim().max(20).optional(),
  message: z.string().trim().max(5000).optional(),
  page: z.string().trim().max(200).optional(),
  website: z.string().max(200).optional(),
});

export function createEnquiriesRouter(deps: EnquiriesRouterDeps): Router {
  const router = Router();
  const limit = createRateLimit({
    windowMs: 10 * 60 * 1000,
    max: 5,
    message: 'Too many requests from this network. Please email info@nayaro.tech.',
  });

  router.post('/enquiries', limit, async (req, res) => {
    const input = enquirySchema.parse(req.body);
    // A bot filled the hidden field: accept quietly so it learns nothing.
    if (input.website !== undefined && input.website.trim() !== '') {
      res.status(202).json({ ok: true });
      return;
    }
    if (input.kind === 'contact' && (input.message ?? '').length < 10) {
      throw new ApiError(400, 'VALIDATION_ERROR', 'Please write a short message.');
    }
    if (deps.hub === null) {
      throw new ApiError(
        503,
        'ENQUIRIES_NOT_CONFIGURED',
        'Requests are not connected yet. Please email info@nayaro.tech.',
      );
    }

    const meta: Record<string, string> = {};
    if (input.outlets) meta['Outlets'] = input.outlets;
    if (input.page) meta['Page'] = input.page;
    const country = req.header('cf-ipcountry');
    if (country && /^[A-Z]{2}$/.test(country)) meta['Country'] = country;

    let response: Response;
    try {
      response = await fetch(`${deps.hub.url.replace(/\/+$/, '')}/messages/inbound`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-nayaro-product-key': deps.hub.key },
        body: JSON.stringify({
          kind: input.kind,
          name: input.name,
          email: input.email,
          phone: input.phone,
          company: input.company,
          message: input.message,
          topic: `${KIND_LABEL[input.kind]} — Nayaro RMS`,
          meta,
          ip: clientAddress(req),
          userAgent: req.header('user-agent')?.slice(0, 300),
        }),
        // Generous: the inbox API may be waking from sleep on a free host.
        signal: AbortSignal.timeout(45_000),
      });
    } catch (error: unknown) {
      deps.logger.error('Nayaro inbox unreachable', error);
      throw new ApiError(
        502,
        'ENQUIRY_FAILED',
        'We could not send that just now. Please email info@nayaro.tech.',
      );
    }
    if (!response.ok) {
      deps.logger.error(
        `Nayaro inbox refused the enquiry (${String(response.status)}): ${await response.text()}`,
      );
      throw new ApiError(
        502,
        'ENQUIRY_FAILED',
        'We could not send that just now. Please email info@nayaro.tech.',
      );
    }
    deps.logger.info(`Enquiry forwarded to the Nayaro inbox: ${input.kind}`);
    res.status(202).json({ ok: true });
  });

  return router;
}
