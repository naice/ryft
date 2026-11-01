import { useEffect, useState } from 'react';
import { Maximize2, Minimize2, Minus, X } from 'lucide-react';
import { Channels } from '@shared/channels';
import { api } from '../../lib/api';
import { useApp } from '../../state/appStore';
import { IconButton } from '../../components/ui/primitives';

const DOT = 'size-3 rounded-full transition-[filter] duration-120 hover:brightness-125';

export function TitleBar() {
  const isMac = useApp((state) => state.info?.platform === 'darwin');
  const [maximized, setMaximized] = useState(false);
  useEffect(() => api.onWindowMaximized(setMaximized), []);

  const minimize = () => void api.invoke(Channels.windowMinimize);
  const toggle = () => void api.invoke(Channels.windowToggleMaximize);
  const close = () => void api.invoke(Channels.windowClose);

  return (
    <div
      data-testid="titlebar"
      className="ryft-drag flex h-7 flex-none items-center px-3"
      onDoubleClick={isMac ? undefined : toggle}
    >
      {/* macOS draws its native traffic lights in this spot. */}
      {!isMac && (
        <div className="ryft-no-drag flex items-center gap-2" onDoubleClick={(event) => event.stopPropagation()}>
          <button type="button" aria-label="Fenster schließen" onClick={close} className={`${DOT} bg-[var(--ryft-error)]`} />
          <button type="button" aria-label="Fenster minimieren" onClick={minimize} className={`${DOT} bg-[var(--ryft-warning)]`} />
          <button
            type="button"
            aria-label={maximized ? 'Fenster wiederherstellen' : 'Fenster maximieren'}
            onClick={toggle}
            className={`${DOT} bg-[var(--ryft-success)]`}
          />
        </div>
      )}
      <div className="flex-1" />
      {!isMac && (
        <div className="flex items-center gap-1" onDoubleClick={(event) => event.stopPropagation()}>
          <IconButton label="Minimieren" size={22} onClick={minimize}>
            <Minus size={14} />
          </IconButton>
          <IconButton label={maximized ? 'Wiederherstellen' : 'Maximieren'} size={22} onClick={toggle}>
            {maximized ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
          </IconButton>
          <IconButton label="Schließen" size={22} onClick={close}>
            <X size={14} />
          </IconButton>
        </div>
      )}
    </div>
  );
}
