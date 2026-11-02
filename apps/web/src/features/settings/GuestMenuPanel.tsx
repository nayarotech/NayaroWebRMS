import { useState, type JSX } from 'react';
import { Check, Copy, ExternalLink, Printer } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { QrCode } from '@/features/connect/components/QrCode';
import { PrintableQr } from '@/features/connect/components/PrintableQr';
import { useAuth } from '@/features/auth/hooks/useAuth';

/**
 * The restaurant's public, read-only menu. The link carries only the
 * workspace code; guests never see staff screens, stock or sales.
 */
export function GuestMenuPanel({
  enabled,
  busy,
  onToggle,
}: {
  readonly enabled: boolean;
  readonly busy: boolean;
  readonly onToggle: () => void;
}): JSX.Element {
  const { tenant } = useAuth();
  const [copied, setCopied] = useState(false);
  const [printing, setPrinting] = useState(false);
  const url = tenant === null ? '' : `${window.location.origin}/m/${tenant.workspace}`;

  return (
    <Card>
      <CardHeader
        title="Guest QR menu"
        description="A read-only menu guests open by scanning a QR code at the table."
        actions={
          <Badge tone={enabled ? 'success' : 'neutral'} dot>
            {enabled ? 'Live' : 'Off'}
          </Badge>
        }
      />
      <CardBody>
        <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
          <div className="min-w-0 flex-1 space-y-4">
            <p className="text-muted text-body">
              Shows names, prices, set-menu contents and what is unavailable today. Prices update as you
              change the menu. Guests still order through your staff.
            </p>
            {enabled && (
              <div className="bg-surface-3 border-border flex items-center gap-2 rounded-control border px-3 py-2">
                <span className="min-w-0 flex-1 truncate font-mono text-caption">{url}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={copied ? Check : Copy}
                  onClick={() => {
                    void navigator.clipboard.writeText(url).then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1800);
                    });
                  }}
                >
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button variant={enabled ? 'secondary' : 'primary'} loading={busy} onClick={onToggle}>
                {enabled ? 'Turn off guest menu' : 'Turn on guest menu'}
              </Button>
              {enabled && (
                <>
                  <Button
                    variant="secondary"
                    icon={Printer}
                    onClick={() => {
                      setPrinting(true);
                    }}
                  >
                    Print QR card
                  </Button>
                  <Button
                    variant="ghost"
                    icon={ExternalLink}
                    onClick={() => {
                      window.open(url, '_blank', 'noopener,noreferrer');
                    }}
                  >
                    Preview
                  </Button>
                </>
              )}
            </div>
          </div>
          {enabled && (
            <div className="border-border self-center rounded-card border bg-white p-3">
              <QrCode value={url} size={148} label={`QR code for ${tenant?.name ?? 'the'} menu`} />
            </div>
          )}
        </div>
      </CardBody>
      {printing && (
        <PrintableQr
          value={url}
          caption={tenant === null ? 'Our menu' : `${tenant.name} · Menu`}
          footnote="Scan to view our menu"
          onDone={() => {
            setPrinting(false);
          }}
        />
      )}
    </Card>
  );
}
