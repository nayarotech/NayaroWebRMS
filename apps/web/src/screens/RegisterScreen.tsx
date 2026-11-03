import { useState, type FormEvent, type JSX } from 'react';
import type { PendingRegistrationResponse } from '@nayaro/shared';
import { Link, useNavigate } from 'react-router';
import { AuthLayout } from '@/components/layout/AuthLayout';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { InlineAlert } from '@/components/ui/States';
import { ApiRequestError } from '@/services/apiClient';
import { startRegistration } from '@/features/auth/api/auth.api';
import { VerifyEmailStep } from '@/features/auth/components/VerifyEmailStep';
import { useAuth } from '@/features/auth/hooks/useAuth';

interface RegisterForm {
  restaurantName: string;
  workspace: string;
  address: string;
  phone: string;
  panNumber: string;
  ownerName: string;
  email: string;
  username: string;
  password: string;
  confirmPassword: string;
}

const EMPTY: RegisterForm = {
  restaurantName: '',
  workspace: '',
  address: '',
  phone: '',
  panNumber: '',
  ownerName: '',
  email: '',
  username: '',
  password: '',
  confirmPassword: '',
};

function suggestWorkspace(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

type Errors = Partial<Record<keyof RegisterForm, string>>;

function validate(form: RegisterForm): Errors {
  const errors: Errors = {};
  if (form.restaurantName.trim() === '') errors.restaurantName = 'Enter the restaurant name.';
  if (!/^[a-z0-9](?:[a-z0-9-]{1,38})[a-z0-9]$/.test(form.workspace)) {
    errors.workspace = 'Use 3–40 lower-case letters, numbers or hyphens.';
  }
  if (form.ownerName.trim() === '') errors.ownerName = 'Enter the owner’s name.';
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(form.username)) {
    errors.username = 'Use 3–32 letters, numbers, dots, underscores or hyphens.';
  }
  if (form.password.length < 8) errors.password = 'Use at least 8 characters.';
  if (form.confirmPassword !== form.password)
    errors.confirmPassword = 'The passwords do not match.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
    errors.email = 'Enter a valid email address. We send a code to verify it.';
  }
  return errors;
}

export function RegisterScreen(): JSX.Element {
  const navigate = useNavigate();
  const { completeSignIn } = useAuth();
  const [pending, setPending] = useState<PendingRegistrationResponse | null>(null);
  const [form, setForm] = useState<RegisterForm>(EMPTY);
  const [workspaceEdited, setWorkspaceEdited] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const set = (key: keyof RegisterForm, value: string): void => {
    setForm((current) => {
      const next = { ...current, [key]: value };
      if (key === 'restaurantName' && !workspaceEdited) next.workspace = suggestWorkspace(value);
      return next;
    });
    setErrors((current) => ({ ...current, [key]: undefined }));
    setFailure(null);
  };

  const onSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const found = validate(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setSubmitting(true);
    try {
      const email = form.email.trim().toLowerCase();
      // Nothing is created yet: the server parks the form and emails a code.
      setPending(
        await startRegistration({
          restaurant: {
            slug: form.workspace,
            name: form.restaurantName.trim(),
            ...(form.address.trim() ? { address: form.address.trim() } : {}),
            ...(form.phone.trim() ? { phone: form.phone.trim() } : {}),
            ...(form.panNumber.trim() ? { panNumber: form.panNumber.trim() } : {}),
            contactEmail: email,
          },
          owner: { name: form.ownerName.trim(), email, username: form.username, password: form.password },
        }),
      );
    } catch (error: unknown) {
      if (error instanceof ApiRequestError && error.code === 'WORKSPACE_TAKEN') {
        setErrors({ workspace: error.message });
      } else if (error instanceof ApiRequestError && error.code === 'EMAIL_TAKEN') {
        setErrors({ email: error.message });
      } else {
        setFailure(
          error instanceof ApiRequestError
            ? error.message
            : 'Registration failed. Please try again.',
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (pending !== null) {
    return (
      <AuthLayout>
        <VerifyEmailStep
          pending={pending}
          onVerified={async (result) => {
            completeSignIn(result);
            await navigate('/dashboard', { replace: true });
          }}
          onChangeEmail={() => {
            setPending(null);
          }}
        />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <h1 className="text-display font-extrabold tracking-tight">Register your restaurant</h1>
      <p className="text-muted mt-1 mb-7 text-body">
        Create your workspace and owner account. Your 14-day trial starts today.
      </p>

      <form
        noValidate
        onSubmit={(event) => {
          void onSubmit(event);
        }}
      >
        <fieldset className="mb-2">
          <legend className="text-overline text-muted mb-3 font-bold tracking-wider uppercase">
            Restaurant
          </legend>
          <TextField
            label="Restaurant name"
            autoFocus
            value={form.restaurantName}
            error={errors.restaurantName}
            onChange={(event) => {
              set('restaurantName', event.target.value);
            }}
          />
          <TextField
            label="Workspace code"
            hint="Your team types this to sign in. It also appears in your guest menu link."
            autoCapitalize="none"
            spellCheck={false}
            value={form.workspace}
            error={errors.workspace}
            onChange={(event) => {
              setWorkspaceEdited(true);
              set('workspace', event.target.value.toLowerCase());
            }}
          />
          <div className="grid gap-x-4 sm:grid-cols-2">
            <TextField
              label="Phone (optional)"
              autoComplete="tel"
              value={form.phone}
              onChange={(event) => {
                set('phone', event.target.value);
              }}
            />
            <TextField
              label="PAN / VAT number (optional)"
              value={form.panNumber}
              onChange={(event) => {
                set('panNumber', event.target.value);
              }}
            />
          </div>
          <TextField
            label="Address (optional)"
            autoComplete="street-address"
            value={form.address}
            onChange={(event) => {
              set('address', event.target.value);
            }}
          />
        </fieldset>

        <fieldset className="mb-2">
          <legend className="text-overline text-muted mb-3 font-bold tracking-wider uppercase">
            Owner account
          </legend>
          <TextField
            label="Your name"
            autoComplete="name"
            value={form.ownerName}
            error={errors.ownerName}
            onChange={(event) => {
              set('ownerName', event.target.value);
            }}
          />
          <TextField
            label="Email"
            type="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            hint="We send a 6-digit code to verify it. You can sign in with this email."
            value={form.email}
            error={errors.email}
            onChange={(event) => {
              set('email', event.target.value);
            }}
          />
          <TextField
            label="Username"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            value={form.username}
            error={errors.username}
            onChange={(event) => {
              set('username', event.target.value);
            }}
          />
          <div className="grid gap-x-4 sm:grid-cols-2">
            <TextField
              label="Password"
              secret
              autoComplete="new-password"
              value={form.password}
              error={errors.password}
              onChange={(event) => {
                set('password', event.target.value);
              }}
            />
            <TextField
              label="Confirm password"
              secret
              autoComplete="new-password"
              value={form.confirmPassword}
              error={errors.confirmPassword}
              onChange={(event) => {
                set('confirmPassword', event.target.value);
              }}
            />
          </div>
        </fieldset>

        {failure !== null && <InlineAlert className="mb-4">{failure}</InlineAlert>}

        <Button type="submit" size="lg" loading={submitting} className="w-full">
          {submitting ? 'Sending your code…' : 'Continue'}
        </Button>
      </form>

      <p className="text-muted mt-8 text-center text-body">
        Already registered?{' '}
        <Link to="/login" className="text-accent-hover font-bold hover:underline">
          Sign in
        </Link>
      </p>
    </AuthLayout>
  );
}
