/**
 * Romdoul mark — a stylized រំដួល (romdoul, Cambodia's national flower):
 * three broad front petals over three back petals with a round bud center.
 * Uses currentColor so the parent themes it (neon cyan in the cyberpunk skin).
 */
export function RomdoulLogo({ className }: { className?: string }) {
  const petal = 'M24 6 C29 12 29 19 24 24 C19 19 19 12 24 6 Z';
  return (
    <svg viewBox="0 0 48 48" className={className} fill="currentColor" aria-hidden="true">
      {/* back petals (rotated 60°, softer) */}
      <g opacity="0.45">
        {[60, 180, 300].map((r) => (
          <path key={r} d={petal} transform={`rotate(${r} 24 24)`} />
        ))}
      </g>
      {/* front petals */}
      <g opacity="0.92">
        {[0, 120, 240].map((r) => (
          <path key={r} d={petal} transform={`rotate(${r} 24 24)`} />
        ))}
      </g>
      {/* bud center */}
      <circle cx="24" cy="24" r="5" />
      <circle cx="24" cy="24" r="8" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.5" />
    </svg>
  );
}
