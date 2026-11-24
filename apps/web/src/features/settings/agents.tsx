/**
 * Settings → Agents: AI agents (MCP clients) with access to Hermes — each one a device token with
 * platform `agent`, issued through OAuth consent or created here with the passphrase.
 *
 * Tokens are stored only as a SHA-256 hash, so a token is shown in full exactly once (when created
 * here); the list identifies each one by a short fingerprint of its hash. Revoking deletes the token.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Device } from '@cadence/core/domain';
import { Bot, Check, Copy, KeyRound } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { api, call } from '@/lib/api';
import { Button, IconButton } from '@/ui/Button';
import { EmptyState } from '@/ui/EmptyState';
import { Field, Input } from '@/ui/Field';
import { Section } from '@/ui/Section';
import { Skeleton } from '@/ui/Skeleton';
import { Table, type Column } from '@/ui/Table';
import { Tooltip } from '@/ui/Tooltip';
import { toast } from '@/ui/toast';
import { InlineError, Row, Rows, TwoStepButton, relativeTime } from './common';
import { addedOn, devicesKey, useRevokeDevice } from './devices';

export function SettingsAgentsPage() {
  const q = useQuery({ queryKey: devicesKey, queryFn: () => call(api.auth.devices.$get()) });
  const revoke = useRevokeDevice();
  const agents = (q.data?.devices ?? []).filter((d) => d.platform === 'agent');

  const columns: Column<Device>[] = [
    {
      key: 'name',
      header: 'Agent',
      width: '100%',
      className: 'max-w-0',
      cell: (d) => (
        <span className="flex min-w-0 items-center gap-2.5">
          <Bot className="size-4 shrink-0 text-fg-3" aria-hidden />
          <span className="truncate text-fg-1">{d.name}</span>
        </span>
      ),
    },
    {
      key: 'token',
      header: 'Token',
      width: '8.5rem',
      cell: (d) =>
        d.fingerprint ? (
          <Tooltip content="Fingerprint of the stored token hash. The token itself is only shown once, when it is created.">
            <code tabIndex={0} className="rounded-xs bg-surface-1 px-1.5 py-0.5 font-mono text-body-sm text-fg-2 outline-none">
              #{d.fingerprint}
            </code>
          </Tooltip>
        ) : (
          <span className="text-fg-3">—</span>
        ),
    },
    { key: 'via', header: 'Via', hideBelow: 'md', width: '5.5rem', cell: (d) => <span className="text-fg-2">{d.connectedVia === 'oauth' ? 'OAuth' : 'Token'}</span> },
    { key: 'added', header: 'Added', hideBelow: 'xl', width: '8.5rem', cell: (d) => <span className="whitespace-nowrap text-fg-2">{addedOn(d.createdAt)}</span> },
    { key: 'used', header: 'Last used', width: '8rem', cell: (d) => <span className="whitespace-nowrap text-fg-2">{d.lastUsedAt ? relativeTime(d.lastUsedAt) : 'Not yet'}</span> },
    {
      key: 'expires',
      header: 'Expires',
      hideBelow: 'sm',
      width: '8rem',
      cell: (d) => (
        <span className="whitespace-nowrap text-fg-2" title={addedOn(d.expiresAt)}>
          {relativeTime(d.expiresAt)}
        </span>
      ),
    },
    {
      key: 'revoke',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      width: '1%',
      cell: (d) => (
        <div className="flex justify-end">
          <TwoStepButton size="sm" label="Revoke" confirmLabel="Confirm revoke" onConfirm={() => revoke.mutate(d)} />
        </div>
      ),
    },
  ];

  return (
    <>
      <Section title="Agents" description="AI agents (Claude, Claude Code, Codex, any MCP client) that can read your training and manage your plan. Each token lasts 30 days; revoking one cuts the agent off at once.">
        {q.isPending ? (
          <div className="flex flex-col gap-2" aria-hidden>
            <Skeleton className="h-8 w-full" radius="sm" />
            <Skeleton className="h-11 w-full" radius="sm" />
          </div>
        ) : q.isError ? (
          <InlineError action={<Button size="sm" variant="ghost" onClick={() => void q.refetch()}>Retry</Button>}>Couldn't load your agents.</InlineError>
        ) : agents.length === 0 ? (
          <EmptyState size="sm" icon={<Bot />} title="No agents connected">
            Add Hermes to an MCP client with the endpoint below, or create a token for clients without OAuth.
          </EmptyState>
        ) : (
          <Table aria-label="Agents" rows={agents} rowKey={(d) => d.id} columns={columns} />
        )}
      </Section>

      <ConnectAgentSection />
    </>
  );
}

/** Copy button with a short-lived check mark. */
function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.success(`${label} copied`);
    } catch {
      toast.error('Couldn’t copy. Select the text and copy it instead.');
    }
  };
  return <IconButton label={copied ? 'Copied' : `Copy ${label.toLowerCase()}`} icon={copied ? <Check /> : <Copy />} onClick={() => void copy()} />;
}

function Snippet({ title, text, label }: { title: string; text: string; label: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-label text-fg-2">{title}</span>
      <div className="flex min-w-0 items-start gap-2">
        <pre className="min-w-0 flex-1 overflow-x-auto rounded-sm bg-surface-1 px-2.5 py-2 font-mono text-body-sm whitespace-pre text-fg-1 select-all">{text}</pre>
        <CopyButton text={text} label={label} />
      </div>
    </div>
  );
}

/** Shell-safe server name for the `claude mcp add` command. */
const SERVER_NAME = 'hermes';

function ConnectAgentSection() {
  const qc = useQueryClient();
  const [name, setName] = useState('Claude Code');
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [created, setCreated] = useState<{ token: string; device: Device } | null>(null);
  const endpoint = `${typeof window !== 'undefined' ? window.location.origin : ''}/mcp`;

  // Plain fetch, not `call`: a wrong passphrase is a 401 that must not bounce the user to /login.
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !passphrase) return;
    setPending(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/devices', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ passphrase, name: name.trim(), platform: 'agent' }),
      });
      const body = (await res.json().catch(() => null)) as { token?: string; device?: Device; error?: { code?: string; message?: string } } | null;
      if (!res.ok || !body?.token || !body.device) {
        setError(body?.error?.code === 'invalid_passphrase' ? 'That passphrase is not right.' : (body?.error?.message ?? `Couldn’t create the token (${res.status}).`));
        return;
      }
      setCreated({ token: body.token, device: body.device });
      setPassphrase('');
      void qc.invalidateQueries({ queryKey: devicesKey });
    } catch {
      setError('You appear to be offline');
    } finally {
      setPending(false);
    }
  };

  const claudeCmd = created ? `claude mcp add --transport http ${SERVER_NAME} ${endpoint} --header "Authorization: Bearer ${created.token}"` : '';
  const json = created
    ? JSON.stringify({ mcpServers: { [SERVER_NAME]: { type: 'http', url: endpoint, headers: { Authorization: `Bearer ${created.token}` } } } }, null, 2)
    : '';

  return (
    <Section
      title="Connect an agent"
      description="Let an AI agent (Claude, Claude Code, Codex or any MCP client) read your training and manage your plan. Clients with OAuth only need the endpoint: they open a Hermes page where you approve with your passphrase. For the others, create a token below. Either way the agent shows up in the list above for 30 days, and revoking it there cuts it off."
    >
      {created ? (
        <div className="flex flex-col gap-5">
          <Snippet title={`Token for “${created.device.name}”${created.device.fingerprint ? ` (#${created.device.fingerprint})` : ''} — shown once, valid 30 days; copy it now`} text={created.token} label="Token" />
          <Snippet title="Claude Code" text={claudeCmd} label="Command" />
          <Snippet title="Other MCP clients (JSON config, Streamable HTTP)" text={json} label="Config" />
          <div>
            <Button size="sm" variant="secondary" onClick={() => setCreated(null)}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)}>
          <Rows>
            <Row title="Endpoint" description="Streamable HTTP; OAuth, or a bearer token from below.">
              <code className="min-w-0 truncate rounded-sm bg-surface-1 px-2.5 py-1.5 font-mono text-body-sm text-fg-1 select-all">{endpoint}</code>
              <CopyButton text={endpoint} label="Endpoint" />
            </Row>
          </Rows>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <Field label="Agent name" className="sm:w-56">
              <Input value={name} onChange={(e) => setName(e.currentTarget.value)} maxLength={64} leading={<Bot />} autoComplete="off" />
            </Field>
            <Field label="Your passphrase" className="sm:w-56" error={error ?? undefined}>
              <Input type="password" value={passphrase} onChange={(e) => setPassphrase(e.currentTarget.value)} leading={<KeyRound />} autoComplete="current-password" />
            </Field>
            <Button type="submit" variant="secondary" loading={pending} disabled={!name.trim() || !passphrase}>
              Create agent token
            </Button>
          </div>
        </form>
      )}
    </Section>
  );
}
