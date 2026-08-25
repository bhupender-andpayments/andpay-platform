// The tenant-specific Bank Master page (Task 3, 24 Aug 2026): what used to be
// the in-list expand is now its own route, /masterdata/bank-masters/:tnntId.
// One tenant's identity up top (with Edit and the shared card-template
// controls, Task 4) and its aggregators beneath, searchable and paged, each
// row with View (the read-only dialog, Task 2) and Edit.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '../../auth/AuthContext.js'
import { AggregatorLogoThumb } from './AggregatorLogoThumb.js'
import { BankMasterDetailDialog } from './BankMasterDetailDialog.js'
import { AggregatorCreateDialog } from './AggregatorCreateDialog.js'
import { AggregatorDetailDialog } from './AggregatorDetailDialog.js'
import {
  getBankMasters,
  getTemplateCurrent,
  uploadBankTemplate,
  getBankConfigRows,
  upsertBankConfig,
  type BankMasterRow,
  type AggregatorRow,
  type TemplateCurrent,
  type BankConfigRowView,
} from '../../api/endpoints.js'
import { PageHeader, Button, Card, ErrorNote, SkeletonRows, Input, Field } from '../../ui/primitives.js'
import { newIdempotencyKey } from '../../api/idempotency.js'
import { IconSearch } from '../../ui/icons.js'
import { fmtAgo, fmtDateTime } from '../../ui/format.js'
import {
  MASTERDATA_PAGE_SIZE,
  matchesAggregatorQuery,
  sortedAggregators,
  initialsOf,
  StatusDot,
} from './shared.js'

export function TenantAggregatorsPage() {
  const { tnntId } = useParams()
  const { client } = useAuth()
  const [rows, setRows] = useState<BankMasterRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editingTenant, setEditingTenant] = useState(false)
  const [addingAggregator, setAddingAggregator] = useState(false)
  const [viewing, setViewing] = useState<AggregatorRow | null>(null)
  const [editing, setEditing] = useState<AggregatorRow | null>(null)
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)

  // -- The shared card template (Task 4) -------------------------------- //
  const [template, setTemplate] = useState<TemplateCurrent | null>(null)
  const [templateFile, setTemplateFile] = useState<File | null>(null)
  const [templateUploading, setTemplateUploading] = useState(false)
  const [templateError, setTemplateError] = useState<string | null>(null)
  const [templateEpoch, setTemplateEpoch] = useState(0)
  // The tenant default config row: carries the overlay flags (the strips
  // option, 24 Aug 2026). null until loaded or when no row exists yet.
  const [defaultCfg, setDefaultCfg] = useState<BankConfigRowView | null>(null)
  const [marksSaving, setMarksSaving] = useState(false)
  const [marksError, setMarksError] = useState<string | null>(null)

  const load = useCallback(() => {
    getBankMasters(client)
      .then((res) => {
        if (!Array.isArray(res)) setError('Unexpected response shape.')
        setRows(res)
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Failed to load bank masters.')
      })
    getTemplateCurrent(client)
      .then(setTemplate)
      .catch(() => setTemplate(null))
    if (tnntId !== undefined) {
      getBankConfigRows(client, tnntId)
        .then((rows) => setDefaultCfg(rows.find((r) => r.bankCode === '' && r.branchCode === '') ?? null))
        .catch(() => setDefaultCfg(null))
    }
  }, [client, tnntId])

  useEffect(() => {
    load()
  }, [load])

  const tenant = useMemo(() => rows?.find((t) => t.tnntId === tnntId) ?? null, [rows, tnntId])

  const aggregators = useMemo(() => {
    if (tenant === null) return []
    const q = query.trim().toLowerCase()
    return sortedAggregators(tenant).filter((a) => matchesAggregatorQuery(a, q))
  }, [tenant, query])

  const pageCount = Math.max(1, Math.ceil(aggregators.length / MASTERDATA_PAGE_SIZE))
  const safePage = Math.min(page, pageCount - 1)
  const pageRows = aggregators.slice(safePage * MASTERDATA_PAGE_SIZE, safePage * MASTERDATA_PAGE_SIZE + MASTERDATA_PAGE_SIZE)

  // The strips option (Rahul, 24 Aug 2026): whether every card prints the
  // rotated dispatch id and the bank code beside the QR. One checkbox drives
  // both flags across all three product types; the renderer defaults them ON,
  // so an absent key reads as checked.
  function marksEnabled(): boolean {
    const t = defaultCfg?.imageTemplates
    if (t === null || typeof t !== 'object' || t === undefined) return true
    const standee = (t as Record<string, unknown>)['STANDEE']
    if (standee === null || typeof standee !== 'object' || standee === undefined) return true
    const overlay = (standee as Record<string, unknown>)['overlay']
    if (overlay === null || typeof overlay !== 'object' || overlay === undefined) return true
    const marks = (overlay as Record<string, unknown>)['marks']
    if (marks === null || typeof marks !== 'object' || marks === undefined) return true
    return (marks as Record<string, unknown>)['dispatchId'] !== false
  }

  async function toggleMarks(next: boolean): Promise<void> {
    if (tenant === null || defaultCfg === null) return
    setMarksSaving(true)
    setMarksError(null)
    try {
      const current =
        defaultCfg.imageTemplates !== null && typeof defaultCfg.imageTemplates === 'object'
          ? (defaultCfg.imageTemplates as Record<string, unknown>)
          : {}
      const nextTemplates: Record<string, unknown> = { ...current }
      for (const type of ['SOUNDBOX', 'STANDEE', 'STICKER']) {
        const entry =
          nextTemplates[type] !== null && typeof nextTemplates[type] === 'object'
            ? { ...(nextTemplates[type] as Record<string, unknown>) }
            : {}
        const overlay =
          entry['overlay'] !== null && typeof entry['overlay'] === 'object'
            ? { ...(entry['overlay'] as Record<string, unknown>) }
            : {}
        overlay['marks'] = { dispatchId: next, bankCode: next }
        entry['overlay'] = overlay
        nextTemplates[type] = entry
      }
      await upsertBankConfig(
        client,
        {
          tenantWire: tenant.tnntId,
          bankCode: '',
          brandingParams: defaultCfg.brandingParams ?? {},
          imageTemplates: nextTemplates,
        },
        newIdempotencyKey(),
      )
      load()
    } catch (err) {
      setMarksError(err instanceof Error ? err.message : 'Failed to save the option.')
    } finally {
      setMarksSaving(false)
    }
  }

  async function submitTemplate(): Promise<void> {
    if (templateFile === null || tenant === null) return
    setTemplateUploading(true)
    setTemplateError(null)
    try {
      await uploadBankTemplate(client, tenant.tnntId, templateFile)
      setTemplateFile(null)
      setTemplateEpoch((n) => n + 1)
      load()
    } catch (err) {
      setTemplateError(err instanceof Error ? err.message : 'The template upload failed. Try again.')
    } finally {
      setTemplateUploading(false)
    }
  }

  if (rows !== null && tenant === null) {
    return (
      <div className="space-y-5">
        <PageHeader title="Bank Master" description="This bank master does not exist." />
        <Link className="text-sm font-medium text-primary hover:underline" to="/masterdata">
          Back to Master Data
        </Link>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <Link className="text-sm font-medium text-primary hover:underline" to="/masterdata">
            ← Master Data
          </Link>
          <PageHeader
            title={tenant?.displayName ?? 'Bank Master'}
            description={
              tenant === null
                ? 'Loading…'
                : `Bank reference code ${tenant.bankReferenceCode} · ${tenant.aggregators.length} aggregators`
            }
          />
        </div>
        {tenant !== null && (
          <div className="flex flex-none gap-2 pt-6">
            <Button type="button" variant="secondary" onClick={() => setEditingTenant(true)}>
              Edit bank master
            </Button>
            <Button type="button" onClick={() => setAddingAggregator(true)}>
              Add aggregator
            </Button>
          </div>
        )}
      </div>
      {error !== null && <ErrorNote>{error}</ErrorNote>}

      {/* -- The shared card template (Task 4) --------------------------- */}
      <Card>
        <div className="space-y-3 p-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">Card template</h2>
            <p className="text-sm text-muted-foreground">
              {template?.collateral != null ? (
                <>
                  {template.collateral.filename} · {template.collateral.version}
                  {template.collateral.lastModified != null && (
                    <>
                      {' '}
                      ·{' '}
                      <span title={fmtDateTime(template.collateral.lastModified)}>
                        replaced {fmtAgo(template.collateral.lastModified)}
                      </span>
                    </>
                  )}
                  {' '}· shared by every aggregator; a bank's own template still overrides.
                </>
              ) : (
                'The shared frame every card renders over. None uploaded yet.'
              )}
            </p>
          </div>
          {templateError !== null && <ErrorNote>{templateError}</ErrorNote>}
          <div className="flex items-end gap-3">
            <div className="min-w-0 flex-1">
              <Field
                label={template?.collateral != null ? 'Replace template (PDF)' : 'Template (PDF)'}
                htmlFor="tenant-template-file"
                hint="One print-ready PDF, stored for both the standee/sticker and soundbox groups so the two delivery PDFs keep one trim."
              >
                <Input
                  id="tenant-template-file"
                  key={`template-${templateEpoch}`}
                  type="file"
                  accept="application/pdf,.pdf"
                  onChange={(e) => setTemplateFile(e.target.files?.[0] ?? null)}
                />
              </Field>
            </div>
            <Button
              type="button"
              variant="secondary"
              onClick={() => void submitTemplate()}
              disabled={templateFile === null || tenant === null}
              loading={templateUploading}
            >
              Upload template
            </Button>
          </div>
          {marksError !== null && <ErrorNote>{marksError}</ErrorNote>}
          <label className="flex items-center gap-2 border-t pt-3 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={marksEnabled()}
              disabled={marksSaving || defaultCfg === null}
              onChange={(e) => void toggleMarks(e.target.checked)}
              aria-label="Print dispatch id and bank code beside the QR"
            />
            <span>
              Print the dispatch id and bank code beside the QR
              <span className="block text-xs text-muted-foreground">
                The print vendor uses these to reconcile a page in a merged PDF; turn off only if the bank asks.
              </span>
            </span>
          </label>
        </div>
      </Card>

      {/* -- The aggregators ---------------------------------------------- */}
      <Card>
        <div className="flex flex-wrap items-center gap-3 px-4 pt-4">
          <h2 className="text-base font-semibold">Aggregators</h2>
          <div className="relative ml-auto w-64">
            <IconSearch
              width={16}
              height={16}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              aria-label="Search aggregators"
              placeholder="Search name or code"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setPage(0)
              }}
              className="h-9 pl-9"
            />
          </div>
        </div>
        {rows === null ? (
          <SkeletonRows rows={5} cols={4} />
        ) : (
          <div className="px-4 pb-4 pt-3">
            <div className="grid grid-cols-[minmax(0,1fr)_180px_120px_110px] gap-3 border-b px-2 pb-2 text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground max-sm:hidden">
              <span>Aggregator</span>
              <span>Contact</span>
              <span>Status</span>
              <span aria-hidden="true" />
            </div>
            {pageRows.length === 0 ? (
              <p className="px-2 py-6 text-sm text-muted-foreground">No aggregators match.</p>
            ) : (
              <ul className="divide-y">
                {pageRows.map((a) => {
                  const initials = (
                    <span
                      aria-hidden="true"
                      className="flex size-8 flex-none items-center justify-center rounded-lg bg-muted text-[10px] font-semibold text-muted-foreground"
                    >
                      {initialsOf(a.displayName)}
                    </span>
                  )
                  return (
                    <li
                      key={a.aggrId}
                      className="grid grid-cols-[minmax(0,1fr)_180px_120px_110px] items-center gap-3 py-2.5 max-sm:grid-cols-[minmax(0,1fr)_110px]"
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        {a.hasLogo ? <AggregatorLogoThumb aggrId={a.aggrId} name={a.displayName} fallback={initials} /> : initials}
                        <div className="min-w-0">
                          <p className="flex items-center gap-2 text-sm font-medium">
                            <span className="truncate">{a.displayName}</span>
                            {a.isDefault && (
                              <span className="flex-none rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                                default
                              </span>
                            )}
                          </p>
                          <p className="truncate font-mono text-[11px] text-muted-foreground">{a.aggregatorCode}</p>
                        </div>
                      </div>
                      <p className="truncate text-sm text-muted-foreground max-sm:hidden">{a.email ?? a.mobile ?? '-'}</p>
                      <div className="max-sm:hidden">
                        <StatusDot status={a.status} />
                      </div>
                      <div className="flex justify-end gap-3">
                        <button
                          type="button"
                          className="text-sm font-medium text-primary hover:underline"
                          aria-label={`View aggregator ${a.displayName}`}
                          onClick={() => setViewing(a)}
                        >
                          View
                        </button>
                        <button
                          type="button"
                          className="text-sm font-medium text-primary hover:underline"
                          aria-label={`Edit aggregator ${a.displayName}`}
                          onClick={() => setEditing(a)}
                        >
                          Edit
                        </button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
            <div className="flex items-center justify-between border-t px-2 pt-3">
              <p className="text-sm text-muted-foreground">
                {aggregators.length === 0
                  ? '0 of 0'
                  : `${safePage * MASTERDATA_PAGE_SIZE + 1}-${Math.min((safePage + 1) * MASTERDATA_PAGE_SIZE, aggregators.length)} of ${aggregators.length}`}
              </p>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={safePage === 0}
                  onClick={() => setPage((p) => Math.max(0, p - 1))}
                >
                  Previous
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={safePage >= pageCount - 1}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          </div>
        )}
      </Card>

      {tenant !== null && editingTenant && (
        <BankMasterDetailDialog
          bank={tenant}
          open
          onOpenChange={(next) => {
            if (!next) setEditingTenant(false)
          }}
          onSaved={load}
          onAddAggregator={() => {
            setEditingTenant(false)
            setAddingAggregator(true)
          }}
        />
      )}
      {tenant !== null && addingAggregator && (
        <AggregatorCreateDialog
          tenant={tenant}
          open
          onOpenChange={(next) => {
            if (!next) setAddingAggregator(false)
          }}
          onCreated={load}
        />
      )}
      {viewing !== null && (
        <AggregatorDetailDialog
          aggregator={viewing}
          open
          readOnly
          onOpenChange={(next) => {
            if (!next) setViewing(null)
          }}
          onSaved={load}
        />
      )}
      {editing !== null && (
        <AggregatorDetailDialog
          aggregator={editing}
          open
          onOpenChange={(next) => {
            if (!next) setEditing(null)
          }}
          onSaved={load}
        />
      )}
    </div>
  )
}
