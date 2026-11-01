import { useId } from 'react';

/** The stacked-server icon of the reference, with the cyan-to-purple brand gradient on its strokes. */
export function ServerStackIcon({ size = 24, muted = false }: { size?: number; muted?: boolean }) {
  const id = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="8" y1="2" x2="16" y2="22" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--ryft-cyan)" />
          <stop offset="1" stopColor="var(--ryft-purple)" />
        </linearGradient>
      </defs>
      <g stroke={muted ? 'currentColor' : `url(#${id})`} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round">
        <path d="M12 2.5 20.5 6v12L12 21.5 3.5 18V6Z" />
        <path d="M3.5 6 12 9.5 20.5 6" />
        <path d="M3.5 12 12 15.5 20.5 12" />
      </g>
    </svg>
  );
}

/** The Hosts entry of the navigation: stacked layers in a rounded square, in the brand gradient. */
export function HostsNavIcon({ size = 18 }: { size?: number }) {
  const id = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="6" y1="2" x2="18" y2="22" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--ryft-cyan)" />
          <stop offset="1" stopColor="var(--ryft-purple)" />
        </linearGradient>
      </defs>
      <g stroke={`url(#${id})`} strokeWidth="1.9" strokeLinejoin="round" strokeLinecap="round">
        <rect x="3" y="2.5" width="18" height="19" rx="4.5" />
        <path d="M3.5 9 12 12.5 20.5 9" />
        <path d="M3.5 15 12 18.5 20.5 15" />
      </g>
    </svg>
  );
}

/** The R of ryft-icon.svg without its square frame, which is how the reference shows it beside the wordmark. */
export function RyftGlyph({ size = 22 }: { size?: number }) {
  const id = useId();
  return (
    <svg width={size} height={size} viewBox="200 280 610 515" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="200" y1="280" x2="810" y2="795" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--ryft-cyan)" />
          <stop offset="1" stopColor="var(--ryft-purple)" />
        </linearGradient>
      </defs>
      <path
        fill={`url(#${id})`}
        d="M252 296 H610 C735 296 798 366 798 470 C798 555 752 607 676 630 L797 785 H615 L463 586 H584 C623 586 649 568 649 530 C649 494 625 474 584 474 H394 L252 296 Z"
      />
      <path fill={`url(#${id})`} d="M394 544 H539 L307 784 H208 Z" />
    </svg>
  );
}

export function RyftWordmark() {
  return <span className="text-[18px] leading-none font-bold tracking-[1.8px] text-text">RYFT</span>;
}
