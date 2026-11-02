import { useMemo, useState, type JSX } from 'react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';
import {
  QR_PURPOSE_LABELS,
  buildQrPayload,
  type QrPurpose,
  type WifiCredentials,
  type WifiSecurity,
} from '../qrPayload';
import { PrintableQr } from './PrintableQr';
import { QrCode } from './QrCode';

/**
 * A QR code maker for the things a restaurant tapes to its own walls.
 *
 * Separate from the panel above, and the separation is the point: those codes
 * are part of how Nayaro RMS works, these are part of how the restaurant
 * works. A guest wifi code, a link to an online menu, the takeaway number on a
 * counter card. None of it touches the database, nothing is saved, and none of
 * it is about this software at all.
 *
 * It is here because the alternative is an owner pasting their wifi password
 * into a website to have a picture made of it, and because the machine this
 * runs on is often not on the internet anyway.
 */
export function QrStudioPanel(): JSX.Element {
  const [purpose, setPurpose] = useState<QrPurpose>('WIFI');
  const [text, setText] = useState('');
  const [caption, setCaption] = useState('');
  const [printing, setPrinting] = useState(false);
  const [wifi, setWifi] = useState<WifiCredentials>({
    ssid: '',
    password: '',
    security: 'WPA',
    hidden: false,
  });

  const payload = useMemo(() => buildQrPayload(purpose, { text, wifi }), [purpose, text, wifi]);
  const meta = QR_PURPOSE_LABELS[purpose];

  /** What gets printed under the code. Falls back to something true rather than blank. */
  const printedCaption =
    caption.trim().length > 0
      ? caption.trim()
      : purpose === 'WIFI'
        ? `Wi-Fi: ${wifi.ssid}`
        : 'Scan me';

  return (
    <section className="border-border-2 bg-surface col-span-2 rounded-card border p-5">
      <h2 className="text-[16px] font-extrabold tracking-tight">Make a QR code</h2>
      <p className="text-muted mt-0.5 mb-4 text-[12.5px] leading-relaxed">
        For your own walls and counters — guest wifi, a link to your menu, your takeaway number.
        Made in your browser and never sent anywhere, so your
        wifi password stays in the building. Nothing here is saved.
      </p>

      <div className="mb-4 flex gap-1.5">
        {(Object.keys(QR_PURPOSE_LABELS) as QrPurpose[]).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => {
              setPurpose(option);
            }}
            className={cn(
              'rounded-lg border px-3 py-1.5 text-[12.5px] font-bold',
              option === purpose
                ? 'border-accent bg-accent text-white'
                : 'border-border-3 text-muted',
            )}
          >
            {QR_PURPOSE_LABELS[option].label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-[1fr_auto] gap-5">
        <div className="flex min-w-0 flex-col gap-2.5">
          <p className="text-muted-2 text-[11.5px] leading-relaxed">{meta.blurb}</p>

          {purpose === 'WIFI' ? (
            <WifiFields wifi={wifi} onChange={setWifi} />
          ) : (
            <Field
              label={meta.label}
              value={text}
              placeholder={meta.placeholder}
              multiline={purpose === 'TEXT'}
              onChange={setText}
            />
          )}

          <Field
            label="Caption on the printout"
            value={caption}
            placeholder={purpose === 'WIFI' ? 'Free wifi for guests' : 'Scan for our menu'}
            onChange={setCaption}
            hint="Printed under the code. Leave blank for a sensible default."
          />
        </div>

        <div className="flex w-[200px] shrink-0 flex-col items-center gap-2.5">
          <QrCode value={payload} size={180} label="Preview of the QR code you are making" />
          <Button
            variant="secondary"
            disabled={payload.length === 0}
            className="h-9 w-full px-3 text-[13px]"
            onClick={() => {
              setPrinting(true);
            }}
          >
            Print
          </Button>
          {payload.length === 0 && (
            <p className="text-muted-2 text-center text-[11px] leading-snug">
              {purpose === 'WIFI' ? 'Enter the network name.' : 'Enter something to encode.'}
            </p>
          )}
        </div>
      </div>

      {purpose === 'WIFI' && (
        <p className="border-border/70 text-muted-2 mt-4 border-t pt-3 text-[11px] leading-relaxed">
          A wifi code contains the password in readable form — that is how a phone joins without
          being told it. Put this on a wall for guests, not where it can be photographed from the
          street.
        </p>
      )}

      {printing && (
        <PrintableQr
          value={payload}
          caption={printedCaption}
          footnote={purpose === 'WIFI' ? 'Scan with your camera to join the wifi.' : undefined}
          onDone={() => {
            setPrinting(false);
          }}
        />
      )}
    </section>
  );
}

function WifiFields({
  wifi,
  onChange,
}: {
  wifi: WifiCredentials;
  onChange: (next: WifiCredentials) => void;
}): JSX.Element {
  return (
    <>
      <Field
        label="Network name (SSID)"
        value={wifi.ssid}
        placeholder="Exactly as it appears on a phone"
        mono
        onChange={(ssid) => {
          onChange({ ...wifi, ssid });
        }}
      />

      {wifi.security !== 'NONE' && (
        <Field
          label="Password"
          value={wifi.password}
          mono
          onChange={(password) => {
            onChange({ ...wifi, password });
          }}
        />
      )}

      <div className="flex items-end gap-2">
        <label className="min-w-0 flex-1">
          <span className="text-muted mb-1 block text-[11.5px] font-semibold">Security</span>
          <select
            value={wifi.security}
            onChange={(event) => {
              onChange({ ...wifi, security: event.target.value as WifiSecurity });
            }}
            className="bg-field border-border-3 focus:border-accent-hover w-full rounded-lg border px-2.5 py-1.5 text-[13px] outline-none"
          >
            {/* WPA covers WPA, WPA2 and WPA3 - readers treat them as one. */}
            <option value="WPA">WPA / WPA2 / WPA3</option>
            <option value="WEP">WEP (old routers)</option>
            <option value="NONE">Open — no password</option>
          </select>
        </label>

        <label className="flex min-h-[34px] items-center gap-2 pb-1.5">
          <input
            type="checkbox"
            checked={wifi.hidden}
            onChange={(event) => {
              onChange({ ...wifi, hidden: event.target.checked });
            }}
            className="size-4"
          />
          <span className="text-[12px] font-semibold">Hidden network</span>
        </label>
      </div>
    </>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  hint,
  mono = false,
  multiline = false,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  hint?: string;
  mono?: boolean;
  multiline?: boolean;
}): JSX.Element {
  const className = cn(
    'bg-field border-border-3 focus:border-accent-hover w-full rounded-lg border px-2.5 py-1.5 text-[13px] outline-none',
    mono && 'font-mono',
  );

  return (
    <label className="block">
      <span className="text-muted mb-1 block text-[11.5px] font-semibold">{label}</span>
      {multiline ? (
        <textarea
          aria-label={label}
          value={value}
          rows={3}
          maxLength={800}
          placeholder={placeholder}
          onChange={(event) => {
            onChange(event.target.value);
          }}
          className={cn(className, 'resize-none')}
        />
      ) : (
        <input
          aria-label={label}
          value={value}
          maxLength={400}
          placeholder={placeholder}
          onChange={(event) => {
            onChange(event.target.value);
          }}
          className={className}
        />
      )}
      {hint !== undefined && <span className="text-muted-2 mt-1 block text-[11px]">{hint}</span>}
    </label>
  );
}
