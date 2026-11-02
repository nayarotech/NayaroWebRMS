import { useState, type JSX } from 'react';
import type { CustomerDto, CustomerRequest } from '@nayaro/shared';
import { Modal } from '@/components/ui/Modal';
import { TextField } from '@/components/ui/TextField';
import { Button } from '@/components/ui/Button';

export function CustomerEditor({
  customer,
  busy,
  error,
  onClose,
  onSave,
}: {
  customer?: CustomerDto;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (request: CustomerRequest & { isActive: boolean }) => Promise<boolean>;
}): JSX.Element {
  const [name, setName] = useState(customer?.name ?? '');
  const [phone, setPhone] = useState(customer?.phone ?? '');
  const [address, setAddress] = useState(customer?.address ?? '');
  const [isActive, setActive] = useState(customer?.isActive ?? true);
  return (
    <Modal
      open
      title={customer ? 'Edit customer' : 'Add customer'}
      onClose={() => {
        if (!busy) onClose();
      }}
      description="Use a phone number or address to distinguish customers with the same name."
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && name.trim())
            void onSave({
              name: name.trim(),
              phone: phone.trim(),
              address: address.trim(),
              isActive,
            }).then((saved) => {
              if (saved) onClose();
            });
        }}
      >
        <fieldset disabled={busy}>
          <TextField
            label="Customer name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={120}
            required
            autoFocus
          />
          <TextField
            label="Phone (optional)"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            maxLength={40}
            type="tel"
          />
          <TextField
            label="Address (optional)"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            maxLength={240}
          />
          {customer && (
            <label className="mb-4 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={isActive}
                onChange={(e) => setActive(e.target.checked)}
              />
              Allow new credit sales
            </label>
          )}
          {error && (
            <p role="alert" className="text-danger mb-3 text-sm">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim()} loading={busy}>
              Save customer
            </Button>
          </div>
        </fieldset>
      </form>
    </Modal>
  );
}
