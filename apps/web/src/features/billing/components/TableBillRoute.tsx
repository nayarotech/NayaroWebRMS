import type { JSX } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import { Button } from '@/components/ui/Button';
import { useOrderForTarget } from '@/features/orders/hooks/useOrder';
import { Page } from '@/components/layout/Page';

/**
 * "Table 5 wants to pay."
 *
 * Billing is addressed by ORDER, because an invoice belongs to an order and a
 * table has a new one every evening. But a customer says a table number, and
 * the cashier hears a table number - so this route takes the thing a person
 * says and resolves it to the thing the system uses.
 *
 * The same reasoning as `/orders/table/:tableId`, which the router already
 * notes: the table is the stable identity, and resolving late is what makes a
 * stale floor board harmless. A cashier clicking Bill on a table whose order
 * was closed a moment ago gets an honest "nothing on this table" rather than a
 * bill for an order that no longer exists.
 */
export function TableBillRoute(): JSX.Element {
  const params = useParams();
  const navigate = useNavigate();
  const tableId = params['tableId'] ?? '';
  const order = useOrderForTarget({ kind: 'TABLE', tableId });

  if (order.isPending) {
    return <p className="text-muted text-sm">Opening the bill…</p>;
  }

  if (order.data != null) {
    // `replace`, so the browser's back gesture returns to the floor rather
    // than to this resolver, which would immediately forward again.
    return <Navigate to={`/billing/${order.data.id}`} replace />;
  }

  return (
    <Page>
      <div className="border-border bg-surface shadow-card rounded-card border px-8 py-12 text-center">
        <h2 className="text-[18px] font-extrabold tracking-tight">Nothing to bill on this table</h2>
        <p className="text-muted mt-2 text-[14px] leading-relaxed">
          {order.isError
            ? 'Nayaro RMS could not be reached. Check your internet connection and try again.'
            : 'This table has no open order. It may have been settled already, or the order was moved.'}
        </p>
        <Button variant="secondary" className="mt-6" onClick={() => void navigate('/tables')}>
          Back to tables
        </Button>
      </div>
    </Page>
  );
}
