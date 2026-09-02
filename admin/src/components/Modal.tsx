import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { IconX } from './Icons'

/**
 * Rendered through a portal on <body>: cards use an opacity fade-in, which makes
 * the browser treat them as stacking contexts, so a fixed modal rendered inline
 * would be trapped beneath later siblings.
 */
export function Modal({
  open,
  title,
  subtitle,
  onClose,
  children,
  footer,
  width,
}: {
  open: boolean
  title: ReactNode
  subtitle?: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: number
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [open, onClose])

  if (!open) return null
  return createPortal(
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" style={width ? { width: `min(${width}px, 100%)` } : undefined}>
        <header className="modal__header">
          <div className="grow">
            <h3 className="modal__title">{title}</h3>
            {subtitle && <p className="card__subtitle">{subtitle}</p>}
          </div>
          <button className="btn btn--ghost btn--icon btn--sm" onClick={onClose} aria-label="Close">
            <IconX />
          </button>
        </header>
        <div className="modal__body">{children}</div>
        {footer && <footer className="modal__footer">{footer}</footer>}
      </div>
    </div>,
    document.body,
  )
}
