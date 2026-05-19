import type { ReactNode } from "react";

interface TooltipProps {
  label: string;
  children?: ReactNode;
}

export function Tooltip({ label, children }: TooltipProps) {
  return (
    <span className="tooltip" tabIndex={0} aria-label={label}>
      {children || "?"}
      <span className="tooltip__bubble">{label}</span>
    </span>
  );
}
