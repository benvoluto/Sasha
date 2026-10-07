// The Sasha wordmark. Colors come from the `.logo` rules in globals.css
// (brand-color, and a dark-mode override).

export function MarkerLogo({ className = "" }: { className?: string }) {
  return (
    <svg
      width="96"
      height="28"
      viewBox="0 0 96 28"
      xmlns="http://www.w3.org/2000/svg"
      className={`logo ${className}`}
      role="img"
      aria-label="Sasha"
    >
      <text x="0" y="22" fontSize="24" fontWeight="700" letterSpacing="-0.5" className="brand-color" fill="currentColor">
        Sasha
      </text>
    </svg>
  );
}

export { MarkerLogo as AppLogo };
