import { useCallback, useEffect, useMemo, useState } from 'react'
import { api, errorMessage } from '../api/client'
import type { EventConfig, EventStatus, PutConfigResponse, TileWeights, VaultConfig, VaultObjectives } from '../api/types'
import { diffConfigs, fmtDiffValue, type DiffEntry } from '../utils/diff'
import { IconAlert, IconArrowLeft, IconDice, IconInfo, IconRestore, IconSpinner } from './Icons'
import { Modal } from './Modal'
import { useToast } from './Toast'
import { Banner, Card, ErrorState, Pill, Skeleton } from './ui'

export interface RestoreRequest {
  version: number
  config: EventConfig
  nonce: number
}

interface ReadOnlyView {
  version: number
  config: EventConfig | null
  loading: boolean
  error: unknown
}

const NAME_KEY = 'vr_admin_name'
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))

// ---------------------------------------------------------------------------
// Numeric input that tolerates partial typing and only commits valid numbers.
// ---------------------------------------------------------------------------
function NumInput({
  value,
  onChange,
  step,
  min,
  max,
  int,
  disabled,
  changed,
  invalid,
  className = '',
  title,
  id,
  ariaLabel,
}: {
  value: number
  onChange: (n: number) => void
  step?: number | 'any'
  min?: number
  max?: number
  int?: boolean
  disabled?: boolean
  changed?: boolean
  invalid?: boolean
  className?: string
  title?: string
  id?: string
  ariaLabel?: string
}) {
  const [text, setText] = useState(String(value))
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    if (!focused) setText(Number.isFinite(value) ? String(value) : '')
  }, [value, focused])
  const n = Number(text)
  const bad = invalid || text.trim() === '' || !Number.isFinite(n) || (int && !Number.isInteger(n)) || (min !== undefined && n < min) || (max !== undefined && n > max)
  return (
    <input
      id={id}
      type="number"
      inputMode="decimal"
      className={`input ${className} ${bad ? 'input--invalid' : ''} ${changed && !bad ? 'input--changed' : ''}`}
      value={text}
      step={step}
      min={min}
      max={max}
      disabled={disabled}
      title={title}
      aria-label={ariaLabel}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false)
        setText(Number.isFinite(value) ? String(value) : '')
      }}
      onChange={(e) => {
        const t = e.target.value
        setText(t)
        const parsed = Number(t)
        if (t.trim() !== '' && Number.isFinite(parsed) && (!int || Number.isInteger(parsed))) onChange(parsed)
      }}
    />
  )
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------
function validate(c: EventConfig): string[] {
  const errs: string[] = []
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v)
  if (!num(c.difficulty) || c.difficulty <= 0) errs.push('Difficulty must be greater than 0.')
  if (!num(c.lootMultiplier) || c.lootMultiplier <= 0) errs.push('Loot multiplier must be greater than 0.')
  if (!Number.isInteger(c.livesCost) || c.livesCost < 0) errs.push('Lives cost must be a non-negative integer.')
  if (!Number.isInteger(c.seed) || c.seed < 0 || c.seed > 0xffffffff) errs.push('Seed must be an integer in [0, 4294967295].')
  if (!num(c.bustPenalty) || c.bustPenalty < 0 || c.bustPenalty > 1) errs.push('Bust penalty must be within [0, 1].')
  if (c.vaultMultipliers.length !== c.vaults.length) errs.push(`Vault multipliers (${c.vaultMultipliers.length}) must match the number of vaults (${c.vaults.length}).`)
  c.vaultMultipliers.forEach((m, i) => {
    if (!num(m) || m <= 0) errs.push(`Vault ${i + 1} multiplier must be greater than 0.`)
  })
  c.vaults.forEach((v, i) => {
    const n = `Vault ${i + 1}`
    if (!v.name.trim()) errs.push(`${n} needs a name.`)
    if (!Number.isInteger(v.moves) || v.moves < 1) errs.push(`${n} moves must be a positive integer.`)
    if (!Number.isInteger(v.locks) || v.locks < 0) errs.push(`${n} locks must be a non-negative integer.`)
    for (const k of ['key', 'laser', 'camera'] as const) {
      if (!Number.isInteger(v.objectives[k]) || v.objectives[k] < 0) errs.push(`${n} ${k} objective must be a non-negative integer.`)
    }
    if (v.objectives.key + v.objectives.laser + v.objectives.camera === 0) errs.push(`${n} has no objectives — it would be cracked instantly.`)
    let total = 0
    for (const k of Object.keys(v.weights) as (keyof TileWeights)[]) {
      if (!Number.isInteger(v.weights[k]) || v.weights[k] < 0) errs.push(`${n} ${k} weight must be a non-negative integer.`)
      total += v.weights[k]
    }
    if (total <= 0) errs.push(`${n} tile weights must sum to more than 0.`)
    if (v.locks >= c.grid.w * c.grid.h) errs.push(`${n} has more locks than grid cells.`)
  })
  return errs
}

/** Objective requirement after difficulty scaling (docs/engine.md §4). */
function scaled(base: number, difficulty: number) {
  const d = Math.round(difficulty * 100)
  return Math.floor((base * d + 50) / 100)
}

const OBJ_KEYS: (keyof VaultObjectives)[] = ['key', 'laser', 'camera']
const WEIGHT_KEYS: (keyof TileWeights)[] = ['key', 'laser', 'camera', 'money', 'diamond', 'guard']

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------
export function ConfigEditor({
  eventId,
  base,
  eventStatus,
  readOnly,
  onExitReadOnly,
  onRestore,
  restore,
  onPublished,
}: {
  eventId: string
  base: EventConfig
  eventStatus: EventStatus
  readOnly: ReadOnlyView | null
  onExitReadOnly: () => void
  onRestore: (version: number) => void
  restore: RestoreRequest | null
  onPublished: (res: PutConfigResponse) => void
}) {
  const toast = useToast()
  const [draft, setDraft] = useState<EventConfig>(() => clone(base))
  const [note, setNote] = useState('')
  const [author, setAuthor] = useState(() => {
    try {
      return localStorage.getItem(NAME_KEY) || 'admin'
    } catch {
      return 'admin'
    }
  })
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [publishError, setPublishError] = useState<string | null>(null)

  // New base version arrives (after publish / reload) → reset the draft.
  useEffect(() => {
    setDraft(clone(base))
    setNote('')
    setPublishError(null)
  }, [base.version, base.eventId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Restore request from version history → load fields into the draft.
  useEffect(() => {
    if (!restore) return
    const c = clone(restore.config)
    setDraft({ ...c, eventId: base.eventId, version: base.version })
    setNote((n) => n || `Restore v${restore.version}`)
    toast.info(`Loaded v${restore.version} into the editor`, 'Review the diff and publish to create a new version.')
  }, [restore?.nonce]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    try {
      localStorage.setItem(NAME_KEY, author)
    } catch {
      /* ignore */
    }
  }, [author])

  const diff = useMemo(() => diffConfigs(base, draft), [base, draft])
  const changedPaths = useMemo(() => new Set(diff.map((d) => d.path)), [diff])
  const errors = useMemo(() => validate(draft), [draft])
  const dirty = diff.length > 0
  const canPublish = dirty && note.trim().length > 0 && errors.length === 0 && !publishing

  const set = useCallback(<K extends keyof EventConfig>(k: K, v: EventConfig[K]) => setDraft((d) => ({ ...d, [k]: v })), [])
  const setVault = useCallback((i: number, patch: Partial<VaultConfig>) => {
    setDraft((d) => {
      const vaults = d.vaults.map((v, j) => (j === i ? { ...v, ...patch } : v))
      return { ...d, vaults }
    })
  }, [])
  const setObjective = (i: number, k: keyof VaultObjectives, v: number) =>
    setDraft((d) => ({ ...d, vaults: d.vaults.map((x, j) => (j === i ? { ...x, objectives: { ...x.objectives, [k]: v } } : x)) }))
  const setWeight = (i: number, k: keyof TileWeights, v: number) =>
    setDraft((d) => ({ ...d, vaults: d.vaults.map((x, j) => (j === i ? { ...x, weights: { ...x.weights, [k]: v } } : x)) }))
  const setMultiplier = (i: number, v: number) => setDraft((d) => ({ ...d, vaultMultipliers: d.vaultMultipliers.map((m, j) => (j === i ? v : m)) }))

  const randomizeSeed = () => {
    const buf = new Uint32Array(1)
    crypto.getRandomValues(buf)
    set('seed', buf[0])
  }

  async function publish() {
    setPublishing(true)
    setPublishError(null)
    try {
      // Server assigns version/createdAt/createdBy/note — strip them from the payload.
      const { version: _v, createdAt: _a, createdBy: _b, note: _n, ...fields } = draft
      const res = await api.putEventConfig(eventId, fields, note.trim(), author.trim() || 'admin')
      toast.success(`Config v${res.config.version} published — active runs keep v${base.version}`, `New heists start on v${res.config.version}.`)
      setConfirmOpen(false)
      onPublished(res)
    } catch (e) {
      setPublishError(errorMessage(e))
      toast.error('Publish failed', errorMessage(e))
    } finally {
      setPublishing(false)
    }
  }

  // Which config the form shows: an older read-only version, or the editable draft.
  const ro = readOnly !== null
  const shown: EventConfig | null = ro ? readOnly.config : draft
  const isChanged = (path: string) => !ro && changedPaths.has(path)

  const title = ro ? `Config v${readOnly.version}` : `Config editor`
  const subtitle = ro
    ? 'Read-only snapshot of an older version. Restore it to load these values into the editor.'
    : `Editing on top of v${base.version}. Publishing creates v${base.version + 1}; runs already in progress keep v${base.version}.`

  return (
    <Card
      title={
        <span className="row">
          {title}
          {ro ? <Pill tone="sky">read-only</Pill> : dirty ? <Pill tone="gold">{diff.length} change{diff.length === 1 ? '' : 's'}</Pill> : <Pill tone="neutral">no changes</Pill>}
        </span>
      }
      subtitle={subtitle}
      actions={
        ro ? (
          <>
            <button className="btn btn--sm" onClick={onExitReadOnly}>
              <IconArrowLeft /> Back to v{base.version}
            </button>
            <button className="btn btn--sm btn--primary" onClick={() => onRestore(readOnly.version)} disabled={!readOnly.config}>
              <IconRestore /> Restore as new version
            </button>
          </>
        ) : (
          <span className="chip" title="Board size is fixed per event">
            Grid <b>{draft.grid.w}×{draft.grid.h}</b>
          </span>
        )
      }
      className="fade-in"
      footer={
        !ro && (
          <>
            <div className="row gap-12 grow" style={{ minWidth: 0 }}>
              <label className="row text-sm muted" style={{ gap: 6 }}>
                Author
                <input className="input input--sm" style={{ width: 120 }} value={author} onChange={(e) => setAuthor(e.target.value)} aria-label="Author" />
              </label>
              {errors.length > 0 && (
                <span className="row text-sm" style={{ color: 'var(--ruby)' }} title={errors.join('\n')}>
                  <IconAlert width={14} height={14} /> {errors.length} validation issue{errors.length === 1 ? '' : 's'}
                </span>
              )}
            </div>
            <div className="row">
              <button className="btn btn--ghost" onClick={() => setDraft(clone(base))} disabled={!dirty}>
                Discard
              </button>
              <button className="btn btn--primary" onClick={() => setConfirmOpen(true)} disabled={!canPublish} title={!dirty ? 'No changes to publish' : !note.trim() ? 'A change note is required' : errors[0]}>
                UPDATE EVENT → v{base.version + 1}
              </button>
            </div>
          </>
        )
      }
    >
      {ro && readOnly.error ? <ErrorState error={readOnly.error} /> : null}
      {ro && readOnly.loading && !readOnly.config && (
        <div className="stack">
          <Skeleton variant="block" style={{ height: 120 }} />
          <Skeleton variant="block" />
        </div>
      )}

      {shown && (
        <>
          {!ro && eventStatus === 'ENDED' && (
            <Banner tone="warn" icon={<IconInfo style={{ color: 'var(--gold)' }} />}>
              This event has ended. You can still publish versions (e.g. to fix history), but no new runs will use them.
            </Banner>
          )}
          {ro && readOnly.config?.note && (
            <Banner tone="info" icon={<IconInfo style={{ color: 'var(--sky)' }} />}>
              <b>v{readOnly.version}</b> · {readOnly.config.note} <span className="muted">— {readOnly.config.createdBy}</span>
            </Banner>
          )}

          {/* Global knobs */}
          <div className="form-grid">
            <div className="field">
              <label className="field__label" htmlFor="difficulty">
                Difficulty
              </label>
              <NumInput id="difficulty" value={shown.difficulty} step={0.05} min={0.05} disabled={ro} changed={isChanged('difficulty')} onChange={(v) => set('difficulty', Math.round(v * 100) / 100)} />
              <span className="field__hint">Scales objectives: floor((base·d+50)/100)</span>
            </div>
            <div className="field">
              <label className="field__label" htmlFor="loot">
                Loot multiplier
              </label>
              <NumInput id="loot" value={shown.lootMultiplier} step={0.1} min={0.1} disabled={ro} changed={isChanged('lootMultiplier')} onChange={(v) => set('lootMultiplier', Math.round(v * 100) / 100)} />
              <span className="field__hint">Applied to the final score</span>
            </div>
            <div className="field">
              <label className="field__label" htmlFor="lives">
                Lives cost
              </label>
              <NumInput id="lives" value={shown.livesCost} step={1} min={0} int disabled={ro} changed={isChanged('livesCost')} onChange={(v) => set('livesCost', v)} />
              <span className="field__hint">Lives consumed per heist start</span>
            </div>
            <div className="field">
              <label className="field__label" htmlFor="bust">
                Bust penalty
              </label>
              <NumInput id="bust" value={shown.bustPenalty} step={0.05} min={0} max={1} disabled={ro} changed={isChanged('bustPenalty')} onChange={(v) => set('bustPenalty', Math.round(v * 100) / 100)} />
              <span className="field__hint">Score × (1 − penalty) when busted; shield halves it</span>
            </div>
            <div className="field" style={{ gridColumn: 'span 2' }}>
              <label className="field__label" htmlFor="seed">
                Seed
              </label>
              <div className="input-group">
                <NumInput id="seed" value={shown.seed} step={1} min={0} max={0xffffffff} int disabled={ro} changed={isChanged('seed')} onChange={(v) => set('seed', v)} className="mono-num" />
                {!ro && (
                  <button className="btn btn--icon" type="button" onClick={randomizeSeed} title="Randomize seed (uint32)" aria-label="Randomize seed">
                    <IconDice />
                  </button>
                )}
              </div>
              <span className="field__hint">uint32 · every board of the day derives from this</span>
            </div>
          </div>

          {/* Vault multipliers */}
          <div className="field">
            <span className="field__label">
              Vault multipliers <span className="muted-2 text-xs">score × multiplier of the deepest vault cracked</span>
            </span>
            <div className="mult-grid">
              {shown.vaultMultipliers.map((m, i) => (
                <div className="field" key={i} style={{ gap: 4 }}>
                  <span className="field__hint center">V{i + 1}</span>
                  <NumInput value={m} step={0.5} min={0.5} disabled={ro} changed={isChanged(`vaultMultipliers[${i}]`)} onChange={(v) => setMultiplier(i, v)} className="input--sm center" ariaLabel={`Vault ${i + 1} multiplier`} />
                </div>
              ))}
            </div>
          </div>

          {/* Per-vault tables: objectives/moves/locks, then tile weights. Two tables keep
              the editor readable inside a 2/3-width card without horizontal scrolling. */}
          <div className="field">
            <span className="field__label">
              Vaults · objectives &amp; layout
              <span className="muted-2 text-xs">hover an objective to see the difficulty-scaled requirement</span>
            </span>
            <div className="table-wrap" style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
              <table className="table table--compact table--editor">
                <thead>
                  <tr>
                    <th className="sub">#</th>
                    <th className="sub">Name</th>
                    <th className="sub num">Moves</th>
                    <th className="sub num" style={{ color: 'var(--sky)' }}>
                      Key
                    </th>
                    <th className="sub num" style={{ color: 'var(--sky)' }}>
                      Laser
                    </th>
                    <th className="sub num" style={{ color: 'var(--sky)' }}>
                      Camera
                    </th>
                    <th className="sub num">Locks</th>
                    <th className="sub num muted-2">Eff. obj.</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.vaults.map((v, i) => {
                    const eff = OBJ_KEYS.map((k) => scaled(v.objectives[k], shown.difficulty))
                    return (
                      <tr key={i}>
                        <td className="muted mono-num">{i + 1}</td>
                        <td>
                          <input
                            className={`input input--sm input--name ${isChanged(`vaults[${i}].name`) ? 'input--changed' : ''} ${!v.name.trim() ? 'input--invalid' : ''}`}
                            value={v.name}
                            disabled={ro}
                            onChange={(e) => setVault(i, { name: e.target.value })}
                            aria-label={`Vault ${i + 1} name`}
                          />
                        </td>
                        <td className="num">
                          <NumInput value={v.moves} step={1} min={1} int disabled={ro} changed={isChanged(`vaults[${i}].moves`)} onChange={(n) => setVault(i, { moves: n })} className="input--sm" ariaLabel={`Vault ${i + 1} moves`} />
                        </td>
                        {OBJ_KEYS.map((k, ki) => (
                          <td className="num" key={k}>
                            <NumInput
                              value={v.objectives[k]}
                              step={1}
                              min={0}
                              int
                              disabled={ro}
                              changed={isChanged(`vaults[${i}].objectives.${k}`)}
                              onChange={(n) => setObjective(i, k, n)}
                              className="input--sm"
                              title={`Effective at difficulty ${shown.difficulty}: ${eff[ki]}`}
                              ariaLabel={`Vault ${i + 1} ${k} objective`}
                            />
                          </td>
                        ))}
                        <td className="num">
                          <NumInput value={v.locks} step={1} min={0} int disabled={ro} changed={isChanged(`vaults[${i}].locks`)} onChange={(n) => setVault(i, { locks: n })} className="input--sm" ariaLabel={`Vault ${i + 1} locks`} />
                        </td>
                        <td className="num muted mono-num text-xs nowrap" title="Key / laser / camera after difficulty scaling">
                          {eff.join(' / ')}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>

          <div className="field">
            <span className="field__label">
              Vaults · tile weights
              <span className="muted-2 text-xs">relative draw weights per tile type; hover for the share</span>
            </span>
            <div className="table-wrap" style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
              <table className="table table--compact table--editor">
                <thead>
                  <tr>
                    <th className="sub">#</th>
                    <th className="sub">Vault</th>
                    <th className="sub num" style={{ color: 'var(--gold)' }}>
                      Key
                    </th>
                    <th className="sub num" style={{ color: 'var(--gold)' }}>
                      Laser
                    </th>
                    <th className="sub num" style={{ color: 'var(--gold)' }}>
                      Camera
                    </th>
                    <th className="sub num" style={{ color: 'var(--gold)' }}>
                      Money
                    </th>
                    <th className="sub num" style={{ color: 'var(--gold)' }}>
                      Diamond
                    </th>
                    <th className="sub num" style={{ color: 'var(--gold)' }}>
                      Guard
                    </th>
                    <th className="sub num">Σ</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.vaults.map((v, i) => {
                    const total = WEIGHT_KEYS.reduce((s, k) => s + (v.weights[k] || 0), 0)
                    return (
                      <tr key={i}>
                        <td className="muted mono-num">{i + 1}</td>
                        <td className="truncate" style={{ maxWidth: 140 }}>
                          {v.name || <span className="muted-2">—</span>}
                        </td>
                        {WEIGHT_KEYS.map((k) => (
                          <td className="num" key={k}>
                            <NumInput
                              value={v.weights[k]}
                              step={1}
                              min={0}
                              int
                              disabled={ro}
                              changed={isChanged(`vaults[${i}].weights.${k}`)}
                              onChange={(n) => setWeight(i, k, n)}
                              className="input--sm"
                              title={total > 0 ? `${((v.weights[k] / total) * 100).toFixed(1)}% of tiles` : undefined}
                              ariaLabel={`Vault ${i + 1} ${k} weight`}
                            />
                          </td>
                        ))}
                        <td className="num muted mono-num" style={{ color: total > 0 ? undefined : 'var(--ruby)' }}>
                          {total}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Change note */}
          {!ro && (
            <div className="field">
              <label className="field__label" htmlFor="note">
                <span>
                  Change note <span className="req">*</span>
                </span>
                <span className="muted-2 text-xs">shown in version history</span>
              </label>
              <textarea
                id="note"
                className={`input ${dirty && !note.trim() ? 'input--invalid' : ''}`}
                placeholder="Why are you changing this? e.g. “Vault 4 too hard, lowered lasers”"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
              />
            </div>
          )}

          {!ro && errors.length > 0 && (
            <Banner tone="error" icon={<IconAlert style={{ color: 'var(--ruby)' }} />}>
              <ul style={{ margin: 0, paddingLeft: 16 }}>
                {errors.slice(0, 5).map((e) => (
                  <li key={e}>{e}</li>
                ))}
                {errors.length > 5 && <li className="muted">…and {errors.length - 5} more</li>}
              </ul>
            </Banner>
          )}
        </>
      )}

      <Modal
        open={confirmOpen}
        onClose={() => !publishing && setConfirmOpen(false)}
        title={`Publish config v${base.version + 1}?`}
        subtitle={`${diff.length} field${diff.length === 1 ? '' : 's'} changed vs v${base.version}. Active runs keep v${base.version}; new heists start on v${base.version + 1}.`}
        footer={
          <>
            <button className="btn" onClick={() => setConfirmOpen(false)} disabled={publishing}>
              Cancel
            </button>
            <button className="btn btn--primary" onClick={publish} disabled={publishing}>
              {publishing ? <IconSpinner /> : null}
              {publishing ? 'Publishing…' : `Publish v${base.version + 1}`}
            </button>
          </>
        }
      >
        <DiffList diff={diff} />
        <div className="kv" style={{ marginTop: 4 }}>
          <dt>Note</dt>
          <dd>{note.trim() || <span className="muted">—</span>}</dd>
          <dt>Author</dt>
          <dd>{author.trim() || 'admin'}</dd>
          <dt>Endpoint</dt>
          <dd className="mono">PUT /admin/v1/events/{eventId}/config</dd>
        </div>
        {publishError && <ErrorState error={new Error(publishError)} />}
      </Modal>
    </Card>
  )
}

function DiffList({ diff }: { diff: DiffEntry[] }) {
  if (diff.length === 0) return <Banner tone="neutral">No changes.</Banner>
  return (
    <div className="diff">
      {diff.map((d) => (
        <div className="diff__row" key={d.path}>
          <div className="diff__label">
            {d.label}
            <span className="diff__path">{d.path}</span>
          </div>
          <div className="diff__before">{fmtDiffValue(d.before)}</div>
          <div className="diff__arrow">→</div>
          <div className="diff__after">{fmtDiffValue(d.after)}</div>
        </div>
      ))}
    </div>
  )
}
