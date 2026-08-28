/**
 * TriStateCheckbox.tsx — a native checkbox that can also render `indeterminate`
 * (the visual "some selected" dash state browsers support but have no HTML
 * attribute for — it must be set imperatively via a DOM ref).
 *
 * Used by SectionHeader / SubGroupHeader so a section's "select all" checkbox
 * honestly reflects all/some/none of its rows in one glance, instead of the
 * previous plain "All · None" text buttons.
 */

import { useEffect, useRef } from 'react';
import type { TriState } from '../../graph/selectionState';

interface TriStateCheckboxProps {
  state: TriState['state'];
  onSetAll: (on: boolean) => void;
  'aria-label': string;
  className?: string;
}

export default function TriStateCheckbox({
  state,
  onSetAll,
  className,
  ...aria
}: TriStateCheckboxProps) {
  const ref = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === 'some';
  }, [state]);

  return (
    <input
      ref={ref}
      type="checkbox"
      checked={state === 'all'}
      onChange={() => onSetAll(state !== 'all')}
      aria-label={aria['aria-label']}
      className={
        className ??
        'rounded border-[var(--lb-dim)] cursor-pointer focus-visible:ring-1 focus-visible:ring-[#da7756]'
      }
      style={{ accentColor: '#da7756' }}
    />
  );
}
