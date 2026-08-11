export function Sparkline({ values }: { values: number[] }) {
  const max = Math.max(...values, 1);
  const points = values
    .map(
      (value, index) =>
        `${(index / Math.max(1, values.length - 1)) * 84},${26 - (value / max) * 23}`,
    )
    .join(' ');
  return (
    <svg className="sparkline" viewBox="0 0 84 28" aria-label={`Trend ${values.join(', ')}`}>
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
