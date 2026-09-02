import type { VersionMeta } from '../api/types'
import { useNow } from '../api/hooks'
import { fmtDateTime, fmtRelative } from '../utils/format'
import { IconEye, IconRestore } from './Icons'
import { Card, EmptyState, Pill } from './ui'

export function VersionHistory({
  versions,
  current,
  viewing,
  onView,
  onRestore,
}: {
  versions: VersionMeta[]
  current: number
  viewing: number | null
  onView: (version: number) => void
  onRestore: (version: number) => void
}) {
  const now = useNow(30_000)
  const sorted = [...versions].sort((a, b) => b.version - a.version)
  return (
    <Card title="Version history" subtitle={`${versions.length} version${versions.length === 1 ? '' : 's'} · newest first`} className="fade-in">
      {sorted.length === 0 ? (
        <EmptyState title="No versions" message="This event has no config versions yet." />
      ) : (
        <div className="timeline" style={{ maxHeight: 620, overflowY: 'auto', paddingRight: 4 }}>
          {sorted.map((v) => {
            const isCurrent = v.version === current
            const isViewing = v.version === viewing
            return (
              <div key={v.version} className={`tl-item ${isCurrent ? 'tl-item--current' : ''} ${isViewing ? 'tl-item--viewing' : ''}`}>
                <div className="tl-item__dot" />
                <div style={{ minWidth: 0 }}>
                  <div className="tl-item__head">
                    <span className="tl-item__version">v{v.version}</span>
                    {isCurrent && <Pill tone="gold">current</Pill>}
                    {isViewing && <Pill tone="sky">viewing</Pill>}
                    {!isCurrent && (
                      <div className="tl-item__actions">
                        <button className="btn btn--ghost btn--xs" onClick={() => onView(v.version)} title="View this version read-only">
                          <IconEye width={14} height={14} /> view
                        </button>
                        <button className="btn btn--ghost btn--xs" onClick={() => onRestore(v.version)} title="Load into the editor as a new version">
                          <IconRestore width={14} height={14} /> restore
                        </button>
                      </div>
                    )}
                  </div>
                  <div className="tl-item__note">{v.note || <span className="muted-2">No note</span>}</div>
                  <div className="tl-item__meta">
                    {v.createdBy} · {fmtDateTime(v.createdAt)} · {fmtRelative(v.createdAt, now)}
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}
