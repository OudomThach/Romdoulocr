/**
 * Angkor Wat mark — the iconic frontal silhouette: five tiered "prang" towers
 * (tall central tower flanked by four lower ones in a quincunx) rising from the
 * long gallery, the way it reads on the Cambodian flag. Towers are stepped
 * (corncob tiers) rather than smooth, which is what makes it read as Angkor Wat.
 *
 * Uses currentColor so the parent themes it: deep slate in light, glowing
 * temple-gold in dark (cyberpunk).
 */

/** Build a symmetric, tiered tower silhouette path (stepped sides → pointed top). */
function tower(cx: number, baseY: number, tipY: number, halfWidth: number, tiers: number): string {
  const stepH = (baseY - tipY) / (tiers + 1);
  const hw = (i: number) => halfWidth * (1 - i / (tiers + 1));

  // Left edge: from base up, alternating "rise" then "step in" at each tier.
  const pts: [number, number][] = [[cx - hw(0), baseY]];
  for (let i = 0; i < tiers; i++) {
    const yTop = baseY - stepH * (i + 1);
    pts.push([cx - hw(i), yTop]); // rise at current width
    pts.push([cx - hw(i + 1), yTop]); // step inward
  }
  pts.push([cx, tipY]); // tip

  // Mirror the left edge to the right (reverse order), then close.
  const all = [...pts];
  for (let i = pts.length - 2; i >= 0; i--) {
    all.push([cx + (cx - pts[i][0]), pts[i][1]]);
  }
  return (
    all.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ') + 'Z'
  );
}

// cx, baseY, tipY, halfWidth, tiers
const TOWERS: [number, number, number, number, number][] = [
  [10, 31, 17, 2.9, 3], // outer left
  [18.5, 31, 12, 3.3, 3], // inner left
  [28, 31, 4.5, 4.3, 4], // central (tallest)
  [37.5, 31, 12, 3.3, 3], // inner right
  [46, 31, 17, 2.9, 3], // outer right
];

const FINIALS: [number, number][] = [
  [10, 16],
  [18.5, 11],
  [28, 3.4],
  [37.5, 11],
  [46, 16],
];

export function AngkorWatLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 56 44" className={className} fill="currentColor" aria-hidden="true">
      {TOWERS.map((t, i) => (
        <path key={i} d={tower(...t)} />
      ))}
      {FINIALS.map(([cx, cy], i) => (
        <circle key={i} cx={cx} cy={cy} r={0.9} />
      ))}
      {/* long gallery building + stepped plinth + causeway */}
      <rect x="4" y="30.5" width="48" height="5.2" rx="1" />
      <rect x="1.5" y="35.5" width="53" height="2.8" rx="1" />
      <rect x="9" y="38.6" width="38" height="1.8" rx="0.9" />
    </svg>
  );
}
