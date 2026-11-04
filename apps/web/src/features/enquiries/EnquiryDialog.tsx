import { useState, type FormEvent, type JSX } from 'react';
import { CheckCircle2 } from 'lucide-react';
import type { EnquiryKind, EnquiryRequest } from '@nayaro/shared';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Field, Select, Textarea } from '@/components/ui/Field';
import { TextField } from '@/components/ui/TextField';
import { InlineAlert } from '@/components/ui/States';
import { apiClient, ApiRequestError } from '@/services/apiClient';

const COPY: Record<
  EnquiryKind,
  { title: string; description: string; submit: string; note: string }
> = {
  quote: {
    title: 'Ask for a quote',
    description: 'Tell us about your restaurant and we will send a monthly and a yearly price.',
    submit: 'Send request',
    note: 'Anything we should know? (optional)',
  },
  demo: {
    title: 'Book a demo',
    description: 'We will show you Nayaro RMS on a call, using a menu like yours.',
    submit: 'Book my demo',
    note: 'Good days and times for a call (optional)',
  },
  contact: {
    title: 'Contact Nayaro',
    description: 'Questions, partnerships, anything else.',
    submit: 'Send message',
    note: 'Your message',
  },
};

/**
 * Quote, demo and contact requests from the RMS site. The server forwards them
 * to the central Nayaro inbox at nayaro.tech, so the team sees requests from
 * every product in one dashboard.
 */
export function EnquiryDialog({
  kind,
  page,
  onClose,
}: {
  readonly kind: EnquiryKind | null;
  readonly page: string;
  readonly onClose: () => void;
}): JSX.Element {
  return (
    <Modal
      open={kind !== null}
      onClose={onClose}
      title={kind === null ? '' : COPY[kind].title}
      {...(kind === null ? {} : { description: COPY[kind].description })}
      className="w-[min(520px,94vw)]"
    >
      {/* Keyed so each opening starts with a fresh form. */}
      {kind !== null && <EnquiryForm key={kind} kind={kind} page={page} onDone={onClose} />}
    </Modal>
  );
}

function EnquiryForm({
  kind,
  page,
  onDone,
}: {
  readonly kind: EnquiryKind;
  readonly page: string;
  readonly onDone: () => void;
}): JSX.Element {
  const [form, setForm] = useState({
    name: '',
    email: '',
    phone: '',
    company: '',
    outlets: '1',
    message: '',
    website: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const set = (key: keyof typeof form, value: string): void => {
    setForm((current) => ({ ...current, [key]: value }));
    setError(null);
  };

  const valid =
    form.name.trim() !== '' &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim()) &&
    (kind !== 'contact' || form.message.trim().length >= 10);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    const request: EnquiryRequest = {
      kind,
      name: form.name.trim(),
      email: form.email.trim(),
      page,
      ...(form.phone.trim() ? { phone: form.phone.trim() } : {}),
      ...(form.company.trim() ? { company: form.company.trim() } : {}),
      ...(kind === 'contact' ? {} : { outlets: form.outlets }),
      ...(form.message.trim() ? { message: form.message.trim() } : {}),
      ...(form.website ? { website: form.website } : {}),
    };
    try {
      await apiClient.post('/enquiries', request);
      setSent(true);
    } catch (cause: unknown) {
      setError(
        cause instanceof ApiRequestError
          ? cause.message
          : 'We could not send that just now. Please email info@nayaro.tech.',
      );
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <div className="flex flex-col items-center py-6 text-center">
        <span className="bg-ok/12 text-ok-fg grid size-12 place-items-center rounded-card">
          <CheckCircle2 size={24} aria-hidden />
        </span>
        <h3 className="mt-4 text-heading font-extrabold">
          Thank you, {form.name.trim().split(/\s+/)[0]}.
        </h3>
        <p className="text-muted mt-1.5 max-w-sm text-body">
          Your request reached the Nayaro team. We will reply to {form.email.trim()} soon.
        </p>
        <Button variant="secondary" className="mt-6" onClick={onDone}>
          Close
        </Button>
      </div>
    );
  }

  const copy = COPY[kind];
  return (
    <form
      noValidate
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      {error !== null && <InlineAlert className="mb-4">{error}</InlineAlert>}
      <div className="grid gap-x-4 sm:grid-cols-2">
        <TextField
          label="Your name"
          autoComplete="name"
          autoFocus
          value={form.name}
          onChange={(event) => {
            set('name', event.target.value);
          }}
        />
        <TextField
          label="Email"
          type="email"
          autoComplete="email"
          value={form.email}
          onChange={(event) => {
            set('email', event.target.value);
          }}
        />
        <TextField
          label="Phone or WhatsApp (optional)"
          type="tel"
          autoComplete="tel"
          value={form.phone}
          onChange={(event) => {
            set('phone', event.target.value);
          }}
        />
        <TextField
          label={kind === 'contact' ? 'Company (optional)' : 'Restaurant name'}
          autoComplete="organization"
          value={form.company}
          onChange={(event) => {
            set('company', event.target.value);
          }}
        />
      </div>
      {kind !== 'contact' && (
        <Field label="Outlets" className="mb-4">
          {({ id }) => (
            <Select
              id={id}
              value={form.outlets}
              onChange={(event) => {
                set('outlets', event.target.value);
              }}
            >
              <option value="1">1 restaurant</option>
              <option value="2-3">2–3 outlets</option>
              <option value="4-10">4–10 outlets</option>
              <option value="10+">More than 10</option>
            </Select>
          )}
        </Field>
      )}
      <Field label={copy.note} className="mb-4">
        {({ id }) => (
          <Textarea
            id={id}
            rows={3}
            maxLength={5000}
            value={form.message}
            onChange={(event) => {
              set('message', event.target.value);
            }}
          />
        )}
      </Field>
      {/* Spam trap: hidden from people, irresistible to bots. */}
      <input
        type="text"
        name="website"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden
        value={form.website}
        onChange={(event) => {
          set('website', event.target.value);
        }}
        className="hidden"
      />
      <Button type="submit" size="lg" className="w-full" loading={busy} disabled={!valid}>
        {copy.submit}
      </Button>
      <p className="text-muted-2 mt-3 text-center text-caption">
        Sent to the Nayaro team. Prefer email? Write to info@nayaro.tech.
      </p>
    </form>
  );
}
